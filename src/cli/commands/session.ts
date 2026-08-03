/**
 * golem session — session tree view (R8.S3).
 * Shows recorded conversation trees: branches, forks, and message depths.
 */

import { stat } from "node:fs/promises";
import type { Command } from "commander";
import { findProjectDir } from "../../config/index.js";
import { readSessionTree, renderSessionTree, sessionTreePath } from "../../session/session-tree.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

export default function register(program: Command): void {
  program
    .command("session")
    .description("Show the recorded session tree (branches, forks, message depths)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        // Check if the session tree exists — the proxy must have run at least once.
        const st = await stat(sessionTreePath(opts.dir)).catch(() => null);
        if (st === null) {
          process.stdout.write(
            "No session tree yet. The proxy must process at least one request first.\n",
          );
          return;
        }

        const tree = await readSessionTree(opts.dir);
        if (tree === null || tree.conversations.length === 0) {
          process.stdout.write("No recorded sessions.\n");
          return;
        }

        if (opts.json) {
          process.stdout.write(`${JSON.stringify(tree, null, 2)}\n`);
          return;
        }

        process.stdout.write(renderSessionTree(tree));
      } catch (err) {
        process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    });
}
