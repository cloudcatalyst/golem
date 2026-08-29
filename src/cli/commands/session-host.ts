/**
 * `golem session host` — R13.3's CLI surface.
 *
 * Deliberately a subcommand of `session` rather than a new top-level verb: the
 * session tree, the conversation store and a hosted session are three views of
 * the same subject, and a developer looking for "what sessions exist" should
 * find them together.
 */

import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { classifyAction } from "../../autonomy/index.js";
import { findProjectDir, loadConfig } from "../../config/index.js";
import {
  appendHostLog,
  findHostSession,
  forgetHostSession,
  HostedSession,
  hostSettingsArg,
  listHostSessions,
  readHostLog,
  reapDeadSessions,
  registerHostSession,
  updateHostSession,
} from "../../session/index.js";
import { InitError } from "../init.js";
import { defaultProjectPort } from "../proxy-daemon.js";
import { proxyBaseUrl } from "../proxy-wiring.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

const out = (s: string): void => void process.stdout.write(s);

/** `2026-08-29T10:04:00.000Z` -> `2026-08-29 10:04`. */
function short(iso: string | undefined): string {
  if (iso === undefined) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Resolve `--dir` by walking the command chain.
 *
 * The same commander quirk `session forget` documents (R13.2): when a parent
 * command and a descendant both declare `--dir`, the value typed on the command
 * line can be captured by whichever parser reaches it first while scanning the
 * remaining argv — not necessarily this subcommand's own `opts()`. `session`
 * declares `--dir` for its tree view, so `session host start --dir X` lands on
 * `session`, and reading only the leaf's `opts()` silently hosts the session in
 * the WRONG PROJECT — observed live 2026-08-29, which is how this helper exists.
 *
 * Walking the chain and preferring the first EXPLICIT value fixes it in both
 * flag orders without either command having to know about the other.
 */
function resolveDir(command: Command, own: string): string {
  for (let c: Command | null = command; c !== null; c = c.parent) {
    const value = c.opts<{ dir?: string }>().dir;
    // Skip the defaulted value: every level defaults to _DEFAULT_DIR, so
    // "is set" is not the question — "was typed" is.
    if (typeof value === "string" && value !== _DEFAULT_DIR) return value;
  }
  return own;
}

export default function register(session: Command): void {
  const host = session
    .command("host")
    .description("Run an agent session Golem owns — supervised, through the proxy, refusable");

  host
    .command("start", { isDefault: true })
    .description("Start a hosted session and relay one or more messages to it")
    .argument("[message...]", "the first turn to relay")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--origin <who>", 'who authored the turn — a device id, or "local"', "local")
    .action(async (message: string[], opts: { dir: string; origin: string }, command: Command) => {
      try {
        const dir = resolveDir(command, opts.dir);
        if (message.length === 0) {
          throw new InitError('give the first turn: `golem session host start "your message"`');
        }
        const text = message.join(" ");
        const { settings } = await loadConfig({ projectDir: dir });
        const port = settings.proxy.port ?? defaultProjectPort(dir);
        const baseUrl = proxyBaseUrl(port);
        const id = randomUUID();

        const hosted = new HostedSession({
          projectDir: dir,
          proxyBaseUrl: baseUrl,
          settingsJson: hostSettingsArg({ sessionId: id }),
        });

        await registerHostSession(dir, {
          id,
          projectDir: dir,
          startedAt: new Date().toISOString(),
          pid: process.pid,
        });
        await appendHostLog(dir, {
          kind: "lifecycle",
          ts: new Date().toISOString(),
          sessionId: id,
          event: "started",
          detail: `runner through ${baseUrl}`,
        });

        out(`hosted session ${id}\n  project: ${dir}\n  proxy:   ${baseUrl}\n\n`);

        hosted.on("event", (event: { type: string; [k: string]: unknown }) => {
          switch (event.type) {
            case "text":
              out(`\n${String(event.text)}\n`);
              break;
            case "tool_use":
              // ADR-0007 §2: tool calls are VISIBLE. A hosted session that only
              // showed prose would be asking for trust it has not earned.
              out(`  → ${String(event.name)} ${JSON.stringify(event.input).slice(0, 160)}\n`);
              break;
            case "tool_result":
              out(
                `  ← ${event.isError === true ? "REFUSED/ERROR" : "ok"}: ${String(event.content).slice(0, 300)}\n`,
              );
              break;
            case "permission_denied":
              out(`  ⛔ runner guard refused ${String(event.tool)}: ${String(event.message)}\n`);
              break;
            case "rate_limit":
              // Invariant 8: a hosted session is subject to the park like
              // anything else, and says so rather than dying quietly.
              out("  ⏸ rate-limit pressure reported by the runner\n");
              break;
            case "result":
              out(
                `\n[turn complete${typeof event.costUsd === "number" ? ` · $${event.costUsd.toFixed(4)}` : ""}]\n`,
              );
              hosted.end();
              break;
          }
        });

        hosted.on("exit", async (info: { code: number | null; error?: string }) => {
          await updateHostSession(dir, id, {
            stoppedAt: new Date().toISOString(),
            ...(hosted.runnerSessionId !== undefined
              ? { runnerSessionId: hosted.runnerSessionId }
              : {}),
            ...(info.error !== undefined ? { lastError: info.error } : {}),
          });
          await appendHostLog(dir, {
            kind: "lifecycle",
            ts: new Date().toISOString(),
            sessionId: id,
            event: info.error === undefined ? "stopped" : "crashed",
            ...(info.error !== undefined ? { detail: info.error } : {}),
          });
          if (info.error !== undefined) out(`\nsession ended: ${info.error}\n`);
          process.exit(info.code ?? 0);
        });

        hosted.start();

        // Invariant 4: attribution BEFORE delivery. A turn nobody can attribute
        // must not run, so the log write is awaited before the relay.
        await appendHostLog(dir, {
          kind: "turn",
          ts: new Date().toISOString(),
          sessionId: id,
          origin: opts.origin,
          text,
        });
        hosted.send(text);

        // A kill mid-turn denies rather than dangles: the runner dies with this
        // process, and the lifecycle line records that the turn was abandoned.
        const abandon = (): void => {
          void appendHostLog(dir, {
            kind: "lifecycle",
            ts: new Date().toISOString(),
            sessionId: id,
            event: "stopped",
            detail: "link killed mid-turn — the turn was abandoned, not answered",
          }).finally(() => {
            hosted.kill();
            process.exit(130);
          });
        };
        process.on("SIGINT", abandon);
        process.on("SIGTERM", abandon);
      } catch (err) {
        _fail(err);
      }
    });

  host
    .command("list")
    .description("Hosted sessions for this project, with liveness actually checked")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }, command: Command) => {
      try {
        const dir = resolveDir(command, opts.dir);
        await reapDeadSessions(dir, new Date().toISOString());
        const sessions = await listHostSessions(dir);
        if (opts.json) {
          out(`${JSON.stringify(sessions, null, 2)}\n`);
          return;
        }
        if (sessions.length === 0) {
          out('no hosted sessions — `golem session host start "…"` makes one\n');
          return;
        }
        for (const s of sessions) {
          const state = s.alive ? "RUNNING" : (s.lastError ?? "stopped");
          out(`  ${s.id}  ${short(s.startedAt)}  pid ${s.pid}  ${state}\n`);
        }
      } catch (err) {
        _fail(err);
      }
    });

  host
    .command("log")
    .description("The attributable record: turns relayed, decisions made, lifecycle")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("-n, --limit <count>", "how many entries", "50")
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; limit: string; json: boolean }, command: Command) => {
      try {
        const dir = resolveDir(command, opts.dir);
        const limit = Number(opts.limit);
        if (!Number.isInteger(limit) || limit <= 0) {
          throw new InitError(`invalid --limit "${opts.limit}"`);
        }
        const entries = await readHostLog(dir, limit);
        if (opts.json) {
          out(`${JSON.stringify(entries, null, 2)}\n`);
          return;
        }
        if (entries.length === 0) {
          out("no hosted-session activity recorded\n");
          return;
        }
        for (const e of entries) {
          if (e.kind === "turn") {
            out(`  ${e.ts}  TURN     ${e.origin.padEnd(10)} ${e.text.slice(0, 90)}\n`);
          } else if (e.kind === "decision") {
            out(
              `  ${e.ts}  ${e.decision.toUpperCase().padEnd(8)} ${e.tool.padEnd(10)} ${e.action.padEnd(11)} ${e.reason.slice(0, 70)}\n`,
            );
          } else {
            out(`  ${e.ts}  ${e.event.toUpperCase().padEnd(8)} ${e.detail ?? ""}\n`);
          }
        }
      } catch (err) {
        _fail(err);
      }
    });

  host
    .command("stop")
    .description("Stop a hosted session — the turn in flight is abandoned, not answered")
    .argument("<id>")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (id: string, opts: { dir: string }, command: Command) => {
      try {
        const dir = resolveDir(command, opts.dir);
        const found = await findHostSession(dir, id);
        if (found === null) throw new InitError(`no hosted session ${id}`);
        if (!found.alive) {
          out(`${id} is not running\n`);
          return;
        }
        process.kill(found.pid);
        await updateHostSession(dir, id, { stoppedAt: new Date().toISOString() });
        await appendHostLog(dir, {
          kind: "lifecycle",
          ts: new Date().toISOString(),
          sessionId: id,
          event: "stopped",
          detail: "stopped by `golem session host stop`",
        });
        out(`stopped ${id}\n`);
      } catch (err) {
        _fail(err);
      }
    });

  host
    .command("forget")
    .description("Drop a hosted session's record and its transcript")
    .argument("<id>")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (id: string, opts: { dir: string }, command: Command) => {
      try {
        const dir = resolveDir(command, opts.dir);
        const gone = await forgetHostSession(dir, id);
        out(gone ? `forgot ${id}\n` : `no hosted session ${id}\n`);
      } catch (err) {
        _fail(err);
      }
    });

  host
    .command("explain")
    .description("What the host would decide about a tool call, without running one")
    .argument("<tool>", "tool name, e.g. Bash")
    .argument("[input...]", "the argument, e.g. the bash command")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (tool: string, input: string[], opts: { dir: string }, command: Command) => {
      try {
        const dir = resolveDir(command, opts.dir);
        const { decideHostGate, resolveHostGate } = await import("../../session/index.js");
        const { readAutonomyLevel } = await import("../../autonomy/index.js");
        const level = await readAutonomyLevel(dir);
        const action = classifyAction(tool, { command: input.join(" ") });
        const resolved = resolveHostGate(decideHostGate(level, action));
        out(
          `tool:     ${tool}\naction:   ${action}\nlevel:    ${level}\ndecision: ${resolved.decision.toUpperCase()}\nreason:   ${resolved.reason}\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });
}
