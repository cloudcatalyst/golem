/**
 * Worktree → main-checkout root collapse (task ccr-ref-scope, 2026-08-22).
 *
 * A git LINKED WORKTREE (`git worktree add`, or Claude Code's own
 * `isolation: "worktree"`) is a second working directory sharing one
 * repository. Golem decided a worktree is the SAME project as its main
 * checkout for both the CCR store (`src/compression/`) and the vector index
 * (`canonicalProjectId`, `src/knowledge/file-driver.ts`) — see
 * `docs/wiki/concepts/CCR Ref Scope.md` for why, and
 * `docs/plan/verification-notes.md` for the date. Both routes call THIS one
 * function so neither can drift from the other's answer (the same shape as
 * R11.2's `canonicalProjectId` fix: one identity function, not one opinion
 * per call site).
 *
 * Pure filesystem reads, no `git` subprocess: a linked worktree's `.git` is a
 * FILE (not a directory) containing `gitdir: <main>/.git/worktrees/<name>`,
 * and that directory's `commondir` file holds the (usually relative) path
 * back to the shared `.git` — the exact bookkeeping the git binary itself
 * reads to answer `rev-parse --git-common-dir`. Reading it directly avoids a
 * spawn on every resolution and keeps this synchronous, matching
 * `canonicalProjectId`'s existing contract (a pure string→string function
 * callers can call inline, not an async one they have to thread through).
 *
 * Anything that doesn't look EXACTLY like that layout — no `.git` at this
 * path, `.git` is already a directory (already a main checkout, or a bare
 * repo), an unreadable/malformed pointer or `commondir` — resolves to `dir`
 * UNCHANGED. Never throws, never guesses: a directory that isn't a git repo
 * at all (the common case for a fresh `golem init`) must come back exactly
 * as it went in.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const GITDIR_POINTER_RE = /^gitdir:\s*(.+?)\s*$/m;

/**
 * Resolve `dir` to its git worktree's main checkout root, or return `dir`
 * unchanged if it already is one (or isn't a git repo at all).
 *
 * Only absolute paths are inspected — a relative or opaque id (a bare
 * project label, a test fixture name) is returned unchanged rather than
 * resolved against the CURRENT PROCESS's cwd, which would answer a question
 * about the wrong directory entirely.
 */
export function resolveWorktreeRoot(dir: string): string {
  if (!isAbsolute(dir)) return dir;

  const dotGitPath = join(dir, ".git");
  let dotGitStat: ReturnType<typeof statSync>;
  try {
    dotGitStat = statSync(dotGitPath);
  } catch {
    return dir; // no `.git` here — not a repo (or not at this exact level)
  }
  if (!dotGitStat.isFile()) return dir; // a directory `.git` is already a main checkout

  let pointer: string;
  try {
    pointer = readFileSync(dotGitPath, "utf8");
  } catch {
    return dir;
  }
  const worktreeGitDir = GITDIR_POINTER_RE.exec(pointer)?.[1];
  if (worktreeGitDir === undefined || worktreeGitDir === "") return dir;

  let commonDirRaw: string;
  try {
    commonDirRaw = readFileSync(join(worktreeGitDir, "commondir"), "utf8");
  } catch {
    return dir; // not the linked-worktree layout this function understands
  }
  const commonDirRel = commonDirRaw.trim();
  if (commonDirRel === "") return dir;
  const commonGitDir = isAbsolute(commonDirRel)
    ? commonDirRel
    : resolve(worktreeGitDir, commonDirRel);

  const mainRoot = dirname(commonGitDir);
  return mainRoot === "" ? dir : mainRoot;
}
