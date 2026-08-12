/**
 * Everything `buildProxyFromSettings` writes to `.golem/state` / `.golem/telemetry`
 * after a request: the pipeline-event recorder, the usage sample, and the
 * observe-only response-header snapshot (served model + limit prediction).
 *
 * Extracted verbatim from `proxy-runtime.ts` (R10.1). Every hook here is
 * **observe-only and fail-open**: fire-and-forget writes with swallowed errors,
 * because an observability file must never be able to affect a request.
 */

import type { SliderPolicy } from "../../interfaces/policy.js";
import type { PipelineEvent } from "../../pipeline/index.js";
import { sniffRequestModel, type UpstreamProvider } from "../../providers/index.js";
import {
  type ProxyRequest,
  parseLimitPrediction,
  type ResponseUsage,
  writeContextLedger,
  writeLimitState,
  writeServedModel,
  writeServedModelForTarget,
} from "../../proxy/index.js";
import { type SessionTreeRecorder, writeSessionTree } from "../../session/session-tree.js";
import {
  recordAvoidedUpstream,
  recordPipelineEvent,
  recordUsageEvent,
} from "../../telemetry/index.js";
import type { TelemetryStore } from "../../telemetry/types.js";

export interface PipelineEventRecorderInput {
  readonly dir: string;
  readonly telemetry: TelemetryStore;
  readonly sessionRecorder: SessionTreeRecorder;
}

/** The pipeline's per-request `onEvent` sink: telemetry, context ledger, session tree. */
export function createPipelineEventRecorder(
  input: PipelineEventRecorderInput,
): (event: PipelineEvent) => void {
  const { dir, telemetry, sessionRecorder } = input;
  return (event) => {
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
  };
}

export interface ResponseTelemetryInput {
  readonly dir: string;
  readonly telemetry: TelemetryStore;
  /** Shared with the pipeline so a usage sample is tagged with the SAME level (R1.1). */
  readonly resolvePolicy: () => Promise<SliderPolicy>;
  readonly forceSemanticOnCaching: boolean;
  readonly upstreamProvider: UpstreamProvider;
  readonly upstreamModel: string | undefined;
  /** The ACTIVE account id, stamped on the served-model snapshot; null for legacy config. */
  readonly accountId: string | null;
}

export interface ResponseTelemetryHooks {
  readonly onResponseUsage: (usage: ResponseUsage | null, request: ProxyRequest) => void;
  readonly onResponseHeaders: (
    headers: Readonly<Record<string, string | string[] | undefined>>,
    request: ProxyRequest,
  ) => void;
}

/** The two observe-only response hooks, sharing this build's limit-persist throttle. */
export function createResponseTelemetryHooks(
  input: ResponseTelemetryInput,
): ResponseTelemetryHooks {
  const { dir, telemetry, resolvePolicy, forceSemanticOnCaching, upstreamProvider, upstreamModel } =
    input;
  // Throttle limit-state persistence (P2a) so a busy SSE stream doesn't rewrite
  // `.golem/state/limit-state.json` on every response.
  let lastLimitPersistMs = 0;
  const LIMIT_PERSIST_THROTTLE_MS = 3000;
  return {
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
          accountId: input.accountId,
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
  };
}
