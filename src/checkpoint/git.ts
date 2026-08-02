/**
 * R8.9 — the git primitives the change ledger is built on.
 *
 * Two rules shape every function here, and both come from CLAUDE.md:
 *
 * 1. **Argument arrays, never shell strings** — a path with a space or a `&` in
 *    it must not become a second command, on any of the three OSes.
 * 2. **Data, not exceptions** — `runGit` resolves for every outcome (nonzero
 *    exit, missing binary, fatal error), because the ledger's contract is "no
 *    git / not a repo / dirty index degrades to a *no-op with a reason*". A
 *    thrown error would have to be caught and re-classified at every call site
 *    to keep that promise, so the classification happens once, here.
 *
 * Nothing in this file writes to `<gitDir>/index`, moves `HEAD`, or creates a
 * ref: the callers do that, and only through `GIT_INDEX_FILE` temp indexes.
 */

import { spawn } from "node:child_process";
import { commandOnPath } from "../ext/detect.js";

export interface GitResult {
  /** Exit code, or `null` when the process could not be spawned at all. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when `git` itself could not be executed (ENOENT etc.). */
  readonly spawnFailed: boolean;
}

export interface RunGitOptions {
  /** Fed to the child's stdin, then stdin is closed (see below). */
  readonly stdin?: string;
  /**
   * Path for `GIT_INDEX_FILE`. This is the whole safety mechanism of the
   * ledger: every staging operation runs against a throwaway index, so the
   * user's real index is never read-modify-written by Golem.
   */
  readonly indexFile?: string;
  /** Extra environment (the ledger uses it to pin the committer identity). */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/**
 * Run `git` in `cwd` with an argument array. Resolves for every outcome and
 * never throws.
 *
 * stdin is ALWAYS closed (with `opts.stdin` or empty) — `commit-tree` and
 * `checkout-index --stdin` read to EOF, so a caller that forgot to close it
 * would hang forever rather than fail.
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
  opts: RunGitOptions = {},
): Promise<GitResult> {
  const env: Record<string, string | undefined> = { ...process.env, ...opts.extraEnv };
  if (opts.indexFile !== undefined) env.GIT_INDEX_FILE = opts.indexFile;

  return new Promise<GitResult>((resolve) => {
    const child = spawn("git", [...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (err: Error) => {
      resolve({ code: null, stdout: "", stderr: err.message, spawnFailed: true });
    });
    child.once("close", (code) => {
      resolve({ code, stdout, stderr, spawnFailed: false });
    });
    if (child.stdin) {
      child.stdin.on("error", () => {
        // EPIPE when the child exited before reading stdin — not an error here.
      });
      try {
        child.stdin.end(opts.stdin ?? "", "utf8");
      } catch {
        // EPIPE at the call site too.
      }
    }
  });
}

/**
 * Trimmed stdout when the command succeeded, else `null`.
 *
 * Used for the many `rev-parse`-shaped questions where "it failed" and "it
 * printed nothing" mean the same thing to the caller (no HEAD, not a repo).
 */
export async function gitOk(
  cwd: string,
  args: readonly string[],
  opts: RunGitOptions = {},
): Promise<string | null> {
  const res = await runGit(cwd, args, opts);
  return res.code === 0 ? res.stdout.replace(/\r?\n$/, "").trim() : null;
}

/** A usable repository, with the facts the ledger's preflight needs. */
export interface RepoFacts {
  readonly kind: "repo";
  /** Absolute worktree root — every ledger git call runs from here. */
  readonly root: string;
  /** Absolute `.git` dir (or the real dir for a worktree/submodule). */
  readonly gitDir: string;
  /** HEAD commit, or `null` on an unborn HEAD (a repo with no commits). */
  readonly head: string | null;
  /** True when HEAD points at a commit rather than a branch. */
  readonly detached: boolean;
  /**
   * True when the index holds anything HEAD does not: staged adds/mods/deletes,
   * or an unmerged path. A restore writes the WORKTREE, so a dirty index would
   * leave staged content and worktree content describing different states —
   * `restoreCheckpoint` refuses instead.
   */
  readonly indexDirty: boolean;
}

/** Why the ledger cannot operate here (always a no-op, never a partial act). */
export interface RepoUnavailable {
  readonly kind: "no-git" | "not-a-repo";
  readonly reason: string;
}

export type RepoState = RepoFacts | RepoUnavailable;

/**
 * Inspect `cwd`: is git installed, is this a repo, and what state is it in.
 *
 * Cheap-first: the PATH check is spawn-free (`commandOnPath`), so the common
 * "no git installed" answer costs a few `stat` calls rather than a process.
 */
export async function inspectRepo(cwd: string): Promise<RepoState> {
  if (commandOnPath("git") === null) {
    return { kind: "no-git", reason: "git is not on PATH — the change ledger needs git" };
  }

  const root = await gitOk(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === null || root === "") {
    return { kind: "not-a-repo", reason: `${cwd} is not inside a git worktree` };
  }
  const gitDir = await gitOk(root, ["rev-parse", "--absolute-git-dir"]);
  if (gitDir === null || gitDir === "") {
    return { kind: "not-a-repo", reason: `could not resolve the git dir for ${root}` };
  }

  // `rev-parse HEAD` fails on an unborn HEAD; that is a fact, not an error.
  const head = await gitOk(root, ["rev-parse", "HEAD"]);
  const symbolic = await gitOk(root, ["symbolic-ref", "--quiet", "HEAD"]);
  const detached = head !== null && symbolic === null;

  return { kind: "repo", root, gitDir, head, detached, indexDirty: await indexDirty(root) };
}

/**
 * Staged-change probe via `status --porcelain`, not `diff --cached`.
 *
 * `diff --cached` needs a HEAD to compare against and errors on an unborn one,
 * which would make a fresh repo look like a hard failure. Porcelain's index
 * column answers the same question in one call and is well-defined with no
 * commits (a staged file reads `A `). `-uno` drops untracked files: those are
 * not staged, and a repo full of untracked files is the normal case.
 */
async function indexDirty(root: string): Promise<boolean> {
  const res = await runGit(root, ["status", "--porcelain", "--untracked-files=no"]);
  if (res.code !== 0) return true; // unreadable status → fail closed (refuse to restore)
  for (const line of res.stdout.split(/\r?\n/)) {
    if (line === "") continue;
    const indexColumn = line[0];
    if (indexColumn !== undefined && indexColumn !== " " && indexColumn !== "?") return true;
  }
  return false;
}
