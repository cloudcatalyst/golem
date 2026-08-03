/**
 * golem autonomy — extracted from program.ts (R8.27).
 */

import type { Command } from "commander";
import {
  AUTONOMY_LEVEL_HELP,
  AUTONOMY_LEVELS,
  parseAutonomyLevel,
  readActionLog,
  readAutonomyState,
  setAutonomyGateEnabled,
  writeAutonomyLevel,
} from "../../autonomy/index.js";
import { findProjectDir } from "../../config/index.js";
import { addEventHook, removeEventHook } from "../../hooks/index.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();
const PRE_TOOL_USE_HOOK_COMMAND = "golem hook pre-tool-use";

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}

export default function register(program: Command): void {
  const autonomyCmd = program
    .command("autonomy")
    .description("Cruise-control autonomy level + approval gate (see ADR-0002)");

  autonomyCmd
    .command("show", { isDefault: true })
    .description("Show the current autonomy level")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        const { level, enabled } = await readAutonomyState(opts.dir);
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify({ level, enabled, help: AUTONOMY_LEVEL_HELP[level] }, null, 2)}\n`,
          );
          return;
        }
        process.stdout.write(
          `autonomy gate: ${enabled ? "ENABLED" : "DISABLED"} — level ${level} — ${AUTONOMY_LEVEL_HELP[level]}\n`,
        );
        if (!enabled)
          process.stdout.write(
            "⚠ The gate is OFF: Golem adds no approval prompts; your Claude Code allow-list + native prompts govern every action. Re-enable with `golem autonomy enable`.\n",
          );
        else if (level !== "manual")
          process.stdout.write(
            `⚠ Golem is auto-approving some steps at level "${level}". Destructive/outward actions still require your approval (ADR-0002). Set 'manual' to disable.\n`,
          );
        process.stdout.write(
          "the gate needs the PreToolUse hook wired (`golem init` does this by default; `golem autonomy wire`/`unwire` toggle it). Turn the gate off without unwiring: `golem autonomy disable`.\n",
        );
      } catch (err) {
        _fail(err);
      }
    });

  autonomyCmd
    .command("enable")
    .description("Turn the autonomy approval gate ON (the default)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (opts: { dir: string }) => {
      try {
        await setAutonomyGateEnabled(opts.dir, true);
        const { level } = await readAutonomyState(opts.dir);
        process.stdout.write(
          `autonomy gate ENABLED — level ${level} — ${AUTONOMY_LEVEL_HELP[level]}\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });

  autonomyCmd
    .command("disable")
    .description("Turn the autonomy approval gate OFF")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (opts: { dir: string }) => {
      try {
        await setAutonomyGateEnabled(opts.dir, false);
        process.stdout.write(
          "autonomy gate DISABLED — Golem adds no approval prompts; your Claude Code allow-list + native prompts govern. The snooze + coder-first nudges still run. Re-enable with `golem autonomy enable`.\n",
        );
      } catch (err) {
        _fail(err);
      }
    });

  autonomyCmd
    .command("set")
    .description(`Set the autonomy level (${AUTONOMY_LEVELS.join(" | ")})`)
    .argument("<level>", "autonomy level", parseAutonomyLevel)
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (level: ReturnType<typeof parseAutonomyLevel>, opts: { dir: string }) => {
      try {
        await writeAutonomyLevel(opts.dir, level);
        process.stdout.write(`autonomy level set to ${level} — ${AUTONOMY_LEVEL_HELP[level]}\n`);
        if (level !== "manual")
          process.stdout.write(
            `⚠ Golem will now auto-approve ${level === "outcome" ? "read + write" : "read-only"} actions once wired. Destructive/outward steps still require your approval.\n`,
          );
      } catch (err) {
        _fail(err);
      }
    });

  autonomyCmd
    .command("wire")
    .description("Install the PreToolUse gate hook in .claude/settings.json")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (opts: { dir: string }) => {
      try {
        const action = await addEventHook(
          { projectDir: opts.dir },
          "PreToolUse",
          PRE_TOOL_USE_HOOK_COMMAND,
        );
        process.stdout.write(`${action.kind}: ${action.path} — ${action.detail}\n`);
        process.stdout.write("autonomy gate wired. Restart Claude Code to activate.\n");
      } catch (err) {
        _fail(err);
      }
    });

  autonomyCmd
    .command("unwire")
    .description("Remove the PreToolUse gate hook")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (opts: { dir: string }) => {
      try {
        const action = await removeEventHook(
          { projectDir: opts.dir },
          "PreToolUse",
          PRE_TOOL_USE_HOOK_COMMAND,
        );
        process.stdout.write(`${action.kind}: ${action.path} — ${action.detail}\n`);
      } catch (err) {
        _fail(err);
      }
    });

  autonomyCmd
    .command("log")
    .description("Show the autonomy action log")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("-n, --limit <count>", "how many entries to show", "50")
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; limit: string; json: boolean }) => {
      try {
        const limit = Number(opts.limit);
        if (!Number.isInteger(limit) || limit <= 0)
          throw new Error(`invalid --limit "${opts.limit}"`);
        const entries = await readActionLog(opts.dir, limit);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
          return;
        }
        if (entries.length === 0) {
          process.stdout.write("no autonomy decisions logged yet\n");
          return;
        }
        for (const e of entries)
          process.stdout.write(
            `  ${e.ts}  ${e.decision.padEnd(6)} ${e.action.padEnd(11)} ${e.tool}\n`,
          );
      } catch (err) {
        _fail(err);
      }
    });
}
