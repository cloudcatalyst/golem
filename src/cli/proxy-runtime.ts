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
import { dialsFromSettings, type GolemSettings, policyFromSettings } from "../config/index.js";
import type { InferenceService } from "../interfaces/inference.js";
import { SliderLevel, sliderPolicyForLevel } from "../interfaces/policy.js";
import { hashingEmbedFn, openKnowledgeBase } from "../knowledge/index.js";
import { KnowledgeLocalAnswerService } from "../knowledge/local-answer.js";
import { contentHashIndex, WebCache, webCacheDir } from "../knowledge/web-cache.js";
import type { SliderStore } from "../mcp/slider-store.js";
import { createGolemPipeline } from "../pipeline/index.js";
import {
  isGeminiProvider,
  isTranslatingProvider,
  listTargets,
  makeAuthMapper,
  resolveActiveUpstream,
  resolveAuthScheme,
  resolveDefaultTargetId,
  sniffRequestModel,
  targetWarnings,
  type UpstreamProvider,
  upstreamAssumesCaching,
} from "../providers/index.js";
import {
  GolemProxy,
  parseLimitPrediction,
  writeContextLedger,
  writeLimitState,
  writeServedModel,
  writeServedModelForTarget,
} from "../proxy/index.js";
import { SessionTreeRecorder, writeSessionTree } from "../session/session-tree.js";
import {
  recordAvoidedUpstream,
  recordPipelineEvent,
  recordUsageEvent,
} from "../telemetry/index.js";
import type { TelemetryStore } from "../telemetry/types.js";
import { buildUpstreamTransport, createRouteResolver } from "./route-resolver.js";

/**
 * The bypass shim's fixed policy (Decision 56): slider level 1 — redaction ON,
 * lossless, brevity `off`. `sliderPolicyForLevel`'s defaults already mean exactly
 * this (`brevity` defaults to `off`, `compression` tracks the level), so the shim
 * needs no new dial and no frozen-contract change; it is one pinned policy value.
 *
 * Frozen at module scope precisely so it cannot be reached by the live slider.
 */
const SHIM_POLICY = sliderPolicyForLevel(SliderLevel.Lossless);

export interface ProxyBuild {
  readonly proxy: GolemProxy;
  /** Present only when `settings.compression.headroom_sidecar` is set (opt-in, slider ≥2). */
  readonly semantic?: HeadroomSidecar;
  /**
   * The upstream this proxy actually forwards to — the resolved ACTIVE account,
   * not the top-level `proxy.upstream_*` config. Returned so the caller's startup
   * banner reports the truth: it used to print `settings.proxy.upstream_base_url`,
   * which meant a proxy serving an active account still announced
   * `-> https://api.anthropic.com` and made a working `golem account use` look
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
   * Decision 56 — build the **bypass shim** rather than the full pipeline.
   *
   * `golem proxy stop` keeps the project port bound so Claude Code never dials a
   * dead socket (its `ANTHROPIC_BASE_URL` cannot be un-set without a window
   * reload — verification-notes §112b). This flag is what "pipeline off" means
   * concretely: the live slider store is ignored and the policy is pinned to
   * **level 1**, local-answer is suppressed, and the Headroom sidecar is never
   * constructed.
   *
   * **Level 1, deliberately NOT level 0.** Level 0 / `x-golem-bypass` forwards
   * untouched, i.e. with redaction OFF — the single sanctioned redaction-off path,
   * which CLAUDE.md permits only when it is never the default and always surfaced
   * loudly. A Stop button that quietly routed unredacted prompts upstream would
   * breach that hard rule while looking like a convenience. So the shim redacts.
   */
  readonly shim?: boolean;
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
  // Decision 53: the opaque `headroom_config` bag rides through to the worker, so
  // Headroom options Golem has never heard of are reachable from settings alone.
  // Decision 56: the bypass shim runs no compression at all, so the sidecar is
  // never constructed for it (and `headroomCcrStore` below stays undefined too).
  const semantic =
    settings.compression.headroom_sidecar && build.shim !== true
      ? new HeadroomSidecar({ config: settings.compression.headroom_config })
      : undefined;
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
    settings.knowledge.local_answer_enabled &&
    build.suppressLocalAnswer !== true &&
    build.shim !== true // Decision 56: the shim answers nothing locally
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
    // Decision 56: pinned, and deliberately ignores the live slider store — a
    // shim that tracked the slider could be moved to level 0 (redaction off)
    // while presenting itself as "stopped".
    if (build.shim === true) return SHIM_POLICY;
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
  // R6.2 (ADR-0003): resolve the ACTIVE account (or the legacy top-level config).
  // Secrets are never a setting — the credential comes from the environment.
  // A named-but-unknown active_account falls back to the top-level config with a
  // warning (never a silent switch to a different account — fail-closed).
  const { resolved: upstream, warning: accountWarning } = resolveActiveUpstream(
    {
      legacy: {
        provider: settings.proxy.upstream_provider,
        base_url: settings.proxy.upstream_base_url,
        ...(settings.proxy.upstream_model !== undefined
          ? { model: settings.proxy.upstream_model }
          : {}),
        auth_scheme: resolveAuthScheme(
          settings.proxy.upstream_provider,
          settings.proxy.upstream_auth_scheme,
        ),
      },
      ...(settings.proxy.accounts !== undefined ? { accounts: settings.proxy.accounts } : {}),
      ...(settings.proxy.default_target !== undefined
        ? { activeAccount: settings.proxy.default_target }
        : {}),
      knownTargetIds: listTargets(settings.proxy).map((t) => t.id),
      legacyApiKey: process.env.GOLEM_UPSTREAM_API_KEY,
    },
    process.env,
  );
  if (accountWarning !== undefined) process.stderr.write(`golem proxy: ${accountWarning}\n`);
  // R9.1: warn for EVERY misconfigured target, not just the one being served.
  // A broken target that is not yet routed to is still broken, and the point of
  // a registry is finding that out before a request depends on it. The registry
  // is inert here — this changes what is printed, never what is served.
  for (const w of targetWarnings(settings.proxy)) {
    process.stderr.write(`golem proxy: target "${w.targetId}": ${w.message}\n`);
  }
  // A default_target naming an id in neither registry fails closed downstream
  // (R9.2); say so at startup rather than on the first request that needs it.
  const defaultTargetId = resolveDefaultTargetId(settings.proxy);
  if (!listTargets(settings.proxy).some((t) => t.id === defaultTargetId)) {
    process.stderr.write(
      `golem proxy: default target "${defaultTargetId}" is in neither proxy.targets nor ` +
        "proxy.accounts — no substitute will be used.\n",
    );
  }
  // R6.1 case (a): the selected provider governs the semantic stage's caching
  // assumption (verification-notes §73). undefined for `anthropic` → URL heuristic.
  const assumeCachingUpstream = upstreamAssumesCaching(upstream.provider);
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
    onEvent: (event) => {
      const nowIso = new Date().toISOString();
      void recordPipelineEvent(telemetry, event, nowIso).catch(() => {});
      // R8.4 — latest-only context ledger. Best-effort and fire-and-forget, the
      // same contract as the limit-prediction state write: an observability file
      // must never be able to affect a request.
      if (event.contextLedger !== undefined) {
        void writeContextLedger(dir, event.contextLedger, nowIso).catch(() => {});
      }
      // R8.S3 — persist the session tree after every request.
      const tree = sessionRecorder.snapshot();
      if (tree.conversations.length > 0) void writeSessionTree(dir, tree).catch(() => {});
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
  // R6.1 case (a): auth-header mapping for a non-Anthropic Anthropic-protocol
  // upstream. The credential is a secret the CLI resolved from the OS credential
  // store and handed to this process at spawn (Decision 47 — an environment
  // variable is the internal transport, never a user-facing setting), and never
  // comes from settings.json. `inherit` (the Anthropic default) yields no mapper,
  // so the passthrough forwards the client's own auth verbatim.
  const upstreamProvider = upstream.provider;
  const authScheme = upstream.authScheme;
  const upstreamApiKey = upstream.apiKey;
  const mapUpstreamHeaders = makeAuthMapper(authScheme, upstreamApiKey);
  const accountLabel = upstream.accountId === null ? "" : ` (account "${upstream.accountId}")`;
  if (
    upstreamProvider !== "anthropic" &&
    authScheme !== "inherit" &&
    (upstreamApiKey === undefined || upstreamApiKey === "")
  ) {
    process.stderr.write(
      `golem proxy: upstream_provider "${upstreamProvider}"${accountLabel} needs a credential — ` +
        `set it with \`golem account login ${upstream.accountId ?? upstreamProvider}\`; ` +
        "forwarding the client's own auth for now.\n",
    );
  }
  // R6.1 case (b): translate request+response bodies for a non-Anthropic schema.
  // Non-streaming uses translateResponse; streaming uses createStreamTranslator.
  // The pipeline still runs in Anthropic terms before this; translation is last.
  const upstreamModel = upstream.model;
  // R9.2: the SAME builder every routed target uses, so the single-upstream path
  // and the multi-target path cannot drift. A drifting translator does not throw
  // — it mangles a response — so sharing one construction is the only way to
  // keep them honest.
  const { translateUpstream } = buildUpstreamTransport({
    provider: upstreamProvider,
    baseUrl: upstream.baseUrl,
    model: upstreamModel,
    authScheme,
    apiKey: upstreamApiKey,
    reasoningEffort: settings.proxy.upstream_reasoning_effort,
    mapReasoning: settings.proxy.map_reasoning_to_thinking,
  });
  if (isTranslatingProvider(upstreamProvider) && upstreamModel === undefined) {
    process.stderr.write(
      `golem proxy: upstream_provider "${upstreamProvider}" needs proxy.upstream_model ` +
        "(the backend model id, e.g. qwen2.5-coder:7b); requests will fail until it is set.\n",
    );
  }
  if (
    isGeminiProvider(upstreamProvider) &&
    (upstreamApiKey === undefined || upstreamApiKey === "")
  ) {
    process.stderr.write(
      'golem proxy: upstream_provider "gemini" needs a credential (sent as the ?key= query ' +
        `param) — set it with \`golem account login ${upstream.accountId ?? "gemini"}\`; ` +
        "requests will 401 until it is set.\n",
    );
  }
  // Throttle limit-state persistence (P2a) so a busy SSE stream doesn't rewrite
  // `.golem/state/limit-state.json` on every response.
  let lastLimitPersistMs = 0;
  const LIMIT_PERSIST_THROTTLE_MS = 3000;
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
    ...(listTargets(settings.proxy).length > 1 && build.shim !== true
      ? {
          resolveRoute: createRouteResolver({
            settings: settings.proxy,
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
    onResponseUsage: (usage, request) => {
      if (usage === null) return;
      const nowIso = new Date().toISOString();
      // R8.8: which model this sample was billed against. Same rule as the
      // served-model snapshot below — the configured model wins on a translating
      // upstream (the client's `claude-*` never reaches it), otherwise read the
      // client's own model back out of the request body (observe-only). Absent
      // when neither is available, so the cost report can say "unattributed"
      // instead of pricing tokens against a guessed model.
      const billedModel = upstreamModel ?? sniffRequestModel(request.body);
      void (async () => {
        // Decision 52: tag the sample with the brevity level in force, so
        // `aggregateUsageByBrevity` can compare BILLED output tokens per level.
        // This is the only honest place to measure it — the saving is in the
        // response, not the request. Same documented race as `level`: a dial
        // changed between request and response tags the sample with the new
        // value, which is acceptable for an alternating A/B.
        const policy = await resolvePolicy();
        const level = policy.level;
        await recordUsageEvent(
          telemetry,
          {
            projectId: dir,
            level,
            usage,
            semanticForced: forceSemanticOnCaching,
            brevity: policy.brevity,
            ...(billedModel !== undefined ? { model: billedModel } : {}),
            provider: upstreamProvider,
          },
          nowIso,
        );
      })().catch(() => {});
    },
    // Fires on EVERY response (both the byte-faithful pipe and the translating
    // path) once upstream response headers arrive — unlike onResponseUsage,
    // which on the translating path can get `null` (the UsageSniffer never sees
    // a usage block past the SSE translator). Two observe-only writes hang here.
    onResponseHeaders: (headers, request) => {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      // R6.2 display: record the model that actually fronted this request, so
      // `golem status`/`statusline` + the VS Code extension can show the current
      // model. For a translating upstream that is the configured `upstream.model`
      // (it won over the client's `claude-*`). For a byte-faithful Anthropic
      // upstream `upstreamModel` is undefined — the client's own per-request
      // model flows through — so we read it back out of the request body
      // (observe-only, never mutating the forwarded bytes) rather than showing
      // nothing. Fail-open (never affects the forwarded response).
      //
      // The active account id is stamped alongside it so a snapshot can be told
      // apart from one written by a different upstream — otherwise a switch left
      // every display surface reporting the previous account's model.
      //
      // R9.2: with many targets served concurrently, "the current model" has N
      // answers. When a route served this request, record it under that
      // TARGET's id — the spec's 21e correctness rail ("the responding model is
      // always visible") is not optional, and one surface showing one model
      // while three targets serve is the R8.32 failure again. The target's own
      // configured model wins, since that is what actually reached the upstream.
      const route = request.route;
      const servedModel =
        (route !== undefined ? route.rewriteModel : undefined) ??
        upstreamModel ??
        sniffRequestModel(request.body);
      if (servedModel !== undefined) {
        const snapshot = {
          model: servedModel,
          servedAtIso: nowIso,
          accountId: upstream.accountId,
        };
        void (
          route !== undefined
            ? writeServedModelForTarget(dir, route.targetId, snapshot)
            : writeServedModel(dir, snapshot)
        ).catch(() => {});
      }
      // Limit prediction (snooze P2a): persist the observed session/weekly window
      // utilization + reset to `.golem/state/limit-state.json`, throttled so a busy
      // stream doesn't rewrite the file per response. Observe-only, fail-open.
      if (nowMs - lastLimitPersistMs < LIMIT_PERSIST_THROTTLE_MS) return;
      const prediction = parseLimitPrediction(headers, nowIso);
      // R9.2: a target emitting no `anthropic-ratelimit-unified-*` headers writes
      // nothing, which is right — but the snapshot must then say WHOSE limit it
      // describes, or a display surface implies one target's number covers
      // targets that are in fact unmonitored.
      if (prediction === null) return;
      lastLimitPersistMs = nowMs;
      void writeLimitState(dir, {
        ...prediction,
        targetId: route?.targetId ?? null,
      }).catch(() => {});
    },
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
