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

  it("returns null when the file does not match the schema", async () => {
    await writeContextLedger(dir, buildContextLedger({ messages: [] }), "t");
    await writeFile(contextLedgerPath(dir), JSON.stringify({ unexpected: true }), "utf8");
    expect(await readContextLedger(dir)).toBeNull();
  });
});
