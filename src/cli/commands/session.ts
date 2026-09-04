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
import { FileJoinQueue } from "../../session/join-queue.js";
import { readLiveConversations } from "../../session/live-conversations.js";
import { readSessionTree, renderSessionTree, sessionTreePath } from "../../session/session-tree.js";
import register_session_host from "./session-host.js";

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

  // R13.3 — `golem session host …`
  register_session_host(session);

  // R13.7 — invariant 4's local half. The developer at the keyboard can see what
  // their own device said into their session: what is waiting, what landed, and
  // which conversations can be addressed at all.
  session
    .command("pending")
    .description(
      "Show messages a paired device has sent into running conversations — what is " +
        "waiting, what was delivered, and which conversations can be addressed (R13.7)",
    )
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }, command: Command) => {
      try {
        // Same commander `--dir` quirk documented on `forget` below.
        const dir = command.parent?.opts<{ dir: string }>().dir ?? opts.dir;
        const { loadConfig } = await import("../../config/index.js");
        const { settings } = await loadConfig({ projectDir: dir });
        const queue = new FileJoinQueue({ projectDir: dir });
        const [messages, conversations] = await Promise.all([
          queue.list(),
          readLiveConversations(dir),
        ]);

        if (opts.json) {
          const payload = {
            injectionEnabled: settings.security.join_injection,
            conversations,
            messages,
          };
          process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
          return;
        }

        process.stdout.write(
          settings.security.join_injection
            ? "Delivery into running sessions: ON (security.join_injection)\n"
            : "Delivery into running sessions: OFF — messages are refused at the door (security.join_injection)\n",
        );

        process.stdout.write(`\nAddressable conversations (${conversations.length}):\n`);
        if (conversations.length === 0) {
          process.stdout.write("  none — the proxy has seen no recent requests\n");
        }
        for (const c of conversations) {
          // An ambiguous key is SHOWN, not hidden: a user should see why a
          // conversation they can name cannot be written to (invariant 3).
          const flag = c.ambiguous ? "  [AMBIGUOUS — not addressable]" : "";
          process.stdout.write(
            `  ${c.conversationId}  ${c.messageCount} messages  last ${c.lastRequestAt}${flag}\n`,
          );
        }

        const waiting = messages.filter(
          (m) => m.deliveredAt === undefined && m.expiredAt === undefined,
        );
        process.stdout.write(`\nWaiting (${waiting.length}):\n`);
        if (waiting.length === 0) process.stdout.write("  nothing queued\n");
        for (const m of waiting) {
          const excerpt = m.text.replace(/\s+/g, " ").slice(0, 100);
          process.stdout.write(
            `  ${m.messageId} → ${m.conversationId}  from ${m.deviceId}  queued ${m.enqueuedAt}\n` +
              `      ${excerpt}\n`,
          );
        }

        const settled = messages.filter(
          (m) => m.deliveredAt !== undefined || m.expiredAt !== undefined,
        );
        process.stdout.write(`\nSettled (${settled.length}):\n`);
        if (settled.length === 0) process.stdout.write("  nothing yet\n");
        for (const m of settled) {
          const what =
            m.expiredAt !== undefined
              ? `EXPIRED ${m.expiredAt} (waited too long to be delivered)`
              : `delivered ${m.deliveredAt}`;
          process.stdout.write(
            `  ${m.messageId} → ${m.conversationId}  from ${m.deviceId}  ${what}\n`,
          );
        }
      } catch (err) {
        process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    });

  session
    .command("drop <messageId>")
    .description("Drop a still-waiting device message so it is never delivered (R13.7)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (messageId: string, opts: { dir: string }, command: Command) => {
      try {
        const dir = command.parent?.opts<{ dir: string }>().dir ?? opts.dir;
        const dropped = await new FileJoinQueue({ projectDir: dir }).forget(messageId);
        process.stdout.write(
          dropped
            ? `Dropped ${messageId}; it will never be delivered.\n`
            : `No waiting message ${messageId} (it may already have been delivered).\n`,
        );
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
