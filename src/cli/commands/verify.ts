/**
 * `golem verify` — run the green-check gate, streaming one line per check.
 *
 * The command layer is deliberately thin: it owns argv and `process.exitCode`,
 * and `runVerify` owns the work. That split is what lets a test assert the
 * outcome without crossing a process boundary.
 */

import type { Command } from "commander";
import { runVerify } from "../verify.js";

export default function register(program: Command): void {
  program
    .command("verify")
    .description(
      "Run the green-check gate (build, typecheck, lint, format, deps, tests, wiki) — " +
        "one progress line per check, judged by exit code",
    )
    .option("--dir <path>", "project directory", process.cwd())
    .option(
      "--only <ids>",
      "comma-separated check ids to run (build is kept when a selected check needs it)",
    )
    .option("--no-build", "skip the build step (checks reading dist/ may then be stale)")
    .option("--fail-fast", "stop at the first failing check instead of running them all", false)
    .action(async (opts: { dir: string; only?: string; build: boolean; failFast: boolean }) => {
      const only = opts.only
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const outcome = await runVerify({
        projectDir: opts.dir,
        // Spread rather than assign: `exactOptionalPropertyTypes` distinguishes
        // "absent" from "explicitly undefined", and absent is what "run them all" means.
        ...(only && only.length > 0 ? { only } : {}),
        skipBuild: !opts.build,
        failFast: opts.failFast,
      });
      // The exit code IS the verdict — CLAUDE.md's gate is read from it, not
      // from tailed output.
      if (!outcome.ok) process.exitCode = 1;
    });
}
