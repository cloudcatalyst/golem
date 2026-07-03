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
 * Prefix stability (verification-notes §14): redaction is a pure function of
 * the text and the compression stage is deterministic per A2's contract, so
 * re-processing a previously-sent prefix reproduces identical bytes and
 * Anthropic prompt-cache hits survive.
 */

import type { CompressionService, TokenDelta } from "../interfaces/compression.js";
import { effectiveStages, type SliderPolicy } from "../interfaces/policy.js";
import type { ProxyRequest, RequestPipeline } from "../proxy/types.js";
import { redactRequestBody } from "./redaction.js";

/** A telemetry record emitted once per processed request (A4 consumes it). */
export interface PipelineEvent {
  readonly projectId: string;
  readonly level: number;
  readonly stageSavings: Readonly<Record<string, TokenDelta>>;
  readonly ccrRefsStored: number;
}

export interface GolemPipelineOptions {
  readonly compression: CompressionService;
  /** Resolve the active policy per request (e.g. from live settings). */
  readonly policy: () => SliderPolicy;
  /** Logical project id for compression stats/telemetry attribution. */
  readonly projectId: string;
  /** Optional sink for per-request telemetry; defaults to a no-op. */
  readonly onEvent?: (event: PipelineEvent) => void;
}

const MESSAGES_PATH_RE = /^\/(?:v1\/)?messages\b/;

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

      const policy = options.policy();
      const stages = effectiveStages(policy);
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
        const result = await options.compression.compress(
          body.messages as ReadonlyArray<Readonly<Record<string, unknown>>>,
          policy,
          options.projectId,
        );
        body = { ...body, messages: [...result.messagesOut] };
        for (const [stage, delta] of Object.entries(result.stageSavings)) {
          stageSavings[stage] = delta;
        }
        ccrRefsStored = result.refs.length;
        changed = true;
      }

      if (!changed) {
        // Nothing to do — preserve original bytes exactly.
        return request;
      }

      emit({ projectId: options.projectId, level: policy.level, stageSavings, ccrRefsStored });
      return { ...request, body: Buffer.from(JSON.stringify(body), "utf8") };
    },
  };
}
