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
}

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
  };
}
