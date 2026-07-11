/**
 * WS-A A3 — the request pipeline: redaction → compression → forward.
 *
 * Implements the proxy's {@link RequestPipeline} seam (src/proxy/types.ts).
 * The proxy invokes `process()` ONLY for non-bypassed requests, so bypass is
 * not handled here. Stage order is a CLAUDE.md hard rule: **redaction runs
 * first**, before any content is transformed, stored, or forwarded; then the
 * lossless compression stage (A2) runs per the resolved SliderPolicy.
 *
 * Byte-faithfulness (CLAUDE.md): the pipeline only rewrites the body of
 * `POST /v1/messages` requests carrying a JSON body. Anything else — other
 * paths, non-JSON bodies, or a request where no stage changed anything —
 * is returned unchanged (same object, original bytes), so streaming and
 * tool-use traffic and secret-free level-0 requests stay byte-identical.
 *
 * Prefix stability (verification-notes §14): at levels ≤1, redaction is a pure
 * function of the text and the lossless compression stage is deterministic per
 * A2's contract, so re-processing a previously-sent prefix reproduces identical
 * bytes and Anthropic prompt-cache hits survive. The OPTIONAL semantic stage
 * (slider ≥2, {@link SemanticCompressor}) is lossy and NOT prefix-stable, so it
 * is gated OFF on Anthropic-style caching upstreams (Decision 31) and only runs
 * against non-caching gateways; it always fails open (a null result leaves the
 * losslessly-compressed body untouched).
 */

import { estimateTokens } from "../compression/index.js";
import type { SemanticCompressor } from "../compression/semantic.js";
import type { CompressionService, TokenDelta } from "../interfaces/compression.js";
import type { SliderPolicy } from "../interfaces/policy.js";
import type { ProxyRequest, RequestPipeline } from "../proxy/types.js";
import { redactRequestBody } from "./redaction.js";

/**
 * Whether an upstream is known to do Anthropic-style prompt caching (byte-
 * identical-prefix). Semantic compression rewrites/drops mid-history content,
 * which changes the cached prefix and turns a 0.1× cache read into a 1.0× miss
 * on the whole suffix — net-negative on such upstreams (verification-notes
 * §14/§32/§34). So the lossy semantic stage is gated OFF on caching upstreams
 * (Decision 31); it engages only on non-caching gateways (e.g. some Foundry /
 * OpenRouter deployments) where resent history is re-billed at full price.
 */
function isCachingUpstream(upstreamBaseUrl: string | undefined): boolean {
  if (upstreamBaseUrl === undefined) return true; // default upstream is Anthropic — assume caching
  try {
    return new URL(upstreamBaseUrl).host.toLowerCase().includes("anthropic.com");
  } catch {
    return true; // unparseable → be conservative (assume caching, skip lossy compression)
  }
}

/** A telemetry record emitted once per processed request (A4 consumes it). */
export interface PipelineEvent {
  readonly projectId: string;
  readonly level: number;
  /** Whole-request before/after — the honest headline savings for this request. */
  readonly requestTokens: TokenDelta;
  /** Per-stage deltas (breakdown only; mixed scopes — do not sum). */
  readonly stageSavings: Readonly<Record<string, TokenDelta>>;
  readonly ccrRefsStored: number;
}

export interface GolemPipelineOptions {
  readonly compression: CompressionService;
  /**
   * Resolve the active policy per request (e.g. from live settings). May
   * return a promise so callers can re-read a persisted slider level on
   * every request instead of freezing it at construction time.
   */
  readonly policy: () => SliderPolicy | Promise<SliderPolicy>;
  /** Logical project id for compression stats/telemetry attribution. */
  readonly projectId: string;
  /** Optional sink for per-request telemetry; defaults to a no-op. */
  readonly onEvent?: (event: PipelineEvent) => void;
  /**
   * OPTIONAL semantic compressor (slider ≥3). When present and the policy's
   * `semanticCompression` is not "off", it runs after lossless compression.
   * It is lossy and fails open — a null result skips the stage. Provided by the
   * Headroom sidecar (headroom-adapter.ts); absent by default.
   */
  readonly semantic?: SemanticCompressor;
  /**
   * Upstream base URL, used ONLY to decide whether the lossy semantic stage may
   * run: it is gated OFF on Anthropic-style caching upstreams (Decision 31, see
   * {@link isCachingUpstream}). Absent → treated as the caching default.
   */
  readonly upstreamBaseUrl?: string;
  /**
   * OPT-IN research flag (R2.6, verification-notes §58/§59): bypass the
   * {@link isCachingUpstream} gate for the semantic stage specifically, so it
   * can be A/B'd on Anthropic instead of assumed net-negative. Does not
   * change what the stage does — only whether it runs there. Off by default;
   * the caller (proxy-runtime) also tags every usage sample recorded while
   * this is on, so `aggregateUsageBySemanticForced` can compare gate-on vs
   * gate-off billed cache-read totals.
   */
  readonly forceSemanticOnCaching?: boolean;
}

// Match the Anthropic Messages endpoint as the tail of the path — NOT anchored
// at the start — so provider-prefixed gateways work too: Anthropic
// `/v1/messages`, and Azure Foundry / OpenRouter-style `/anthropic/v1/messages`
// (Decision 22). End-anchored so it excludes sub-resources like
// `/v1/messages/batches` (different body shape). Query string allowed.
const MESSAGES_PATH_RE = /\/(?:v1\/)?messages(?:\?.*)?$/;

function isMessagesRequest(request: ProxyRequest): boolean {
  return request.method.toUpperCase() === "POST" && MESSAGES_PATH_RE.test(request.url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build the Golem request pipeline. The returned object is the value passed as
 * `pipeline` to {@link GolemProxy}; the proxy recomputes content-length from
 * the returned body.
 */
export function createGolemPipeline(options: GolemPipelineOptions): RequestPipeline {
  const emit = options.onEvent ?? ((): void => {});

  return {
    name: "golem",
    async process(request: ProxyRequest): Promise<ProxyRequest> {
      if (request.body === null || !isMessagesRequest(request)) {
        return request;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(request.body.toString("utf8"));
      } catch {
        // Not JSON we can safely rewrite — forward untouched.
        return request;
      }
      if (!isRecord(parsed)) {
        return request;
      }

      const policy = await options.policy();
      const stages = policy.stages;
      const stageSavings: Record<string, TokenDelta> = {};
      let body: Record<string, unknown> = parsed;
      let changed = false;
      let ccrRefsStored = 0;

      // Stage 1 — redaction (always first; runs at every level per the table).
      if (stages.redaction) {
        const redacted = redactRequestBody(body);
        stageSavings.redaction = redacted.delta;
        if (redacted.count > 0 && isRecord(redacted.value)) {
          body = redacted.value;
          changed = true;
        }
      }

      // Stage 2 — lossless compression (level >= 1).
      if (stages.losslessCompression && Array.isArray(body.messages)) {
        const messagesIn = body.messages as ReadonlyArray<Readonly<Record<string, unknown>>>;
        const result = await options.compression.compress(messagesIn, policy, options.projectId);
        for (const [stage, delta] of Object.entries(result.stageSavings)) {
          stageSavings[stage] = delta;
        }
        ccrRefsStored = result.refs.length;
        // Only mark the request changed when a message actually changed
        // (transforms return the same reference for untouched messages) —
        // otherwise a compression no-op would still re-serialize the body and
        // break the "no stage changed anything → original bytes" guarantee.
        const compressed =
          result.messagesOut.length !== messagesIn.length ||
          result.messagesOut.some((message, i) => message !== messagesIn[i]);
        if (compressed) {
          body = { ...body, messages: [...result.messagesOut] };
          changed = true;
        }
      }

      // Stage 3 — semantic compression (level ≥2, optional, lossy, fail-open).
      // Runs on the already-losslessly-compressed messages. GATED OFF on
      // Anthropic-style caching upstreams (Decision 31): rewriting mid-history
      // content breaks the byte-identical cached prefix, so it engages only on
      // non-caching gateways. Any failure resolves null and leaves the body
      // as-is, preserving the level-≤1 guarantees. `forceSemanticOnCaching`
      // (R2.6) bypasses this specific gate, opt-in, for A/B measurement —
      // see the option's doc comment.
      if (
        stages.semanticCompression !== "off" &&
        options.semantic !== undefined &&
        (!isCachingUpstream(options.upstreamBaseUrl) || options.forceSemanticOnCaching === true) &&
        Array.isArray(body.messages)
      ) {
        const semantic = await options.semantic.compress(
          body.messages as ReadonlyArray<Readonly<Record<string, unknown>>>,
          stages.semanticCompression,
        );
        if (semantic !== null) {
          body = { ...body, messages: [...semantic.messages] };
          stageSavings.semantic = {
            tokensBefore: semantic.tokensBefore,
            tokensAfter: semantic.tokensAfter,
          };
          changed = true;
        }
      }

      if (!changed) {
        // Nothing to do — preserve original bytes exactly.
        return request;
      }

      const finalJson = JSON.stringify(body);
      // Honest end-to-end savings: the WHOLE original body vs the WHOLE final
      // body — the only apples-to-apples number. Per-stage deltas below are a
      // breakdown and measure different scopes (redaction=whole body, dedup=the
      // deduped span, compaction=the messages array), so they must NOT be
      // stitched into a request total (verification-notes §25/§30).
      const requestTokens: TokenDelta = {
        tokensBefore: estimateTokens(JSON.stringify(parsed)),
        tokensAfter: estimateTokens(finalJson),
      };

      emit({
        projectId: options.projectId,
        level: policy.level,
        requestTokens,
        stageSavings,
        ccrRefsStored,
      });
      return { ...request, body: Buffer.from(finalJson, "utf8") };
    },
  };
}
