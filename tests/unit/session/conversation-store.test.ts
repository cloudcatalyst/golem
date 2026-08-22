/**
 * R13.2 — the local conversation store: redaction-before-write, bounded
 * eviction (count + age), forget/forgetAll, restart round-trip, identity
 * agreement with session-tree.ts, and gitignore coverage.
 */

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { cachePrefixFingerprint } from "../../../src/proxy/cache-prefix.js";
import {
  conversationIdFor,
  conversationStoreDir,
  LocalConversationStore,
} from "../../../src/session/conversation-store.js";
import { resolveWorktreeRoot } from "../../../src/shared/git-worktree.js";
import { useTempDirs } from "../../helpers/tmp.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let dir: string;
const newTempDir = useTempDirs("golem-conversation-store-");

beforeEach(async () => {
  dir = await newTempDir();
});

/** A minimal Anthropic-shaped turn body, for `conversationIdFor`. */
function req(messages: unknown[]): Record<string, unknown> {
  return { model: "claude-sonnet-5-20260501", max_tokens: 1024, messages };
}

describe("LocalConversationStore — redaction before write", () => {
  it("stores a runtime-generated secret as a placeholder, never the secret itself", async () => {
    const store = new LocalConversationStore(dir);
    // Built at runtime (per the standing fixture rule): a literal secret
    // gets swept up by the entropy sweep / secret scanners from under a
    // hardcoded test, and a literal `[REDACTED:...]` would pass vacuously
    // without ever exercising the redaction rule.
    const secret = `ghp_${"a".repeat(36)}`;
    expect(secret).not.toContain("REDACTED"); // sanity: this really is a raw secret

    await store.appendTurn("conv-1", {
      role: "user",
      content: `here is my token: ${secret}`,
      timestamp: "2026-08-22T00:00:00.000Z",
    });

    const record = await store.readConversation("conv-1");
    expect(record).not.toBeNull();
    const stored = JSON.stringify(record?.turns[0]?.content);
    expect(stored).not.toContain(secret);
    expect(stored).toContain("[REDACTED:github-token:1]");
  });

  it("redacts every turn independently, not only the first", async () => {
    const store = new LocalConversationStore(dir);
    const secret = `ghp_${"b".repeat(36)}`;
    await store.appendTurn("conv-2", {
      role: "user",
      content: "hello",
      timestamp: "2026-08-22T00:00:00.000Z",
    });
    await store.appendTurn("conv-2", {
      role: "assistant",
      content: `token: ${secret}`,
      timestamp: "2026-08-22T00:01:00.000Z",
    });

    const record = await store.readConversation("conv-2");
    const stored = JSON.stringify(record?.turns[1]?.content);
    expect(stored).not.toContain(secret);
    expect(stored).toContain("[REDACTED:github-token:1]");
  });
});

describe("LocalConversationStore — restart round-trip (the seam, not just the unit)", () => {
  it("reads turns back byte-identical after a simulated proxy restart", async () => {
    const first = new LocalConversationStore(dir);
    await first.appendTurn("conv-3", {
      role: "user",
      content: "what does this repo do?",
      timestamp: "2026-08-22T00:00:00.000Z",
    });
    await first.appendTurn("conv-3", {
      role: "assistant",
      content: "it is a local-first pre-LLM processing layer.",
      timestamp: "2026-08-22T00:01:00.000Z",
    });

    // A restart is a brand-new process: nothing but the on-disk files
    // survives, so a second, independent store instance stands in for it.
    const restarted = new LocalConversationStore(dir);
    const record = await restarted.readConversation("conv-3");

    expect(record?.turns.map((t) => ({ role: t.role, content: t.content }))).toStrictEqual([
      { role: "user", content: "what does this repo do?" },
      { role: "assistant", content: "it is a local-first pre-LLM processing layer." },
    ]);
    expect(record?.conversationId).toBe("conv-3");
  });
});

describe("LocalConversationStore — bounded by count", () => {
  it("evicts the oldest conversation once maxConversations is exceeded", async () => {
    const store = new LocalConversationStore(dir, { maxConversations: 3 });
    const ids = ["a", "b", "c", "d", "e"];
    for (let i = 0; i < ids.length; i++) {
      await store.appendTurn(ids[i] as string, {
        role: "user",
        content: `turn ${i}`,
        timestamp: `2026-08-22T00:0${i}:00.000Z`,
      });
    }

    const remaining = (await store.listConversations()).map((c) => c.conversationId);
    expect(remaining).toHaveLength(3);
    // The two OLDEST (a, b) must be gone; the three newest survive.
    expect(remaining).not.toContain("a");
    expect(remaining).not.toContain("b");
    expect(remaining.sort()).toStrictEqual(["c", "d", "e"]);
  });
});

describe("LocalConversationStore — bounded by age", () => {
  it("evicts a conversation whose lastTurnAt is older than maxAgeMs", async () => {
    const store = new LocalConversationStore(dir, { maxAgeMs: 1000 });
    // Far enough in the past that it is stale under ANY real Date.now() this
    // test could run at, without needing to fake the clock.
    await store.appendTurn("stale", {
      role: "user",
      content: "old conversation",
      timestamp: "2000-01-01T00:00:00.000Z",
    });
    // A second append (any conversation) triggers eviction's next pass.
    await store.appendTurn("fresh", {
      role: "user",
      content: "new conversation",
      timestamp: new Date().toISOString(),
    });

    const remaining = (await store.listConversations()).map((c) => c.conversationId);
    expect(remaining).toStrictEqual(["fresh"]);
    expect(await store.readConversation("stale")).toBeNull();
  });
});

describe("LocalConversationStore — forget", () => {
  it("forget(id) removes exactly one conversation and reports whether it existed", async () => {
    const store = new LocalConversationStore(dir);
    await store.appendTurn("keep", {
      role: "user",
      content: "hi",
      timestamp: "2026-08-22T00:00:00.000Z",
    });
    await store.appendTurn("drop", {
      role: "user",
      content: "bye",
      timestamp: "2026-08-22T00:00:00.000Z",
    });

    expect(await store.forget("drop")).toBe(true);
    expect(await store.forget("drop")).toBe(false); // already gone
    expect(await store.readConversation("drop")).toBeNull();
    expect(await store.readConversation("keep")).not.toBeNull();
  });

  it("forgetAll() removes every conversation — the documented delete-everything path", async () => {
    const store = new LocalConversationStore(dir);
    await store.appendTurn("one", {
      role: "user",
      content: "a",
      timestamp: "2026-08-22T00:00:00.000Z",
    });
    await store.appendTurn("two", {
      role: "user",
      content: "b",
      timestamp: "2026-08-22T00:00:00.000Z",
    });

    await store.forgetAll();

    expect(await store.listConversations()).toStrictEqual([]);
    expect(await store.readConversation("one")).toBeNull();
    expect(await store.readConversation("two")).toBeNull();
  });
});

describe("LocalConversationStore — tolerance and empty state", () => {
  it("listConversations() returns [] when nothing has been recorded yet", async () => {
    const store = new LocalConversationStore(path.join(dir, "never-created"));
    expect(await store.listConversations()).toStrictEqual([]);
  });

  it("skips a corrupt conversation file rather than throwing", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "corrupt.json"), "not json{{{", "utf8");
    const store = new LocalConversationStore(dir);
    expect(await store.listConversations()).toStrictEqual([]);
    expect(await store.readConversation("corrupt")).toBeNull();
  });
});

describe("conversationIdFor — identity agrees with session-tree.ts", () => {
  it("matches cachePrefixFingerprint's conversationKey exactly", () => {
    const body = req([{ role: "user", content: "hello" }]);
    expect(conversationIdFor(body)).toBe(cachePrefixFingerprint(body).conversationKey);
  });

  it("is stable across otherwise-identical requests, same as session-tree's key", () => {
    const body1 = req([{ role: "user", content: "hello" }]);
    const body2 = req([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    // Same first message -> same conversation id, regardless of what follows.
    expect(conversationIdFor(body1)).toBe(conversationIdFor(body2));
  });
});

describe(".gitignore actually covers .golem/conversations/", () => {
  it("git check-ignore reports the store directory as ignored", () => {
    // Proves the PATTERN, not merely that ".golem/" happens to also cover it —
    // this repo lists every .golem subdirectory individually, so a new one is
    // NOT ignored unless it was added explicitly (task R13.2 gate: "verify,
    // do not assume the pattern covers a new subdirectory").
    const probe = ".golem/conversations/deadbeefdeadbeef.json";
    const output = execFileSync("git", ["check-ignore", "-q", probe], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // `git check-ignore -q` exits 0 (no stdout) when the path IS ignored, and
    // a nonzero exit (which execFileSync throws on) when it is NOT — reaching
    // this line at all is the assertion.
    expect(output.toString()).toBe("");
  });

  it("a fresh clone carries no conversation store (git tracks nothing under it)", () => {
    const tracked = execFileSync("git", ["ls-files", ".golem/conversations"], {
      cwd: REPO_ROOT,
    })
      .toString()
      .trim();
    expect(tracked).toBe("");
  });
});

describe("conversationStoreDir", () => {
  it("resolves to <projectRoot>/.golem/conversations for a non-repo directory", () => {
    // `dir` (a bare temp directory, no `.git`) passes through
    // resolveWorktreeRoot unchanged — this asserts the plain join, distinct
    // from the worktree-collapse case covered below.
    expect(conversationStoreDir(dir)).toBe(path.join(dir, ".golem", "conversations"));
  });

  it("collapses a git worktree checkout to its main checkout's root (ccr-ref-scope)", () => {
    // This test file itself runs from inside a linked worktree
    // (.claude/worktrees/<agent>/), so REPO_ROOT here IS a worktree — proving
    // this store's identity agrees with the CCR store / vector index without
    // needing to fabricate a fake worktree layout on disk.
    expect(conversationStoreDir(REPO_ROOT)).toBe(
      path.join(resolveWorktreeRoot(REPO_ROOT), ".golem", "conversations"),
    );
  });
});
