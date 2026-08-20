/**
 * Shared helpers for the Golem MCP server modules.
 *
 * Extracted from server.ts (R8.28) so the per-concern modules can use them
 * without creating a circular dependency.
 */

import { recordToolCall, type TelemetryStore } from "../telemetry/index.js";
import { VERSION } from "../version.js";

export const GOLEM_MCP_SERVER_NAME = "golem";

/**
 * Advertised in the MCP initialize handshake. Tracks the package version
 * (Decision 41a: package.json is the single source of truth, propagated to
 * `version.ts` by `npm run sync-version`) rather than a separately hand-bumped
 * literal — a hardcoded one sat at "0.1.0" through eighteen minor releases,
 * telling every connecting client the wrong thing.
 */
export const GOLEM_MCP_SERVER_VERSION = VERSION;

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
