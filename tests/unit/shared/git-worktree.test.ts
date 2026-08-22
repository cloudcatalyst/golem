/**
 * Unit tests for `resolveWorktreeRoot` (task ccr-ref-scope, 2026-08-22).
 *
 * These pin the on-disk layout the function trusts — a linked worktree's
 * `.git` is a FILE holding `gitdir: <worktree-gitdir>`, and that directory's
 * `commondir` file holds the (usually relative) path back to the shared
 * `.git` — by constructing that shape directly on disk rather than shelling
 * out to real `git`. `tests/integration/ccr-worktree-scope.test.ts` covers
 * the real-`git worktree add` end-to-end path; this file is the fast,
 * exhaustive unit-level pin of every branch, including the malformed ones
 * that real git would never produce but a corrupt or half-written repo
 * might.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorktreeRoot } from "../../../src/shared/git-worktree.js";
import { useTempDirs } from "../../helpers/tmp.js";

const newTempDir = useTempDirs("git-worktree-resolve-");

describe("resolveWorktreeRoot", () => {
  it("returns a non-absolute path unchanged", () => {
    expect(resolveWorktreeRoot("relative/path")).toBe("relative/path");
    expect(resolveWorktreeRoot("")).toBe("");
  });

  it("returns a directory with no .git entry unchanged", async () => {
    const dir = await newTempDir();
    expect(resolveWorktreeRoot(dir)).toBe(dir);
  });

  it("returns a directory whose .git is itself a directory unchanged (a main checkout)", async () => {
    const dir = await newTempDir();
    await mkdir(path.join(dir, ".git"));
    expect(resolveWorktreeRoot(dir)).toBe(dir);
  });

  it("resolves a linked worktree to the dirname of the shared .git it points at", async () => {
    const base = await newTempDir();

    const mainRoot = path.join(base, "main-checkout");
    const sharedGitDir = path.join(mainRoot, ".git");
    const worktreeRoot = path.join(base, "agent-worktree");
    const worktreeGitDir = path.join(sharedGitDir, "worktrees", "agent-worktree");

    await mkdir(sharedGitDir, { recursive: true });
    await mkdir(worktreeGitDir, { recursive: true });
    await mkdir(worktreeRoot, { recursive: true });

    // relative, exactly as real git writes it
    await writeFile(path.join(worktreeGitDir, "commondir"), "../..\n", "utf8");
    await writeFile(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");

    expect(resolveWorktreeRoot(worktreeRoot)).toBe(mainRoot);
  });

  it("resolves via an absolute commondir path too", async () => {
    const base = await newTempDir();

    const mainRoot = path.join(base, "main-checkout");
    const sharedGitDir = path.join(mainRoot, ".git");
    const worktreeRoot = path.join(base, "agent-worktree");
    const worktreeGitDir = path.join(base, "external-git-dir");

    await mkdir(sharedGitDir, { recursive: true });
    await mkdir(worktreeGitDir, { recursive: true });
    await mkdir(worktreeRoot, { recursive: true });

    await writeFile(path.join(worktreeGitDir, "commondir"), `${sharedGitDir}\n`, "utf8");
    await writeFile(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");

    expect(resolveWorktreeRoot(worktreeRoot)).toBe(mainRoot);
  });

  it("falls back to dir unchanged when the .git file has no gitdir: line", async () => {
    const dir = await newTempDir();
    await writeFile(path.join(dir, ".git"), "not a gitdir pointer\n", "utf8");
    expect(resolveWorktreeRoot(dir)).toBe(dir);
  });

  it("falls back to dir unchanged when gitdir points at a directory with no commondir file", async () => {
    const base = await newTempDir();
    const worktreeRoot = path.join(base, "repo");
    const worktreeGitDir = path.join(base, "orphan-git-dir");

    await mkdir(worktreeRoot, { recursive: true });
    await mkdir(worktreeGitDir, { recursive: true });
    await writeFile(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");

    expect(resolveWorktreeRoot(worktreeRoot)).toBe(worktreeRoot);
  });

  it("falls back to dir unchanged when commondir is empty", async () => {
    const base = await newTempDir();
    const worktreeRoot = path.join(base, "repo");
    const worktreeGitDir = path.join(base, "git-dir");

    await mkdir(worktreeRoot, { recursive: true });
    await mkdir(worktreeGitDir, { recursive: true });
    await writeFile(path.join(worktreeGitDir, "commondir"), "", "utf8");
    await writeFile(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");

    expect(resolveWorktreeRoot(worktreeRoot)).toBe(worktreeRoot);
  });

  it("falls back to dir unchanged when gitdir points at a nonexistent directory", async () => {
    const base = await newTempDir();
    const worktreeRoot = path.join(base, "repo");
    await mkdir(worktreeRoot, { recursive: true });
    await writeFile(
      path.join(worktreeRoot, ".git"),
      `gitdir: ${path.join(base, "does-not-exist")}\n`,
      "utf8",
    );

    expect(resolveWorktreeRoot(worktreeRoot)).toBe(worktreeRoot);
  });
});
