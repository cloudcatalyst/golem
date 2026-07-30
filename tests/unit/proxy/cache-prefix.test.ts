/**
 * R8.1 — cache-prefix fingerprinting and bust detection.
 *
 * The behaviour under test is the distinction that decides the bill: a normal
 * agentic turn (append) versus an edit to already-sent bytes (bust), and which
 * component to blame when the prefix breaks.
 */

import { describe, expect, it } from "vitest";
import {
  CachePrefixObserver,
  cachePrefixFingerprint,
  classifyPrefixChange,
} from "../../../src/proxy/cache-prefix.js";

const TOOLS = [{ name: "search", description: "find things", input_schema: { type: "object" } }];

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "claude-opus-5",
    tools: TOOLS,
    system: [{ type: "text", text: "You are helpful." }],
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ],
    ...over,
  };
}

describe("cachePrefixFingerprint", () => {
  it("is stable for identical bodies", () => {
    expect(cachePrefixFingerprint(body())).toEqual(cachePrefixFingerprint(body()));
  });

  it("ignores fields outside the cacheable prefix", () => {
    const a = cachePrefixFingerprint(body());
    const b = cachePrefixFingerprint(body({ max_tokens: 4096, stream: true, temperature: 0.7 }));
    expect(a).toEqual(b);
  });

  it("treats a missing key and an explicit undefined as the same", () => {
    const withoutTools = body();
    delete withoutTools.tools;
    expect(cachePrefixFingerprint(withoutTools).tools).toBe(
      cachePrefixFingerprint(body({ tools: undefined })).tools,
    );
  });

  it("keys the conversation on the first message, so it survives appends", () => {
    const one = cachePrefixFingerprint(body());
    const grown = cachePrefixFingerprint(
      body({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
          { role: "user", content: "third" },
        ],
      }),
    );
    expect(grown.conversationKey).toBe(one.conversationKey);
  });

  it("produces an empty conversation key when there are no messages", () => {
    expect(cachePrefixFingerprint({ messages: [] }).conversationKey).toBe("");
  });

  it("does not embed prompt content in the fingerprint", () => {
    const fp = cachePrefixFingerprint(body({ system: "SECRET-MARKER-STRING" }));
    expect(JSON.stringify(fp)).not.toContain("SECRET-MARKER-STRING");
  });
});

describe("classifyPrefixChange", () => {
  const base = cachePrefixFingerprint(body());

  it("reports `first` when there is nothing to compare", () => {
    const o = classifyPrefixChange(undefined, base);
    expect(o.verdict).toBe("first");
    expect(o.component).toBeUndefined();
  });

  it("reports `append` for an unchanged prefix with new messages", () => {
    const next = cachePrefixFingerprint(
      body({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
          { role: "user", content: "third" },
        ],
      }),
    );
    const o = classifyPrefixChange(base, next);
    expect(o.verdict).toBe("append");
    expect(o.detail).toContain("1 message(s) appended");
  });

  it("reports `append` for a byte-identical repeat", () => {
    const o = classifyPrefixChange(base, cachePrefixFingerprint(body()));
    expect(o.verdict).toBe("append");
    expect(o.detail).toContain("full cache hit");
  });

  it("blames `tools` when the tool block changes", () => {
    const next = cachePrefixFingerprint(body({ tools: [...TOOLS, { name: "extra" }] }));
    const o = classifyPrefixChange(base, next);
    expect(o.verdict).toBe("bust");
    expect(o.component).toBe("tools");
    expect(o.detail).toContain("renders first");
  });

  it("blames `tools` even when reordering preserves the set", () => {
    // Byte-identity is the cache key, so a reorder is a bust, not a no-op.
    const two = [TOOLS[0], { name: "b" }];
    const prev = cachePrefixFingerprint(body({ tools: two }));
    const next = cachePrefixFingerprint(body({ tools: [two[1], two[0]] }));
    expect(classifyPrefixChange(prev, next).component).toBe("tools");
  });

  it("blames `system` when only the system block changes", () => {
    const next = cachePrefixFingerprint(body({ system: [{ type: "text", text: "different" }] }));
    const o = classifyPrefixChange(base, next);
    expect(o.verdict).toBe("bust");
    expect(o.component).toBe("system");
  });

  it("prefers the EARLIEST change when several components differ", () => {
    // tools renders before system, and the earliest change is the expensive one.
    const next = cachePrefixFingerprint(
      body({ tools: [{ name: "other" }], system: [{ type: "text", text: "different" }] }),
    );
    expect(classifyPrefixChange(base, next).component).toBe("tools");
  });

  it("blames `messages` and names the turn when history is edited", () => {
    const next = cachePrefixFingerprint(
      body({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "EDITED" },
          { role: "user", content: "third" },
        ],
      }),
    );
    const o = classifyPrefixChange(base, next);
    expect(o.verdict).toBe("bust");
    expect(o.component).toBe("messages");
    expect(o.firstChangedMessage).toBe(1);
  });

  it("treats a shrinking history (compaction or rewind) as a bust", () => {
    const next = cachePrefixFingerprint(body({ messages: [{ role: "user", content: "first" }] }));
    const o = classifyPrefixChange(base, next);
    expect(o.verdict).toBe("bust");
    expect(o.component).toBe("messages");
    expect(o.firstChangedMessage).toBe(1);
    expect(o.detail).toContain("history shrank from 2 to 1");
  });

  it("always supplies a human-readable detail", () => {
    for (const o of [
      classifyPrefixChange(undefined, base),
      classifyPrefixChange(base, base),
      classifyPrefixChange(base, cachePrefixFingerprint(body({ tools: [] }))),
    ]) {
      expect(o.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("CachePrefixObserver", () => {
  it("reports first, then append, across a growing conversation", () => {
    const observer = new CachePrefixObserver();
    expect(observer.observe(body()).verdict).toBe("first");
    const grown = body({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
    });
    expect(observer.observe(grown).verdict).toBe("append");
  });

  it("detects a bust on the request that causes it", () => {
    const observer = new CachePrefixObserver();
    observer.observe(body());
    const o = observer.observe(body({ tools: [{ name: "changed" }] }));
    expect(o.verdict).toBe("bust");
    expect(o.component).toBe("tools");
  });

  it("re-baselines after a bust, so one change is not reported twice", () => {
    const observer = new CachePrefixObserver();
    observer.observe(body());
    const changed = body({ tools: [{ name: "changed" }] });
    expect(observer.observe(changed).verdict).toBe("bust");
    expect(observer.observe(changed).verdict).toBe("append");
  });

  it("tracks conversations independently", () => {
    const observer = new CachePrefixObserver();
    const convoA = body();
    const convoB = body({ messages: [{ role: "user", content: "a different opening" }] });
    expect(observer.observe(convoA).verdict).toBe("first");
    expect(observer.observe(convoB).verdict).toBe("first");
    expect(observer.observe(convoA).verdict).toBe("append");
    expect(observer.size()).toBe(2);
  });

  it("bounds memory by evicting the oldest conversation", () => {
    const observer = new CachePrefixObserver(2);
    observer.observe(body({ messages: [{ role: "user", content: "one" }] }));
    observer.observe(body({ messages: [{ role: "user", content: "two" }] }));
    observer.observe(body({ messages: [{ role: "user", content: "three" }] }));
    expect(observer.size()).toBe(2);
    // "one" was evicted, so it looks like a new conversation again.
    expect(observer.observe(body({ messages: [{ role: "user", content: "one" }] })).verdict).toBe(
      "first",
    );
  });

  it("never throws on a malformed body", () => {
    const observer = new CachePrefixObserver();
    expect(() => observer.observe({})).not.toThrow();
    expect(() => observer.observe({ messages: "not-an-array" })).not.toThrow();
    expect(() => observer.observe({ messages: [null] })).not.toThrow();
  });
});

/**
 * R8.13 / notes §104 — the regression suite for the bug §99 recorded.
 *
 * Claude Code moves its `cache_control` breakpoint to the newest block every turn,
 * so the previously-final message loses a key it used to carry. Hashing the message
 * as sent made that a `bust` at index `prevLen - 1` on EVERY turn — 142 busts, 3
 * firsts, 0 appends, against a billed 98.4% hit rate.
 *
 * Anthropic's docs are explicit that this still hits: "blocks that were previously
 * marked with a `cache_control` block are later not marked with this, but they will
 * still be considered a cache hit". A marker is not content.
 */
describe("cache_control is a marker, not content (§104)", () => {
  /** The exact live shape: the breakpoint rides the last block of the last message. */
  function turn(texts: readonly string[]): Record<string, unknown> {
    const messages = texts.map((text, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [
        i === texts.length - 1
          ? { type: "text", text, cache_control: { type: "ephemeral" } }
          : { type: "text", text },
      ],
    }));
    return { model: "claude-opus-5", tools: TOOLS, system: "You are helpful.", messages };
  }

  it("fingerprints a message identically whether or not it carries a breakpoint", () => {
    const marked = { role: "user", content: [{ type: "text", text: "hi" }] };
    const a = cachePrefixFingerprint({ messages: [marked] });
    const b = cachePrefixFingerprint({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
        },
      ],
    });
    expect(b.messages).toEqual(a.messages);
    expect(b.conversationKey).toBe(a.conversationKey);
    // The marker is excluded from the hash but still counted.
    expect(b.breakpoints).toBe(1);
    expect(a.breakpoints).toBe(0);
  });

  it("ignores a top-level (non-content-block) cache_control too", () => {
    const plain = cachePrefixFingerprint({ messages: [{ role: "user", content: "hi" }] });
    const marked = cachePrefixFingerprint({
      messages: [{ role: "user", content: "hi", cache_control: { type: "ephemeral" } }],
    });
    expect(marked.messages).toEqual(plain.messages);
  });

  it("excludes it from `system` and `tools` as well", () => {
    const plain = cachePrefixFingerprint({
      system: [{ type: "text", text: "S" }],
      tools: [{ name: "search", input_schema: { type: "object" } }],
    });
    const marked = cachePrefixFingerprint({
      system: [{ type: "text", text: "S", cache_control: { type: "ephemeral" } }],
      tools: [
        {
          name: "search",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
        },
      ],
    });
    expect(marked.system).toBe(plain.system);
    expect(marked.tools).toBe(plain.tools);
    expect(marked.breakpoints).toBe(2);
  });

  it("REGRESSION: a moving breakpoint over three turns is append, append — not bust", () => {
    const observer = new CachePrefixObserver();
    expect(observer.observe(turn(["a", "b", "c"])).verdict).toBe("first");
    // Turn 2 appends two messages; the breakpoint leaves "c" and lands on "e".
    expect(observer.observe(turn(["a", "b", "c", "d", "e"])).verdict).toBe("append");
    expect(observer.observe(turn(["a", "b", "c", "d", "e", "f", "g"])).verdict).toBe("append");
  });

  it("still catches a REAL edit to already-sent history", () => {
    const observer = new CachePrefixObserver();
    observer.observe(turn(["a", "b", "c"]));
    const edited = observer.observe(turn(["a", "CHANGED", "c", "d"]));
    expect(edited.verdict).toBe("bust");
    expect(edited.component).toBe("messages");
    expect(edited.firstChangedMessage).toBe(1);
    expect(edited.messageCount).toBe(4);
  });
});

/**
 * R8.13 / §104 — the second documented miss: a valid prefix the read cannot find.
 * A read walks back at most 20 block positions from the breakpoint, so appending
 * that many blocks in one turn steps over the previous write.
 */
describe("the 20-block lookback window", () => {
  /**
   * `perMessage` gives the block count per message. Breakpoints are attached to the
   * LAST block of an existing message rather than added as extra messages — an extra
   * message would shift indices and read as a content edit, not a lookback.
   */
  function blocks(perMessage: readonly number[], breakpoints = 1): Record<string, unknown> {
    const messages = perMessage.map((count, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: Array.from({ length: count }, (_, b) => ({ type: "text", text: `m${i}b${b}` })),
    }));
    const mark = (index: number): void => {
      const message = messages[index];
      if (message === undefined) return;
      const last = message.content[message.content.length - 1];
      if (last !== undefined) Object.assign(last, { cache_control: { type: "ephemeral" } });
    };
    if (breakpoints >= 1) mark(messages.length - 1);
    if (breakpoints >= 2) mark(0);
    return { messages };
  }

  it("counts content blocks per message, and 1 for a string content", () => {
    const fp = cachePrefixFingerprint({
      messages: [
        { role: "user", content: "plain string" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      ],
    });
    expect(fp.blockCounts).toEqual([1, 2]);
  });

  it("reports a lookback bust when a single turn appends 20+ blocks", () => {
    const observer = new CachePrefixObserver();
    observer.observe(blocks([1, 1]));
    const jump = observer.observe(blocks([1, 1, 20]));
    expect(jump.verdict).toBe("bust");
    expect(jump.component).toBe("lookback");
    // Nothing changed — the detail must not read like an edit.
    expect(jump.detail).toContain("lookback window");
    expect(jump.firstChangedMessage).toBeUndefined();
  });

  it("stays an append just under the window", () => {
    const observer = new CachePrefixObserver();
    observer.observe(blocks([1, 1]));
    expect(observer.observe(blocks([1, 1, 18])).verdict).toBe("append");
  });

  it("does not predict a lookback miss when a second breakpoint opens a second window", () => {
    const observer = new CachePrefixObserver();
    observer.observe(blocks([1, 1], 2));
    expect(observer.observe(blocks([1, 1, 30], 2)).verdict).toBe("append");
  });
});
