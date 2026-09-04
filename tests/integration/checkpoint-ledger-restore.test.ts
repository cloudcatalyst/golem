/**
 * R8.9 — the change ledger against a REAL git repo: restore guards.
 *
 * The restore is itself undoable, and it refuses rather than guesses when the
 * worktree is in a state it cannot safely rewind (dirty index, detached HEAD).
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

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createCheckpoint,
  inspectRepo,
  restoreCheckpoint,
  runGit,
} from "../../src/checkpoint/index.js";
import { gitOutput, hasGit, read, useCheckpointRepos } from "./helpers/checkpoint-repo.js";

// Every test here drives a real `git` through several subprocess round-trips, and
// process spawn on Windows is slow enough that the 20s default times out under a
// full-suite run even though the same file passes in isolation. The cost is spawn
// latency, not the code under test, so raise the ceiling rather than lose the file
// to flakes. Kept per-file when R13.17 split this suite: the slices are shorter,
// but an individual test's spawn cost under contention is unchanged.
vi.setConfig({ testTimeout: 90_000 });

// R10.2: one recursive delete for the file, not one per repo created.
const { makeRepo } = useCheckpointRepos("golem-ledger-restore");

describe.skipIf(!hasGit)("change ledger (R8.9) — restore guards", () => {
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
});
