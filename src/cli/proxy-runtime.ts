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
import {
  anthropicToGemini,
  anthropicToOpenAIChat,
  createGeminiToAnthropicSSE,
  createOpenAIToAnthropicSSE,
  geminiPath,
  geminiToAnthropic,
  isGeminiProvider,
  isTranslatingProvider,
  makeAuthMapper,
  openAIChatToAnthropic,
  resolveActiveUpstream,
  resolveAuthScheme,
  sniffRequestModel,
  upstreamAssumesCaching,
  upstreamChatCompletionsPath,
} from "../providers/index.js";
import type { UpstreamTranslator } from "../proxy/index.js";
import {
  GolemProxy,
  parseLimitPrediction,
  writeLimitState,
  writeServedModel,
} from "../proxy/index.js";
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
      ...(settings.proxy.active_account !== undefined
        ? { activeAccount: settings.proxy.active_account }
        : {}),
      legacyApiKey: process.env.GOLEM_UPSTREAM_API_KEY,
    },
    process.env,
  );
  if (accountWarning !== undefined) process.stderr.write(`golem proxy: ${accountWarning}\n`);
  // R6.1 case (a): the selected provider governs the semantic stage's caching
  // assumption (verification-notes §73). undefined for `anthropic` → URL heuristic.
  const assumeCachingUpstream = upstreamAssumesCaching(upstream.provider);
  const pipeline = createGolemPipeline({
    compression: NativeLosslessCompression.forProjectDir(dir),
    policy: resolvePolicy,
    projectId: dir,
    upstreamBaseUrl: upstream.baseUrl,
    forceSemanticOnCaching,
    ...(assumeCachingUpstream !== undefined ? { assumeCachingUpstream } : {}),
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
  const upstreamBase = upstream.baseUrl;
  const translateFallback = {
    id: "msg_golem_translated",
    model: upstreamModel ?? upstreamProvider,
  };
  const modelOpt = upstreamModel !== undefined ? { model: upstreamModel } : {};

  let translateUpstream: UpstreamTranslator | undefined;
  if (isGeminiProvider(upstreamProvider)) {
    // Gemini: distinct schema; auth is a `?key=` query param carried in the
    // per-request path, so the base `path` is a placeholder that translateRequest
    // always overrides.
    translateUpstream = {
      path: geminiPath(upstreamBase, upstreamModel ?? "", false, upstreamApiKey),
      translateRequest: (body: Buffer | null) => {
        const { body: g, stream, model } = anthropicToGemini(body, modelOpt);
        return {
          body: Buffer.from(JSON.stringify(g), "utf8"),
          stream,
          path: geminiPath(upstreamBase, model, stream, upstreamApiKey),
        };
      },
      translateResponse: (body: Buffer): Buffer =>
        Buffer.from(JSON.stringify(geminiToAnthropic(body, translateFallback)), "utf8"),
      createStreamTranslator: () => createGeminiToAnthropicSSE(translateFallback),
    };
  } else if (isTranslatingProvider(upstreamProvider)) {
    // OpenAI / Ollama: OpenAI Chat Completions schema. b4-kimi: pass through
    // reasoning_effort and map the reasoning trace ↔ Anthropic thinking blocks.
    const reasoningEffort = settings.proxy.upstream_reasoning_effort;
    const mapReasoning = settings.proxy.map_reasoning_to_thinking;
    const reqOpts = reasoningEffort !== undefined ? { ...modelOpt, reasoningEffort } : modelOpt;
    const respOpts = { mapReasoning };
    translateUpstream = {
      path: upstreamChatCompletionsPath(upstreamBase),
      translateRequest: (body: Buffer | null) => {
        const req = anthropicToOpenAIChat(body, reqOpts);
        return { body: Buffer.from(JSON.stringify(req), "utf8"), stream: req.stream };
      },
      translateResponse: (body: Buffer): Buffer =>
        Buffer.from(
          JSON.stringify(openAIChatToAnthropic(body, translateFallback, respOpts)),
          "utf8",
        ),
      createStreamTranslator: () =>
        createOpenAIToAnthropicSSE({ ...translateFallback, mapReasoning }),
    };
  }
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
    onPipelineError: (err) => {
      process.stderr.write(
        `golem proxy: pipeline error — forwarded request unchanged (passthrough): ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    },
    onResponseUsage: (usage) => {
      if (usage === null) return;
      const nowIso = new Date().toISOString();
      void (async () => {
        const level = (await resolvePolicy()).level;
        await recordUsageEvent(
          telemetry,
          { projectId: dir, level, usage, semanticForced: forceSemanticOnCaching },
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
      const servedModel = upstreamModel ?? sniffRequestModel(request.body);
      if (servedModel !== undefined) {
        void writeServedModel(dir, {
          model: servedModel,
          servedAtIso: nowIso,
          accountId: upstream.accountId,
        }).catch(() => {});
      }
      // Limit prediction (snooze P2a): persist the observed session/weekly window
      // utilization + reset to `.golem/state/limit-state.json`, throttled so a busy
      // stream doesn't rewrite the file per response. Observe-only, fail-open.
      if (nowMs - lastLimitPersistMs < LIMIT_PERSIST_THROTTLE_MS) return;
      const prediction = parseLimitPrediction(headers, nowIso);
      if (prediction === null) return;
      lastLimitPersistMs = nowMs;
      void writeLimitState(dir, prediction).catch(() => {});
    },
  });
  return semantic !== undefined ? { proxy, semantic } : { proxy };
}
