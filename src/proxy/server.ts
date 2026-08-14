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
import { gunzipSync } from "node:zlib";
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

/**
 * R9.2: replace the body's `model` with the target's real model id, for a
 * request that selected its target with a virtual `golem/<id>` id.
 *
 * Returns `null` when the body is absent or is not JSON carrying a `model`
 * string — the caller then refuses the request rather than forwarding
 * `golem/coder` to a provider that has no such model and will 404 or, worse,
 * fuzzy-match it.
 *
 * This is the **only** place the proxy rewrites the request model, and it fires
 * only when the incoming value was a Golem selector — never a real model id — so
 * the byte-faithful guarantee for ordinary traffic is untouched.
 */
function rewriteBodyModel(body: Buffer | null, model: string): Buffer | null {
  if (body === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.model !== "string") return null;
  return Buffer.from(JSON.stringify({ ...record, model }), "utf8");
}

/**
 * Is this request the Anthropic `count_tokens` route (R10.15)? Matches on the
 * path suffix so a gateway base-path prefix does not defeat it, and ignores any
 * query string.
 */
function isCountTokensPath(url: string): boolean {
  const path = url.split("?")[0]?.replace(/\/+$/, "") ?? "";
  return path.endsWith("/v1/messages/count_tokens");
}

/**
 * R9.2: how many distinct upstream origins one proxy run will pool connections
 * for. Generous next to any real target registry, and present only so a bug (or
 * a config that generates origins) cannot grow the map without bound. Reaching
 * it does not fail the request — the origin is dialled with a throwaway pool.
 */
const MAX_POOLED_ORIGINS = 32;

export class GolemProxy {
  readonly config: ProxyConfig;

  /**
   * Toggle: when false, the proxy forwards every request as a raw passthrough
   * (identity pipeline, no redaction/compression/brevity). The toggle is
   * in-process — no process restart needed — so `golem off` is instant and
   * does not affect the URL wired into Claude Code. True by default after
   * construction; changed via {@link setPipelineEnabled} or on an admin
   * request to `/__golem/pipeline/<enabled>`.
   */
  #pipelineEnabled = true;

  setPipelineEnabled(enabled: boolean): void {
    this.#pipelineEnabled = enabled;
  }

  pipelineEnabled(): boolean {
    return this.#pipelineEnabled;
  }

  private readonly server: Server;
  /**
   * R9.2 — one `Pool` per upstream origin, created lazily and all closed in
   * `close()`. Per-origin pooling is what undici is designed for, so serving
   * several targets concurrently falls out of it; a single `Pool` bound to one
   * origin in the constructor was the entire structural blocker.
   *
   * The single-upstream case is unchanged in behaviour: it is simply a map with
   * one entry, created on the first request instead of in the constructor.
   */
  private readonly pools = new Map<string, Pool>();
  /** Upstream path prefix for the DEFAULT upstream (empty unless the base URL carries one). */
  private readonly basePath: string;

  constructor(options: ProxyServerOptions = {}) {
    this.config = resolveProxyConfig(options);
    const upstream = new URL(this.config.upstreamBaseUrl);
    this.basePath = upstream.pathname.replace(/\/+$/, "");
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  /** The pooled dispatcher for an origin, created on first use. */
  private poolFor(origin: string): Pool {
    const existing = this.pools.get(origin);
    if (existing !== undefined) return existing;
    const pool = new Pool(origin, {
      connect: { timeout: this.config.connectTimeoutMs },
      headersTimeout: this.config.headersTimeoutMs,
      bodyTimeout: this.config.bodyTimeoutMs,
    });
    // Past the cap the pool is still returned but not retained, so it is closed
    // by GC rather than tracked — a request must never fail because of a cap
    // that exists only to bound a pathological config.
    if (this.pools.size < MAX_POOLED_ORIGINS) this.pools.set(origin, pool);
    return pool;
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
    // Every origin dialled this run, not just the configured one.
    await Promise.all([...this.pools.values()].map((p) => p.close()));
    this.pools.clear();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // R9.23 — admin endpoint for the pipeline toggle (`golem on`/`golem off`).
    if (req.url === "/__golem/pipeline/true" && req.method === "POST") {
      this.#pipelineEnabled = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ pipeline_enabled: true }));
      return;
    }
    if (req.url === "/__golem/pipeline/false" && req.method === "POST") {
      this.#pipelineEnabled = false;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ pipeline_enabled: false }));
      return;
    }

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

    // R9.2: resolve the route BEFORE the pipeline, because the route decides two
    // pipeline inputs — the redaction floor (from the target's `trust`) and
    // whether the semantic stage may assume a caching upstream. Redaction still
    // runs first WITHIN the pipeline, so the hard rule is untouched.
    //
    // Fail-closed: an unknown target is an error, never a fallback to the
    // default. Applied before the bypass check as well — `x-golem-bypass` turns
    // off *processing*, and must not also turn a refused route into a silent
    // forward to somewhere the caller did not name.
    if (this.config.resolveRoute !== undefined) {
      const decision = this.config.resolveRoute(forward);
      if (!decision.ok) {
        this.respondProxyError(res, decision.status, decision.message);
        return;
      }
      forward = { ...forward, route: decision.route };
      // A virtual `golem/<id>` model selected the target; no provider has a
      // model by that name, so the body must carry the target's real one. This
      // is the ONLY case where the proxy rewrites the model field, and it only
      // ever replaces a string that was never a real model id.
      if (decision.route.rewriteModel !== undefined) {
        const rewritten = rewriteBodyModel(forward.body, decision.route.rewriteModel);
        if (rewritten === null) {
          this.respondProxyError(
            res,
            400,
            `golem proxy: request selected target "${decision.route.targetId}" with a virtual ` +
              "model id, but the body is not JSON with a model field, so there is nothing to " +
              "rewrite. No request was forwarded.",
          );
          return;
        }
        forward = { ...forward, body: rewritten };
      }
    }

    // A3 seam: redaction -> compression. FAIL-OPEN — a pipeline error must
    // never break the session: fall back to forwarding the ORIGINAL request
    // byte-faithfully (CLAUDE.md proxy-fidelity rule). Pipeline-disabled or
    // bypass-header skips it (both forward the body untouched).
    if (this.#pipelineEnabled && !isBypassRequest(req.headers)) {
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
    //
    // R9.2: read transport from the resolved ROUTE when there is one, falling
    // back to the single-upstream config otherwise. Byte-fidelity is a property
    // of the provider, not of the proxy — an Anthropic-protocol route stays a
    // raw byte pipe and a translating route was never byte-faithful (R6.1 case
    // b); per-route selection just states that per request instead of per run.
    const route = forward.route;
    const upstreamOrigin = route !== undefined ? new URL(route.baseUrl) : undefined;
    const mapHeaders =
      route !== undefined ? route.mapUpstreamHeaders : this.config.mapUpstreamHeaders;
    const upstreamHeaders = mapHeaders ? mapHeaders({ ...forward.headers }) : forward.headers;

    // R6.1 case (b) slice b1: translate the request body to the OpenAI schema
    // for a translating upstream (OpenAI / Ollama). The pipeline (redaction →
    // compression) has already run in Anthropic terms above, so translation is
    // the final step and never sees un-redacted content. A translation failure
    // is a clean proxy error, not a mismatched-shape forward.
    const translate = route !== undefined ? route.translateUpstream : this.config.translateUpstream;
    const basePath =
      upstreamOrigin !== undefined ? upstreamOrigin.pathname.replace(/\/+$/, "") : this.basePath;
    let requestPath = basePath + forward.url;
    let requestBody = forward.body;
    let requestHeaders = upstreamHeaders;
    let translateStreaming = false;
    // R10.15: `/v1/messages/count_tokens` has no OpenAI-schema equivalent, so a
    // translating upstream answers it here rather than forwarding it as a
    // completion. Never reached on the Anthropic passthrough, where the real
    // endpoint exists and the byte-faithful forward is correct.
    if (translate?.countTokens !== undefined && isCountTokensPath(forward.url)) {
      let counted: Buffer;
      try {
        counted = translate.countTokens(forward.body);
      } catch (err) {
        this.respondProxyError(
          res,
          400,
          `golem proxy: could not count tokens for this request (${String(err)})`,
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(counted);
      return;
    }
    if (translate !== undefined) {
      let translated: { body: Buffer; stream: boolean; path?: string };
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
      requestPath = translated.path ?? translate.path;
      requestHeaders = { ...upstreamHeaders, "content-type": "application/json" };
    }

    let upstream: Dispatcher.ResponseData;
    try {
      upstream = await this.poolFor(
        upstreamOrigin?.origin ?? new URL(this.config.upstreamBaseUrl).origin,
      ).request({
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
      // Observe-only header hook (served-model + limit prediction) — the
      // translating branch returns before the byte-faithful hook below, so fire
      // it here too. Header-only; never touches the body pipe (fidelity preserved).
      const onResponseHeaders = this.config.onResponseHeaders;
      if (onResponseHeaders !== undefined) {
        try {
          onResponseHeaders(upstream.headers, forward);
        } catch {
          // observe-only — a hook error can never affect the forwarded response
        }
      }
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
        // The Anthropic passthrough relays bytes verbatim, but the translating
        // path must PARSE the body — so decode gzip first (undici doesn't
        // auto-decompress; some OpenAI-schema upstreams, e.g. Moonshot, gzip).
        const enc = this.header(upstream.headers, "content-encoding");
        if (enc?.toLowerCase().includes("gzip")) {
          raw = gunzipSync(raw);
        }
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
