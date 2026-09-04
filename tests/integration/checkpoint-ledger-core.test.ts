/**
 * R8.9 — the change ledger against a REAL git repo: checkpoints and restores.
 *
 * Creating a checkpoint without disturbing the user's branch/HEAD/index, ref
 * reuse on an unchanged tree, and the full restore of modified/deleted/added
 * files.
 *
 * These are the task's gate, restated as assertions: opt-in, and it never
 * touches the user's branch, index, or unrelated worktree state. So each test
 * checks the *absence* of a side effect as much as the presence of the effect —
 * `refs/heads` unchanged, HEAD unchanged, index unchanged, ignored files intact.
 *
 * Skips itself when `git` is not installed (the ledger's own degrade path is
 * asserted separately, without git, in the no-repo test).
 *
 * One of four `checkpoint-ledger-*.test.ts` slices — see
 * `helpers/checkpoint-repo.ts` for why they are separate files (R13.17).
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createCheckpoint,
  listCheckpoints,
  planRestore,
  restoreCheckpoint,
} from "../../src/checkpoint/index.js";
import { exists, gitOutput, hasGit, read, useCheckpointRepos } from "./helpers/checkpoint-repo.js";

// Every test here drives a real `git` through several subprocess round-trips, and
// process spawn on Windows is slow enough that the 20s default times out under a
// full-suite run even though the same file passes in isolation. The cost is spawn
// latency, not the code under test, so raise the ceiling rather than lose the file
// to flakes. Kept per-file when R13.17 split this suite: the slices are shorter,
// but an individual test's spawn cost under contention is unchanged.
vi.setConfig({ testTimeout: 90_000 });

// R10.2: one recursive delete for the file, not one per repo created.
const { makeRepo } = useCheckpointRepos("golem-ledger-core");

describe.skipIf(!hasGit)("change ledger (R8.9) — checkpoints and restores", () => {
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
});
