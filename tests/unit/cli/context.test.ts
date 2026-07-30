/**
 * R8.4 — context-ledger rendering.
 *
 * The assertions to care about: "no data" says so instead of drawing an empty
 * table, tool names reach the output (that is the whole actionability of the
 * report), and the closing note explains *why* a big block matters — it is
 * re-read every turn, per §93.
 */

import { describe, expect, it } from "vitest";
import { renderContextLedger } from "../../../src/cli/context.js";
import { buildContextLedger, type ContextLedger } from "../../../src/proxy/index.js";

function ledger(body: Record<string, unknown>): ContextLedger {
  return { ...buildContextLedger(body), capturedAt: "2026-07-30T12:00:00.000Z" };
}

const LONG = "x".repeat(4000);

describe("renderContextLedger", () => {
  it("says there is no ledger rather than rendering an empty report", () => {
    const out = renderContextLedger(null);
    expect(out).toContain("No ledger recorded yet");
    expect(out).toContain("full bypass");
    expect(out).not.toContain("By bucket:");
  });

  it("shows buckets sorted by size with shares", () => {
    const out = renderContextLedger(
      ledger({
        system: "s".repeat(400),
        messages: [{ role: "user", content: [{ type: "text", text: LONG }] }],
      }),
    );
    expect(out).toContain("By bucket:");
    expect(out).toContain("user text");
    expect(out).toContain("system prompt");
    // Largest bucket first: user text (4000 chars) before system (400).
    expect(out.indexOf("user text")).toBeLessThan(out.indexOf("system prompt"));
    expect(out).toMatch(/\d+\.\d%/);
  });

  it("names the tools responsible for tool_result bulk", () => {
    const out = renderContextLedger(
      ledger({
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "Grep", input: {} }],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: LONG }] },
        ],
      }),
    );
    expect(out).toContain("Tool results by tool");
    expect(out).toContain("Grep");
    expect(out).toContain("across 1 result(s)");
    expect(out).toContain("Grep result");
  });

  it("omits the per-tool section when nothing resolved", () => {
    const out = renderContextLedger(
      ledger({ messages: [{ role: "user", content: [{ type: "text", text: LONG }] }] }),
    );
    expect(out).not.toContain("Tool results by tool");
  });

  it("labels request-level blocks distinctly from message blocks", () => {
    const out = renderContextLedger(
      ledger({
        tools: [{ name: "search", description: LONG }],
        messages: [{ role: "user", content: [{ type: "text", text: LONG }] }],
      }),
    );
    expect(out).toContain("request-level");
    expect(out).toContain("message 0");
  });

  it("explains that these tokens are re-read every turn, and that counts are estimates", () => {
    const out = renderContextLedger(ledger({ messages: [{ role: "user", content: "hello" }] }));
    expect(out).toContain("EVERY subsequent turn");
    expect(out).toContain("estimates");
    expect(out).toContain("no prompt content is stored");
  });

  it("attributes the tools block by owner, and says which rows Golem may touch", () => {
    const out = renderContextLedger(
      ledger({
        tools: [
          { name: "mcp__golem__search", description: "d".repeat(200), input_schema: {} },
          { name: "Read", description: "r".repeat(900), input_schema: {} },
          { name: "mcp__context7__query-docs", description: "q", input_schema: {} },
        ],
        messages: [],
      }),
    );
    expect(out).toContain("Tool definitions");
    expect(out).toContain("Golem MCP tools");
    expect(out).toContain("other MCP servers");
    expect(out).toContain("client built-ins");
    // The honesty line: an 18.8k ceiling is not an 18.8k lever (§95).
    expect(out).toContain("Only the Golem rows");
    // The split that says which half a shrinker should attack (§89).
    expect(out).toContain("input schemas");
    expect(out).toContain("mcp__golem__search");
  });

  it("flags deferred definitions only when some are deferred", () => {
    const deferred = renderContextLedger(
      ledger({
        tools: [
          { name: "a", description: "x", input_schema: {}, defer_loading: true },
          { name: "b", description: "y", input_schema: {} },
        ],
        messages: [],
      }),
    );
    expect(deferred).toContain("defer_loading");
    expect(deferred).toContain("[deferred]");

    const plain = renderContextLedger(
      ledger({ tools: [{ name: "b", description: "y", input_schema: {} }], messages: [] }),
    );
    expect(plain).not.toContain("defer_loading");
  });

  it("omits the tools section entirely when the request carried no tools", () => {
    const out = renderContextLedger(ledger({ messages: [{ role: "user", content: LONG }] }));
    expect(out).not.toContain("Tool definitions —");
  });

  it("renders a header with the capture time and message count", () => {
    const out = renderContextLedger(
      ledger({
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
        ],
      }),
    );
    expect(out).toContain("2026-07-30T12:00:00.000Z");
    expect(out).toContain("2 message(s)");
  });
});
