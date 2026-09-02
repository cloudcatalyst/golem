/**
 * WS-A A3 — the request pipeline: redaction → compression → forward.
 *
 * Implements the proxy's {@link RequestPipeline} seam (src/proxy/types.ts).
 * The proxy invokes `process()` ONLY for non-bypassed requests, so bypass is
 * not handled here. Stage order is a CLAUDE.md hard rule: **redaction runs
 * first**, before any content is transformed, stored, or forwarded; then the
 * lossless compression stage (A2) runs per the resolved PipelinePolicy.
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
import { isCachingUpstream } from "../compression/effective-level.js";
import {
  backfillHeadroomCcrRefs,
  estimateTokens,
  substituteKnownContent,
} from "../compression/index.js";
import type { SemanticCompressor } from "../compression/semantic.js";
import type { CompressionService, TokenDelta } from "../interfaces/compression.js";
import type { JoinQueue, JoinQueueMessage } from "../interfaces/join-queue.js";
import type { LocalAnswerService } from "../interfaces/local-answer.js";
import { type BrevityLevel, compressionRank, type PipelinePolicy } from "../interfaces/policy.js";
import type { PluginPipelineStage } from "../plugins/types.js";
import {
  type CacheBustComponent,
  CachePrefixObserver,
  type CachePrefixVerdict,
  conversationKeyOf,
} from "../proxy/cache-prefix.js";
import { buildContextLedger, type ContextLedgerCore } from "../proxy/context-ledger.js";
import type { ProxyRequest, RequestPipeline } from "../proxy/types.js";
import { isRecord } from "../shared/json.js";
import { proxyLog } from "../shared/proxy-log.js";
import { applyBrevity } from "./brevity.js";
import { applyJoinMessages, canInject } from "./join-injection.js";
import { eligibleLocalAnswerText, synthesizeLocalAnswerResponse } from "./local-answer-response.js";
import { redactRequestBody } from "./redaction.js";

/**
 * Whether an upstream is known to do Anthropic-style prompt caching (byte-
 * identical-prefix). Semantic compression rewrites/drops mid-history content,
 * which changes the cached prefix and turns a 0.1× cache read into a 1.0× miss
 * on the whole suffix — net-negative on such upstreams (verification-notes
 * §14/§32/§34, and §103 for the measured 8.7×–11.3× penalty). So the lossy
 * semantic stage is gated OFF on caching upstreams (Decision 31); it engages
 * only on non-caching gateways (e.g. some Foundry / OpenRouter deployments)
 * where resent history is re-billed at full price.
 *
 * The definition now lives in `compression/effective-level.ts` so `golem status`
 * can predict this gate rather than reporting a level the pipeline will not
 * apply. This file is still the ENFORCEMENT point — see that module's header.
 */

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
   * R8.13: where in `messages` the bust landed, and out of how many. The pair is
   * what makes a bust interpretable — §99 recorded 142 busts against a billed
   * 98.4% hit rate precisely because "an earlier byte changed" was recorded
   * without ever saying *how much earlier*.
   */
  readonly cacheBustMessageIndex?: number;
  readonly cacheMessageCount?: number;
  /**
   * R8.4: token attribution for the outgoing request — which buckets, which
   * biggest blocks, which tools produced the `tool_result` bulk. Carried on the
   * event so the CLI layer owns the (latest-only) file write, keeping file I/O out
   * of the pipeline. Never persisted per-request into telemetry: only the most
   * recent ledger is useful, and the per-request history is already covered by the
   * savings and usage events.
   */
  readonly contextLedger?: ContextLedgerCore;
  /**
   * R13.7: how many messages authored on a paired device this request carried
   * (ADR-0007 section 3b). Absent or 0 on every request that carried none, which
   * is every request until the user turns injection on.
   */
  readonly remoteMessagesInjected?: number;
}

export interface GolemPipelineOptions {
  readonly compression: CompressionService;
  /**
   * Resolve the active policy per request (e.g. from live settings). May
   * return a promise so callers can re-read a persisted slider level on
   * every request instead of freezing it at construction time.
   */
  readonly policy: () => PipelinePolicy | Promise<PipelinePolicy>;
  /** Logical project id for compression stats/telemetry attribution. */
  readonly projectId: string;
  /** Optional sink for per-request telemetry; defaults to a no-op. */
  readonly onEvent?: (event: PipelineEvent) => void;
  /**
   * R8.S3 — optional session-tree recorder. Called once per non-bypassed
   * Messages request, after the body is parsed but before any transforms.
   * Observe-only: never affects the request, never throws on error.
   * The recorder stamps its own timestamps — the pipeline is clock-free.
   */
  readonly sessionRecorder?: {
    observe(body: Readonly<Record<string, unknown>>): void;
  };
  /**
   * R13.7 — which conversations are live, and which of them can be addressed.
   *
   * Observe-only and always wired, like `sessionRecorder`: knowing what exists
   * is not the same act as writing into it, and a device must be able to see a
   * conversation (and be told injection is off) rather than see nothing.
   */
  readonly liveConversations?: {
    observe(body: Readonly<Record<string, unknown>>): void;
    addressable(
      conversationId: string,
    ): { readonly ok: true } | { readonly ok: false; readonly reason: string };
  };
  /**
   * R13.7 — the queue of messages authored on a paired device (ADR-0007 §3b).
   *
   * **Wired ONLY when the user has turned injection on.** That is invariant 6
   * made structural rather than conditional: with the option absent there is no
   * branch to reach, no queue to read, and a request with nothing queued is
   * byte-identical to today at compression ≤ 1 because no code ran at all.
   */
  readonly joinQueue?: JoinQueue;
  /**
   * Called with the messages this request delivered, before it is forwarded.
   *
   * Invariant 4's local half: the developer at the keyboard sees what their own
   * device said into their session. Never throws into the request path.
   */
  readonly onJoinInjected?: (messages: readonly JoinQueueMessage[], conversationId: string) => void;
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
   * `ccrStore` so `expand` can recover it. Shares the semantic stage's gate —
   * `stages.semanticCompression !== "off"` AND a non-caching upstream —
   * independent of whether a Headroom sidecar (`semantic`) is configured.
   * NOT identical, in one respect worth knowing before reading an A/B result:
   * {@link forceSemanticOnCaching} bypasses the caching gate for the semantic
   * stage ONLY, so on a caching upstream with that flag set, semantic
   * compression runs and this stage still does not.
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
  /**
   * R8.11 / ADR-0005 — third-party pipeline stages, in load order.
   *
   * They run after redaction and after the local-answer short-circuit, and
   * redaction re-runs over whatever they return, so a stage can neither see nor
   * introduce unredacted content. A stage that throws is skipped for that
   * request. Absent or empty → not a single line of the plugin path executes,
   * so an install with no plugins behaves exactly as it did before R8.11.
   */
  readonly pluginStages?: readonly PluginPipelineStage[];
}

// Match the Anthropic Messages endpoint as the tail of the path — NOT anchored
// at the start — so provider-prefixed gateways work too: Anthropic
// `/v1/messages`, and Azure Foundry / OpenRouter-style `/anthropic/v1/messages`
// (Decision 22). End-anchored so it excludes sub-resources like
// `/v1/messages/batches` (different body shape). Query string allowed.
const MESSAGES_PATH_RE = /^\/(?:[a-z0-9-]+\/)?v1\/messages(?:\?.*)?$/;

function isMessagesRequest(request: ProxyRequest): boolean {
  return request.method.toUpperCase() === "POST" && MESSAGES_PATH_RE.test(request.url);
}

/**
 * Build the Golem request pipeline. The returned object is the value passed as
 * `pipeline` to {@link GolemProxy}; the proxy recomputes content-length from
 * the returned body.
 */
/**
 * R10.23 — how long the local-answer stage may hold a live request before Golem
 * gives up on it and forwards upstream.
 *
 * The stage runs a vector search inline, which means an embedder call, which on
 * a cold local model is seconds — and it is eligible precisely on the
 * single-turn requests that START a session, so the first turn of a session was
 * the one that paid, presenting as the client sitting on "waiting for API".
 * Two seconds is chosen to be longer than a warm search (milliseconds) and far
 * shorter than a user's patience.
 */
const LOCAL_ANSWER_BUDGET_MS = 2_000;

/**
 * R10.23 — how long Golem's own pre-forward work may take before it is worth
 * telling the operator about. Under this, the pipeline is invisible against
 * normal upstream latency; over it, the client is showing "waiting for API" for
 * time the API is not responsible for, and the honesty rail (Decision 25) says
 * name the real cause rather than let the upstream wear it.
 */
const HELD_REQUEST_LOG_MS = 750;

/**
 * Log — once, on one line — that Golem held a request longer than
 * {@link HELD_REQUEST_LOG_MS}, with the per-stage breakdown that says which
 * stage did it. Observation only: it can neither change nor fail a request.
 */
function reportHeldRequest(
  startedAt: number,
  stageMs: Record<string, number>,
  outcome: string,
): void {
  const total = performance.now() - startedAt;
  if (total < HELD_REQUEST_LOG_MS) return;
  const breakdown = Object.entries(stageMs)
    .filter(([, ms]) => ms >= 1)
    .sort((a, b) => b[1] - a[1])
    .map(([stage, ms]) => `${stage}=${Math.round(ms)}ms`)
    .join(" ");
  proxyLog(
    `pipeline held this request ${Math.round(total)}ms before ` +
      `forwarding (${outcome})${breakdown.length > 0 ? ` — ${breakdown}` : ""}`,
  );
}

export function createGolemPipeline(options: GolemPipelineOptions): RequestPipeline {
  const emit = options.onEvent ?? ((): void => {});
  // R8.1 — one observer per pipeline instance (i.e. per proxy process), because
  // cache-bust detection is inherently a comparison against the previous request
  // of the same conversation. Bounded internally.
  const cacheObserver = new CachePrefixObserver();

  return {
    name: "golem",
    async process(request: ProxyRequest): Promise<ProxyRequest> {
      // R10.23 — every stage below runs BEFORE the request is forwarded, so
      // whatever they cost, the user is watching the client say "waiting for
      // API" for exactly that long, with nothing in the log to say Golem is the
      // one holding it. Time the stages and, past the threshold, say so.
      const startedAt = performance.now();
      const stageMs: Record<string, number> = {};
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

      // R8.S3 — observe for session tree (fire-and-forget, never affects the request).
      if (options.sessionRecorder !== undefined) {
        try {
          options.sessionRecorder.observe(parsed);
        } catch {
          // observe-only — never fail a request over a session-tree write
        }
      }

      // R13.7 — observe for the live-conversation registry, on the ORIGINAL body
      // (before any injection), so conversation identity is what the CLIENT sent.
      // Observe-only and always on: knowing a conversation exists is not the same
      // act as writing into it.
      if (options.liveConversations !== undefined) {
        try {
          options.liveConversations.observe(parsed);
        } catch {
          // observe-only — never fail a request over a registry write
        }
      }

      const policy = await options.policy();
      const stages = policy.stages;
      const stageSavings: Record<string, TokenDelta> = {};
      let body: Record<string, unknown> = parsed;
      let changed = false;
      let ccrRefsStored = 0;
      let avoidedUpstreamInputTokens = 0;
      let brevityDirectiveTokens = 0;

      // Stage 0.9 — join injection (R13.7, ADR-0007 section 3b).
      //
      // Placed BEFORE redaction on purpose. The queue already redacts on the way
      // in (its contract's binding note), and running the redaction stage over
      // the injected block as well means there is no path by which text reaches
      // the upstream without passing the stage that CLAUDE.md's hard rule puts
      // first. Belt and braces, in the one direction where a mistake is
      // unrecoverable.
      //
      // Nothing here runs unless the user turned injection on: `joinQueue` is
      // wired only then, so with it off a request with nothing queued is
      // byte-identical because no code ran at all (invariant 6).
      let injectedRemote: readonly JoinQueueMessage[] = [];
      if (options.joinQueue !== undefined && canInject(body)) {
        const joinAt = performance.now();
        try {
          const conversationId = conversationKeyOf(body);
          const verdict = options.liveConversations?.addressable(conversationId) ?? { ok: true };
          if (conversationId !== "" && verdict.ok) {
            // `claim` is exactly-once ACROSS PROCESSES, and `canInject` was
            // checked above, so a claimed message is one this request will carry.
            const claimed = await options.joinQueue.claim(conversationId);
            if (claimed.length > 0) {
              const applied = applyJoinMessages(body, claimed);
              if (applied.injected.length > 0) {
                body = applied.body;
                changed = true;
                injectedRemote = applied.injected;
                // Invariant 4's local half — the developer at the keyboard sees
                // what their own device said into their session.
                try {
                  options.onJoinInjected?.(applied.injected, conversationId);
                } catch {
                  // Visibility must not be able to fail a request; the queue's
                  // delivered record and the host log already hold the fact.
                }
              }
            }
          }
        } catch (err) {
          // Fail-open, like every optional stage here: a queue that cannot be
          // read leaves the request exactly as the client sent it.
          proxyLog(`join injection skipped (${err instanceof Error ? err.message : String(err)})`);
        } finally {
          stageMs["join-injection"] = performance.now() - joinAt;
        }
      }

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
      //
      // R13.7: skipped outright when this request just carried a remote message.
      // A local answer short-circuits the request, so answering here would
      // consume a message that was already claimed and never let it reach the
      // session it was addressed to.
      if (options.localAnswer !== undefined && injectedRemote.length === 0) {
        const queryText = eligibleLocalAnswerText(body);
        if (queryText !== undefined) {
          const localAnswerAt = performance.now();
          try {
            // R10.23 — BOUND it. This stage runs a vector search (and therefore
            // an embedder, which on a cold local model is a multi-second first
            // call) inline on a live request, and it is eligible on exactly the
            // single-turn requests that open a session — so the very first turn
            // was the one that paid. Past the budget, abandon the local answer
            // and forward upstream: the KB answer is an optimisation, and no
            // optimisation may hold a user's turn open indefinitely. Fail-open
            // is already this stage's contract for errors; a timeout is just the
            // slow flavour of the same verdict.
            const result = await Promise.race([
              options.localAnswer.service.tryAnswer({
                text: queryText,
                projectId: options.projectId,
              }),
              new Promise<never>((_resolve, reject) => {
                const timer = setTimeout(
                  () =>
                    reject(new Error(`local-answer stage exceeded ${LOCAL_ANSWER_BUDGET_MS}ms`)),
                  LOCAL_ANSWER_BUDGET_MS,
                );
                // Never let a pending budget timer hold the process open.
                timer.unref?.();
              }),
            ]);
            if (result.answered) {
              const stream = body.stream === true;
              const respondDirectly = synthesizeLocalAnswerResponse(queryText, result.text, stream);
              const originalJson = JSON.stringify(parsed);
              emit({
                projectId: options.projectId,
                level: compressionRank(policy.compression),
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
              reportHeldRequest(startedAt, stageMs, "answered locally");
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
          } finally {
            stageMs["local-answer"] = performance.now() - localAnswerAt;
          }
        }
      }

      // Stage 1.7 — plugin pipeline stages (R8.11 / ADR-0005).
      //
      // Placed HERE for two reasons, both load-bearing. It is after redaction, so
      // a third-party stage never sees raw content. And it is after the
      // local-answer short-circuit, so a request Golem answers itself does not
      // run third-party code at all.
      //
      // Then redaction RE-RUNS over whatever a stage returned. Redaction is
      // idempotent (placeholders are outside every rule's charset), so the second
      // pass cannot renumber anything — what it buys is that a plugin stage
      // cannot introduce unredacted content into the request, however it obtained
      // it. That is a structural answer to "can a plugin weaken redaction",
      // rather than a promise that we read the plugin.
      if (options.pluginStages !== undefined && options.pluginStages.length > 0) {
        const pluginsAt = performance.now();
        let touched = false;
        for (const stage of options.pluginStages) {
          try {
            const next = await stage.transform({ body, projectId: options.projectId });
            if (next !== undefined && isRecord(next) && next !== body) {
              body = next;
              touched = true;
            }
          } catch (err) {
            // A plugin never fails a user's request: skip the stage, keep the
            // pre-stage body, say so once on stderr.
            proxyLog(
              `plugin stage ${stage.name} threw and was skipped (${
                err instanceof Error ? err.message : String(err)
              })`,
            );
          }
        }
        if (touched) {
          changed = true;
          if (stages.redaction) {
            const reRedacted = redactRequestBody(body);
            if (reRedacted.count > 0 && isRecord(reRedacted.value)) {
              body = reRedacted.value;
              // Attribute the extra pass separately — a plugin stage that keeps
              // introducing secrets should be visible, not folded into stage 1.
              stageSavings["redaction-after-plugins"] = reRedacted.delta;
            }
          }
        }
        stageMs.plugins = performance.now() - pluginsAt;
      }

      // Stage 2 — lossless compression (level >= 1).
      if (stages.losslessCompression && Array.isArray(body.messages)) {
        const messagesIn = body.messages as ReadonlyArray<Readonly<Record<string, unknown>>>;
        const compressAt = performance.now();
        const result = await options.compression.compress(messagesIn, policy, options.projectId);
        stageMs.compression = performance.now() - compressAt;
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
        const semanticAt = performance.now();
        const semantic = await options.semantic.compress(
          messagesInSemantic,
          stages.semanticCompression,
        );
        stageMs.semantic = performance.now() - semanticAt;
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
      // messages. Shares the semantic stage's non-caching-upstream rule (see
      // context-substitution.ts's module doc for why), and is independent of
      // whether a Headroom sidecar is configured. Deliberately does NOT honour
      // `forceSemanticOnCaching`: that flag is scoped to the semantic stage
      // (see its doc comment), so an R2.6 A/B on a caching upstream measures
      // semantic compression alone, with this stage still gated off.
      if (
        stages.semanticCompression !== "off" &&
        options.contextSubstitution !== undefined &&
        !effectiveCaching(options) &&
        Array.isArray(body.messages)
      ) {
        const messagesInSub = body.messages as ReadonlyArray<Readonly<Record<string, unknown>>>;
        const substitutionAt = performance.now();
        const lookup = await options.contextSubstitution.lookup();
        const substituted = await substituteKnownContent(
          messagesInSub,
          lookup,
          options.contextSubstitution.ccrStore,
          options.contextSubstitution.minChars,
        );
        stageMs.substitution = performance.now() - substitutionAt;
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
        reportHeldRequest(startedAt, stageMs, "forwarded unchanged");
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
        level: compressionRank(policy.compression),
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
        ...(cacheObservation.firstChangedMessage !== undefined && {
          cacheBustMessageIndex: cacheObservation.firstChangedMessage,
        }),
        cacheMessageCount: cacheObservation.messageCount,
        ...(injectedRemote.length > 0 && { remoteMessagesInjected: injectedRemote.length }),
      });
      reportHeldRequest(startedAt, stageMs, "forwarded rewritten");
      return { ...request, body: Buffer.from(finalJson, "utf8") };
    },
  };
}
