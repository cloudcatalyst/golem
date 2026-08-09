/**
 * Shared helpers for the Golem MCP server modules.
 *
 * Extracted from server.ts (R8.28) so the per-concern modules can use them
 * without creating a circular dependency.
 */

import { z } from "zod";
import { migrateSliderLevel, type SliderLevel } from "../interfaces/index.js";
import { recordToolCall, type TelemetryStore } from "../telemetry/index.js";

export const GOLEM_MCP_SERVER_NAME = "golem";
export const GOLEM_MCP_SERVER_VERSION = "0.1.0";

export const LEVEL_NAMES: Readonly<Record<SliderLevel, string>> = {
  0: "passthrough",
  1: "lossless",
  2: "balanced",
  3: "aggressive",
};

/**
 * R8.33 — the `level` tool accepts 1–3 only. Level 0 (full bypass, redaction
 * OFF) remains a fully supported setting, but it is reachable only from the
 * CLI (`golem slider 0`), mirroring ADR-0002 threat item 4: no MCP surface may
 * write the least-safe setting, so context-borne injection cannot disable
 * redaction. Legacy 4/5 still map to 3 via `migrateSliderLevel`.
 */
export const LEVEL_ZERO_IS_CLI_ONLY =
  "Level 0 cannot be set from a tool call. It is a full bypass — redaction is " +
  "OFF at level 0, so secrets/PII would reach the upstream unredacted. If that " +
  "is genuinely intended, the user must run `golem slider 0` in their terminal. " +
  "Use level 1 for byte-faithful passthrough with redaction still on.";

export const sliderLevelInput = z
  .number()
  .int()
  .min(1, { message: LEVEL_ZERO_IS_CLI_ONLY })
  .max(5)
  .describe(
    "Slider level 1–3: 1 lossless, 2 balanced, 3 aggressive. Legacy 4/5 are " +
      "accepted and mapped to 3. Level 0 (passthrough — full bypass, no " +
      "redaction) is CLI-only: `golem slider 0`.",
  );

export function asSliderLevel(level: number): SliderLevel {
  return migrateSliderLevel(level);
}

export function textResult(text: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text }] };
}

export function errorResult(text: string): {
  isError: true;
  content: [{ type: "text"; text: string }];
} {
  return { isError: true, content: [{ type: "text", text }] };
}

/** One user-role text message — the shape every Golem prompt returns. */
export function promptMessages(text: string): {
  messages: [{ role: "user"; content: { type: "text"; text: string } }];
} {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

/** R4.3 — where a tool records its per-call telemetry, and under which project. */
export interface ToolTelemetry {
  readonly store: TelemetryStore;
  readonly projectId: string;
}

/**
 * R4.3 — record a `tool` telemetry event for `result` and return it unchanged,
 * so a handler can `return instrumented(tel, "search", startMs, <result>)` at
 * any of its return sites. Measures wall-clock duration and structured-result
 * size; for `coder` it also captures the model and the drafted-locally char
 * count (the "drafted-locally" bucket). Fire-and-forget: a telemetry write
 * never delays or fails the tool result. No-op when `tel` is undefined.
 */
export function instrumented<
  R extends {
    readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
    readonly structuredContent?: Record<string, unknown>;
  },
>(tel: ToolTelemetry | undefined, toolName: string, startMs: number, result: R): R {
  if (tel !== undefined) {
    const sc = result.structuredContent;
    const isCoder = toolName === "coder";
    void recordToolCall(
      tel.store,
      {
        projectId: tel.projectId,
        tool: toolName,
        durationMs: Date.now() - startMs,
        resultBytes: sc !== undefined ? JSON.stringify(sc).length : 0,
        ...(isCoder && sc !== undefined && typeof sc.model === "string" ? { model: sc.model } : {}),
        ...(isCoder && sc !== undefined && typeof sc.text === "string"
          ? { draftChars: sc.text.length }
          : {}),
      },
      new Date().toISOString(),
    ).catch(() => {});
  }
  return result;
}
