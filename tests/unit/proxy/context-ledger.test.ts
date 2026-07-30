/**
 * R8.4 — context attribution.
 *
 * The load-bearing behaviour is `tool_use_id` → tool-name resolution: without it
 * the biggest consumer of an agentic context is an anonymous blob, and the whole
 * report becomes unactionable. Everything else is bucketing and tolerance.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildContextLedger,
  contextLedgerPath,
  readContextLedger,
  toolOrigin,
  writeContextLedger,
} from "../../../src/proxy/context-ledger.js";
import { rmTemp } from "../../helpers/tmp.js";

const LONG = "x".repeat(4000);

describe("buildContextLedger", () => {
  it("attributes request-level tools and system", () => {
    const ledger = buildContextLedger({
      tools: [{ name: "search", description: LONG }],
      system: [{ type: "text", text: LONG }],
      messages: [],
    });
    expect(ledger.buckets.tools).toBeGreaterThan(0);
    expect(ledger.buckets.system).toBeGreaterThan(0);
    expect(ledger.messages).toBe(0);
    // Request-level blocks are marked with index -1, not 0 (0 is a real message).
    expect(ledger.largest.every((b) => b.messageIndex === -1)).toBe(true);
  });

  it("splits text by role", () => {
    const ledger = buildContextLedger({
      messages: [
        { role: "user", content: [{ type: "text", text: LONG }] },
        { role: "assistant", content: [{ type: "text", text: LONG }] },
      ],
    });
    expect(ledger.buckets.userText).toBeGreaterThan(0);
    expect(ledger.buckets.assistantText).toBeGreaterThan(0);
  });

  it("handles a plain string content", () => {
    const ledger = buildContextLedger({
      messages: [
        { role: "user", content: LONG },
        { role: "assistant", content: LONG },
      ],
    });
    expect(ledger.buckets.userText).toBeGreaterThan(0);
    expect(ledger.buckets.assistantText).toBeGreaterThan(0);
    expect(ledger.buckets.other).toBe(0);
  });

  it("resolves tool_result blocks back to the tool that produced them", () => {
    const ledger = buildContextLedger({
      messages: [
        { role: "user", content: [{ type: "text", text: "find it" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { path: "a.ts" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: LONG }],
        },
      ],
    });
    expect(ledger.perTool).toHaveLength(1);
    expect(ledger.perTool[0]?.tool).toBe("Read");
    expect(ledger.perTool[0]?.results).toBe(1);
    expect(ledger.perTool[0]?.tokens).toBeGreaterThan(0);
    expect(ledger.largest.some((b) => b.tool === "Read")).toBe(true);
  });

  it("groups repeated results from the same tool and sorts tools by tokens", () => {
    const ledger = buildContextLedger({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "g1", name: "Grep", input: {} },
            { type: "tool_use", id: "g2", name: "Grep", input: {} },
            { type: "tool_use", id: "r1", name: "Read", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "g1", content: "short" },
            { type: "tool_result", tool_use_id: "g2", content: "short" },
            { type: "tool_result", tool_use_id: "r1", content: LONG },
          ],
        },
      ],
    });
    expect(ledger.perTool.map((r) => r.tool)).toEqual(["Read", "Grep"]);
    expect(ledger.perTool.find((r) => r.tool === "Grep")?.results).toBe(2);
  });

  it("still buckets a tool_result whose tool_use is missing, without inventing a name", () => {
    const ledger = buildContextLedger({
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "unknown", content: LONG }] },
      ],
    });
    expect(ledger.buckets.toolResult).toBeGreaterThan(0);
    expect(ledger.perTool).toHaveLength(0);
    expect(ledger.largest[0]?.tool).toBeUndefined();
  });

  it("buckets thinking and images separately", () => {
    const ledger = buildContextLedger({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: LONG },
            { type: "redacted_thinking", data: "abc" },
          ],
        },
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", data: LONG } }],
        },
      ],
    });
    expect(ledger.buckets.thinking).toBeGreaterThan(0);
    expect(ledger.buckets.image).toBeGreaterThan(0);
  });

  it("counts tool_use blocks as assistant output, not as tool results", () => {
    const ledger = buildContextLedger({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "a", name: "X", input: { LONG } }] },
      ],
    });
    expect(ledger.buckets.assistantText).toBeGreaterThan(0);
    expect(ledger.buckets.toolResult).toBe(0);
  });

  it("sorts the largest blocks descending and caps the list", () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: "user",
      content: [{ type: "text", text: "y".repeat((i + 1) * 100) }],
    }));
    const ledger = buildContextLedger({ messages });
    expect(ledger.largest.length).toBeLessThanOrEqual(8);
    const tokens = ledger.largest.map((b) => b.tokens);
    expect([...tokens].sort((a, b) => b - a)).toEqual(tokens);
  });

  it("puts unrecognised blocks in `other` rather than throwing", () => {
    const ledger = buildContextLedger({
      messages: [
        { role: "user", content: [{ type: "some_future_block_type", payload: LONG }] },
        "not-an-object",
        { role: "user", content: 42 },
      ],
    });
    expect(ledger.buckets.other).toBeGreaterThan(0);
    expect(ledger.messages).toBe(3);
  });

  it("never throws on a malformed body", () => {
    expect(() => buildContextLedger({})).not.toThrow();
    expect(() => buildContextLedger({ messages: "nope" })).not.toThrow();
    expect(() => buildContextLedger({ messages: [null, undefined] })).not.toThrow();
  });

  it("stores no prompt content", () => {
    const ledger = buildContextLedger({
      system: "SECRET-MARKER",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "SECRET-2" }] },
      ],
    });
    const json = JSON.stringify(ledger);
    expect(json).not.toContain("SECRET-MARKER");
    expect(json).not.toContain("SECRET-2");
    // Tool NAMES are schema identifiers and are deliberately kept.
    expect(json).toContain("Read");
  });

  it("reports a total for the whole serialized body, not just the sum of buckets", () => {
    const ledger = buildContextLedger({
      model: "claude-opus-5",
      max_tokens: 4096,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    const bucketSum = Object.values(ledger.buckets).reduce((a, b) => a + b, 0);
    expect(ledger.totalTokens).toBeGreaterThanOrEqual(bucketSum);
  });
});

/**
 * R8.S1 — the `tools` block decomposition.
 *
 * The load-bearing behaviour here is *ownership*: §95's 18.8k aggregate promoted a
 * shrinker without saying whose tokens they were, and a shrinker aimed at the
 * client's built-ins is a fidelity change rather than a dial. So the origin split
 * and the description/schema split are what these tests pin down.
 */
describe("toolOrigin", () => {
  it("reads ownership off Claude Code's MCP namespacing", () => {
    expect(toolOrigin("mcp__golem__search")).toBe("golem");
    expect(toolOrigin("mcp__context7__query-docs")).toBe("mcp");
    expect(toolOrigin("Read")).toBe("builtin");
    // A server tool is not Golem's either, and must not be mistaken for one.
    expect(toolOrigin("tool_search_tool_bm25_20251119")).toBe("builtin");
  });

  it("does not treat a lookalike name as Golem's", () => {
    expect(toolOrigin("mcp__golemish__thing")).toBe("mcp");
    expect(toolOrigin("golem_search")).toBe("builtin");
  });
});

describe("buildContextLedger — tools block", () => {
  const body = {
    tools: [
      {
        name: "mcp__golem__search",
        description: "d".repeat(400),
        input_schema: { type: "object", properties: { query: { type: "string" } } },
      },
      { name: "Read", description: "r".repeat(800), input_schema: { type: "object" } },
      {
        name: "mcp__context7__query-docs",
        description: "q".repeat(200),
        input_schema: { type: "object" },
        defer_loading: true,
      },
    ],
    messages: [],
  };

  it("splits the block by origin", () => {
    const block = buildContextLedger(body).toolsBlock;
    expect(block).toBeDefined();
    expect(block?.count).toBe(3);
    const origins = Object.fromEntries((block?.byOrigin ?? []).map((r) => [r.origin, r]));
    expect(origins.golem?.count).toBe(1);
    expect(origins.mcp?.count).toBe(1);
    expect(origins.builtin?.count).toBe(1);
    // `Read` has the longest description, so the client owns the most tokens here.
    expect(origins.builtin?.tokens).toBeGreaterThan(origins.golem?.tokens ?? 0);
  });

  it("splits each definition into description, schema, and other", () => {
    const block = buildContextLedger(body).toolsBlock;
    const read = block?.tools.find((t) => t.name === "Read");
    expect(read?.descriptionTokens).toBeGreaterThan(0);
    expect(read?.schemaTokens).toBeGreaterThan(0);
    // The parts are estimated independently of the whole, so the remainder must
    // never go negative — that would make the split look free.
    for (const tool of block?.tools ?? []) {
      expect(tool.otherTokens).toBeGreaterThanOrEqual(0);
      expect(tool.descriptionTokens + tool.schemaTokens).toBeLessThanOrEqual(tool.tokens);
    }
    expect(block?.descriptionTokens).toBe(
      (block?.tools ?? []).reduce((n, t) => n + t.descriptionTokens, 0),
    );
  });

  it("counts deferred definitions", () => {
    const block = buildContextLedger(body).toolsBlock;
    expect(block?.deferred).toBe(1);
    expect(block?.tools.find((t) => t.name === "mcp__context7__query-docs")?.deferred).toBe(true);
    expect(block?.tools.find((t) => t.name === "Read")?.deferred).toBe(false);
  });

  it("accepts the MCP `inputSchema` spelling as well as the wire `input_schema`", () => {
    const block = buildContextLedger({
      tools: [
        { name: "x", inputSchema: { type: "object", properties: { a: { type: "string" } } } },
      ],
      messages: [],
    }).toolsBlock;
    expect(block?.tools[0]?.schemaTokens).toBeGreaterThan(0);
  });

  it("sorts definitions largest first", () => {
    const block = buildContextLedger(body).toolsBlock;
    const tokens = (block?.tools ?? []).map((t) => t.tokens);
    expect([...tokens].sort((a, b) => b - a)).toEqual(tokens);
  });

  it("agrees with the `tools` bucket", () => {
    const ledger = buildContextLedger(body);
    expect(ledger.toolsBlock?.tokens).toBe(ledger.buckets.tools);
  });

  it("records absence rather than a row of zeros", () => {
    expect(buildContextLedger({ messages: [] }).toolsBlock).toBeUndefined();
    expect(buildContextLedger({ tools: [], messages: [] }).toolsBlock).toBeUndefined();
    expect(buildContextLedger({ tools: "nope", messages: [] }).toolsBlock).toBeUndefined();
  });

  it("counts an unrecognised definition instead of dropping it", () => {
    const block = buildContextLedger({ tools: ["not-an-object"], messages: [] }).toolsBlock;
    expect(block?.count).toBe(1);
    expect(block?.tools[0]?.name).toBe("(unrecognised)");
    expect(block?.otherTokens).toBeGreaterThan(0);
  });

  it("stores tool names but no description or schema content", () => {
    const json = JSON.stringify(
      buildContextLedger({
        tools: [
          {
            name: "mcp__golem__search",
            description: "SECRET-DESC",
            input_schema: { properties: { SECRET_PROP: { type: "string" } } },
          },
        ],
        messages: [],
      }),
    );
    expect(json).toContain("mcp__golem__search");
    expect(json).not.toContain("SECRET-DESC");
    expect(json).not.toContain("SECRET_PROP");
  });
});

describe("context ledger persistence", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-ctx-ledger-"));
  });

  afterEach(async () => {
    await rm(dir, rmTemp);
  });

  it("round-trips through the state file, stamping capturedAt at write time", async () => {
    const core = buildContextLedger({ messages: [{ role: "user", content: "hello" }] });
    await writeContextLedger(dir, core, "2026-07-30T12:00:00.000Z");
    const read = await readContextLedger(dir);
    expect(read?.capturedAt).toBe("2026-07-30T12:00:00.000Z");
    expect(read?.messages).toBe(1);
  });

  it("returns null when no ledger has been written", async () => {
    expect(await readContextLedger(dir)).toBeNull();
  });

  it("returns null on a corrupt file rather than throwing", async () => {
    const file = contextLedgerPath(dir);
    await mkdtemp(path.join(tmpdir(), "unused-"));
    await writeContextLedger(dir, buildContextLedger({ messages: [] }), "2026-07-30T12:00:00.000Z");
    await writeFile(file, "{ not json", "utf8");
    expect(await readContextLedger(dir)).toBeNull();
  });

  it("still reads a ledger written before the tools block existed", async () => {
    // `toolsBlock` is optional precisely so an added field cannot discard a whole
    // ledger through the schema-drift null path.
    const file = contextLedgerPath(dir);
    await writeContextLedger(dir, buildContextLedger({ messages: [] }), "t");
    const legacy = {
      totalTokens: 10,
      messages: 1,
      buckets: {
        tools: 0,
        system: 0,
        userText: 10,
        assistantText: 0,
        thinking: 0,
        toolResult: 0,
        image: 0,
        other: 0,
      },
      largest: [],
      perTool: [],
      capturedAt: "2026-07-29T00:00:00.000Z",
    };
    await writeFile(file, JSON.stringify(legacy), "utf8");
    const read = await readContextLedger(dir);
    expect(read?.capturedAt).toBe("2026-07-29T00:00:00.000Z");
    expect(read?.toolsBlock).toBeUndefined();
  });

  it("round-trips the tools block", async () => {
    const core = buildContextLedger({
      tools: [{ name: "mcp__golem__search", description: "d", input_schema: { type: "object" } }],
      messages: [],
    });
    await writeContextLedger(dir, core, "2026-07-30T12:00:00.000Z");
    const read = await readContextLedger(dir);
    expect(read?.toolsBlock?.count).toBe(1);
    expect(read?.toolsBlock?.tools[0]?.origin).toBe("golem");
  });

  it("returns null when the file does not match the schema", async () => {
    await writeContextLedger(dir, buildContextLedger({ messages: [] }), "t");
    await writeFile(contextLedgerPath(dir), JSON.stringify({ unexpected: true }), "utf8");
    expect(await readContextLedger(dir)).toBeNull();
  });
});
