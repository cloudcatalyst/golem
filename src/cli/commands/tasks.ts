/**
 * golem task — extracted from program.ts (R8.27).
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { findProjectDir, loadConfig } from "../../config/index.js";
import {
  createProbeRunner,
  detectCapability,
  OllamaClient,
  OllamaInferenceService,
} from "../../inference/index.js";
import {
  buildResumeArgv,
  createTask,
  escalateTask,
  FileTaskStore,
  isResumable,
  PlanTaskStore,
  runQueueLocally,
} from "../../tasks/index.js";
import { InitError } from "../init.js";
import {
  groupPlanTasks,
  renderPlanIndex,
  renderPlanSummary,
  splicePlanIndex,
} from "../plan-index.js";
import {
  findScopedTask,
  findTask,
  listScopedTasks,
  renderScopedTaskList,
  renderTask,
  spawnResume,
  storeForScope,
} from "../task.js";
import { buildTaskGrounding } from "../task-grounding.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

async function _buildInferenceForDir(dir: string) {
  try {
    const { settings } = await loadConfig({ projectDir: dir });
    const client = new OllamaClient({
      baseUrl: settings.inference.ollama_base_url,
      requestTimeoutMs: settings.inference.request_timeout_ms,
    });
    const facts = await detectCapability(createProbeRunner());
    return new OllamaInferenceService(client, facts);
  } catch {
    return null;
  }
}

export default function register(program: Command): void {
  const taskCmd = program
    .command("task")
    .description(
      "Durable task queue — persist a prompt/agent and resume it later (survives limits)",
    );

  taskCmd
    .command("add")
    .description("Queue a durable task (a prompt to run/resume later)")
    .argument("<prompt...>", "the prompt/instructions to persist")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--title <text>", "short label for `task list`")
    .option("--session-id <uuid>", "Claude Code session id to resume deterministically")
    .option("--continue", "resume the most-recent conversation instead of a session id", false)
    .option("--agent <type>", "agent type to relaunch as")
    .option("--idem-key <key>", "idempotency key for the side effect this task owns")
    .option("--not-before <iso>", "capacity gate: don't auto-resume before this ISO time")
    .option("--json", "machine-readable output", false)
    .action(
      async (
        prompt: string[],
        opts: {
          dir: string;
          title?: string;
          sessionId?: string;
          continue: boolean;
          agent?: string;
          idemKey?: string;
          notBefore?: string;
          json: boolean;
        },
      ) => {
        try {
          const task = createTask({
            prompt: prompt.join(" "),
            continueLatest: opts.continue,
            ...(opts.title !== undefined ? { title: opts.title } : {}),
            ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
            ...(opts.agent !== undefined ? { agentType: opts.agent } : {}),
            ...(opts.idemKey !== undefined ? { idempotencyKey: opts.idemKey } : {}),
            ...(opts.notBefore !== undefined ? { notBefore: opts.notBefore } : {}),
          });
          const stored = await new FileTaskStore(opts.dir).put(task);
          process.stdout.write(
            opts.json ? `${JSON.stringify(stored, null, 2)}\n` : `queued task ${stored.id}\n`,
          );
        } catch (err) {
          _fail(err);
        }
      },
    );

  taskCmd
    .command("list")
    .description("List tasks — committed roadmap tasks and this machine's parked ones")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--plan", "only committed roadmap tasks", false)
    .option("--local", "only this machine's parked tasks", false)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; plan: boolean; local: boolean; json: boolean }) => {
      try {
        if (opts.plan && opts.local)
          throw new InitError(
            "--plan and --local are mutually exclusive (omit both for all tasks)",
          );
        const only = opts.plan ? "plan" : opts.local ? "local" : undefined;
        const entries = await listScopedTasks(opts.dir, only);
        process.stdout.write(
          opts.json
            ? `${JSON.stringify(
                entries.map((e) => ({ scope: e.scope, ...e.task })),
                null,
                2,
              )}\n`
            : renderScopedTaskList(entries),
        );
      } catch (err) {
        _fail(err);
      }
    });

  taskCmd
    .command("show")
    .description("Show one task in detail")
    .argument("<id>", "task id or unique prefix")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (id: string, opts: { dir: string; json: boolean }) => {
      try {
        const found = findScopedTask(await listScopedTasks(opts.dir), id);
        if (found === "none") throw new InitError(`no task matching "${id}"`);
        if (found === "ambiguous") throw new InitError(`"${id}" matches more than one task`);
        process.stdout.write(
          opts.json
            ? `${JSON.stringify({ scope: found.scope, ...found.task }, null, 2)}\n`
            : renderTask(found.task),
        );
      } catch (err) {
        _fail(err);
      }
    });

  taskCmd
    .command("index")
    .description("Render the roadmap open-work index from docs/plan/tasks/")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--summary", "one-screen terminal summary", false)
    .option("--write [file]", "splice the Markdown between the golem:task-index markers")
    .option("--json", "machine-readable output", false)
    .action(
      async (opts: { dir: string; summary: boolean; write?: string | boolean; json: boolean }) => {
        try {
          const tasks = await new PlanTaskStore(opts.dir).list();
          if (opts.json) {
            const { ready, blocked, done } = groupPlanTasks(tasks);
            process.stdout.write(`${JSON.stringify({ ready, blocked, done }, null, 2)}\n`);
            return;
          }
          if (opts.summary) {
            process.stdout.write(renderPlanSummary(tasks));
            return;
          }
          const rendered = renderPlanIndex(tasks);
          if (opts.write === undefined || opts.write === false) {
            process.stdout.write(`${rendered}\n`);
            return;
          }
          const target =
            typeof opts.write === "string"
              ? opts.write
              : path.join(opts.dir, "docs", "plan", "ROADMAP.md");
          const before = await readFile(target, "utf8");
          const { text, spliced } = splicePlanIndex(before, rendered);
          if (!spliced) throw new InitError(`${target} has no golem:task-index markers`);
          if (text === before) {
            process.stdout.write(`${target} already up to date\n`);
            return;
          }
          await writeFile(target, text, "utf8");
          process.stdout.write(`updated the task index in ${target}\n`);
        } catch (err) {
          _fail(err);
        }
      },
    );

  taskCmd
    .command("resume")
    .description("Build (and optionally spawn) the headless resume command for a task")
    .argument("<id>", "task id or unique prefix")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--spawn", "actually launch it (detached); default just prints the command", false)
    .option("--output-json", "resume with --output-format json", false)
    .option("--permission-mode <mode>", "begin the resumed session in this permission mode")
    .action(
      async (
        id: string,
        opts: { dir: string; spawn: boolean; outputJson: boolean; permissionMode?: string },
      ) => {
        try {
          const store = new FileTaskStore(opts.dir);
          const task = findTask(await store.list(), id);
          if (task === "none") throw new InitError(`no task matching "${id}"`);
          if (task === "ambiguous") throw new InitError(`"${id}" matches more than one task`);
          if (!isResumable(task)) {
            process.stdout.write(`task ${task.id} is not resumable (state is ${task.state})\n`);
            return;
          }
          const argv = buildResumeArgv(task, {
            outputJson: opts.outputJson,
            ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
          });
          if (!opts.spawn) {
            process.stdout.write(
              `resume command (pass --spawn to launch it):\n  ${argv.join(" ")}\n`,
            );
            return;
          }
          const result = spawnResume(argv);
          await store.put({ ...task, state: "running", attempts: task.attempts + 1 });
          process.stdout.write(
            result.spawned
              ? `resumed task ${task.id} (pid ${result.pid ?? "?"})\n`
              : `could not spawn — ${result.note ?? "run it manually"}:\n  ${result.command}\n`,
          );
        } catch (err) {
          _fail(err);
        }
      },
    );

  taskCmd
    .command("cancel")
    .description("Mark a task cancelled (keeps the record)")
    .argument("<id>", "task id or unique prefix")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--delete", "remove the task record entirely", false)
    .action(async (id: string, opts: { dir: string; delete: boolean }) => {
      try {
        const found = findScopedTask(await listScopedTasks(opts.dir), id);
        if (found === "none") throw new InitError(`no task matching "${id}"`);
        if (found === "ambiguous") throw new InitError(`"${id}" matches more than one task`);
        const { task, scope } = found;
        const store = storeForScope(scope, opts.dir);
        if (opts.delete) {
          await store.delete(task.id);
          process.stdout.write(
            scope === "plan"
              ? `deleted plan task ${task.id} — its document is gone, commit the removal\n`
              : `deleted task ${task.id}\n`,
          );
          return;
        }
        await store.put({ ...task, state: "cancelled" });
        process.stdout.write(`cancelled ${scope} task ${task.id}\n`);
      } catch (err) {
        _fail(err);
      }
    });

  taskCmd
    .command("done")
    .description("Mark a task done")
    .argument("<id>", "task id or unique prefix")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--note <text>", "short outcome note appended to the task body")
    .action(async (id: string, opts: { dir: string; note?: string }) => {
      try {
        const found = findScopedTask(await listScopedTasks(opts.dir), id);
        if (found === "none") throw new InitError(`no task matching "${id}"`);
        if (found === "ambiguous") throw new InitError(`"${id}" matches more than one task`);
        const { task, scope } = found;
        const prompt =
          opts.note === undefined ? task.prompt : `${task.prompt}\n\n## Outcome\n\n${opts.note}`;
        await storeForScope(scope, opts.dir).put({ ...task, state: "done", prompt });
        process.stdout.write(
          scope === "plan"
            ? `marked plan task ${task.id} done — run "golem task index --write" to refresh the roadmap\n`
            : `marked task ${task.id} done\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });

  taskCmd
    .command("run")
    .description("Service queued tasks LOCALLY (Ollama tier) — non-blocking multiplexing (R5.3)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--concurrency <n>", "max tasks serviced at once (default 2)", "2")
    .option("--limit <n>", "cap how many queued tasks to service this run")
    .action(async (opts: { dir: string; concurrency: string; limit?: string }) => {
      try {
        const concurrency = Number(opts.concurrency);
        if (!Number.isInteger(concurrency) || concurrency < 1)
          throw new InitError(`invalid --concurrency "${opts.concurrency}"`);
        const limit = opts.limit === undefined ? undefined : Number(opts.limit);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
          throw new InitError(`invalid --limit "${opts.limit}"`);
        const inference = await _buildInferenceForDir(opts.dir);
        if (inference === null) {
          process.stdout.write(
            "local model unavailable — queued tasks left as-is (start Ollama, then `golem task run`).\n",
          );
          return;
        }
        const ground = await buildTaskGrounding(opts.dir, inference);
        const result = await runQueueLocally(
          new FileTaskStore(opts.dir),
          { inference, ...(ground !== undefined ? { ground } : {}) },
          { concurrency, ...(limit !== undefined ? { limit } : {}) },
        );
        if (result.total === 0) {
          process.stdout.write("no queued tasks to service\n");
          return;
        }
        if (result.localModelUnavailable) {
          process.stdout.write(
            `local model unavailable — ${result.total} task(s) left queued (retry when Ollama is up).\n`,
          );
          return;
        }
        process.stdout.write(
          `serviced ${result.serviced}/${result.total} queued task(s) locally${result.failed > 0 ? ` (${result.failed} failed — see \`golem task show\`)` : ""}.\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });

  taskCmd
    .command("escalate")
    .description(
      "Hand a task to the Claude tier: fold its local result into the prompt (R5.3 / 21a)",
    )
    .argument("<id>", "task id or unique prefix")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (id: string, opts: { dir: string }) => {
      try {
        const store = new FileTaskStore(opts.dir);
        const task = findTask(await store.list(), id);
        if (task === "none") throw new InitError(`no task matching "${id}"`);
        if (task === "ambiguous") throw new InitError(`"${id}" matches more than one task`);
        const stored = await store.put(escalateTask(task, null));
        process.stdout.write(
          `escalated task ${stored.id} to the Claude tier — resume it with \`golem task resume ${stored.id.slice(0, 8)} --spawn\`\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });
}
