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

/**
 * Buffer the whole request body. Deliberately uncapped: the proxy binds
 * loopback-only and serves the local developer's own Claude Code traffic
 * (bounded JSON documents), so a size limit would only add a failure mode.
 * Revisit if the proxy ever binds a non-loopback interface.
 */
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

    // R2.3 (Decision 33): the pipeline may have resolved a confident,
    // KB-composed answer for an eligible single-turn request. When it did,
    // serve it directly and skip the upstream call entirely.
    if (forward.respondDirectly !== undefined) {
      const direct = forward.respondDirectly;
      res.writeHead(direct.status, direct.headers);
      res.end(direct.body);
      return;
    }

    // R6.1 case (a): map auth/headers for a non-Anthropic Anthropic-protocol
    // upstream (strip the client's Anthropic credential, inject the configured
    // provider's). Transport-only, never touches the body — SSE/tool-use
    // fidelity is untouched. Default (Anthropic passthrough) has no mapper, so
    // this is literally a no-op there. Applied outside the pipeline so bypass
    // requests still reach the configured upstream with valid credentials.
    const upstreamHeaders = this.config.mapUpstreamHeaders
      ? this.config.mapUpstreamHeaders({ ...forward.headers })
      : forward.headers;

    // R6.1 case (b) slice b1: translate the request body to the OpenAI schema
    // for a translating upstream (OpenAI / Ollama). The pipeline (redaction →
    // compression) has already run in Anthropic terms above, so translation is
    // the final step and never sees un-redacted content. A translation failure
    // is a clean proxy error, not a mismatched-shape forward.
    const translate = this.config.translateUpstream;
    let requestPath = this.basePath + forward.url;
    let requestBody = forward.body;
    let requestHeaders = upstreamHeaders;
    let translateStreaming = false;
    if (translate !== undefined) {
      let translated: { body: Buffer; stream: boolean };
      try {
        translated = translate.translateRequest(forward.body);
      } catch (err) {
        this.respondProxyError(
          res,
          400,
          `golem proxy: could not translate request to the upstream schema (${String(err)})`,
        );
        return;
      }
      requestBody = translated.body;
      translateStreaming = translated.stream;
      requestPath = translate.path;
      requestHeaders = { ...upstreamHeaders, "content-type": "application/json" };
    }

    let upstream: Dispatcher.ResponseData;
    try {
      upstream = await this.pool.request({
        path: requestPath,
        method: forward.method as Dispatcher.HttpMethod,
        headers: requestHeaders,
        body: requestBody,
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

    // Translating upstream (R6.1 case b): convert the response to the Anthropic
    // shape. This is the ONLY path that parses/reserializes a response body — the
    // Anthropic passthrough below stays a raw byte pipe. An upstream error is
    // surfaced unchanged in either mode.
    if (translate !== undefined) {
      if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        let raw: Buffer;
        try {
          raw = Buffer.from(await upstream.body.arrayBuffer());
        } catch {
          res.destroy();
          return;
        }
        res.writeHead(upstream.statusCode, forwardableResponseHeaders(upstream.headers));
        res.end(raw);
        return;
      }

      if (translateStreaming) {
        // b2: pipe the OpenAI SSE stream through the translator to the client
        // live, so tokens arrive incrementally. Never buffered.
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.flushHeaders();
        try {
          await pipeline(upstream.body, translate.createStreamTranslator(), res);
        } catch {
          res.destroy();
          upstream.body.destroy();
        }
        return;
      }

      // b1: non-streaming — buffer, translate, write the Anthropic JSON body.
      let raw: Buffer;
      try {
        raw = Buffer.from(await upstream.body.arrayBuffer());
      } catch {
        res.destroy();
        return;
      }
      let translated: Buffer;
      try {
        translated = translate.translateResponse(raw);
      } catch (err) {
        this.respondProxyError(
          res,
          502,
          `golem proxy: could not translate the upstream response (${String(err)})`,
        );
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(translated),
      });
      res.end(translated);
      return;
    }

    res.writeHead(upstream.statusCode, forwardableResponseHeaders(upstream.headers));
    // Push headers immediately so SSE clients see the response open
    // before the first event arrives.
    res.flushHeaders();

    // Limit prediction (snooze P2a): observe the upstream rate-limit headers.
    // Header-only, never touches the body pipe below — fidelity preserved.
    // Fire-and-forget; must never throw or delay the response.
    const onResponseHeaders = this.config.onResponseHeaders;
    if (onResponseHeaders !== undefined) {
      try {
        onResponseHeaders(upstream.headers, forward);
      } catch {
        // observe-only — a prediction error can never affect the forwarded response
      }
    }

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
