/**
 * WS-A A1 — proxy types and the request-pipeline extension seam.
 *
 * The proxy is a transparent Anthropic-API passthrough. The only place a
 * request may legally be transformed is the {@link RequestPipeline} hook,
 * which task A3 will implement as redaction -> compression -> forward.
 * At A1 the pipeline is the identity.
 *
 * Response bodies otherwise have NO seam by design: SSE streams and tool-use
 * blocks must pass through byte-faithful (CLAUDE.md hard rule), so the
 * response path is always a raw stream pipe. (Decision 25's local-first
 * `localResponse` exception was removed in Decision 31 — the local model is
 * invoked automatically only via the narrower R2.3 mechanism below, never as
 * a slider-triggered draft.)
 *
 * R2.3 (Decision 33) adds ONE additive, opt-in exception:
 * {@link ProxyRequest.respondDirectly}, set by the pipeline only when the
 * local-answer sub-mode is enabled, the request is eligible (single-turn,
 * plain-text), and a confident KB-composed answer was found. Deliberately a
 * new field/name — never confused with the removed `localResponse` seam.
 */

import type { Transform } from "node:stream";

/** Header that forces pure passthrough. Stripped before forwarding upstream. */
export const BYPASS_HEADER = "x-golem-bypass";

/**
 * The Anthropic Messages API `usage` block (R1.1 — net-of-cache measurement,
 * verification-notes §30-37). Sniffed read-only from the response bytes the
 * proxy is already forwarding; never used to alter what is sent to the
 * client (CLAUDE.md proxy-fidelity hard rule — response bodies have no
 * transform seam, only observation).
 */
export interface ResponseUsage {
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
}

/** Default upstream when none is configured. */
export const DEFAULT_UPSTREAM_BASE_URL = "https://api.anthropic.com";

/**
 * An in-flight client request, after hop-by-hop/bypass headers are removed
 * and the body (if any) has been buffered.
 *
 * `url` is the origin-form request target as received (path + query),
 * e.g. `/v1/messages?beta=true`. `headers` values follow Node semantics:
 * lowercased names; `set-cookie` is a string array.
 */
export interface ProxyRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[]>>;
  /** Raw request body bytes, or null when the request has no body. */
  readonly body: Buffer | null;
  /**
   * R2.3 (Decision 33): when set by the pipeline, the proxy serves this
   * response directly and skips the upstream call entirely. Additive and
   * opt-in only — absent for every request unless the local-answer sub-mode
   * is enabled, eligible, and confident. Never set by the identity pipeline.
   */
  readonly respondDirectly?: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Buffer;
  };
  /**
   * R9.2: the target this request was routed to, resolved BEFORE the pipeline
   * runs so the pipeline can see the decision. Follows the `respondDirectly`
   * precedent (Decision 33) rather than inventing a new seam.
   *
   * Absent when no {@link ProxyServerOptions.resolveRoute} is configured — the
   * single-upstream case, which behaves exactly as it did before this field
   * existed.
   */
  readonly route?: ProxyRoute;
}

/**
 * R9.2 — where one request goes, and everything the transport needs to send it
 * there. Assembled per request by {@link RouteResolver} from the R9.1 target
 * registry.
 *
 * The transport fields mirror the single-upstream `ProxyConfig` fields one for
 * one; when no resolver is configured the proxy reads them from `config` exactly
 * as before, so a route is strictly additive.
 */
export interface ProxyRoute {
  readonly targetId: string;
  /** Why this target was chosen — recorded in the audit log verbatim. */
  readonly reason: string;
  readonly baseUrl: string;
  /**
   * The model id to send upstream. Set when the request selected this target
   * with a virtual `golem/<id>` model, in which case the proxy MUST replace the
   * body's model field: no provider has a model called `golem/coder`.
   *
   * Undefined leaves the body untouched (the byte-faithful default).
   */
  readonly rewriteModel?: string;
  /**
   * R9.1 `trust` — the redaction floor for this route. Carried so the pipeline
   * can see it; consumed in R9.3. Redaction is never *weakened* by it.
   */
  readonly trust?: string;
  /**
   * Whether the semantic stage may assume a caching upstream for this route
   * (`upstreamAssumesCaching(provider)`). Per-route because it is a property of
   * the provider, not of the proxy.
   */
  readonly assumeCachingUpstream?: boolean;
  /** Per-route transport, mirroring the same-named {@link ProxyConfig} fields. */
  readonly mapUpstreamHeaders?: (
    headers: Record<string, string | string[]>,
  ) => Record<string, string | string[]>;
  readonly translateUpstream?: UpstreamTranslator;
}

/**
 * R9.2 — resolve one request to a target, or refuse it.
 *
 * **Fail-closed by construction:** the failure arm carries a status and a
 * message rather than a fallback route, because a proxy that quietly serves a
 * different target than the one named sends the caller's context somewhere they
 * did not choose. Claude Code will not catch an unknown `golem/*` id
 * (verification-notes §114 caveat 4), so Golem must produce the error itself.
 *
 * Synchronous and total: it reads already-loaded settings, never the network.
 */
export type RouteResolver = (
  request: ProxyRequest,
) =>
  | { readonly ok: true; readonly route: ProxyRoute }
  | { readonly ok: false; readonly status: number; readonly message: string };

/**
 * Extension seam for the A3 pipeline (redaction -> compression).
 *
 * Contract:
 * - Invoked only when the request does NOT carry `x-golem-bypass`;
 *   bypassed requests are forwarded untouched, unconditionally.
 * - May return a new {@link ProxyRequest}; `content-length` is recomputed
 *   by the proxy from the returned body, never by the pipeline.
 * - Must never reorder redaction after compression (CLAUDE.md hard rule).
 * - At slider level <= 1 the pipeline must be byte-preserving for
 *   streaming-relevant content; the recorded-shape integration tests
 *   enforce this.
 */
export interface RequestPipeline {
  readonly name: string;
  process(request: ProxyRequest): Promise<ProxyRequest>;
}

/** The A1 default: forwards every request byte-for-byte. */
export const identityPipeline: RequestPipeline = {
  name: "identity",
  process: (request) => Promise.resolve(request),
};

/** Constructor options for {@link GolemProxy}. All fields optional. */
export interface ProxyServerOptions {
  /**
   * R11.1 / ADR-0004 — start with the pipeline OFF: every request forwarded
   * byte-faithfully, redaction included in what is skipped. Set from
   * `proxy.bypass_all`, the explicit successor to slider level 0.
   *
   * Distinct from the in-process `golem on`/`golem off` toggle only in that this
   * one is a starting state read from settings, so it survives the restarts that
   * silently reset that toggle. Defaults to enabled — the bypass is never the
   * default (CLAUDE.md hard rule).
   */
  readonly pipelineEnabled?: boolean;
  /**
   * Upstream base URL. May include a path prefix (e.g. an LLM gateway at
   * `https://gw.example/anthropic`); the incoming request target is appended
   * to it verbatim. Default: {@link DEFAULT_UPSTREAM_BASE_URL}.
   */
  readonly upstreamBaseUrl?: string;
  /** TCP/TLS connect timeout to the upstream, ms. Default 10_000. */
  readonly connectTimeoutMs?: number;
  /** Time allowed for upstream response headers, ms. Default 300_000. */
  readonly headersTimeoutMs?: number;
  /**
   * Max idle time between upstream body chunks, ms. Default 300_000.
   * (Anthropic SSE streams emit `ping` events well within this.)
   */
  readonly bodyTimeoutMs?: number;
  /** Request pipeline hook. Default: {@link identityPipeline}. */
  readonly pipeline?: RequestPipeline;
  /**
   * Called when the pipeline throws and the proxy falls open to byte-faithful
   * passthrough (the request is forwarded UNCHANGED). Observability only —
   * it must not rethrow. Default: none.
   */
  readonly onPipelineError?: (err: unknown, request: ProxyRequest) => void;
  /**
   * Called once per response, after the body finished streaming to the
   * client, with any `usage` block sniffed from it (null if none was found —
   * malformed body, non-messages response, or the body exceeded the sniff
   * cap). Observability only: never affects what was forwarded, must not
   * rethrow. Default: none (sniffing is skipped entirely when absent).
   */
  readonly onResponseUsage?: (usage: ResponseUsage | null, request: ProxyRequest) => void;
  /**
   * Called (observe-only) with every upstream response's headers, before the
   * body is piped. Used for limit PREDICTION (snooze proposal P2a): the
   * `anthropic-ratelimit-unified-*` headers carry window utilization + reset.
   * Never affects the forwarded response, must not rethrow. Default: none
   * (skipped entirely when absent). Distinct from the removed `onUsageLimit`
   * (Decision 37) — this observes every response, and only for prediction.
   */
  readonly onResponseHeaders?: (
    headers: Readonly<Record<string, string | string[] | undefined>>,
    request: ProxyRequest,
  ) => void;
  /**
   * R6.1 case (a): rewrite the headers sent upstream (e.g. strip the client's
   * Anthropic credential and inject a different provider's key under its
   * expected header — see src/providers). Applied to the forwarded headers
   * immediately before the upstream request, OUTSIDE the pipeline, so it also
   * covers `x-golem-bypass` requests (the upstream still needs valid creds).
   * A transport/routing concern only — it never touches the body, so SSE and
   * tool-use fidelity is untouched. Default: none (the Anthropic passthrough
   * forwards the client's own auth verbatim).
   */
  readonly mapUpstreamHeaders?: (
    headers: Record<string, string | string[]>,
  ) => Record<string, string | string[]>;
  /**
   * R6.1 case (b) slice b1: front an OpenAI-schema upstream (OpenAI / Ollama)
   * by translating the request and response bodies, NON-STREAMING. When set,
   * the proxy POSTs the translated body to {@link UpstreamTranslator.path},
   * buffers the upstream response, and writes the translated Anthropic body —
   * the "response-transform seam". This is the ONLY code path that parses a
   * response body; it is opt-in and NEVER set for an Anthropic upstream, whose
   * response stays a raw byte pipe (byte-faithful hard rule). Default: none.
   */
  readonly translateUpstream?: UpstreamTranslator;
  /**
   * R9.2: resolve each request to a target from the R9.1 registry. **Optional —
   * when absent the proxy behaves exactly as it did before multi-target routing,
   * serving the single configured upstream.** The single-upstream fields above
   * remain the degenerate one-target case, which is what makes this an additive
   * change rather than a rewrite: every existing byte-fidelity and
   * recorded-shape test passes unmodified.
   */
  readonly resolveRoute?: RouteResolver;
}

/**
 * Translates between the Anthropic Messages protocol the client speaks and an
 * OpenAI-schema upstream (R6.1 case b). `translateRequest` reports whether the
 * request is streaming so the proxy picks the matching response path:
 * non-streaming → buffer + {@link translateResponse} (b1); streaming →
 * {@link createStreamTranslator} piped live (b2). The translate methods throw on
 * an untranslatable body; the proxy turns that into a clean proxy error rather
 * than forwarding a mismatched shape.
 */
export interface UpstreamTranslator {
  /**
   * Default upstream request path (relative to the base URL origin) — used when
   * {@link translateRequest} does not return a per-request `path`. OpenAI uses
   * this fixed path; Gemini overrides it per request (its path embeds the model,
   * the `:generateContent`/`:streamGenerateContent` method, `alt=sse`, and the
   * `?key=` query-param credential).
   */
  readonly path: string;
  /**
   * Anthropic request body → upstream request body bytes, plus whether the
   * client asked to stream (drives the response path below) and an optional
   * per-request `path` override (Gemini).
   */
  translateRequest(body: Buffer | null): {
    readonly body: Buffer;
    readonly stream: boolean;
    readonly path?: string;
  };
  /** Upstream (OpenAI) NON-streaming response body → Anthropic response body bytes (b1). */
  translateResponse(body: Buffer): Buffer;
  /**
   * R10.15 — answer `/v1/messages/count_tokens` locally, returning the Anthropic
   * `{"input_tokens": N}` body. An OpenAI-schema upstream has no such endpoint,
   * so there is nothing to forward: without this the request is translated into a
   * chat completion and answered with prose. Absent = the route is not handled
   * and the request forwards as before.
   */
  countTokens?(body: Buffer | null): Buffer;
  /**
   * A fresh stream transform: OpenAI SSE bytes in → Anthropic SSE bytes out (b2).
   * The proxy pipes `upstream.body` through this to the client. One per response.
   */
  createStreamTranslator(): Transform;
}

/** Fully-resolved proxy configuration. */
export interface ProxyConfig {
  readonly upstreamBaseUrl: string;
  readonly connectTimeoutMs: number;
  readonly headersTimeoutMs: number;
  readonly bodyTimeoutMs: number;
  readonly pipeline: RequestPipeline;
  readonly onPipelineError?: (err: unknown, request: ProxyRequest) => void;
  readonly onResponseUsage?: (usage: ResponseUsage | null, request: ProxyRequest) => void;
  readonly onResponseHeaders?: (
    headers: Readonly<Record<string, string | string[] | undefined>>,
    request: ProxyRequest,
  ) => void;
  readonly mapUpstreamHeaders?: (
    headers: Record<string, string | string[]>,
  ) => Record<string, string | string[]>;
  readonly translateUpstream?: UpstreamTranslator;
  readonly resolveRoute?: RouteResolver;
}

export function resolveProxyConfig(options: ProxyServerOptions = {}): ProxyConfig {
  return {
    upstreamBaseUrl: options.upstreamBaseUrl ?? DEFAULT_UPSTREAM_BASE_URL,
    connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
    headersTimeoutMs: options.headersTimeoutMs ?? 300_000,
    bodyTimeoutMs: options.bodyTimeoutMs ?? 300_000,
    pipeline: options.pipeline ?? identityPipeline,
    ...(options.onPipelineError !== undefined ? { onPipelineError: options.onPipelineError } : {}),
    ...(options.onResponseUsage !== undefined ? { onResponseUsage: options.onResponseUsage } : {}),
    ...(options.onResponseHeaders !== undefined
      ? { onResponseHeaders: options.onResponseHeaders }
      : {}),
    ...(options.mapUpstreamHeaders !== undefined
      ? { mapUpstreamHeaders: options.mapUpstreamHeaders }
      : {}),
    ...(options.translateUpstream !== undefined
      ? { translateUpstream: options.translateUpstream }
      : {}),
    ...(options.resolveRoute !== undefined ? { resolveRoute: options.resolveRoute } : {}),
  };
}
