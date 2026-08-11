/**
 * R8.9 — the change ledger against a REAL git repo.
 *
 * These are the task's gate, restated as assertions: opt-in, and it never
 * touches the user's branch, index, or unrelated worktree state. So each test
 * checks the *absence* of a side effect as much as the presence of the effect —
 * `refs/heads` unchanged, HEAD unchanged, index unchanged, ignored files intact.
 *
 * Skips itself when `git` is not installed (the ledger's own degrade path is
 * asserted separately, without git, in the no-repo test).
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCheckpoint,
  dropCheckpoint,
  inspectRepo,
  listCheckpoints,
  planRestore,
  pruneCheckpoints,
  resolveCheckpoint,
  restoreCheckpoint,
  runGit,
} from "../../src/checkpoint/index.js";
import { commandOnPath } from "../../src/pkg/detect.js";
import { rmTemp } from "../helpers/tmp.js";

const hasGit = commandOnPath("git") !== null;
const dirs: string[] = [];

// Every test here drives a real `git` through several subprocess round-trips, and
// process spawn on Windows is slow enough that the 20s default times out under a
// full-suite run even though the same file passes in isolation. The cost is spawn
// latency, not the code under test, so raise the ceiling rather than lose the file
// to flakes.
vi.setConfig({ testTimeout: 90_000 });

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, rmTemp)));
});

/**
 * `git init` with line endings pinned.
 *
 * Not cosmetic: `checkout-index` runs the smudge filter, so with
 * `autocrlf=true` (many Windows installs) a restored file comes back CRLF —
 * exactly what `git checkout` would give, and documented in `ledger.ts`.
 * Pinning it keeps these tests about the ledger, not the developer's config.
 */
async function initRepo(dir: string): Promise<void> {
  await runGit(dir, ["init", "--initial-branch=main"]);
  await runGit(dir, ["config", "core.autocrlf", "false"]);
  await runGit(dir, ["config", "core.eol", "lf"]);
}

/** A repo with one commit, deterministic identity, and a `.gitignore`. */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "golem-ledger-"));
  dirs.push(dir);
  await runGit(dir, ["init", "--initial-branch=main"]);
  await runGit(dir, ["config", "user.name", "Test"]);
  await runGit(dir, ["config", "user.email", "test@example.invalid"]);
  await runGit(dir, ["config", "commit.gpgsign", "false"]);
  // Not cosmetic: `checkout-index` runs the smudge filter, so with
  // `autocrlf=true` (many Windows installs) a restored file comes back CRLF —
  // exactly what `git checkout` would give, and documented in ledger.ts.
  // Pinning it keeps these tests about the ledger, not the developer's config.
  await runGit(dir, ["config", "core.autocrlf", "false"]);
  await runGit(dir, ["config", "core.eol", "lf"]);
  await writeFile(path.join(dir, ".gitignore"), "ignored/\n", "utf8");
  await writeFile(path.join(dir, "keep.txt"), "original\n", "utf8");
  await mkdir(path.join(dir, "ignored"), { recursive: true });
  await writeFile(path.join(dir, "ignored", "state.json"), "{}\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["commit", "-m", "init"]);
  return dir;
}

async function read(dir: string, rel: string): Promise<string> {
  return readFile(path.join(dir, rel), "utf8");
}

async function exists(dir: string, rel: string): Promise<boolean> {
  try {
    await stat(path.join(dir, rel));
    return true;
  } catch {
    return false;
  }
}

async function gitOutput(dir: string, args: readonly string[]): Promise<string> {
  return (await runGit(dir, args)).stdout.trim();
}

describe.skipIf(!hasGit)("change ledger (R8.9)", () => {
  it("checkpoints into a shadow ref and leaves branch, HEAD and index alone", async () => {
    const dir = await makeRepo();
    const headBefore = await gitOutput(dir, ["rev-parse", "HEAD"]);
    const branchesBefore = await gitOutput(dir, ["for-each-ref", "refs/heads"]);
    const statusBefore = await gitOutput(dir, ["status", "--porcelain"]);

    await writeFile(path.join(dir, "keep.txt"), "attempt\n", "utf8");
    const created = await createCheckpoint(dir, { note: "before the attempt" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.unchanged).toBe(false);
    expect(created.value.checkpoint.ref).toMatch(/^refs\/golem\/ledger\//);

    // Nothing that belongs to the user moved.
    expect(await gitOutput(dir, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await gitOutput(dir, ["for-each-ref", "refs/heads"])).toBe(branchesBefore);
    expect(await gitOutput(dir, ["diff", "--cached", "--name-only"])).toBe("");
    // The only worktree difference is the edit the test made itself.
    expect(await gitOutput(dir, ["status", "--porcelain"])).not.toBe(statusBefore);

    // The snapshot is a real commit, so ordinary git tooling reads it.
    const shown = await gitOutput(dir, [
      "show",
      "--name-only",
      "--format=%s",
      created.value.checkpoint.ref,
    ]);
    expect(shown).toContain("before the attempt");
  });

  it("re-checkpointing an unchanged tree reuses the ref instead of spamming one", async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, "keep.txt"), "attempt\n", "utf8");
    const first = await createCheckpoint(dir, { note: "one" });
    const second = await createCheckpoint(dir, { note: "two" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.unchanged).toBe(true);
    expect(second.value.checkpoint.id).toBe(first.value.checkpoint.id);
    const list = await listCheckpoints(dir);
    expect(list.ok && list.value).toHaveLength(1);
  });

  it("restores modified, deleted and added files, and keeps ignored files", async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, "keep.txt"), "good\n", "utf8");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;\n", "utf8");
    const cp = await createCheckpoint(dir, { note: "known good" });
    expect(cp.ok).toBe(true);
    if (!cp.ok) return;

    // A failed attempt: modify one file, delete another, add a new one in a new dir.
    await writeFile(path.join(dir, "keep.txt"), "broken\n", "utf8");
    await rm(path.join(dir, "src", "a.ts"));
    await mkdir(path.join(dir, "src", "deep"), { recursive: true });
    await writeFile(path.join(dir, "src", "deep", "junk.ts"), "// nope\n", "utf8");
    await writeFile(path.join(dir, "ignored", "state.json"), '{"live":true}\n', "utf8");

    const plan = await planRestore(dir, cp.value.checkpoint);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect([...plan.value.restore].sort()).toEqual(["keep.txt", "src/a.ts"]);
    expect(plan.value.delete).toEqual(["src/deep/junk.ts"]);

    const restored = await restoreCheckpoint(dir, cp.value.checkpoint.id);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.restored).toBe(2);
    expect(restored.value.deleted).toBe(1);

    expect(await read(dir, "keep.txt")).toBe("good\n");
    expect(await read(dir, "src/a.ts")).toBe("export const a = 1;\n");
    expect(await exists(dir, "src/deep/junk.ts")).toBe(false);
    // The directory the junk file created is gone too (git tracks no dirs).
    expect(await exists(dir, "src/deep")).toBe(false);
    // Ignored files are outside the snapshot, so a restore must not rewind them.
    expect(await read(dir, "ignored/state.json")).toBe('{"live":true}\n');
    // Still no commits of our own, still no staged content.
    expect(await gitOutput(dir, ["diff", "--cached", "--name-only"])).toBe("");
    expect(await gitOutput(dir, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("takes a pre-restore checkpoint, so the restore is itself undoable", async () => {
    const dir = await makeRepo();
    const good = await createCheckpoint(dir, { note: "good" });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    await writeFile(path.join(dir, "keep.txt"), "work in progress\n", "utf8");

    const restored = await restoreCheckpoint(dir, "latest");
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.safety).not.toBeNull();
    expect(await read(dir, "keep.txt")).toBe("original\n");

    // Undo the undo.
    const safetyId = restored.value.safety?.id ?? "";
    const back = await restoreCheckpoint(dir, safetyId);
    expect(back.ok).toBe(true);
    expect(await read(dir, "keep.txt")).toBe("work in progress\n");
  });

  it("refuses to restore with a dirty index — a no-op with a reason", async () => {
    const dir = await makeRepo();
    const cp = await createCheckpoint(dir, { note: "clean" });
    expect(cp.ok).toBe(true);
    await writeFile(path.join(dir, "keep.txt"), "staged edit\n", "utf8");
    await runGit(dir, ["add", "keep.txt"]);

    const restored = await restoreCheckpoint(dir, "latest");
    expect(restored.ok).toBe(false);
    if (restored.ok) return;
    expect(restored.reason).toMatch(/staged changes/);
    // The file is untouched: refusal, not a partial restore.
    expect(await read(dir, "keep.txt")).toBe("staged edit\n");
  });

  it("refuses to restore on a detached HEAD", async () => {
    const dir = await makeRepo();
    await createCheckpoint(dir, { note: "before detaching" });
    const head = await gitOutput(dir, ["rev-parse", "HEAD"]);
    await runGit(dir, ["checkout", "--detach", head]);
    expect((await inspectRepo(dir)).kind).toBe("repo");

    await writeFile(path.join(dir, "keep.txt"), "changed\n", "utf8");
    const restored = await restoreCheckpoint(dir, "latest");
    expect(restored.ok).toBe(false);
    if (restored.ok) return;
    expect(restored.reason).toMatch(/detached/);
    expect(await read(dir, "keep.txt")).toBe("changed\n");
  });

  it("resolves latest / exact id / unique prefix, and rejects an ambiguous one", async () => {
    const dir = await makeRepo();
    const a = await createCheckpoint(dir, {
      note: "a",
      now: new Date("2026-07-31T10:00:00.000Z"),
    });
    await writeFile(path.join(dir, "keep.txt"), "second\n", "utf8");
    const b = await createCheckpoint(dir, {
      note: "b",
      now: new Date("2026-07-31T11:00:00.000Z"),
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.checkpoint.id).toBe("20260731T100000Z");

    const latest = await resolveCheckpoint(dir, "latest");
    expect(latest.ok && latest.value.id).toBe("20260731T110000Z");
    const exact = await resolveCheckpoint(dir, "20260731T100000Z");
    expect(exact.ok && exact.value.note).toBe("a");
    const prefix = await resolveCheckpoint(dir, "20260731T10");
    expect(prefix.ok && prefix.value.note).toBe("a");
    const ambiguous = await resolveCheckpoint(dir, "202607");
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.reason).toMatch(/ambiguous/);
    const missing = await resolveCheckpoint(dir, "19990101T000000Z");
    expect(missing.ok).toBe(false);
  });

  it("prunes to the newest N, and drops one ref without touching files", async () => {
    const dir = await makeRepo();
    for (const [i, content] of ["one", "two", "three"].entries()) {
      await writeFile(path.join(dir, "keep.txt"), `${content}\n`, "utf8");
      await createCheckpoint(dir, {
        note: content,
        keep: 50,
        now: new Date(Date.UTC(2026, 6, 31, 10, i, 0)),
      });
    }
    const before = await listCheckpoints(dir);
    expect(before.ok && before.value).toHaveLength(3);

    const dropped = await dropCheckpoint(dir, "20260731T100100Z");
    expect(dropped.ok).toBe(true);
    expect(await read(dir, "keep.txt")).toBe("three\n");
    const afterDrop = await listCheckpoints(dir);
    expect(afterDrop.ok && afterDrop.value.map((c) => c.note)).toEqual(["three", "one"]);

    const pruned = await pruneCheckpoints(dir, 1);
    expect(pruned.ok && pruned.value).toBe(1);
    const afterPrune = await listCheckpoints(dir);
    expect(afterPrune.ok && afterPrune.value.map((c) => c.note)).toEqual(["three"]);
  });

  it("auto-prunes on create, keeping the newest N", async () => {
    const dir = await makeRepo();
    for (const [i, content] of ["a", "b", "c", "d"].entries()) {
      await writeFile(path.join(dir, "keep.txt"), `${content}\n`, "utf8");
      await createCheckpoint(dir, {
        note: content,
        keep: 2,
        now: new Date(Date.UTC(2026, 6, 31, 12, i, 0)),
      });
    }
    const list = await listCheckpoints(dir);
    expect(list.ok && list.value.map((c) => c.note)).toEqual(["d", "c"]);
  });

  // Found in R8.9's own CLI smoke test: in a repo with no `.gitignore`, a
  // restore deleted `.golem/` state written after the checkpoint — i.e. it
  // rewound Golem rather than the user's attempt. The pathspec now excludes it
  // whether or not it is ignored.
  it("never snapshots or deletes Golem's own .golem/ state, even untracked", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "golem-ledger-state-"));
    dirs.push(dir);
    await initRepo(dir);
    await writeFile(path.join(dir, "a.txt"), "v1\n", "utf8");

    const cp = await createCheckpoint(dir, { note: "no golem state yet" });
    expect(cp.ok).toBe(true);
    if (!cp.ok) return;

    // Golem writes state after the checkpoint (telemetry, tasks, CCR blobs).
    await mkdir(path.join(dir, ".golem", "state"), { recursive: true });
    await writeFile(path.join(dir, ".golem", "state", "telemetry.json"), "{}\n", "utf8");
    await writeFile(path.join(dir, "a.txt"), "broken\n", "utf8");

    const plan = await planRestore(dir, cp.value.checkpoint);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.delete).toEqual([]);
    expect(plan.value.restore).toEqual(["a.txt"]);

    const restored = await restoreCheckpoint(dir, "latest");
    expect(restored.ok).toBe(true);
    expect(await read(dir, "a.txt")).toBe("v1\n");
    expect(await exists(dir, ".golem/state/telemetry.json")).toBe(true);
  });

  it("degrades to a no-op with a reason outside a git repo", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "golem-ledger-plain-"));
    dirs.push(dir);
    const created = await createCheckpoint(dir, { note: "nope" });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.reason).toMatch(/not inside a git worktree|not on PATH/);
    const listed = await listCheckpoints(dir);
    expect(listed.ok).toBe(false);
    const restored = await restoreCheckpoint(dir, "latest");
    expect(restored.ok).toBe(false);
  });

  it("checkpoints a repo with no commits yet (unborn HEAD)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "golem-ledger-unborn-"));
    dirs.push(dir);
    await initRepo(dir);
    await writeFile(path.join(dir, "first.txt"), "hello\n", "utf8");

    const created = await createCheckpoint(dir, { note: "before any commit" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // Parentless snapshot commit — and still no commits on the branch.
    expect(await gitOutput(dir, ["rev-parse", "--verify", "HEAD"])).toBe("");

    await writeFile(path.join(dir, "first.txt"), "broken\n", "utf8");
    const restored = await restoreCheckpoint(dir, "latest");
    expect(restored.ok).toBe(true);
    expect(await read(dir, "first.txt")).toBe("hello\n");
  });
});
