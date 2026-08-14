/**
 * CLI integration glue: assemble a real `GolemProxy` + request pipeline from
 * already-loaded settings, so `golem proxy` (main.ts `runProxyForeground`)
 * and tests that need a real proxy instance share one construction path.
 *
 * Deliberately excludes anything CLI-process-specific: `portInUse` checks,
 * pid-file writing, stdout logging, and SIGINT/SIGTERM/process.exit handling
 * all stay in `runProxyForeground` — this module only builds the objects.
 *
 * R10.1: the three concerns this assembler wires together live in
 * `proxy-build/` — the opt-in sidecars, the upstream resolution + warnings, and
 * the post-request telemetry hooks. This file is the assembly ORDER, which is
 * itself load-bearing (see `resolveProxyUpstream` / `buildUpstreamWiring`).
 */

import type { HeadroomSidecar } from "../compression/headroom-adapter.js";
import { NativeLosslessCompression } from "../compression/index.js";
import { dialsFromSettings, type GolemSettings, policyFromSettings } from "../config/index.js";
import type { InferenceService } from "../interfaces/inference.js";
import { sliderPolicyForLevel } from "../interfaces/policy.js";
import { contentHashIndex } from "../knowledge/web-cache.js";
import type { SliderStore } from "../mcp/slider-store.js";
import { createGolemPipeline } from "../pipeline/index.js";
import { listTargets, type UpstreamProvider } from "../providers/index.js";
import { GolemProxy } from "../proxy/index.js";
import { SessionTreeRecorder } from "../session/session-tree.js";
import type { TelemetryStore } from "../telemetry/types.js";
import { buildProxySidecars } from "./proxy-build/sidecars.js";
import {
  createPipelineEventRecorder,
  createResponseTelemetryHooks,
} from "./proxy-build/telemetry-hooks.js";
import { buildUpstreamWiring, resolveProxyUpstream } from "./proxy-build/upstream-resolution.js";
import { createRouteResolver, type VisionLookup } from "./route-resolver.js";

export interface ProxyBuild {
  readonly proxy: GolemProxy;
  /** Present only when `settings.compression.headroom_sidecar` is set (opt-in, slider ≥2). */
  readonly semantic?: HeadroomSidecar;
  /**
   * The upstream this proxy actually forwards to — the resolved ACTIVE account,
   * not the top-level `proxy.upstream_*` config. Returned so the caller's startup
   * banner reports the truth: it used to print `settings.proxy.upstream_base_url`,
   * which meant a proxy serving an active account still announced
   * `-> https://api.anthropic.com` and made a working `golem gateway use` look
   * like it had not taken effect.
   */
  readonly upstream: {
    readonly provider: UpstreamProvider;
    readonly baseUrl: string;
    readonly accountId: string | null;
    readonly model?: string;
  };
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
  /**
   * R10.14 — per-target image-input capability, from R8.8's model catalog. The
   * caller loads the catalog (async) and passes the lookup in, so this builder
   * stays synchronous. Absent → images are forwarded as before.
   */
  readonly visionOf?: VisionLookup;
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
  const { semantic, ccrStore, headroomCcrStore, webCache, localAnswer } = buildProxySidecars(
    dir,
    settings,
    build,
  );
  const { sliderStore } = build;
  // Shared with onResponseUsage below so a usage sample is tagged with the
  // SAME level-resolution logic the pipeline used for this request's gross
  // savings (R1.1). Re-read rather than threaded through per-request, so
  // there is a (rare, documented) race if the level changes between a
  // request and its response — acceptable for a batch/alternating A/B.
  const resolvePolicy = async () => {
    if (sliderStore === undefined) return policyFromSettings(settings);
    const level = await sliderStore.get();
    // Decision 52: the runtime slider store owns the LEVEL only; the two dial
    // pins still come from settings, so a pinned brevity/compression level
    // survives a `golem slider` change (a pin wins and sticks).
    return sliderPolicyForLevel(level, dialsFromSettings(settings));
  };
  // R2.6 (verification-notes §58/§59): opt-in, static per-run — see the
  // option's doc comment on GolemPipelineOptions.forceSemanticOnCaching.
  const forceSemanticOnCaching = settings.compression.force_semantic_on_caching;
  const { upstream, proxyWithDefault, assumeCachingUpstream } = resolveProxyUpstream(settings);
  // R8.S3 — session tree recorder. Observe-only, fire-and-forget, never fails.
  const sessionRecorder = new SessionTreeRecorder();
  const pipeline = createGolemPipeline({
    compression: NativeLosslessCompression.forProjectDir(dir),
    policy: resolvePolicy,
    projectId: dir,
    upstreamBaseUrl: upstream.baseUrl,
    forceSemanticOnCaching,
    ...(assumeCachingUpstream !== undefined ? { assumeCachingUpstream } : {}),
    sessionRecorder,
    contextSubstitution: {
      ccrStore,
      lookup: async () => {
        const index = await contentHashIndex(webCache);
        return (hash: string) => index.get(hash);
      },
    },
    onEvent: createPipelineEventRecorder({ dir, telemetry, sessionRecorder }),
    ...(semantic !== undefined ? { semantic } : {}),
    ...(headroomCcrStore !== undefined ? { headroomCcrStore } : {}),
    ...(localAnswer !== undefined ? { localAnswer } : {}),
  });
  const { upstreamProvider, upstreamModel, mapUpstreamHeaders, translateUpstream } =
    buildUpstreamWiring(settings, upstream, build.visionOf);
  const { onResponseUsage, onResponseHeaders } = createResponseTelemetryHooks({
    dir,
    telemetry,
    resolvePolicy,
    forceSemanticOnCaching,
    upstreamProvider,
    upstreamModel,
    accountId: upstream.accountId,
  });
  const proxy = new GolemProxy({
    upstreamBaseUrl: upstream.baseUrl,
    connectTimeoutMs: settings.proxy.connect_timeout_ms,
    headersTimeoutMs: settings.proxy.request_timeout_ms,
    bodyTimeoutMs: settings.proxy.request_timeout_ms,
    pipeline,
    ...(mapUpstreamHeaders !== undefined ? { mapUpstreamHeaders } : {}),
    ...(translateUpstream !== undefined ? { translateUpstream } : {}),
    // R9.2: serve every configured target, selected per request by an explicit
    // act. Enabled only when the registry holds more than the synthetic default
    // — with one target the resolver would decide the same thing on every
    // request, so leaving it absent keeps the single-upstream path byte-for-byte
    // the code it has always been.
    ...(listTargets(proxyWithDefault).length > 1
      ? {
          resolveRoute: createRouteResolver({
            settings: proxyWithDefault,
            ...(build.visionOf !== undefined ? { visionOf: build.visionOf } : {}),
            onRoute: ({ targetId, reason, sticky }) => {
              // ADR-0003 invariant 5: every (request → target, why) selection is
              // attributable. Non-secret by construction.
              if (sticky) return; // Already logged when the binding was made.
              process.stderr.write(`golem proxy: routed to "${targetId}" — ${reason}\n`);
            },
          }),
        }
      : {}),
    onPipelineError: (err) => {
      process.stderr.write(
        `golem proxy: pipeline error — forwarded request unchanged (passthrough): ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    },
    onResponseUsage,
    onResponseHeaders,
  });
  const upstreamInfo = {
    provider: upstreamProvider,
    baseUrl: upstream.baseUrl,
    accountId: upstream.accountId,
    ...(upstreamModel !== undefined ? { model: upstreamModel } : {}),
  };
  return semantic !== undefined
    ? { proxy, semantic, upstream: upstreamInfo }
    : { proxy, upstream: upstreamInfo };
}
