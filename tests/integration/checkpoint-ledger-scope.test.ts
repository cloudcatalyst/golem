/**
 * R8.9 — the change ledger against a REAL git repo: scope and degrade paths.
 *
 * What the ledger must NOT touch (Golem's own .golem/ state, even untracked),
 * and how it degrades outside a git repo or on an unborn HEAD.
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

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createCheckpoint,
  listCheckpoints,
  planRestore,
  restoreCheckpoint,
} from "../../src/checkpoint/index.js";
import {
  exists,
  gitOutput,
  hasGit,
  initRepo,
  read,
  useCheckpointRepos,
} from "./helpers/checkpoint-repo.js";

// Every test here drives a real `git` through several subprocess round-trips, and
// process spawn on Windows is slow enough that the 20s default times out under a
// full-suite run even though the same file passes in isolation. The cost is spawn
// latency, not the code under test, so raise the ceiling rather than lose the file
// to flakes. Kept per-file when R13.17 split this suite: the slices are shorter,
// but an individual test's spawn cost under contention is unchanged.
vi.setConfig({ testTimeout: 90_000 });

// R10.2: one recursive delete for the file, not one per repo created.
const { newTempDir } = useCheckpointRepos("golem-ledger-scope");

describe.skipIf(!hasGit)("change ledger (R8.9) — scope and degrade paths", () => {
  // Found in R8.9's own CLI smoke test: in a repo with no `.gitignore`, a
  // restore deleted `.golem/` state written after the checkpoint — i.e. it
  // rewound Golem rather than the user's attempt. The pathspec now excludes it
  // whether or not it is ignored.
  it("never snapshots or deletes Golem's own .golem/ state, even untracked", async () => {
    const dir = await newTempDir();
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
    const dir = await newTempDir();
    const created = await createCheckpoint(dir, { note: "nope" });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.reason).toMatch(/not inside a git worktree|not on PATH/);
    const listed = await listCheckpoints(dir);
    expect(listed.ok).toBe(false);
    const restored = await restoreCheckpoint(dir, "latest");
    expect(restored.ok).toBe(false);
  });

  it("checkpoints a repo with no commits yet (unborn HEAD)", async () => {
    const dir = await newTempDir();
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
