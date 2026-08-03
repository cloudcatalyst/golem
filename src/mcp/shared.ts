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

export const sliderLevelInput = z
  .number()
  .int()
  .min(0)
  .max(5)
  .describe(
    "Slider level 0–3: 0 passthrough (no redaction — full bypass), 1 lossless, " +
      "2 balanced, 3 aggressive. Legacy 4/5 are accepted and mapped to 3.",
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
