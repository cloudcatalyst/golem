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

import type { CcrStore } from "../compression/ccr-store.js";
import type { KnownContentLookup } from "../compression/context-substitution.js";
import {
  backfillHeadroomCcrRefs,
  estimateTokens,
  substituteKnownContent,
} from "../compression/index.js";
import type { SemanticCompressor } from "../compression/semantic.js";
import type { CompressionService, TokenDelta } from "../interfaces/compression.js";
import type { LocalAnswerService } from "../interfaces/local-answer.js";
import type { BrevityLevel, SliderPolicy } from "../interfaces/policy.js";
import {
  type CacheBustComponent,
  CachePrefixObserver,
  type CachePrefixVerdict,
} from "../proxy/cache-prefix.js";
import { buildContextLedger, type ContextLedgerCore } from "../proxy/context-ledger.js";
import type { ProxyRequest, RequestPipeline } from "../proxy/types.js";
import { applyBrevity } from "./brevity.js";
import { eligibleLocalAnswerText, synthesizeLocalAnswerResponse } from "./local-answer-response.js";
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

/**
 * Effective caching decision for the lossy-stage gate: an explicit
 * {@link GolemPipelineOptions.assumeCachingUpstream} (set from the selected
 * provider, R6.1 case (a)) wins; otherwise fall back to the URL heuristic.
 */
function effectiveCaching(options: GolemPipelineOptions): boolean {
  return options.assumeCachingUpstream ?? isCachingUpstream(options.upstreamBaseUrl);
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
  /**
   * R2.2 (spec Decision 24 sub-mode 1): input tokens avoided this request by
   * context substitution — content elided because it was already recognized
   * from the project's web-cache, not because it repeated within THIS
   * request (that's `stageSavings.dedup`). 0 when the stage didn't run or
   * found nothing. Also reflected in `stageSavings.contextSubstitution` and
   * the whole-request `requestTokens` delta; this field exists so the
   * `avoidedUpstream` telemetry bucket can track it as its own metric
   * (verification-notes §59's finding: the gross headline mixes stages).
   */
  readonly avoidedUpstreamInputTokens: number;
  /**
   * R2.3 (spec Decision 24 sub-mode 2 / Decision 33): output tokens avoided
   * this request because the local-answer sub-mode served a KB-composed
   * answer directly and the request never went upstream at all. 0 whenever
   * that didn't happen.
   */
  readonly avoidedUpstreamOutputTokens: number;
  /**
   * Decision 52: the brevity level in force for this request, so usage samples
   * can be bucketed by it (`aggregateUsageByBrevity`). "off" when the dial is
   * off — which is the shipped default until the rollup proves the dial pays.
   */
  readonly brevity: BrevityLevel;
  /**
   * Decision 52: estimated input tokens the brevity directive ADDED to this
   * request. Recorded so the saving can never be reported without its cost —
   * the vendor's own README warns brevity can go net-negative on terse
   * workloads (verification-notes §87). 0 when nothing was injected.
   */
  readonly brevityDirectiveTokens: number;
  /**
   * R8.1: how this request's cacheable prefix relates to the previous request of
   * the same conversation — `first`, `append` (cache should hit), or `bust` (an
   * earlier byte changed, so the prefix was re-prefilled at full input rates).
   *
   * A **prediction from the bytes Golem forwarded**, deliberately kept separate
   * from the billed `cache_read_input_tokens` / `cache_creation_input_tokens` the
   * usage sniffer records. This field explains *why*; those numbers say *whether*.
   * Absent on the local-answer short-circuit (nothing goes upstream) and on events
   * written before this field existed.
   */
  readonly cachePrefix?: CachePrefixVerdict;
  /** R8.1: which component broke the prefix. Set only when `cachePrefix === "bust"`. */
  readonly cacheBustComponent?: CacheBustComponent;
  /**
   * R8.4: token attribution for the outgoing request — which buckets, which
   * biggest blocks, which tools produced the `tool_result` bulk. Carried on the
   * event so the CLI layer owns the (latest-only) file write, keeping file I/O out
   * of the pipeline. Never persisted per-request into telemetry: only the most
   * recent ledger is useful, and the per-request history is already covered by the
   * savings and usage events.
   */
  readonly contextLedger?: ContextLedgerCore;
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
   * R6.1 case (a): explicit override of the {@link isCachingUpstream} URL
   * heuristic. Set by proxy-runtime from the selected `upstream_provider`
   * (verification-notes §73): a non-Anthropic Anthropic-protocol gateway
   * (Azure Foundry / OpenRouter serving Claude) is prompt-cache-capable but
   * has a non-`anthropic.com` host the URL heuristic would misclassify as
   * non-caching — so it is set `true` here (fail-safe: no lossy semantic
   * rewrite, byte-faithful). `undefined` → fall back to the URL heuristic
   * (the Anthropic default and custom `api.anthropic.com`-style URLs).
   */
  readonly assumeCachingUpstream?: boolean;
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
  /**
   * R2.4 (verification-notes §38): Golem's own CCR store, rooted at the same
   * `.golem/ccr` directory `options.compression` writes to, so `expand` can
   * recover content the semantic stage elides. Headroom's `read_lifecycle`
   * transform substitutes stale/superseded Read tool-results with an inline
   * `hash=<hex>` marker (the same grammar `ccrMarker()` mirrors) pointing at
   * a hash Headroom's own in-process store never shares with Golem. When
   * this is present, the pipeline verifies each such marker's hash is
   * actually derived from the content it replaced and backfills the
   * original here, so the marker Headroom already emits resolves through
   * the existing `expand` path unchanged. Absent → no backfill (today's
   * behavior; the gap verification-notes §38 documents).
   */
  readonly headroomCcrStore?: CcrStore;
  /**
   * R2.2 (spec Decision 24 sub-mode 1, verification-notes §62): when present,
   * a stage runs after semantic compression that substitutes any span whose
   * content `lookup` recognizes (e.g. a page already in the project's
   * web-cache) with a compact reference, persisting the original into
   * `ccrStore` so `expand` can recover it. Gated IDENTICALLY to the semantic
   * stage — `stages.semanticCompression !== "off"` AND non-caching upstream
   * — independent of whether a Headroom sidecar (`semantic`) is configured.
   * `lookup` is a thunk rather than a fixed value so the caller can rebuild
   * it fresh per request as the web-cache grows (see
   * context-substitution.ts's module doc for why that's required, not just
   * convenient). Absent → stage does not run (today's behavior).
   */
  readonly contextSubstitution?: {
    readonly ccrStore: CcrStore;
    readonly lookup: () => KnownContentLookup | Promise<KnownContentLookup>;
    /** Overrides DEFAULT_MIN_SUBSTITUTION_CHARS (affects emitted bytes). */
    readonly minChars?: number;
  };
  /**
   * R2.3 (spec Decision 24 sub-mode 2 / Decision 33): OPT-IN local-answer
   * sub-mode. When present, runs right after redaction (stage 1) and before
   * any compression stage — only for requests {@link eligibleLocalAnswerText}
   * accepts (single-turn, plain-text user message). A confident result
   * short-circuits the whole request: `respondDirectly` is set on the
   * returned {@link ProxyRequest} and every later stage is skipped, since
   * there is no upstream call left to compress for. Independent of
   * `slider.level` (Decision 31) and of the caching-upstream gate that
   * governs the semantic/context-substitution stages — this stage never
   * forwards a byte upstream, so there is no cached prefix to preserve or
   * break. Absent → stage does not run (today's behavior).
   */
  readonly localAnswer?: {
    readonly service: LocalAnswerService;
  };
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
  // R8.1 — one observer per pipeline instance (i.e. per proxy process), because
  // cache-bust detection is inherently a comparison against the previous request
  // of the same conversation. Bounded internally.
  const cacheObserver = new CachePrefixObserver();

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
      let avoidedUpstreamInputTokens = 0;
      let brevityDirectiveTokens = 0;

      // Stage 1 — redaction (always first; runs at every level per the table).
      if (stages.redaction) {
        const redacted = redactRequestBody(body);
        stageSavings.redaction = redacted.delta;
        if (redacted.count > 0 && isRecord(redacted.value)) {
          body = redacted.value;
          changed = true;
        }
      }

      // Stage 1.5 — local-answer sub-mode (R2.3, opt-in, independent of
      // slider level). Runs on the already-redacted body — the redaction
      // hard rule applies here same as anywhere else. Only attempted for
      // requests eligibleLocalAnswerText() accepts; a confident result
      // short-circuits the whole request, so no compression stage below has
      // anything left to do.
      if (options.localAnswer !== undefined) {
        const queryText = eligibleLocalAnswerText(body);
        if (queryText !== undefined) {
          try {
            const result = await options.localAnswer.service.tryAnswer({
              text: queryText,
              projectId: options.projectId,
            });
            if (result.answered) {
              const stream = body.stream === true;
              const respondDirectly = synthesizeLocalAnswerResponse(queryText, result.text, stream);
              const originalJson = JSON.stringify(parsed);
              emit({
                projectId: options.projectId,
                level: policy.level,
                requestTokens: { tokensBefore: estimateTokens(originalJson), tokensAfter: 0 },
                // Redaction (stage 1) already ran and recorded its delta —
                // keep it in the event rather than dropping it on this path.
                stageSavings,
                ccrRefsStored: 0,
                avoidedUpstreamInputTokens: estimateTokens(originalJson),
                avoidedUpstreamOutputTokens: estimateTokens(result.text),
                // The request never went upstream, so no directive was injected
                // and there is no output for brevity to have shortened. Record
                // "off" rather than the resolved level, so brevity rollups are
                // not polluted by requests brevity could not have affected.
                brevity: "off",
                brevityDirectiveTokens: 0,
              });
              return { ...request, respondDirectly };
            }
          } catch (err) {
            // Fail-open, mirroring the semantic stage below: a retrieval or
            // embedder failure (e.g. the configured semantic embed model isn't
            // installed) must never error a live request — fall through to the
            // normal upstream path exactly as if the KB had declined to answer.
            // Verified need: verification-notes §64 (Decision 33 review).
            process.stderr.write(
              `golem: local-answer stage failed, falling through to upstream (${
                err instanceof Error ? err.message : String(err)
              })\n`,
            );
          }
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
        (!effectiveCaching(options) || options.forceSemanticOnCaching === true) &&
        Array.isArray(body.messages)
      ) {
        const messagesInSemantic = body.messages as ReadonlyArray<
          Readonly<Record<string, unknown>>
        >;
        const semantic = await options.semantic.compress(
          messagesInSemantic,
          stages.semanticCompression,
        );
        if (semantic !== null) {
          if (options.headroomCcrStore !== undefined) {
            ccrRefsStored += await backfillHeadroomCcrRefs(
              options.headroomCcrStore,
              messagesInSemantic,
              semantic.messages,
            );
          }
          body = { ...body, messages: [...semantic.messages] };
          stageSavings.semantic = {
            tokensBefore: semantic.tokensBefore,
            tokensAfter: semantic.tokensAfter,
          };
          changed = true;
        }
      }

      // Stage 4 — context substitution (R2.2, spec Decision 24 sub-mode 1,
      // verification-notes §62). Runs on the already-semantically-compressed
      // messages. Gated IDENTICALLY to the semantic stage's non-caching-
      // upstream rule (see context-substitution.ts's module doc for why) —
      // but independent of whether a Headroom sidecar is configured.
      if (
        stages.semanticCompression !== "off" &&
        options.contextSubstitution !== undefined &&
        !effectiveCaching(options) &&
        Array.isArray(body.messages)
      ) {
        const messagesInSub = body.messages as ReadonlyArray<Readonly<Record<string, unknown>>>;
        const lookup = await options.contextSubstitution.lookup();
        const substituted = await substituteKnownContent(
          messagesInSub,
          lookup,
          options.contextSubstitution.ccrStore,
          options.contextSubstitution.minChars,
        );
        if (substituted.substitutions > 0) {
          body = { ...body, messages: [...substituted.messages] };
          stageSavings.contextSubstitution = {
            tokensBefore: substituted.tokensBefore,
            tokensAfter: substituted.tokensAfter,
          };
          avoidedUpstreamInputTokens = substituted.tokensBefore - substituted.tokensAfter;
          ccrRefsStored += substituted.substitutions;
          changed = true;
        }
      }

      // Stage 5 — brevity (Decision 52). Output-side: appends a fixed directive
      // to `system` so the model answers more tersely. Deliberately NOT gated on
      // the caching-upstream rule that governs stages 3–4: this stage does not
      // rewrite history, it appends a byte-stable constant, so the cached prefix
      // survives (it is invalidated once when the LEVEL changes, then stable).
      // `policy.brevity` is already resolved — "off" at slider 0 and, by
      // default, at every level until the operator opts in (see policy.ts).
      if (policy.brevity !== "off") {
        const brevity = applyBrevity(body, policy.brevity);
        if (brevity.injected) {
          body = brevity.body;
          brevityDirectiveTokens = brevity.directiveTokens;
          changed = true;
        }
      }

      // R8.1 — classify the cacheable prefix of the bytes we are about to forward.
      //
      // Done BEFORE the `!changed` early return so the per-conversation chain stays
      // complete: skipping a request would leave a stale baseline and mis-time the
      // next verdict. On the unchanged path the observation is computed and
      // discarded (no event is emitted there), which costs three hashes and keeps
      // the chain warm. A bust that lands on an unchanged request is therefore
      // reported one request late rather than lost.
      //
      // Never allowed to affect the request: pure, and the observer cannot throw.
      const cacheObservation = cacheObserver.observe(body);

      // R8.4 — attribute the outgoing request's tokens. Pure and content-free;
      // the CLI layer decides whether to persist it.
      const contextLedger = buildContextLedger(body);

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
        avoidedUpstreamInputTokens,
        avoidedUpstreamOutputTokens: 0,
        brevity: brevityDirectiveTokens > 0 ? policy.brevity : "off",
        brevityDirectiveTokens,
        cachePrefix: cacheObservation.verdict,
        contextLedger,
        ...(cacheObservation.component !== undefined && {
          cacheBustComponent: cacheObservation.component,
        }),
      });
      return { ...request, body: Buffer.from(finalJson, "utf8") };
    },
  };
}
