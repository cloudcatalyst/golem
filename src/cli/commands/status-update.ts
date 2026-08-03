/**
 * golem status / update — extracted from program.ts (R8.27).
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Command } from "commander";
import { findProjectDir } from "../../config/index.js";
import { VERSION } from "../../index.js";
import { checkForUpdate, detectInstallMethod } from "../../update/index.js";
import { InitError } from "../init.js";
import { golemDirExists } from "../local-model.js";
import { collectStatus, renderStatus } from "../status.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

export default function register(program: Command): void {
  program
    .command("status")
    .description(
      "Show Golem status: config + provenance, proxy reachability, project wiring, slider",
    )
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        const report = await collectStatus({ projectDir: opts.dir, version: VERSION });
        process.stdout.write(
          opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderStatus(report),
        );
      } catch (err) {
        _fail(err);
      }
    });

  program
    .command("update")
    .alias("upgrade")
    .description("Check for a newer Golem and upgrade (npm) or print the command (standalone)")
    .option("--dir <path>", "project directory (for the cached check)", _DEFAULT_DIR)
    .option("--check", "only check for an update; don't install", false)
    .option("--force", "ignore the cached check and re-query the npm registry", false)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; check: boolean; force: boolean; json: boolean }) => {
      try {
        const method = detectInstallMethod();
        const cacheDir = (await golemDirExists(opts.dir))
          ? path.join(opts.dir, ".golem", "state")
          : undefined;
        const result = await checkForUpdate({
          current: VERSION,
          method,
          ...(cacheDir !== undefined ? { cacheDir } : {}),
          force: opts.force,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        if (result.latest === null) {
          process.stdout.write(
            `golem ${VERSION} — couldn't check for updates (${result.error ?? "unknown error"}).\n`,
          );
          return;
        }
        if (!result.updateAvailable) {
          process.stdout.write(`golem ${VERSION} is up to date (latest ${result.latest}).\n`);
          return;
        }
        process.stdout.write(
          `golem update available: ${result.current} → ${result.latest} (installed via ${method}).\n`,
        );
        if (opts.check || method !== "npm") {
          process.stdout.write(`  run: ${result.command}\n`);
          return;
        }
        process.stdout.write(`Upgrading via npm: ${result.command}\n`);
        const res = spawnSync("npm", ["install", "-g", "golem-run@latest"], {
          stdio: "inherit",
          shell: true,
        });
        if (res.status !== 0)
          _fail(
            new InitError(`npm exited ${res.status ?? "abnormally"} — upgrade may have failed`),
          );
        process.stdout.write(
          `golem upgraded to ${result.latest}. Restart any running proxy/MCP.\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });
}
