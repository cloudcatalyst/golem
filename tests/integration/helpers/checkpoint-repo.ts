/**
 * Real-git fixtures for the R8.9 change-ledger tests.
 *
 * ## Why these live in a helper rather than one test file
 *
 * R13.17: vitest parallelises across FILES, never within one, and no file in
 * this suite uses `.concurrent`. `checkpoint-ledger.test.ts` was 12 tests in a
 * single file, each driving a real `git init` + commit through several
 * subprocess round-trips — 51.4s of strictly serial work, measured 2026-08-29.
 * That made it the suite's wall-time floor: one worker grinding for ~51s while
 * fifteen sat idle, which is exactly why R10.1's pool/worker experiments could
 * not help (a worker count cannot subdivide a file).
 *
 * The tests are unchanged; they are simply spread across
 * `checkpoint-ledger-*.test.ts` so vitest can run them at the same time. These
 * fixtures are the preamble they used to share, lifted verbatim.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runGit } from "../../../src/checkpoint/index.js";
import { commandOnPath } from "../../../src/pkg/detect.js";
import { useTempDirs } from "../../helpers/tmp.js";

/**
 * The ledger's own degrade path is asserted separately, without git, in the
 * no-repo test — so a machine with no `git` skips the rest rather than failing.
 */
export const hasGit = commandOnPath("git") !== null;

/**
 * `git init` with line endings pinned.
 *
 * Not cosmetic: `checkout-index` runs the smudge filter, so with
 * `autocrlf=true` (many Windows installs) a restored file comes back CRLF —
 * exactly what `git checkout` would give, and documented in `ledger.ts`.
 * Pinning it keeps these tests about the ledger, not the developer's config.
 */
export async function initRepo(dir: string): Promise<void> {
  await runGit(dir, ["init", "--initial-branch=main"]);
  await runGit(dir, ["config", "core.autocrlf", "false"]);
  await runGit(dir, ["config", "core.eol", "lf"]);
}

export async function read(dir: string, rel: string): Promise<string> {
  return readFile(path.join(dir, rel), "utf8");
}

export async function exists(dir: string, rel: string): Promise<boolean> {
  try {
    await stat(path.join(dir, rel));
    return true;
  } catch {
    return false;
  }
}

export async function gitOutput(dir: string, args: readonly string[]): Promise<string> {
  return (await runGit(dir, args)).stdout.trim();
}

/**
 * Per-file temp roots plus the one-commit repo factory.
 *
 * Call at the top level of a test file — {@link useTempDirs} registers its own
 * `beforeAll`/`afterAll`, so it has to run during collection:
 *
 * ```ts
 * const { newTempDir, makeRepo } = useCheckpointRepos("golem-ledger-core");
 * ```
 *
 * Each file gets its own private root and its own single recursive delete
 * (R10.2), so splitting the tests across files did not multiply the deletes.
 */
export function useCheckpointRepos(prefix: string): {
  newTempDir: () => Promise<string>;
  makeRepo: () => Promise<string>;
} {
  const newTempDir = useTempDirs(prefix);

  /** A repo with one commit, deterministic identity, and a `.gitignore`. */
  const makeRepo = async (): Promise<string> => {
    const dir = await newTempDir();
    await runGit(dir, ["init", "--initial-branch=main"]);
    await runGit(dir, ["config", "user.name", "Test"]);
    await runGit(dir, ["config", "user.email", "test@example.com"]);
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
  };

  return { newTempDir, makeRepo };
}
