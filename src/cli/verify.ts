/**
 * long-run-visibility — `golem verify`: the green-check gate as a command.
 *
 * The gate CLAUDE.md defines has existed only as prose (there and in the
 * `/golem:verify` skill), so every agent re-implemented it as an ad-hoc shell
 * loop. Two of six such runs in one session were defective in ways prose cannot
 * prevent: one wrote its log to a path copied out of REDACTED output, and one
 * regenerated a generated file using a globally installed `golem` built from an
 * older commit, silently dropping a new column until a drift test caught it.
 *
 * Three properties are the point, not decoration:
 *
 * 1. **One line-buffered progress line per check, with a stable prefix.** Stdout
 *    IS the event stream, so a watcher (the harness's `Monitor`, or a human's
 *    `tail -f`) needs no filter authoring and no knowledge of our internals.
 * 2. **The log path is printed FIRST**, before any check runs, so nobody has to
 *    invent one — and it lives under `.golem/state/`, which is gitignored, so a
 *    run cannot litter the repo.
 * 3. **The build runs before the checks that depend on it.** This is the failure
 *    above. "Rebuild first" was written down and still missed, which is exactly
 *    the class of instruction that belongs in code.
 *
 * Every check runs by default and the exit code is nonzero if ANY failed, rather
 * than stopping at the first. A gate judged by exit code (CLAUDE.md, while CI is
 * billing-blocked) needs the whole picture in one pass; stopping early is what
 * made a red `vitest` hide whether the wiki was clean. `--fail-fast` opts into
 * stopping.
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "../config/file-io.js";
import {
  formatElapsed,
  HEARTBEAT_MS,
  type VerifyCheckResult,
  type VerifyProgress,
  verifyProgressPath,
} from "./verify-progress.js";

/** Prefix every progress line carries, so a watcher can match one string. */
export const PROGRESS_PREFIX = "golem-verify:";

export interface VerifyCheck {
  readonly id: string;
  /** Argument array, never a shell string — CLAUDE.md's cross-platform rule. */
  readonly argv: readonly string[];
  /** Last-resort shell, set only by {@link npmArgv}'s fallback. Normally false. */
  readonly shell: boolean;
  /** True when the check reads `dist/`, so the build must precede it. */
  readonly needsBuild: boolean;
}

/**
 * How to run an npm script WITHOUT a shell.
 *
 * On Windows `npm` is a `.cmd` shim, and since Node's 2024 change
 * (CVE-2024-27980) spawning one with `shell: false` fails outright with
 * `EINVAL` — observed here on the first run of this command. The two usual
 * escapes are both bad: `shell: true` reintroduces the quoting risks CLAUDE.md's
 * argument-array rule exists to prevent, and hard-coding `node_modules/.bin`
 * entry points re-implements npm's own resolution.
 *
 * So run npm's OWN JavaScript with the Node already running us. Same npm that
 * ships with this Node, no shell on any platform, argument array intact.
 * The `.cmd`/`npm` fallback stays for an exotic layout that has no bundled npm
 * (`shell` is then set for that check, and only that check).
 */
function npmArgv(...args: readonly string[]): { argv: readonly string[]; shell: boolean } {
  const bundled = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (existsSync(bundled)) return { argv: [process.execPath, bundled, ...args], shell: false };
  return {
    argv: [process.platform === "win32" ? "npm.cmd" : "npm", ...args],
    shell: process.platform === "win32",
  };
}

/**
 * The six checks CLAUDE.md names, plus the build they depend on.
 *
 * They are npm scripts rather than direct binaries deliberately: the scripts are
 * what the project already documents and what CI ran, so `golem verify` cannot
 * drift into checking something subtly different from `npm run lint`.
 */
export function verifyChecks(): readonly VerifyCheck[] {
  const script = (id: string, name = id): VerifyCheck => {
    const { argv, shell } = npmArgv("run", name);
    return { id, argv, shell, needsBuild: false };
  };
  return [
    script("build"),
    script("typecheck"),
    script("lint"),
    script("format:check"),
    script("verify:deps"),
    script("test"),
    // Runs the CLI that was just built, not the one on PATH — the whole reason
    // `build` leads. `process.execPath` keeps it to this Node, with no shell.
    {
      id: "wiki",
      argv: [process.execPath, path.join("dist", "cli", "main.js"), "wiki", "check"],
      shell: false,
      needsBuild: true,
    },
  ];
}

export interface RunVerifyOptions {
  readonly projectDir: string;
  readonly only?: readonly string[];
  readonly skipBuild?: boolean;
  readonly failFast?: boolean;
  /** Where progress lines go. Injectable so tests do not write to a real stdout. */
  readonly out?: (line: string) => void;
}

export interface VerifyOutcome {
  readonly ok: boolean;
  readonly results: readonly VerifyCheckResult[];
  readonly logPath: string;
  /** The suite totals line, when the test run printed one. */
  readonly totals: string | null;
}

/** Strip ANSI so a captured line is comparable; vitest colours its summary. */
function decolour(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI escape itself
  return text.replace(/\[[0-9;]*m/g, "");
}

/** `Tests  3374 passed | 2 skipped (3376)` — reported because an exit code hides scale. */
function totalsFrom(text: string): string | null {
  const matches = decolour(text).match(/^\s*Tests\s+.+$/gm);
  return matches?.at(-1)?.trim() ?? null;
}

/** Which checks to run, honouring `--only` without letting `dist/` go stale. */
export function selectChecks(
  all: readonly VerifyCheck[],
  only: readonly string[] | undefined,
  skipBuild: boolean,
): readonly VerifyCheck[] {
  let checks = skipBuild ? all.filter((c) => c.id !== "build") : all;
  if (!only || only.length === 0) return checks;
  const wanted = new Set(only);
  // Keep `build` when something selected needs it, so `--only wiki` cannot
  // silently check a stale `dist/`.
  const needsBuild = checks.some((c) => wanted.has(c.id) && c.needsBuild);
  checks = checks.filter((c) => wanted.has(c.id) || (needsBuild && c.id === "build" && !skipBuild));
  return checks;
}

/**
 * Run the gate, streaming one line per check.
 *
 * Returns rather than exiting, so the command layer owns `process.exitCode` and
 * a test can assert the outcome without a process boundary.
 */
export async function runVerify(options: RunVerifyOptions): Promise<VerifyOutcome> {
  const { projectDir, only, skipBuild = false, failFast = false } = options;
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));

  const checks = selectChecks(verifyChecks(), only, skipBuild);

  const logPath = path.join(projectDir, ".golem", "state", "verify.log");
  await mkdir(path.dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: "w" });

  const startedAt = Date.now();
  const runId = startedAt.toString(36);
  const results: VerifyCheckResult[] = [];
  let current: string | null = null;
  let captured = "";

  const write = async (finished?: { ok: boolean }): Promise<void> => {
    const progress: VerifyProgress = {
      runId,
      total: checks.length,
      done: results,
      current,
      startedAt,
      updatedAt: Date.now(),
      logPath,
      ...(finished ? { finishedAt: Date.now(), ok: finished.ok } : {}),
    };
    // A status-line nicety must never be able to fail the gate it reports on.
    await writeAtomic(verifyProgressPath(projectDir), JSON.stringify(progress, null, 2)).catch(
      () => {},
    );
  };

  // The log path first, before any work: a watcher attaching later still finds it.
  out(`${PROGRESS_PREFIX} log ${logPath}`);
  out(`${PROGRESS_PREFIX} start ${checks.length} checks`);
  await write();

  const heartbeat = setInterval(() => void write(), HEARTBEAT_MS);
  heartbeat.unref();

  try {
    for (const check of checks) {
      current = check.id;
      await write();
      const began = Date.now();
      const [cmd, ...args] = check.argv;
      const exit = await new Promise<number>((resolve) => {
        const fail = (message: string): void => {
          const line = `${check.id}: spawn failed: ${message}\n`;
          captured += line;
          log.write(line);
          resolve(127);
        };
        // `spawn` can throw SYNCHRONOUSLY (Windows EINVAL on a .cmd), which the
        // 'error' handler below never sees. Unhandled, it killed the run after
        // two progress lines and reported nothing about which check died.
        try {
          const child = spawn(String(cmd), args, {
            cwd: projectDir,
            shell: check.shell,
          });
          const consume = (chunk: Buffer): void => {
            const text = chunk.toString("utf8");
            captured += text;
            log.write(text);
          };
          child.stdout.on("data", consume);
          child.stderr.on("data", consume);
          child.on("error", (err) => fail(err.message));
          child.on("close", (code) => resolve(code ?? 1));
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
      });

      const ms = Date.now() - began;
      const ok = exit === 0;
      results.push({ id: check.id, ok, ms, exit });
      current = null;
      await write();
      out(
        ok
          ? `${PROGRESS_PREFIX} ${check.id} ok ${formatElapsed(ms)}`
          : `${PROGRESS_PREFIX} ${check.id} FAILED exit=${exit} ${formatElapsed(ms)}`,
      );
      if (!ok && failFast) break;
    }
  } finally {
    clearInterval(heartbeat);
    log.end();
  }

  const ok = results.length > 0 && results.every((r) => r.ok);
  const totals = totalsFrom(captured);
  await write({ ok });
  if (totals) out(`${PROGRESS_PREFIX} totals ${totals}`);
  out(
    ok
      ? `${PROGRESS_PREFIX} ALL GREEN (${results.length} checks, ${formatElapsed(Date.now() - startedAt)})`
      : `${PROGRESS_PREFIX} FAILED: ${results
          .filter((r) => !r.ok)
          .map((r) => r.id)
          .join(", ")} — full log ${logPath}`,
  );
  return { ok, results, logPath, totals };
}
