/**
 * WS-A A1 — the Golem proxy server: a transparent Anthropic API passthrough.
 *
 * Claude Code points `ANTHROPIC_BASE_URL` at this server; every request is
 * forwarded to the real API with method, path, query, headers (including
 * auth) and body preserved. Responses — most importantly SSE streams with
 * tool-use / thinking / tool_reference blocks — are piped back as raw bytes:
 * no parsing, no re-serialization, no buffering, no event reordering
 * (CLAUDE.md hard rule; verification-notes §15).
 *
 * Request bodies are buffered (they are bounded JSON documents) so the A3
 * pipeline seam ({@link RequestPipeline}) can operate on them; at A1 the
 * pipeline is the identity, so forwarded bytes equal received bytes.
 * No zod here on purpose: the proxy never interprets payloads, so there is
 * no boundary to validate — validation would require a parse/re-serialize
 * cycle that the byte-fidelity rule forbids.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline } from "node:stream/promises";
import { type Dispatcher, Pool } from "undici";
import { mapUpstreamError, PROXY_ERROR_HEADER } from "./errors.js";
import {
  forwardableRequestHeaders,
  forwardableResponseHeaders,
  isBypassRequest,
} from "./headers.js";
import {
  type ProxyConfig,
  type ProxyRequest,
  type ProxyServerOptions,
  resolveProxyConfig,
} from "./types.js";
import { UsageSniffer } from "./usage-sniffer.js";

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

export class GolemProxy {
  readonly config: ProxyConfig;
  private readonly server: Server;
  private readonly pool: Pool;
  /** Upstream path prefix (empty unless the base URL carries one). */
  private readonly basePath: string;

  constructor(options: ProxyServerOptions = {}) {
    this.config = resolveProxyConfig(options);
    const upstream = new URL(this.config.upstreamBaseUrl);
    this.basePath = upstream.pathname.replace(/\/+$/, "");
    this.pool = new Pool(upstream.origin, {
      connect: { timeout: this.config.connectTimeoutMs },
      headersTimeout: this.config.headersTimeoutMs,
      bodyTimeout: this.config.bodyTimeoutMs,
    });
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  /** Bind the proxy. `port` 0 picks an ephemeral port (tests). */
  listen(port = 0, host = "127.0.0.1"): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.removeListener("error", reject);
        resolve(this.server.address() as AddressInfo);
      });
    });
  }

  address(): AddressInfo | null {
    const addr = this.server.address();
    return addr && typeof addr === "object" ? addr : null;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
      // Drop lingering keep-alive connections so close() completes promptly.
      this.server.closeAllConnections();
    });
    await this.pool.close();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Low-latency streaming: disable Nagle on the client socket.
    res.socket?.setNoDelay(true);

    const abort = new AbortController();
    res.on("close", () => {
      // Client went away before we finished — cancel the upstream request.
      if (!res.writableEnded) abort.abort();
    });

    let forward: ProxyRequest;
    try {
      const body = await readBody(req);
      forward = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: forwardableRequestHeaders(req.headers),
        body,
      };
    } catch (err) {
      // We could not even read the client request — nothing to forward.
      this.respondProxyError(res, 400, `golem proxy: could not read request (${String(err)})`);
      return;
    }

    // A3 seam: redaction -> compression. FAIL-OPEN — a pipeline error must
    // never break the session: fall back to forwarding the ORIGINAL request
    // byte-faithfully (CLAUDE.md proxy-fidelity rule). Bypass skips it too.
    if (!isBypassRequest(req.headers)) {
      try {
        forward = await this.config.pipeline.process(forward);
      } catch (err) {
        this.config.onPipelineError?.(err, forward);
        // `forward` is still the original request — leave it unchanged.
      }
    }

    let upstream: Dispatcher.ResponseData;
    try {
      upstream = await this.pool.request({
        path: this.basePath + forward.url,
        method: forward.method as Dispatcher.HttpMethod,
        headers: forward.headers,
        body: forward.body,
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) {
        res.destroy();
        return;
      }
      const mapped = mapUpstreamError(err);
      this.respondProxyError(res, mapped.status, undefined, mapped.body);
      return;
    }

    res.writeHead(upstream.statusCode, forwardableResponseHeaders(upstream.headers));
    // Push headers immediately so SSE clients see the response open
    // before the first event arrives.
    res.flushHeaders();

    // R1.1: optional read-only usage sniffer (verification-notes §30-37) —
    // only constructed when a consumer is listening, so the byte pipe stays
    // the plain two-stream case by default.
    const onResponseUsage = this.config.onResponseUsage;

    try {
      if (onResponseUsage !== undefined) {
        // Still a raw byte pipe end-to-end — the sniffer forwards every
        // chunk unmodified (see usage-sniffer.ts); it never parses/transforms
        // what reaches the client.
        const sniffer = new UsageSniffer(
          this.header(upstream.headers, "content-type"),
          this.header(upstream.headers, "content-encoding"),
        );
        await pipeline(upstream.body, sniffer, res);
        onResponseUsage(sniffer.usage, forward);
      } else {
        // Raw byte pipe — the streaming path is never parsed or transformed.
        await pipeline(upstream.body, res);
      }
    } catch {
      // Mid-stream failure (upstream died or client hung up): we cannot
      // change the status any more, so surface truncation to the client.
      res.destroy();
      upstream.body.destroy();
    }
  }

  private header(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | undefined {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  }

  private respondProxyError(
    res: ServerResponse,
    status: number,
    message?: string,
    body?: string,
  ): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const payload =
      body ??
      JSON.stringify({
        type: "error",
        error: { type: "api_error", message: message ?? "golem proxy: internal error" },
      });
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      [PROXY_ERROR_HEADER]: "true",
    });
    res.end(payload);
  }
}
