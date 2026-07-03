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
      const bypass = isBypassRequest(req.headers);
      forward = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: forwardableRequestHeaders(req.headers),
        body,
      };
      if (!bypass) {
        // A3 seam: redaction -> compression. Identity at A1.
        forward = await this.config.pipeline.process(forward);
      }
    } catch (err) {
      this.respondProxyError(res, 500, `golem proxy: request pipeline failed (${String(err)})`);
      return;
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

    try {
      // Raw byte pipe — the streaming path is never parsed or transformed.
      await pipeline(upstream.body, res);
    } catch {
      // Mid-stream failure (upstream died or client hung up): we cannot
      // change the status any more, so surface truncation to the client.
      res.destroy();
      upstream.body.destroy();
    }
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
