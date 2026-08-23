/**
 * golem session — session tree view (R8.S3), plus `forget` over the R13.2
 * local conversation store (redacted transcripts, ADR-0007 §6). The two
 * stores are separate (hashes-only tree vs. redacted-content store) — see
 * `src/session/session-tree.ts` and `src/session/conversation-store.ts`'s
 * headers — so `forget` only ever touches the conversation store, never the
 * tree.
 */

import { stat } from "node:fs/promises";
import type { Command } from "commander";
import { findProjectDir } from "../../config/index.js";
import { LocalConversationStore } from "../../session/conversation-store.js";
import { readSessionTree, renderSessionTree, sessionTreePath } from "../../session/session-tree.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

export default function register(program: Command): void {
  const session = program
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

  session
    .command("forget [id]")
    .description(
      "Delete one conversation (by id) from the local conversation store, or every " +
        "conversation with --all — the retention promise from ADR-0007 §6 (R13.2)",
    )
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--all", "delete every conversation the store holds", false)
    .action(
      async (id: string | undefined, opts: { dir: string; all: boolean }, command: Command) => {
        try {
          // Commander quirk (verified empirically, R13.2): when a parent
          // command and one of its subcommands both declare the SAME option
          // flag (here `--dir`, also declared on `session` above for the
          // tree-view action), commander's default non-positional option
          // parsing lets the value typed on the command line get captured by
          // whichever command's parser reaches it first while scanning the
          // full remaining argv — NOT necessarily this subcommand's own
          // `opts()`. `opts.dir` above is therefore unreliable here; the
          // parent's own parsed value (`command.parent.opts().dir`) is the one
          // that actually reflects what the user typed, in both
          // `forget --dir <path> <id>` and `forget <id> --dir <path>` order.
          const dir = command.parent?.opts<{ dir: string }>().dir ?? opts.dir;
          const store = LocalConversationStore.forProjectDir(dir);

          if (opts.all) {
            if (id !== undefined) {
              process.stderr.write("golem: pass either an id or --all, not both\n");
              process.exitCode = 1;
              return;
            }
            await store.forgetAll();
            process.stdout.write("Deleted every conversation in the local store.\n");
            return;
          }

          if (id === undefined) {
            process.stderr.write("golem: session forget requires an <id> or --all\n");
            process.exitCode = 1;
            return;
          }

          const deleted = await store.forget(id);
          process.stdout.write(
            deleted ? `Deleted conversation ${id}.\n` : `No stored conversation ${id}.\n`,
          );
        } catch (err) {
          process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exitCode = 1;
        }
      },
    );
}
