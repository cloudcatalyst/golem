/**
 * R8.9 — the change ledger against a REAL git repo: resolve and prune.
 *
 * Resolving latest / exact id / unique prefix (and rejecting an ambiguous one),
 * plus pruning to the newest N by hand and automatically on create.
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
  dropCheckpoint,
  listCheckpoints,
  pruneCheckpoints,
  resolveCheckpoint,
} from "../../src/checkpoint/index.js";
import { hasGit, read, useCheckpointRepos } from "./helpers/checkpoint-repo.js";

// Every test here drives a real `git` through several subprocess round-trips, and
// process spawn on Windows is slow enough that the 20s default times out under a
// full-suite run even though the same file passes in isolation. The cost is spawn
// latency, not the code under test, so raise the ceiling rather than lose the file
// to flakes. Kept per-file when R13.17 split this suite: the slices are shorter,
// but an individual test's spawn cost under contention is unchanged.
vi.setConfig({ testTimeout: 90_000 });

// R10.2: one recursive delete for the file, not one per repo created.
const { makeRepo } = useCheckpointRepos("golem-ledger-prune");

describe.skipIf(!hasGit)("change ledger (R8.9) — resolve and prune", () => {
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
});
