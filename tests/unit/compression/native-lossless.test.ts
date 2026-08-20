/**
 * A2 focused unit tests: dedup correctness (byte-identical retrieval),
 * prompt-cache prefix stability, and stats accounting.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CCR_MARKER_RE,
  ccrMarker,
  DEDUP_EXEMPT_TOOLS,
  NativeLosslessCompression,
  STAGE_COMPACTION,
  STAGE_DEDUP,
} from "../../../src/compression/index.js";
import type { Message } from "../../../src/interfaces/compression.js";
import { policyFor, tokensSaved } from "../../../src/interfaces/index.js";

const LEVEL_0 = policyFor("off");
const LEVEL_1 = policyFor(1);
const PROJECT = "unit-test-project";

/** Large, whitespace-clean payload (compaction is a no-op on it). */
const BIG = Array.from({ length: 40 }, (_, i) => `log line ${i}: something happened`).join("\n");
const OTHER = Array.from({ length: 40 }, (_, i) => `different line ${i}: other output`).join("\n");

function userText(text: string): Message {
  return { role: "user", content: text };
}

function assistantToolUse(id: string): Message {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "Reading the file." },
      { type: "tool_use", id, name: "read_file", input: { path: "big.log" } },
    ],
  };
}

function toolResult(id: string, content: string): Message {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content }],
  };
}

async function makeService(): Promise<NativeLosslessCompression> {
  const projectRoot = await mkdtemp(join(tmpdir(), "golem-a2-unit-"));
  return NativeLosslessCompression.forProjectDir(projectRoot);
}

function contentOfToolResult(message: Message): unknown {
  const blocks = message.content as ReadonlyArray<Record<string, unknown>>;
  return blocks[0]?.content;
}

describe("NativeLosslessCompression dedup", () => {
  it("replaces later exact repeats with a marker and keeps the first occurrence", async () => {
    const svc = await makeService();
    const messages: readonly Message[] = [
      userText("read the log twice"),
      assistantToolUse("toolu_a"),
      toolResult("toolu_a", BIG),
      assistantToolUse("toolu_b"),
      toolResult("toolu_b", BIG),
    ];
    const result = await svc.compress(messages, LEVEL_1, PROJECT);

    expect(result.refs).toHaveLength(1);
    const ref = result.refs[0];
    if (ref === undefined) throw new Error("expected a ref");
    expect(ref.contentType).toBe("text/plain");

    // First occurrence intact, second replaced by the marker.
    expect(contentOfToolResult(result.messagesOut[2] as Message)).toBe(BIG);
    const marker = contentOfToolResult(result.messagesOut[4] as Message);
    expect(marker).toBe(ccrMarker(ref.refId, ref.originalTokens));
    expect(CCR_MARKER_RE.exec(marker as string)?.[1]).toBe(ref.refId);

    // Dedup stage shows real savings.
    const dedup = result.stageSavings[STAGE_DEDUP];
    if (dedup === undefined) throw new Error("expected dedup stage savings");
    expect(tokensSaved(dedup)).toBeGreaterThan(0);
  });

  it("retrieve returns the byte-identical original", async () => {
    const svc = await makeService();
    const original = `${BIG}\r\n  trailing junk   \n\n\n\nend   `;
    const messages: readonly Message[] = [
      toolResult("toolu_a", original),
      toolResult("toolu_b", original),
    ];
    const result = await svc.compress(messages, LEVEL_1, PROJECT);
    expect(result.refs).toHaveLength(1);
    const ref = result.refs[0];
    if (ref === undefined) throw new Error("expected a ref");

    const retrieved = await svc.retrieve(ref);
    expect(retrieved.content).toBe(original); // exact bytes, pre-compaction
    expect(retrieved.ref).toStrictEqual(ref);
  });

  it("emits one ref even when content repeats three times", async () => {
    const svc = await makeService();
    const messages: readonly Message[] = [
      toolResult("t1", BIG),
      toolResult("t2", BIG),
      toolResult("t3", BIG),
    ];
    const result = await svc.compress(messages, LEVEL_1, PROJECT);
    expect(result.refs).toHaveLength(1);
    expect(contentOfToolResult(result.messagesOut[1] as Message)).toBe(
      contentOfToolResult(result.messagesOut[2] as Message),
    );
  });

  it("never dedups small content (marker would not pay for itself)", async () => {
    const svc = await makeService();
    const small = "short repeated output";
    const messages: readonly Message[] = [toolResult("t1", small), toolResult("t2", small)];
    const result = await svc.compress(messages, LEVEL_1, PROJECT);
    expect(result.refs).toHaveLength(0);
    expect(contentOfToolResult(result.messagesOut[1] as Message)).toBe(small);
  });

  it("leaves assistant messages byte-faithful even when they repeat content", async () => {
    const svc = await makeService();
    const assistantEcho: Message = {
      role: "assistant",
      content: [{ type: "text", text: BIG }],
    };
    const messages: readonly Message[] = [toolResult("t1", BIG), assistantEcho];
    const result = await svc.compress(messages, LEVEL_1, PROJECT);
    expect(result.messagesOut[1]).toBe(assistantEcho); // same object, untouched
    expect(result.refs).toHaveLength(0);
  });

  it("level 0 returns the input untouched with no refs", async () => {
    const svc = await makeService();
    const messages: readonly Message[] = [toolResult("t1", BIG), toolResult("t2", BIG)];
    const result = await svc.compress(messages, LEVEL_0, PROJECT);
    expect(result.messagesOut).toBe(messages);
    expect(result.refs).toHaveLength(0);
    expect(result.stageSavings).toStrictEqual({});
  });
});

describe("NativeLosslessCompression prefix stability (prompt-cache alignment)", () => {
  it("extending a conversation never changes earlier compressed messages", async () => {
    const svc = await makeService();
    const prefix: readonly Message[] = [
      userText("start"),
      assistantToolUse("toolu_a"),
      toolResult("toolu_a", BIG),
    ];
    const first = await svc.compress(prefix, LEVEL_1, PROJECT);

    const extended: readonly Message[] = [
      ...prefix,
      assistantToolUse("toolu_b"),
      toolResult("toolu_b", BIG), // duplicate of the prefix content
      assistantToolUse("toolu_c"),
      toolResult("toolu_c", OTHER),
    ];
    const second = await svc.compress(extended, LEVEL_1, PROJECT);

    // The previously-sent prefix is byte-identical on re-compression.
    expect(JSON.stringify(second.messagesOut.slice(0, prefix.length))).toBe(
      JSON.stringify(first.messagesOut),
    );
    // ...while the new duplicate in the suffix was still deduplicated.
    expect(second.refs).toHaveLength(1);
  });

  it("is deterministic across independent instances and stores", async () => {
    const conversation: readonly Message[] = [
      userText("start"),
      toolResult("t1", BIG),
      toolResult("t2", BIG),
      toolResult("t3", `${OTHER}\n\n\n\ntail   \n`),
    ];
    const a = await (await makeService()).compress(conversation, LEVEL_1, PROJECT);
    const b = await (await makeService()).compress(conversation, LEVEL_1, "another-project");
    expect(JSON.stringify(a.messagesOut)).toBe(JSON.stringify(b.messagesOut));
    expect(a.refs).toStrictEqual(b.refs);
  });
});

describe("NativeLosslessCompression stats accounting", () => {
  it("tracks requests, per-stage savings, and CCR counters per project", async () => {
    const svc = await makeService();
    const messages: readonly Message[] = [
      toolResult("t1", `${BIG}   \n\n\n\n${OTHER}   \n`), // compactable
      toolResult("t2", BIG),
      toolResult("t3", BIG), // duplicate
    ];
    const result = await svc.compress(messages, LEVEL_1, "p1");
    expect(result.refs).toHaveLength(1);
    const ref = result.refs[0];
    if (ref === undefined) throw new Error("expected a ref");

    let stats = await svc.stats("p1");
    expect(stats.projectId).toBe("p1");
    expect(stats.requests).toBe(1);
    expect(stats.tokensBefore).toBeGreaterThan(stats.tokensAfter);
    const dedup = stats.perStage[STAGE_DEDUP];
    const compaction = stats.perStage[STAGE_COMPACTION];
    if (dedup === undefined || compaction === undefined) {
      throw new Error("expected both stage entries");
    }
    expect(tokensSaved(dedup)).toBeGreaterThan(0);
    expect(tokensSaved(compaction)).toBeGreaterThan(0);
    expect(stats.ccrRefsStored).toBe(1);
    expect(stats.ccrRefsRetrieved).toBe(0);

    // Retrieval is counted and attributed to the emitting project.
    await svc.retrieve(ref);
    stats = await svc.stats("p1");
    expect(stats.ccrRefsRetrieved).toBe(1);

    // Re-compressing stores nothing new (content-addressed).
    await svc.compress(messages, LEVEL_1, "p1");
    stats = await svc.stats("p1");
    expect(stats.requests).toBe(2);
    expect(stats.ccrRefsStored).toBe(1);

    // Other projects are isolated; the aggregate view is unscoped.
    const other = await svc.stats("untouched-project");
    expect(other.requests).toBe(0);
    expect(other.ccrRefsStored).toBe(0);
    const aggregate = await svc.stats();
    expect(aggregate.projectId).toBeNull();
    expect(aggregate.requests).toBe(2);
    expect(aggregate.tokensBefore).toBeGreaterThanOrEqual(aggregate.tokensAfter);
  });
});

/**
 * R9.23 — a tool SCHEMA must never be replaced by a reference.
 *
 * Hit live twice (2026-08-10, 2026-08-13). Under snooze enforcement the only
 * permitted call is `mcp__golem__snooze`, which is deferred — so its schema has to
 * be loaded with `ToolSearch` first. Every such response came back elided, and
 * `expand` (the way back) is itself deferred and denied by enforcement. The agent
 * could not park, so the note meant to survive the session was never written.
 *
 * The dedup keys on the response BODY, which is why no rephrasing escaped it: four
 * different query spellings produced one hash within a session.
 */
describe("NativeLosslessCompression tool-schema exemption (R9.23)", () => {
  /** A ToolSearch response: two spellings, one body — the live collision. */
  const SCHEMA = JSON.stringify({
    functions: [
      {
        name: "mcp__golem__snooze",
        description: "Park the session at the usage limit.".repeat(8),
        parameters: {
          type: "object",
          properties: {
            until: { type: "string", description: "ISO reset time from the rate-limit headers." },
            note: { type: "string", description: "Where you are up to plus next steps." },
          },
          required: ["until"],
        },
      },
    ],
  });

  function toolSearchCall(id: string, query: string): Message {
    return {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "ToolSearch", input: { query, max_results: 5 } }],
    };
  }

  it("never elides a repeated ToolSearch response, however identical", async () => {
    // Long enough to be a dedup candidate, so the exemption is what spares it.
    expect(SCHEMA.length).toBeGreaterThan(256);

    const svc = await makeService();
    const messages: readonly Message[] = [
      userText("park the session"),
      toolSearchCall("toolu_ts1", "select:mcp__golem__snooze"),
      toolResult("toolu_ts1", SCHEMA),
      // A different spelling that resolves to the same tool — the exact live case.
      toolSearchCall("toolu_ts2", "snooze park usage limit until note"),
      toolResult("toolu_ts2", SCHEMA),
    ];
    const result = await svc.compress(messages, LEVEL_1, PROJECT);

    // BOTH schemas arrive intact. The second one carrying a marker instead is the
    // deadlock: the agent cannot read the contract for the only call it may make.
    expect(contentOfToolResult(result.messagesOut[2] as Message)).toBe(SCHEMA);
    expect(contentOfToolResult(result.messagesOut[4] as Message)).toBe(SCHEMA);
    expect(JSON.stringify(result.messagesOut)).not.toMatch(CCR_MARKER_RE);
    expect(result.refs).toHaveLength(0);
  });

  /**
   * The control. Without it the test above could pass because dedup stopped
   * working at all, which is how a green suite hides a broken stage.
   */
  it("still elides the same repeat when the tool is not exempt", async () => {
    const svc = await makeService();
    const messages: readonly Message[] = [
      userText("read it twice"),
      assistantToolUse("toolu_a"),
      toolResult("toolu_a", SCHEMA),
      assistantToolUse("toolu_b"),
      toolResult("toolu_b", SCHEMA),
    ];
    const result = await svc.compress(messages, LEVEL_1, PROJECT);

    expect(contentOfToolResult(result.messagesOut[2] as Message)).toBe(SCHEMA);
    expect(String(contentOfToolResult(result.messagesOut[4] as Message))).toMatch(CCR_MARKER_RE);
    expect(result.refs).toHaveLength(1);
  });

  it("does not let an exempt result become the first occurrence that elides others", async () => {
    // The trap one level along: if a schema seeded the seen-set, a later
    // non-exempt duplicate would be elided against content that was never
    // itself replaceable. Both must survive.
    const svc = await makeService();
    const messages: readonly Message[] = [
      userText("schema first, then a read of the same bytes"),
      toolSearchCall("toolu_ts", "select:mcp__golem__snooze"),
      toolResult("toolu_ts", SCHEMA),
      assistantToolUse("toolu_r"),
      toolResult("toolu_r", SCHEMA),
    ];
    const result = await svc.compress(messages, LEVEL_1, PROJECT);

    expect(contentOfToolResult(result.messagesOut[2] as Message)).toBe(SCHEMA);
    expect(contentOfToolResult(result.messagesOut[4] as Message)).toBe(SCHEMA);
    expect(result.refs).toHaveLength(0);
  });

  it("exempts a block-array tool_result too, not just a string one", async () => {
    // ToolSearch results arrive as `content: [{type:"text",…}]` as often as a bare
    // string, and an exemption that only covered one shape would be a coin flip.
    const svc = await makeService();
    const blockResult = (id: string): Message => ({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: id, content: [{ type: "text", text: SCHEMA }] },
      ],
    });
    const messages: readonly Message[] = [
      userText("park"),
      toolSearchCall("toolu_b1", "+snooze"),
      blockResult("toolu_b1"),
      toolSearchCall("toolu_b2", "select:mcp__golem__snooze"),
      blockResult("toolu_b2"),
    ];
    const result = await svc.compress(messages, LEVEL_1, PROJECT);
    expect(JSON.stringify(result.messagesOut)).not.toMatch(CCR_MARKER_RE);
  });

  it("keeps prefix bytes stable when the conversation is extended", async () => {
    // The determinism obligation in the module doc: the exemption reads the
    // PREFIX (a tool_result's tool_use always precedes it), so appending turns
    // must not change earlier bytes — a prompt-cache miss on every park otherwise.
    const svc = await makeService();
    const prefix: readonly Message[] = [
      userText("park the session"),
      toolSearchCall("toolu_ts1", "select:mcp__golem__snooze"),
      toolResult("toolu_ts1", SCHEMA),
    ];
    const first = await svc.compress(prefix, LEVEL_1, PROJECT);
    const extended = await svc.compress(
      [...prefix, toolSearchCall("toolu_ts2", "+snooze"), toolResult("toolu_ts2", SCHEMA)],
      LEVEL_1,
      PROJECT,
    );
    expect(JSON.stringify(extended.messagesOut.slice(0, 3))).toBe(
      JSON.stringify(first.messagesOut),
    );
  });

  it("names the exempt tools so the list is reviewable", () => {
    expect(DEDUP_EXEMPT_TOOLS).toContain("ToolSearch");
  });
});
