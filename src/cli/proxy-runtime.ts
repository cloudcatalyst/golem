/**
 * CLI integration glue: assemble a real `GolemProxy` + request pipeline from
 * already-loaded settings, so `golem proxy` (main.ts `runProxyForeground`)
 * and tests that need a real proxy instance share one construction path.
 *
 * Deliberately excludes anything CLI-process-specific: `portInUse` checks,
 * pid-file writing, stdout logging, and SIGINT/SIGTERM/process.exit handling
 * all stay in `runProxyForeground` — this module only builds the objects.
 */

import { join } from "node:path";
import { HeadroomSidecar } from "../compression/headroom-adapter.js";
import { CcrStore, LocalDirBlobStore, NativeLosslessCompression } from "../compression/index.js";
import { type GolemSettings, policyFromSettings } from "../config/index.js";
import type { InferenceService } from "../interfaces/inference.js";
import { sliderPolicyForLevel } from "../interfaces/policy.js";
import { hashingEmbedFn, openKnowledgeBase } from "../knowledge/index.js";
import { KnowledgeLocalAnswerService } from "../knowledge/local-answer.js";
import { contentHashIndex, WebCache, webCacheDir } from "../knowledge/web-cache.js";
import type { SliderStore } from "../mcp/slider-store.js";
import { createGolemPipeline } from "../pipeline/index.js";
import { GolemProxy, parseLimitPrediction, writeLimitState } from "../proxy/index.js";
import {
  recordAvoidedUpstream,
  recordPipelineEvent,
  recordUsageEvent,
} from "../telemetry/index.js";
import type { TelemetryStore } from "../telemetry/types.js";

export interface ProxyBuild {
  readonly proxy: GolemProxy;
  /** Present only when `settings.compression.headroom_sidecar` is set (opt-in, slider ≥2). */
  readonly semantic?: HeadroomSidecar;
}

export interface BuildProxyOptions {
  /**
   * When present, the level is re-read from this store on EVERY request
   * instead of frozen at construction time — makes `level` /
   * `golem slider` double as the live per-task toggle (Decision 25/30).
   */
  readonly sliderStore?: SliderStore;
  /**
   * R2.3 (spec Decision 24 sub-mode 2 / Decision 33): local inference
   * service, used ONLY to select the SEMANTIC embedder for the local-answer
   * sub-mode's KnowledgeBase. Has no effect unless
   * `settings.knowledge.local_answer_enabled` is also set. Absent → the
   * sub-mode, if enabled, falls back to the pure-TS hashing (LEXICAL) embedder.
   *
   * The caller MUST pass this only when the on-disk index was actually built
   * SEMANTIC (see `resolvePersistedEmbedMode`): querying a lexically-built index
   * with semantic vectors — or vice-versa — is a cross-space query that
   * `assertEmbedderSpaceMatch` now rejects (it used to silently score 0 for
   * every chunk). `runProxyForeground` resolves this from the persisted index
   * manifest rather than a blind "is Ollama up?" probe.
   */
  readonly inference?: InferenceService;
  /**
   * Force the local-answer sub-mode OFF for this run even when
   * `settings.knowledge.local_answer_enabled` is set. `runProxyForeground` sets
   * this when the on-disk index was built with a semantic embed model that is
   * no longer available — the index cannot be queried correctly in either space,
   * so declining up front is cleaner than throwing (and failing open) on every
   * eligible request.
   */
  readonly suppressLocalAnswer?: boolean;
}

/**
 * Build a `GolemProxy` wired to the A3 redaction→compression pipeline exactly
 * the way `golem proxy` wires it: `NativeLosslessCompression` rooted at `dir`,
 * the OPT-IN Headroom semantic sidecar when `compression.headroom_sidecar` is
 * set, and per-request `PipelineEvent`s recorded to `telemetry`. Does not
 * call `proxy.listen()` — the caller owns binding (port, ephemeral-for-tests,
 * etc.) and shutdown.
 */
export function buildProxyFromSettings(
  dir: string,
  settings: GolemSettings,
  telemetry: TelemetryStore,
  build: BuildProxyOptions = {},
): ProxyBuild {
  // OPT-IN semantic sidecar (Headroom) for slider ≥3 — off unless configured.
  // Started lazily on first ≥3 request; fails open so the proxy never depends on it.
  const semantic = settings.compression.headroom_sidecar ? new HeadroomSidecar() : undefined;
  // Same `.golem/ccr` directory `NativeLosslessCompression.forProjectDir(dir)`
  // writes to, shared by both the R2.4 Headroom backfill and R2.2 context
  // substitution below, so `expand` recovers either kind of marker uniformly.
  const ccrStore = new CcrStore(new LocalDirBlobStore(join(dir, ".golem", "ccr")));
  // R2.4 (verification-notes §38): only wired into the pipeline when the
  // Headroom sidecar is actually configured — see
  // GolemPipelineOptions.headroomCcrStore's doc comment.
  const headroomCcrStore = semantic !== undefined ? ccrStore : undefined;
  // R2.2 (verification-notes §62): webcache-only v1 scope — see
  // context-substitution.ts's module doc for the caching-upstream gate this
  // feeds, and the pipeline wiring below. Rebuilt fresh on every request
  // (the thunk, not a cached value) so newly-fetched pages are recognized
  // without a restart; acceptable cost at realistic project webcache sizes.
  const webCache = new WebCache(webCacheDir(dir));
  const { sliderStore } = build;
  // R2.3 (spec Decision 24 sub-mode 2 / Decision 33): OFF by default. When
  // enabled, opens the SAME embedded KnowledgeBase `golem index`/`mcp serve`
  // build (FileVectorDriver under `.golem/knowledge`), choosing ONE embedder
  // the way build-knowledge.ts does — semantic when an inference service was
  // provided, else the zero-setup hashing fallback. Static per-run, like
  // `headroom_sidecar` above — this is an opt-in gate, not something the live
  // slider ever toggles (Decision 31: the slider stays a pure compression dial).
  const localAnswer =
    settings.knowledge.local_answer_enabled && build.suppressLocalAnswer !== true
      ? {
          service: new KnowledgeLocalAnswerService(
            openKnowledgeBase({
              projectDir: dir,
              ...(build.inference !== undefined
                ? { inference: build.inference }
                : { embed: hashingEmbedFn() }),
            }),
            { minConfidence: settings.knowledge.local_answer_min_confidence },
          ),
        }
      : undefined;
  // Shared with onResponseUsage below so a usage sample is tagged with the
  // SAME level-resolution logic the pipeline used for this request's gross
  // savings (R1.1). Re-read rather than threaded through per-request, so
  // there is a (rare, documented) race if the level changes between a
  // request and its response — acceptable for a batch/alternating A/B.
  const resolvePolicy = async () => {
    if (sliderStore === undefined) return policyFromSettings(settings);
    const level = await sliderStore.get();
    return sliderPolicyForLevel(level);
  };
  // R2.6 (verification-notes §58/§59): opt-in, static per-run — see the
  // option's doc comment on GolemPipelineOptions.forceSemanticOnCaching.
  const forceSemanticOnCaching = settings.compression.force_semantic_on_caching;
  const pipeline = createGolemPipeline({
    compression: NativeLosslessCompression.forProjectDir(dir),
    policy: resolvePolicy,
    projectId: dir,
    upstreamBaseUrl: settings.proxy.upstream_base_url,
    forceSemanticOnCaching,
    contextSubstitution: {
      ccrStore,
      lookup: async () => {
        const index = await contentHashIndex(webCache);
        return (hash: string) => index.get(hash);
      },
    },
    onEvent: (event) => {
      const nowIso = new Date().toISOString();
      void recordPipelineEvent(telemetry, event, nowIso).catch(() => {});
      if (event.avoidedUpstreamInputTokens > 0 || event.avoidedUpstreamOutputTokens > 0) {
        void recordAvoidedUpstream(
          telemetry,
          event.projectId,
          nowIso,
          event.avoidedUpstreamInputTokens,
          event.avoidedUpstreamOutputTokens,
        ).catch(() => {});
      }
    },
    ...(semantic !== undefined ? { semantic } : {}),
    ...(headroomCcrStore !== undefined ? { headroomCcrStore } : {}),
    ...(localAnswer !== undefined ? { localAnswer } : {}),
  });
  // Throttle limit-state persistence (P2a) so a busy SSE stream doesn't rewrite
  // `.golem/state/limit-state.json` on every response.
  let lastLimitPersistMs = 0;
  const LIMIT_PERSIST_THROTTLE_MS = 3000;
  const proxy = new GolemProxy({
    upstreamBaseUrl: settings.proxy.upstream_base_url,
    connectTimeoutMs: settings.proxy.connect_timeout_ms,
    headersTimeoutMs: settings.proxy.request_timeout_ms,
    bodyTimeoutMs: settings.proxy.request_timeout_ms,
    pipeline,
    onPipelineError: (err) => {
      process.stderr.write(
        `golem proxy: pipeline error — forwarded request unchanged (passthrough): ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    },
    onResponseUsage: (usage) => {
      if (usage === null) return;
      void (async () => {
        const level = (await resolvePolicy()).level;
        await recordUsageEvent(
          telemetry,
          { projectId: dir, level, usage, semanticForced: forceSemanticOnCaching },
          new Date().toISOString(),
        );
      })().catch(() => {});
    },
    // Limit prediction (snooze P2a): persist the observed session/weekly window
    // utilization + reset to `.golem/state/limit-state.json`, throttled so a busy
    // stream doesn't rewrite the file per response. Observe-only, fail-open.
    onResponseHeaders: (headers) => {
      const nowMs = Date.now();
      if (nowMs - lastLimitPersistMs < LIMIT_PERSIST_THROTTLE_MS) return;
      const prediction = parseLimitPrediction(headers, new Date(nowMs).toISOString());
      if (prediction === null) return;
      lastLimitPersistMs = nowMs;
      void writeLimitState(dir, prediction).catch(() => {});
    },
  });
  return semantic !== undefined ? { proxy, semantic } : { proxy };
}
