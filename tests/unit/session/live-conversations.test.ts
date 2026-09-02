/**
 * R13.7 — the live-conversation registry, and the §99 collision it exists for.
 *
 * The load-bearing assertion is the ambiguous one: two conversations that open
 * with an identical first message share a conversation key, and the registry
 * must say so rather than let a message be delivered to whichever it happened to
 * pick (ADR-0007 invariant 3).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IDLE_AFTER_MS,
  LiveConversationRegistry,
  readLiveConversations,
} from "../../../src/session/live-conversations.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-live-conv-"));
});

afterEach(async () => {
  // `maxRetries` because the registry writes snapshots fire-and-forget: a write
  // can land between this rmdir's readdir and its unlink.
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

function body(messages: readonly unknown[], system = "sys"): Record<string, unknown> {
  return { model: "claude-opus-5", system, messages };
}

const HELLO = { role: "user", content: "hello" };

describe("LiveConversationRegistry", () => {
  it("records a conversation and reports it addressable", () => {
    const registry = new LiveConversationRegistry({});
    registry.observe(body([HELLO]));
    const [conversation] = registry.list();
    expect(conversation?.messageCount).toBe(1);
    expect(conversation?.ambiguous).toBe(false);
    expect(registry.addressable(conversation?.conversationId ?? "").ok).toBe(true);
  });

  it("treats a growing message chain as ONE conversation", () => {
    const registry = new LiveConversationRegistry({});
    registry.observe(body([HELLO]));
    registry.observe(body([HELLO, { role: "assistant", content: "hi" }]));
    registry.observe(
      body([HELLO, { role: "assistant", content: "hi" }, { role: "user", content: "more" }]),
    );
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.ambiguous).toBe(false);
    expect(registry.list()[0]?.requestCount).toBe(3);
  });

  it("treats a REWOUND chain as the same conversation, not a second one", () => {
    const registry = new LiveConversationRegistry({});
    registry.observe(body([HELLO, { role: "assistant", content: "hi" }]));
    registry.observe(body([HELLO]));
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.ambiguous).toBe(false);
  });

  it("marks a key AMBIGUOUS when two conversations diverge under it (§99)", () => {
    const registry = new LiveConversationRegistry({});
    registry.observe(body([HELLO, { role: "assistant", content: "one" }]));
    registry.observe(body([HELLO, { role: "assistant", content: "two" }]));
    const [conversation] = registry.list();
    expect(conversation?.ambiguous).toBe(true);
    const verdict = registry.addressable(conversation?.conversationId ?? "");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("ambiguous");
  });

  it("becomes addressable again once one of the two collides goes idle", () => {
    let clock = Date.parse("2026-09-03T09:00:00.000Z");
    const registry = new LiveConversationRegistry({ now: () => clock });
    registry.observe(body([HELLO, { role: "assistant", content: "one" }]));
    registry.observe(body([HELLO, { role: "assistant", content: "two" }]));
    expect(registry.list()[0]?.ambiguous).toBe(true);

    // Only the second one keeps running.
    clock += IDLE_AFTER_MS + 60_000;
    registry.observe(body([HELLO, { role: "assistant", content: "two" }]));
    expect(registry.list()[0]?.ambiguous).toBe(false);
  });

  it("refuses a conversation it has never seen", () => {
    const registry = new LiveConversationRegistry({});
    const verdict = registry.addressable("deadbeefdeadbeef");
    expect(verdict.ok).toBe(false);
  });

  it("ignores a request with no messages — there is nothing to address", () => {
    const registry = new LiveConversationRegistry({});
    registry.observe(body([]));
    expect(registry.list()).toHaveLength(0);
  });

  it("writes a snapshot another PROCESS can read, holding no prompt content", async () => {
    const registry = new LiveConversationRegistry({ projectDir: dir });
    registry.observe(body([{ role: "user", content: "my secret plan" }]));
    await registry.flush();

    const snapshot = await readLiveConversations(dir);
    expect(snapshot).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("secret plan");
  });

  it("reads back nothing when every conversation in the snapshot has gone idle", async () => {
    let clock = Date.parse("2026-09-03T09:00:00.000Z");
    const registry = new LiveConversationRegistry({ projectDir: dir, now: () => clock });
    registry.observe(body([HELLO]));
    await registry.flush();
    expect(await readLiveConversations(dir, { now: () => clock })).toHaveLength(1);

    clock += IDLE_AFTER_MS + 60_000;
    expect(await readLiveConversations(dir, { now: () => clock })).toHaveLength(0);
  });

  it("reads back nothing when there is no snapshot at all", async () => {
    expect(await readLiveConversations(path.join(dir, "nope"))).toHaveLength(0);
  });
});
