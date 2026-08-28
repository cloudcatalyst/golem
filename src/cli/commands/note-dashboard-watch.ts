/**
 * golem note / dashboard / watch — extracted from program.ts (R8.27).
 */

import type { Command } from "commander";
import { findProjectDir, loadConfig } from "../../config/index.js";
import { LAN_HOST, startDashboard } from "../../dashboard/index.js";
import { InitError } from "../init.js";
import { statsSourceForCli } from "../mcp-compression.js";
import { appendNote, listNotes, renderNotes } from "../notes.js";
import { collectSessionStateReport } from "../session-report.js";
import { collectStats } from "../stats.js";
import { runWatch } from "../watch.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

export default function register(program: Command): void {
  const noteCmd = program
    .command("note")
    .description("Capture a quick idea/note into the local capture log (spec Decision 20f)");
  noteCmd
    .argument("[text...]", "note text to capture (quote it, or pass several words)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (text: string[], opts: { dir: string }) => {
      if (text.length === 0) {
        noteCmd.help();
        return;
      }
      try {
        const entry = await appendNote(opts.dir, text.join(" "), new Date().toISOString());
        process.stdout.write(`captured: ${entry.text}\n`);
      } catch (err) {
        _fail(err);
      }
    });

  noteCmd
    .command("list")
    .description("Show recently captured notes, newest first")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("-n, --limit <count>", "how many notes to show", "20")
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; limit: string; json: boolean }) => {
      try {
        const limit = Number(opts.limit);
        if (!Number.isInteger(limit) || limit <= 0)
          throw new InitError(`invalid --limit "${opts.limit}"`);
        const entries = await listNotes(opts.dir, limit);
        process.stdout.write(
          opts.json ? `${JSON.stringify(entries, null, 2)}\n` : renderNotes(entries),
        );
      } catch (err) {
        _fail(err);
      }
    });

  noteCmd
    .command("distill")
    .description(
      "Distill a captured note into a zone-1 question/artifact draft (local model, R3.5)",
    )
    .argument("[ts]", "timestamp of the note to distill")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--force", "re-distill even if a draft already exists", false)
    .action(async (ts: string | undefined, opts: { dir: string; force: boolean }) => {
      try {
        const { distillNoteCapture } = await import("../distill-note.js");
        const result = await distillNoteCapture({
          projectDir: opts.dir,
          ...(ts !== undefined && { ts }),
          force: opts.force,
        });
        process.stdout.write(
          result.kind === "exists"
            ? `draft already exists: ${result.path} (pass --force to re-distill)\n`
            : `distilled: ${result.path}\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });

  program
    .command("dashboard")
    .description("Serve the local savings dashboard (loopback by default; --lan for a phone)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--port <port>", "listen port (overrides config telemetry.dashboard_port)")
    .option(
      "--lan",
      "bind every interface so a phone on the same network can read it (R12.5) — read-only, no write route exists",
    )
    .action(async (opts: { dir: string; port?: string; lan?: boolean }) => {
      try {
        const { settings } = await loadConfig({ projectDir: opts.dir });
        const port =
          opts.port === undefined ? settings.telemetry.dashboard_port : Number(opts.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535)
          throw new InitError(`invalid port "${opts.port}"`);
        // The flag is a one-run override of the config setting; neither can be
        // set from the phone, which is the point (see `telemetry.dashboard_lan`).
        const lan = opts.lan === true || settings.telemetry.dashboard_lan;
        const source = await statsSourceForCli(opts.dir);
        const handle = await startDashboard({
          port,
          ...(lan ? { host: LAN_HOST } : {}),
          snapshot: async () => {
            const { getDialInfo } = await import("../dials.js");
            const { blockedView } = await import("../blocked-view.js");
            const { readSessionState, resolveBlock } = await import("../../hooks/session-state.js");
            const [dial, stats, session] = await Promise.all([
              getDialInfo("compression", { projectDir: opts.dir }),
              collectStats(source),
              readSessionState(opts.dir),
            ]);
            return {
              project_dir: opts.dir,
              compression: { level: dial.setting, name: dial.label },
              stats,
              // R12.2: the same blocked read model `/api/state` serves, so the
              // page itself renders it instead of only the JSON endpoint.
              blocked: blockedView(resolveBlock(session)),
              generated_at: new Date().toISOString(),
            };
          },
          sessionState: () => collectSessionStateReport(opts.dir),
        });
        process.stdout.write(`golem dashboard on ${handle.url} (Ctrl+C to stop)\n`);
        process.stdout.write(`  consolidated session state: ${handle.url}api/state\n`);
        if (lan) {
          // Print the addresses a phone can actually type. `0.0.0.0` is a bind
          // target, not a destination, and `127.0.0.1` is the one address on the
          // machine that a phone definitely cannot reach — so a LAN bind that
          // only prints those two is a feature the user cannot use.
          const { lanUrls } = await import("../../dashboard/index.js");
          const urls = lanUrls(handle.port);
          process.stdout.write(
            "\n⚠ LAN mode: this dashboard is now readable by anything on your network.\n" +
              "  It is READ-ONLY — no write route exists and every method but GET/HEAD is refused —\n" +
              "  but the project path, the tool call being waited on, and your savings figures are visible.\n",
          );
          if (urls.length === 0) {
            process.stdout.write(
              "  no non-loopback address found — is this machine on a network?\n",
            );
          } else {
            process.stdout.write("  open on your phone (same Wi-Fi), then Add to Home Screen:\n");
            for (const url of urls) process.stdout.write(`    ${url}\n`);
          }
        }
        const shutdown = (): void => {
          void handle.close().finally(() => process.exit(0));
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      } catch (err) {
        _fail(err);
      }
    });

  program
    .command("watch")
    .description("Full-screen sidecar TUI of Golem's live session state (run in a second pane)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--interval <ms>", "refresh interval in milliseconds")
    .option("--no-color", "disable ANSI colors")
    .action(async (opts: { dir: string; interval?: string; color?: boolean }) => {
      try {
        const refreshMs = opts.interval === undefined ? undefined : Number(opts.interval);
        if (refreshMs !== undefined && (!Number.isFinite(refreshMs) || refreshMs < 100))
          throw new InitError(`invalid --interval "${opts.interval}" (must be ≥ 100 ms)`);
        await runWatch({
          dir: opts.dir,
          ...(refreshMs !== undefined ? { refreshMs } : {}),
          ...(opts.color !== undefined ? { color: opts.color } : {}),
        });
        process.exit(0);
      } catch (err) {
        _fail(err);
      }
    });
}
