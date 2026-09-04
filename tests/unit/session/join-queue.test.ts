/**
 * R13.7 — the join queue: redaction on the way in, exactly-once on the way out.
 *
 * The tests that matter here are the ones that describe failure honestly:
 * a refusal is a first-class outcome (invariant 3), a retry never doubles, and
 * a message that waited too long is expired rather than delivered late.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileJoinQueue,
  joinQueueDir,
  MAX_PENDING_PER_CONVERSATION,
  PENDING_TTL_MS,
  resolveFromSnapshot,
} from "../../../src/session/join-queue.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-join-queue-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const CONVERSATION = "a1b2c3d4e5f60718";

function queue(options: { now?: () => number; allow?: boolean } = {}): FileJoinQueue {
  return new FileJoinQueue({
    projectDir: dir,
    ...(options.now !== undefined ? { now: options.now } : {}),
    resolve: async () =>
      options.allow === false ? { ok: false, reason: "not addressable" } : { ok: true },
  });
}

describe("FileJoinQueue", () => {
  it("queues a message and reports it as pending", async () => {
    const result = await queue().enqueue({
      conversationId: CONVERSATION,
      deviceId: "phone-1",
      messageId: "m1",
      text: "run the tests",
    });
    expect(result.status).toBe("queued");
    const pending = await queue().pending(CONVERSATION);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.text).toBe("run the tests");
    expect(pending[0]?.deliveredAt).toBeUndefined();
  });

  it("REDACTS before storage — a secret in a message never reaches disk raw", async () => {
    const secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    await queue().enqueue({
      conversationId: CONVERSATION,
      deviceId: "phone-1",
      messageId: "m1",
      text: `use ${secret} to check`,
    });
    const file = path.join(joinQueueDir(dir), "pending", CONVERSATION);
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(file);
    const raw = await readFile(path.join(file, names[0] as string), "utf8");
    expect(raw).not.toContain(secret);
    const [stored] = await queue().pending(CONVERSATION);
    expect(stored?.text).not.toContain(secret);
  });

  it("claims exactly once — a second claim gets nothing", async () => {
    await queue().enqueue({
      conversationId: CONVERSATION,
      deviceId: "phone-1",
      messageId: "m1",
      text: "hello",
    });
    const first = await queue().claim(CONVERSATION);
    const second = await queue().claim(CONVERSATION);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(first[0]?.deliveredAt).toBeTypeOf("string");
  });

  it("does not double-deliver when two claimers race", async () => {
    for (const id of ["m1", "m2", "m3"]) {
      await queue().enqueue({
        conversationId: CONVERSATION,
        deviceId: "phone-1",
        messageId: id,
        text: `message ${id}`,
      });
    }
    // Two independent queue objects, as two processes would be.
    const [a, b] = await Promise.all([queue().claim(CONVERSATION), queue().claim(CONVERSATION)]);
    const ids = [...a, ...b].map((m) => m.messageId).sort();
    expect(ids).toEqual(["m1", "m2", "m3"]);
  });

  it("returns the original outcome for a repeated messageId rather than queueing twice", async () => {
    const input = {
      conversationId: CONVERSATION,
      deviceId: "phone-1",
      messageId: "m1",
      text: "hello",
    };
    await queue().enqueue(input);
    const again = await queue().enqueue({ ...input, text: "different text" });
    expect(again.status).toBe("duplicate");
    if (again.status === "duplicate") expect(again.message.text).toBe("hello");
    expect(await queue().pending(CONVERSATION)).toHaveLength(1);
  });

  it("still answers `duplicate` for an already-delivered id", async () => {
    const input = {
      conversationId: CONVERSATION,
      deviceId: "phone-1",
      messageId: "m1",
      text: "hello",
    };
    await queue().enqueue(input);
    await queue().claim(CONVERSATION);
    const again = await queue().enqueue(input);
    expect(again.status).toBe("duplicate");
    expect(await queue().pending(CONVERSATION)).toHaveLength(0);
  });

  it("refuses an unaddressable conversation rather than parking a message for it", async () => {
    const result = await queue({ allow: false }).enqueue({
      conversationId: CONVERSATION,
      deviceId: "phone-1",
      messageId: "m1",
      text: "hello",
    });
    expect(result.status).toBe("refused");
    expect(await queue().pending(CONVERSATION)).toHaveLength(0);
  });

  it("refuses ids that are not filesystem-safe — a messageId is client-supplied", async () => {
    for (const messageId of ["../escape", "a/b", "with space", ""]) {
      const result = await queue().enqueue({
        conversationId: CONVERSATION,
        deviceId: "phone-1",
        messageId,
        text: "hello",
      });
      expect(result.status).toBe("refused");
    }
  });

  it("refuses an empty message and one over the size limit", async () => {
    const empty = await queue().enqueue({
      conversationId: CONVERSATION,
      deviceId: "d",
      messageId: "m1",
      text: "   ",
    });
    expect(empty.status).toBe("refused");
    const huge = await queue().enqueue({
      conversationId: CONVERSATION,
      deviceId: "d",
      messageId: "m2",
      text: "x".repeat(40_000),
    });
    expect(huge.status).toBe("refused");
    if (huge.status === "refused") expect(huge.reason).toContain("too long");
  });

  it("caps how many messages one conversation may hold", async () => {
    for (let i = 0; i < MAX_PENDING_PER_CONVERSATION; i += 1) {
      const r = await queue().enqueue({
        conversationId: CONVERSATION,
        deviceId: "d",
        messageId: `m${i}`,
        text: "hello",
      });
      expect(r.status).toBe("queued");
    }
    const overflow = await queue().enqueue({
      conversationId: CONVERSATION,
      deviceId: "d",
      messageId: "one-too-many",
      text: "hello",
    });
    expect(overflow.status).toBe("refused");
  });

  it("EXPIRES a message that waited longer than the TTL instead of delivering it late", async () => {
    let clock = Date.parse("2026-09-03T09:00:00.000Z");
    const now = (): number => clock;
    await queue({ now }).enqueue({
      conversationId: CONVERSATION,
      deviceId: "phone-1",
      messageId: "stale",
      text: "deploy it",
    });
    clock += PENDING_TTL_MS + 60_000;
    const claimed = await queue({ now }).claim(CONVERSATION);
    expect(claimed).toHaveLength(0);
    // Claimed out of the queue all the same, so it can never land later.
    expect(await queue({ now }).pending(CONVERSATION)).toHaveLength(0);
    const all = await queue({ now }).list();
    expect(all[0]?.expiredAt).toBeTypeOf("string");
    expect(all[0]?.deliveredAt).toBeUndefined();
  });

  it("drops a waiting message on `forget`, and reports when there was nothing to drop", async () => {
    await queue().enqueue({
      conversationId: CONVERSATION,
      deviceId: "d",
      messageId: "m1",
      text: "hello",
    });
    expect(await queue().forget("m1")).toBe(true);
    expect(await queue().pending(CONVERSATION)).toHaveLength(0);
    expect(await queue().forget("m1")).toBe(false);
  });

  it("skips a corrupt queue file rather than delivering it", async () => {
    await queue().enqueue({
      conversationId: CONVERSATION,
      deviceId: "d",
      messageId: "good",
      text: "hello",
    });
    await writeFile(
      path.join(joinQueueDir(dir), "pending", CONVERSATION, "999-broken.json"),
      "{ not json",
      "utf8",
    );
    const claimed = await queue().claim(CONVERSATION);
    expect(claimed.map((m) => m.messageId)).toEqual(["good"]);
  });
});

describe("resolveFromSnapshot", () => {
  const base = {
    conversationId: CONVERSATION,
    firstSeenAt: "2026-09-03T09:00:00.000Z",
    lastRequestAt: "2026-09-03T09:00:00.000Z",
    messageCount: 4,
    requestCount: 2,
  };

  it("allows a live, unambiguous conversation", async () => {
    const verdict = await resolveFromSnapshot([{ ...base, ambiguous: false }])(CONVERSATION);
    expect(verdict.ok).toBe(true);
  });

  it("refuses an ambiguous one, naming why", async () => {
    const verdict = await resolveFromSnapshot([{ ...base, ambiguous: true }])(CONVERSATION);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("ambiguous");
  });

  it("refuses one the proxy has never seen", async () => {
    const verdict = await resolveFromSnapshot([])(CONVERSATION);
    expect(verdict.ok).toBe(false);
  });
});
