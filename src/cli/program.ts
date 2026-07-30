/**
 * Entry point for the `golem` command (WS-E).
 *
 * E2: init / uninit, plus the runtime commands they wire Claude Code to:
 *   - `golem proxy`      — the A1 proxy running the A3 redaction→compression
 *                          pipeline (Claude Code's ANTHROPIC_BASE_URL target)
 *   - `golem mcp serve`  — the B1 unified MCP server on stdio (.mcp.json entry)
 * E3: status / slider / stats / dashboard (+ index/devices stubs for WS-C/D).
 */

import { spawnSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import {
  AUTONOMY_LEVEL_HELP,
  AUTONOMY_LEVELS,
  parseAutonomyLevel,
  readActionLog,
  readAutonomyState,
  setAutonomyGateEnabled,
  writeAutonomyLevel,
} from "../autonomy/index.js";
// Imported from the module, not the config barrel: the barrel deliberately does
// not re-export the control surface (see src/config/index.ts).
import { collectControlSurface } from "../config/control-surface.js";
import { findProjectDir, loadConfig, settingsFilePaths } from "../config/index.js";
import type { SettingsScope } from "../config/write-setting.js";
import { startDashboard } from "../dashboard/index.js";
import {
  addEventHook,
  buildHookCommand,
  defaultRevalidate,
  GUIDANCE_FEATURES,
  type GuidanceScope,
  guidanceFeature,
  guidanceRulePath,
  removeEventHook,
  removeGuidanceRule,
  writeGuidanceRule,
} from "../hooks/index.js";
import { VERSION } from "../index.js";
import {
  createProbeRunner,
  detectCapability,
  embedModelFor,
  modelsForTier,
  OllamaClient,
  OllamaInferenceService,
} from "../inference/index.js";
import type { HardwareTier, InferenceService } from "../interfaces/inference.js";
import type { KnowledgeBase } from "../interfaces/knowledge.js";
import { migrateSliderLevel, type SliderLevel } from "../interfaces/policy.js";
import { fetchRawPage } from "../knowledge/index.js";
// NOT imported statically: `../mcp/index.js` pulls the MCP SDK, the single
// heaviest module in this file's graph (~700ms to load). Only `golem mcp serve`
// and `golem proxy start` need it, and both reach it through `await import()` at
// their use sites. Every other command — including `golem hook pre-tool-use`,
// which Claude Code runs on every tool call — skips it. (verification-notes §86)
import {
  appendExample,
  readExamples,
  readLastSuggestion,
  translatePrompt,
  writeLastSuggestion,
} from "../prompt/index.js";
import { UPSTREAM_AUTH_SCHEMES, UPSTREAM_PROVIDERS } from "../providers/index.js";
import {
  buildResumeArgv,
  createTask,
  escalateTask,
  FileTaskStore,
  isResumable,
  PlanTaskStore,
  runQueueLocally,
} from "../tasks/index.js";
import {
  type BenchWindow,
  buildCostBenchmark,
  openTelemetryStore,
  readTelemetryEvents,
  renderCostBenchmark,
  type TelemetryEvent,
  type ToolUsageStats,
} from "../telemetry/index.js";
import { checkForUpdate, detectInstallMethod } from "../update/index.js";
import { FederatedWikiReader, FileWikiStore } from "../wiki/index.js";
import {
  addAccount,
  collectAccounts,
  credentialEnvForProxy,
  loginAccount,
  logoutAccount,
  type NewAccount,
  removeAccount,
  renderAccounts,
  useAccount,
} from "./accounts.js";
import {
  embedderSignature,
  ensureProjectIndexed,
  resolvePersistedEmbedMode,
  writeManifest,
} from "./auto-index.js";
import { buildKnowledgeStack, ollamaHasModel } from "./build-knowledge.js";
import {
  getConfig,
  listConfig,
  renderConfigGet,
  renderConfigList,
  renderConfigSet,
  renderConfigUnset,
  setConfig,
  unsetConfig,
} from "./config.js";
import { distillOne, pendingDrafts, renderPendingDrafts } from "./distill.js";
import { distillNoteCapture } from "./distill-note.js";
import { collectExt, renderExt } from "./ext.js";
import { golemInit, golemUninit, InitError, type InitReport } from "./init.js";
import {
  collectLocalModel,
  renderLocalCoderWrite,
  renderLocalModel,
  renderLocalUrlWrite,
  setLocalBaseUrl,
  setLocalCoderEnabled,
} from "./local-config.js";
import { golemDirExists } from "./local-model.js";
import { mcpCompressionService, statsSourceForCli } from "./mcp-compression.js";
import { appendNote, listNotes, renderNotes } from "./notes.js";
import {
  collectOllamaStatus,
  renderOllamaStatus,
  renderSetupResult,
  runOllamaSetup,
  SetupRefusedError,
} from "./ollama.js";
import {
  draftTargetRelPath,
  listPendingPromotions,
  renderPendingPromotions,
  runPromote,
} from "./promote.js";
import {
  portInUse,
  proxyStatus,
  removeProxyPid,
  startDetached,
  stopProxy,
  waitForPortFree,
  writeProxyPid,
} from "./proxy-daemon.js";
import { buildProxyFromSettings } from "./proxy-runtime.js";
import { readProxyDesired, writeProxyDesired } from "./proxy-state.js";
import { collectSessionStateReport } from "./session-report.js";
import { getSliderInfo, SLIDER_LEVEL_NAMES, setSliderLevel } from "./slider.js";
import { collectStats, collectWindowedStats, renderBrevityReport, renderStats } from "./stats.js";
import { collectStatus, renderStatus } from "./status.js";
import { collectGolemState, parseSessionInput, renderStatusLine } from "./statusline.js";
import { synthesizeWeeklyReport } from "./synthesize.js";
import {
  findScopedTask,
  findTask,
  listScopedTasks,
  renderScopedTaskList,
  renderTask,
  spawnResume,
  storeForScope,
} from "./task.js";
import { buildTaskGrounding } from "./task-grounding.js";
import { runWatch } from "./watch.js";
import {
  checkWiki,
  defaultUserWikiDir,
  golemWikiInit,
  resolveWikiDir,
  type WikiCheckReport,
  wikiSourcePrefix,
} from "./wiki.js";

/** Default `--dir`: the enclosing Golem project root, or the cwd if none. */
const DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

const program = new Command();

program
  .name("golem")
  .description("Golem — universal pre-LLM processing layer (golem.run)")
  .version(VERSION);

// The control panel has no subcommand: `golem` on its own IS the panel, routed by
// src/cli/main.ts before this module is even loaded (Decision 51 — that is what
// makes it open in ~170ms instead of paying commander's ~810ms graph). It is
// documented here so `golem --help` still tells people it exists and what flags it
// takes; main.ts's `parsePanelArgs` is the code that actually accepts them, and
// tests/unit/cli-panel-args.test.ts asserts the two agree.
program.addHelpText(
  "after",
  `
Control panel:
  golem                     open the interactive control panel (settings,
                            guidance rules, runtime state) — no subcommand
  golem --dir <path>        open it for another project
  golem --no-pet            hide the pet in the header
  golem --advanced          show advanced controls on open`,
);

function printReport(report: InitReport): void {
  for (const action of report.actions) {
    process.stdout.write(`  ${action.kind.padEnd(6)} ${action.path} — ${action.detail}\n`);
  }
  if (report.dryRun) {
    process.stdout.write("dry run: nothing was written.\n");
  }
}

function printWikiCheckReport(report: WikiCheckReport): void {
  if (report.issues.length === 0) {
    process.stdout.write(`golem wiki check: ${report.pagesChecked} page(s), no issues.\n`);
    return;
  }
  for (const issue of report.issues) {
    process.stdout.write(`  ${issue.relPath} — ${issue.message}\n`);
  }
  process.stdout.write(
    `golem wiki check: ${report.pagesChecked} page(s), ${report.issues.length} issue(s).\n`,
  );
}

function fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

program
  .command("init")
  .description("Wire this project's Claude Code to Golem (proxy, MCP server, /golem/* skills)")
  .option("--dir <path>", "project directory", process.cwd())
  .option("--dry-run", "show what would change without writing", false)
  .option("--foundry <url>", "front an Azure AI Foundry resource base URL")
  .option("--upstream <url>", "front a generic Anthropic-compatible gateway (e.g. OpenRouter)")
  .option("--start-proxy", "start the proxy daemon after wiring", false)
  .action(
    async (opts: {
      dir: string;
      dryRun: boolean;
      foundry?: string;
      upstream?: string;
      startProxy: boolean;
    }) => {
      try {
        // Don't pass proxyPort — golemInit assigns/persists a per-project port
        // (an explicit proxy.port in the project's settings still wins).
        const report = await golemInit({
          projectDir: opts.dir,
          dryRun: opts.dryRun,
          ...(opts.foundry !== undefined ? { foundry: opts.foundry } : {}),
          ...(opts.upstream !== undefined ? { upstream: opts.upstream } : {}),
        });
        printReport(report);
        if (report.dryRun) return;

        // Optionally bring the proxy up now (detached daemon), on the per-project
        // port init just assigned. Also record the intent so SessionStart re-starts it.
        if (opts.startProxy) {
          const { settings } = await loadConfig({ projectDir: opts.dir });
          await writeProxyDesired(opts.dir, "running", new Date().toISOString());
          const pid = await startDetached(
            opts.dir,
            settings.proxy.port,
            process.argv[1] ?? "",
            await credentialEnvForProxy(opts.dir),
          );
          process.stdout.write(
            pid === null
              ? "golem proxy: failed to start — run `golem proxy start --detach` manually\n"
              : `golem proxy: started (pid ${pid}) on port ${settings.proxy.port}\n`,
          );
        }

        process.stdout.write(await initSummary(opts.dir, opts.startProxy));
      } catch (err) {
        fail(err);
      }
    },
  );

/** Post-init next-steps + capability hints (uv → semantic compression, Ollama → semantic KB). */
async function initSummary(dir: string, proxyStarted: boolean): Promise<string> {
  const lines: string[] = ["\nDone."];
  lines.push(
    proxyStarted
      ? "Proxy is running. Restart Claude Code in this project to pick up the wiring."
      : "Start the proxy with `golem proxy start --detach`, then restart Claude Code here.",
  );
  lines.push(
    "The status line is in your terminal; a VS Code panel installs automatically when VS Code",
    "is present — reload the window (Developer: Reload Window) to activate it.",
  );
  // Optional-enhancement discovery.
  const [hasUv, hasEmbedModel] = await Promise.all([commandExists("uv"), ollamaEmbedReady(dir)]);
  const hints: string[] = [];
  if (hasUv) {
    hints.push(
      "• `uv` detected — enable semantic compression: set compression.headroom_sidecar=true and slider ≥3.",
    );
  }
  if (hasEmbedModel) {
    hints.push(
      "• Ollama + embedding model detected — knowledge search will use semantic embeddings.",
    );
  } else {
    hints.push(
      "• Knowledge search works now (built-in lexical); `ollama pull bge-m3` + run Ollama to upgrade to semantic.",
    );
  }
  if (hints.length > 0) lines.push("", "Enhancements:", ...hints);
  return `${lines.join("\n")}\n`;
}

/** Is a command resolvable on PATH? (runs `<cmd> --version` via the D1 probe runner.) */
async function commandExists(cmd: string): Promise<boolean> {
  return (await createProbeRunner()({ command: cmd, args: ["--version"] })).ok;
}

/** Is Ollama up with the tier's text embed model pulled? (build-knowledge's probe.) */
async function ollamaEmbedReady(dir: string): Promise<boolean> {
  try {
    const { settings } = await loadConfig({ projectDir: dir });
    const facts = await detectCapability(createProbeRunner());
    const model = embedModelFor(facts.tier, "text");
    return await ollamaHasModel(settings.inference.ollama_base_url, model);
  } catch {
    return false;
  }
}

program
  .command("uninit")
  .description("Remove everything golem init added (keeps .golem/ project data)")
  .option("--dir <path>", "project directory", process.cwd())
  .option("--dry-run", "show what would change without writing", false)
  .action(async (opts: { dir: string; dryRun: boolean }) => {
    try {
      const { settings } = await loadConfig({ projectDir: opts.dir });
      const report = await golemUninit({
        projectDir: opts.dir,
        dryRun: opts.dryRun,
        proxyPort: settings.proxy.port,
      });
      printReport(report);
    } catch (err) {
      fail(err);
    }
  });

const wiki = program.command("wiki").description("Golem project wiki (spec Decision 28)");

wiki
  .command("init")
  .description("Scaffold the project wiki (WIKI.md schema + zone directories)")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--dry-run", "show what would change without writing", false)
  .option(
    "--user",
    "scaffold the user-scope wiki (~/.golem/wiki/, spec Decision 20e) instead of the project wiki",
    false,
  )
  .action(async (opts: { dir: string; dryRun: boolean; user: boolean }) => {
    try {
      let wikiDir: string;
      if (opts.user) {
        wikiDir = defaultUserWikiDir();
      } else {
        const { settings } = await loadConfig({ projectDir: opts.dir });
        wikiDir = resolveWikiDir(opts.dir, settings.knowledge.wiki_dir);
      }
      // For the user wiki, report paths relative to itself (there's no
      // enclosing project) rather than to --dir.
      const report = await golemWikiInit({
        projectDir: opts.user ? wikiDir : opts.dir,
        wikiDir,
        dryRun: opts.dryRun,
      });
      printReport(report);
    } catch (err) {
      fail(err);
    }
  });

wiki
  .command("check")
  .description("Lint wiki pages: frontmatter, dates, wikilinks, duplicate titles")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .action(async (opts: { dir: string }) => {
    try {
      const { settings } = await loadConfig({ projectDir: opts.dir });
      const wikiDir = resolveWikiDir(opts.dir, settings.knowledge.wiki_dir);
      const report = await checkWiki(wikiDir);
      printWikiCheckReport(report);
      if (report.issues.length > 0) process.exitCode = 1;
    } catch (err) {
      fail(err);
    }
  });

wiki
  .command("distill")
  .description("Distill a cached page into a zone-1 source-note draft (local model, T3)")
  .argument("[url]", "URL to distill (must already be cached by a prior WebFetch)")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--pending", "list drafts awaiting review instead of distilling one", false)
  .option("--force", "re-distill even if a draft already exists for this URL", false)
  .option("--json", "machine-readable output", false)
  .action(
    async (
      url: string | undefined,
      opts: { dir: string; pending: boolean; force: boolean; json: boolean },
    ) => {
      try {
        if (opts.pending) {
          const drafts = await pendingDrafts(opts.dir);
          if (opts.json) {
            process.stdout.write(
              `${JSON.stringify(
                drafts.map((d) => ({
                  slug: d.slug,
                  path: d.path,
                  title: d.frontmatter.title,
                  sources: d.frontmatter.sources,
                })),
                null,
                2,
              )}\n`,
            );
            return;
          }
          process.stdout.write(renderPendingDrafts(drafts));
          return;
        }

        if (url === undefined) {
          throw new InitError("provide a URL to distill, or pass --pending to list drafts");
        }

        const result = await distillOne({ projectDir: opts.dir, url, force: opts.force });
        process.stdout.write(
          result.kind === "exists"
            ? `draft already exists: ${result.path} (pass --force to re-distill)\n`
            : `distilled: ${result.path}\n`,
        );
      } catch (err) {
        fail(err);
      }
    },
  );

wiki
  .command("synthesize")
  .description(
    "Draft a weekly synthesis of recent debriefs + notes into a zone-1 draft (local model, R3.4)",
  )
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--days <n>", "how many days back to gather from", "7")
  .action(async (opts: { dir: string; days: string }) => {
    try {
      const days = Number(opts.days);
      if (!Number.isInteger(days) || days <= 0) {
        throw new InitError(`invalid --days "${opts.days}"`);
      }
      const result = await synthesizeWeeklyReport({ projectDir: opts.dir, days });
      process.stdout.write(
        `synthesized: ${result.path} (${result.debriefCount} debrief(s), ${result.noteCount} note(s))\n`,
      );
    } catch (err) {
      fail(err);
    }
  });

wiki
  .command("promote")
  .description(
    "Review and apply a pending distill draft as a wiki page (Decision 29 append-and-refine)",
  )
  .argument("[id]", "draft id (slug) to promote; omit (or use --list) to list pending drafts")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--list", "list pending drafts instead of promoting", false)
  .option("--yes", "skip the confirmation prompt (required in non-interactive use)", false)
  .option("--json", "machine-readable output (with --list)", false)
  .action(
    async (
      id: string | undefined,
      opts: { dir: string; list: boolean; yes: boolean; json: boolean },
    ) => {
      try {
        const { settings } = await loadConfig({ projectDir: opts.dir });
        const wikiDir = resolveWikiDir(opts.dir, settings.knowledge.wiki_dir);
        const nowIso = new Date().toISOString();

        // No id (or --list): show what's pending, don't write anything.
        if (id === undefined || opts.list) {
          const drafts = await listPendingPromotions(opts.dir);
          if (opts.json) {
            process.stdout.write(
              `${JSON.stringify(
                drafts.map((d) => ({
                  id: d.slug,
                  type: d.frontmatter.type,
                  target: draftTargetRelPath(d),
                  sources: d.frontmatter.sources,
                  created: d.frontmatter.created,
                })),
                null,
                2,
              )}\n`,
            );
          } else {
            process.stdout.write(renderPendingPromotions(drafts, nowIso));
          }
          return;
        }

        const outcome = await runPromote({
          projectDir: opts.dir,
          wikiDir,
          slug: id,
          nowIso,
          yes: opts.yes,
        });
        if (outcome.kind === "cancelled") {
          process.stdout.write("aborted — draft left in place.\n");
          return;
        }
        process.stdout.write(
          `${outcome.created ? "created" : "updated"}: ${outcome.relPath} (draft ${outcome.slug} consumed)\n`,
        );
      } catch (err) {
        fail(err);
      }
    },
  );

async function resolvePort(
  dir: string,
  portOpt?: string,
): Promise<{ port: number; upstream: string; sliderLevel: number }> {
  const { settings } = await loadConfig({ projectDir: dir });
  const port = portOpt === undefined ? settings.proxy.port : Number(portOpt);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InitError(`invalid port "${portOpt}"`);
  }
  return { port, upstream: settings.proxy.upstream_base_url, sliderLevel: settings.slider.level };
}

/**
 * Stop then start the proxy as a background daemon (the `proxy restart` core,
 * reused by `account use` so a config switch takes effect without a manual
 * restart). Returns the new pid + resolved port/upstream, or throws if it does
 * not come back up. Does NOT print — the caller phrases the message.
 */
async function restartProxyDetached(
  dir: string,
  portOpt?: string,
): Promise<{ pid: number; port: number; upstream: string }> {
  await writeProxyDesired(dir, "running", new Date().toISOString());
  const { port, upstream } = await resolvePort(dir, portOpt);
  await stopProxy(dir);
  await waitForPortFree(port);
  // Inject the active account's resolved credential so the daemon — which does
  // NOT inherit this shell's env — starts with it (Decision 46).
  const credEnv = await credentialEnvForProxy(dir);
  const pid = await startDetached(dir, port, process.argv[1] ?? "", credEnv);
  if (pid === null) throw new InitError(`proxy did not come up on port ${port}`);
  return { pid, port, upstream };
}

/** Run the proxy in the foreground: bind, write a pid file, serve until stopped. */
async function runProxyForeground(dir: string, portOpt?: string): Promise<void> {
  const { settings } = await loadConfig({ projectDir: dir });
  const { port } = await resolvePort(dir, portOpt);

  // Resolve the active account's credential from the OS store into this process's
  // env, which is where createProxyRuntime reads it (Decision 47: the env var is
  // an internal handoff, not a setting — so a foreground `golem proxy start` has
  // to do the resolve the detached path does at spawn, or it would run keyless).
  // `??=` so an already-injected value wins: in the detached case the parent CLI
  // already put it there, and the daemon must not depend on reaching a keychain
  // from a session that may have none (ADR-0003).
  for (const [name, secret] of Object.entries(await credentialEnvForProxy(dir))) {
    process.env[name] ??= secret;
  }

  // Idempotent: refuse (cleanly) if a proxy is already up on this port.
  if (await portInUse(port)) {
    process.stdout.write(`golem proxy: already running on port ${port}\n`);
    return;
  }

  const telemetry = openTelemetryStore(dir);
  // Local-scope (gitignored) settings file — the slider is a personal, transient
  // dial that must not churn the committed settings.json (spec Decision 43); the
  // same file + nested slider.level key `golem slider` and the E1 loader use.
  const { JsonFileSliderStore } = await import("../mcp/index.js");
  const sliderStore = new JsonFileSliderStore(settingsFilePaths({ projectDir: dir }).local);
  let inference: InferenceService | undefined;
  let facts: Awaited<ReturnType<typeof detectCapability>> | undefined;
  try {
    const client = new OllamaClient({
      baseUrl: settings.inference.ollama_base_url,
      requestTimeoutMs: settings.inference.request_timeout_ms,
    });
    facts = await detectCapability(createProbeRunner());
    inference = new OllamaInferenceService(client, facts);
  } catch (err) {
    process.stderr.write(
      `golem proxy: local inference unavailable, local-answer sub-mode falls back to the hashing embedder (${
        err instanceof Error ? err.message : String(err)
      })\n`,
    );
  }
  // Choose the local-answer embedder to MATCH the space the on-disk index was
  // built in — not a blind "is Ollama up?" probe. Querying a lexically-built
  // index with semantic vectors (or vice-versa) scores 0 against every chunk
  // (now rejected loudly by assertEmbedderSpaceMatch), so reconcile up front:
  //   • semantic index + its embed model present → semantic embedder,
  //   • semantic index + model gone              → local-answer OFF (unqueryable),
  //   • lexical index / no index yet             → hashing embedder (matches).
  // Static per-run, like the KB build itself; a rebuilt/upgraded index is picked
  // up on the next proxy restart.
  let localAnswerInference: InferenceService | undefined;
  let suppressLocalAnswer = false;
  if (settings.knowledge.local_answer_enabled && inference !== undefined && facts !== undefined) {
    const persisted = await resolvePersistedEmbedMode(dir, dir);
    if (persisted === "semantic") {
      const model = embedModelFor(facts.tier, "text");
      if (await ollamaHasModel(settings.inference.ollama_base_url, model)) {
        localAnswerInference = inference;
      } else {
        suppressLocalAnswer = true;
        process.stderr.write(
          `golem proxy: local-answer disabled — the index was built with the semantic embed model "${model}", which isn't available now; run \`golem index\` to rebuild it lexically, or start Ollama and pull the model\n`,
        );
      }
    }
    // persisted === "lexical" | null → leave localAnswerInference undefined so the
    // KB uses the hashing (lexical) embedder, matching the on-disk index.
  }
  const { proxy, semantic, upstream } = buildProxyFromSettings(dir, settings, telemetry, {
    sliderStore,
    ...(localAnswerInference !== undefined ? { inference: localAnswerInference } : {}),
    ...(suppressLocalAnswer ? { suppressLocalAnswer: true } : {}),
  });
  if (semantic !== undefined) {
    process.stdout.write(
      "golem proxy: Headroom semantic sidecar enabled (slider ≥3, opt-in, fail-open)\n",
    );
  }
  const addr = await proxy.listen(port);
  await writeProxyPid(dir, { pid: process.pid, port: addr.port, ts: new Date().toISOString() });
  // Report the RESOLVED upstream (active account), not the top-level config — see
  // ProxyBuild.upstream. Naming the account and model makes a switch verifiable
  // from the banner alone.
  const via = upstream.accountId === null ? "" : ` [account ${upstream.accountId}]`;
  const model = upstream.model === undefined ? "" : ` model ${upstream.model}`;
  process.stdout.write(
    `golem proxy listening on http://localhost:${addr.port} -> ${upstream.baseUrl}${via}${model} (slider level ${settings.slider.level})\n`,
  );
  const shutdown = (): void => {
    semantic?.stop();
    void Promise.allSettled([proxy.close(), telemetry.close(), removeProxyPid(dir)]).finally(() =>
      process.exit(0),
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const proxyCmd = program
  .command("proxy")
  .description("Golem proxy (Claude Code's ANTHROPIC_BASE_URL target)");

proxyCmd
  .command("start", { isDefault: true })
  .description("Start the proxy (foreground; --detach runs it as a background daemon)")
  .option("--dir <path>", "project directory (for .golem/ config)", DEFAULT_DIR)
  .option("--port <port>", "listen port (overrides config)")
  .option("--detach", "run in the background, surviving this shell", false)
  .action(async (opts: { dir: string; port?: string; detach: boolean }) => {
    try {
      // Persist the intent so SessionStart auto-starts it next time the project opens.
      await writeProxyDesired(opts.dir, "running", new Date().toISOString());
      if (opts.detach) {
        const { port, upstream } = await resolvePort(opts.dir, opts.port);
        if (await portInUse(port)) {
          process.stdout.write(`golem proxy: already running on port ${port}\n`);
          return;
        }
        const pid = await startDetached(
          opts.dir,
          port,
          process.argv[1] ?? "",
          await credentialEnvForProxy(opts.dir),
        );
        if (pid === null) fail(new InitError(`proxy did not come up on port ${port}`));
        process.stdout.write(
          `golem proxy started (pid ${pid}) on http://localhost:${port} -> ${upstream}\n`,
        );
        return;
      }
      await runProxyForeground(opts.dir, opts.port);
    } catch (err) {
      fail(err);
    }
  });

proxyCmd
  .command("stop")
  .description("Stop the running proxy")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .action(async (opts: { dir: string }) => {
    try {
      await writeProxyDesired(opts.dir, "stopped", new Date().toISOString());
      const pid = await stopProxy(opts.dir);
      process.stdout.write(
        pid === null ? "golem proxy: not running\n" : `golem proxy stopped (pid ${pid})\n`,
      );
    } catch (err) {
      fail(err);
    }
  });

proxyCmd
  .command("restart")
  .description("Reliably stop then start the proxy as a background daemon")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--port <port>", "listen port (overrides config)")
  .option("--foreground", "restart in the foreground instead of detached", false)
  .action(async (opts: { dir: string; port?: string; foreground: boolean }) => {
    try {
      // Foreground keeps its bespoke path (it blocks). The --port override only
      // applies here; the detached helper reads the configured port.
      if (opts.foreground) {
        await writeProxyDesired(opts.dir, "running", new Date().toISOString());
        const { port } = await resolvePort(opts.dir, opts.port);
        await stopProxy(opts.dir);
        await waitForPortFree(port);
        await runProxyForeground(opts.dir, opts.port);
        return;
      }
      const { pid, port, upstream } = await restartProxyDetached(opts.dir, opts.port);
      process.stdout.write(
        `golem proxy restarted (pid ${pid}) on http://localhost:${port} -> ${upstream}\n`,
      );
    } catch (err) {
      fail(err);
    }
  });

proxyCmd
  .command("status")
  .description("Show whether the proxy is running")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { dir: string; json: boolean }) => {
    try {
      const { port, upstream } = await resolvePort(opts.dir);
      const st = await proxyStatus(opts.dir, port);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ ...st, upstream })}\n`);
        return;
      }
      process.stdout.write(
        st.running
          ? `golem proxy: running${st.pid ? ` (pid ${st.pid})` : ""} on port ${st.port ?? port} -> ${upstream}\n`
          : "golem proxy: not running\n",
      );
    } catch (err) {
      fail(err);
    }
  });

const mcp = program.command("mcp").description("Golem MCP server");
mcp
  .command("serve")
  .description("Serve the unified Golem MCP server on stdio (used by .mcp.json)")
  .option("--dir <path>", "project directory (for the CCR store)", DEFAULT_DIR)
  .action(async (opts: { dir: string }) => {
    try {
      // stdio owns stdout (MCP JSON-RPC) — NEVER write there here; warnings go to
      // stderr. Build the KB before connecting so a KB failure degrades to
      // "serve without knowledge tools" rather than crashing the server.
      const { settings } = await loadConfig({ projectDir: opts.dir });
      let knowledge: KnowledgeBase | undefined;
      let inference: InferenceService | undefined;
      // The wiki is a plain filesystem store (spec Decision 28) — build it
      // whenever the knowledge base is enabled, independent of whether the
      // vector KB below manages to construct.
      const wiki = settings.knowledge.enabled
        ? new FileWikiStore({ wikiDir: resolveWikiDir(opts.dir, settings.knowledge.wiki_dir) })
        : undefined;
      if (settings.knowledge.enabled) {
        try {
          const stack = await buildKnowledgeStack({ projectDir: opts.dir });
          knowledge = stack.knowledge;
          inference = stack.inference;
          process.stderr.write(
            `golem: knowledge base ready (${stack.embedMode} embeddings${
              stack.embedMode === "lexical" ? "; pull bge-m3 + run Ollama for semantic" : ""
            })\n`,
          );
          // Populate/refresh the index in the BACKGROUND so search works without a
          // manual `golem index`, and re-index automatically if the embedder
          // changed (e.g. bge-m3 got pulled). Never blocks server startup.
          void ensureProjectIndexed({
            projectDir: opts.dir,
            projectId: opts.dir,
            knowledge: stack.knowledge,
            embedMode: stack.embedMode,
            tier: stack.facts.tier,
            watchPaths: settings.knowledge.watch_paths,
            now: new Date().toISOString(),
            log: (m) => process.stderr.write(`golem kb: ${m}\n`),
          }).catch((e) =>
            process.stderr.write(
              `golem kb: auto-index failed (${e instanceof Error ? e.message : String(e)})\n`,
            ),
          );
        } catch (err) {
          process.stderr.write(
            `golem: knowledge base unavailable, serving without it (${
              err instanceof Error ? err.message : String(err)
            })\n`,
          );
        }
      }
      // coder doesn't need the knowledge base — build a standalone
      // InferenceService when the KB path above didn't already produce one
      // (KB disabled, or its own construction failed before reaching this far).
      if (inference === undefined) {
        try {
          const client = new OllamaClient({
            baseUrl: settings.inference.ollama_base_url,
            requestTimeoutMs: settings.inference.request_timeout_ms,
          });
          const facts = await detectCapability(createProbeRunner());
          inference = new OllamaInferenceService(client, facts);
        } catch (err) {
          process.stderr.write(
            `golem: local inference unavailable, coder will be disabled (${
              err instanceof Error ? err.message : String(err)
            })\n`,
          );
        }
      }
      // R4.3 — one telemetry store shared by the compression wrapper (retrieval
      // events) and deps.telemetry (per-call tool events + the stats summary).
      const telemetry = openTelemetryStore(opts.dir);
      const coderInference =
        settings.inference.local_coder_enabled && inference !== undefined ? inference : undefined;
      if (settings.inference.local_coder_enabled === false) {
        process.stderr.write(
          "golem mcp serve: local coder disabled by inference.local_coder_enabled\n",
        );
      }
      const { JsonFileSliderStore, serveStdio } = await import("../mcp/index.js");
      await serveStdio({
        compression: mcpCompressionService(opts.dir, telemetry),
        telemetry,
        // Local-scope (gitignored) settings file — the same file (and nested
        // slider.level key) the E1 loader and `golem slider` use; the slider is a
        // personal, transient dial kept out of committed settings (Decision 43).
        sliderStore: new JsonFileSliderStore(settingsFilePaths({ projectDir: opts.dir }).local),
        ...(knowledge !== undefined
          ? {
              knowledge,
              defaultProjectId: opts.dir,
              projectRootDir: opts.dir,
              wikiDir: wikiSourcePrefix(
                opts.dir,
                resolveWikiDir(opts.dir, settings.knowledge.wiki_dir),
              ),
            }
          : {}),
        ...(inference !== undefined ? { inference } : {}),
        ...(coderInference !== undefined ? { coder: coderInference } : {}),
        // R3.1 (spec Decision 34): opt-in chat-judge rerank, decoupled from the
        // slider (Decision 31) via its own settings leaf.
        ...(inference !== undefined && settings.knowledge.rerank_enabled
          ? { rerank: inference }
          : {}),
        // R3.4 (spec Decision 20e's local tier): federate the user-scope wiki
        // (~/.golem/wiki/) into search/fetch, read-only — writes still only
        // ever go to the project `wiki` via wiki_upsert.
        ...(wiki !== undefined
          ? {
              wiki,
              wikiSearch: settings.knowledge.user_wiki_enabled
                ? new FederatedWikiReader(
                    wiki,
                    new FileWikiStore({ wikiDir: defaultUserWikiDir() }),
                  )
                : wiki,
            }
          : {}),
      });
    } catch (err) {
      fail(err);
    }
  });

program
  .command("status")
  .description("Show Golem status: config + provenance, proxy reachability, project wiring, slider")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { dir: string; json: boolean }) => {
    try {
      const report = await collectStatus({ projectDir: opts.dir, version: VERSION });
      process.stdout.write(
        opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderStatus(report),
      );
    } catch (err) {
      fail(err);
    }
  });

program
  .command("update")
  .alias("upgrade")
  .description("Check for a newer Golem and upgrade (npm) or print the command (standalone)")
  .option("--dir <path>", "project directory (for the cached check)", DEFAULT_DIR)
  .option("--check", "only check for an update; don't install", false)
  .option("--force", "ignore the cached check and re-query the npm registry", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { dir: string; check: boolean; force: boolean; json: boolean }) => {
    try {
      const method = detectInstallMethod();
      // Only cache the verdict inside an EXISTING `.golem/` — never create one in
      // a project that isn't using Golem. (The VS Code extension polls
      // `golem update --check` in every window; without this it littered
      // unrelated repos with `.golem/state/update-check.json`.)
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

      // --check, or a non-npm install we can't upgrade in-process: print the command.
      if (opts.check || method !== "npm") {
        process.stdout.write(`  run: ${result.command}\n`);
        return;
      }

      process.stdout.write(`Upgrading via npm: ${result.command}\n`);
      const res = spawnSync("npm", ["install", "-g", "golem-run@latest"], {
        stdio: "inherit",
        shell: true, // Windows resolves npm.cmd via the shell
      });
      if (res.status !== 0) {
        fail(new InitError(`npm exited ${res.status ?? "abnormally"} — upgrade may have failed`));
      }
      process.stdout.write(`golem upgraded to ${result.latest}. Restart any running proxy/MCP.\n`);
    } catch (err) {
      fail(err);
    }
  });

function parseSliderLevel(raw: string): SliderLevel {
  const level = Number(raw);
  if (!Number.isInteger(level) || level < 0 || level > 5) {
    throw new InvalidArgumentError("level must be an integer from 0 to 3 (legacy 4/5 map to 3)");
  }
  // Accept a legacy 0–5 value and remap onto the current 0–3 scale (Decision 30).
  return migrateSliderLevel(level);
}

program
  .command("statusline")
  .description("Render the Golem status line (for Claude Code's statusLine setting)")
  .option("--color", "force ANSI colors (default: on when stdout is a TTY and NO_COLOR unset)")
  .action(async (opts: { color?: boolean }) => {
    // Must never throw or hang: a broken status line disrupts the editor.
    try {
      const raw = process.stdin.isTTY
        ? ""
        : await new Promise<string>((resolve) => {
            const chunks: Buffer[] = [];
            process.stdin.on("data", (c: Buffer) => chunks.push(c));
            process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            process.stdin.on("error", () => resolve(""));
          });
      const session = parseSessionInput(raw);
      const dir = session.cwd ?? process.cwd();
      const golem = await collectGolemState(dir);
      const color = opts.color ?? (process.stdout.isTTY === true && !process.env.NO_COLOR);
      process.stdout.write(`${renderStatusLine(session, golem, { color })}\n`);
    } catch {
      process.stdout.write("⬢ golem\n");
    }
  });

// Decision 52 — the two dials the slider is a preset over. Both are ordinary
// settings keys, so `golem config set` works too; these verbs exist because a
// dial you flip while measuring deserves a first-class surface that explains
// what it will do and where the value came from.
for (const kind of ["brevity", "compression"] as const) {
  program
    .command(kind)
    .description(
      kind === "brevity"
        ? "Show or set the output-side brevity dial (auto|off|lite|full|ultra)"
        : "Show or set the input-side compression dial (auto|1|2|3)",
    )
    .argument("[value]", "new value; omit to show the current one")
    .option("--dir <path>", "project directory", DEFAULT_DIR)
    .option("--project", "write the committed project scope instead of local", false)
    .option("--json", "machine-readable output", false)
    .action(
      async (value: string | undefined, opts: { dir: string; project: boolean; json: boolean }) => {
        const { brevityEffectNote, describeDial, DIAL_VALUES, DialError, getDialInfo, setDial } =
          await import("./dials.js");
        try {
          if (value === undefined) {
            const info = await getDialInfo(kind, { projectDir: opts.dir });
            if (opts.json) {
              process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
              return;
            }
            process.stdout.write(
              `${describeDial(info)} — set by ${info.layer}` +
                `${info.source !== undefined ? ` (${info.source})` : ""}\n`,
            );
            if (kind === "brevity") {
              process.stdout.write(
                `${brevityEffectNote(info.effective as never, info.sliderLevel)}\n`,
              );
            }
            process.stdout.write(`values: ${DIAL_VALUES[kind].join(" | ")}\n`);
            return;
          }
          const result = await setDial(kind, value, {
            projectDir: opts.dir,
            project: opts.project,
          });
          if (opts.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return;
          }
          process.stdout.write(`${kind} set to ${result.value} in ${result.file}\n`);
          process.stdout.write(`${describeDial(result.info)}\n`);
          if (kind === "brevity") {
            process.stdout.write(
              `${brevityEffectNote(result.info.effective as never, result.info.sliderLevel)}\n`,
            );
          }
          if (result.overriddenBy !== undefined) {
            process.stdout.write(
              `⚠ a higher layer wins — the effective value comes from ${result.overriddenBy.layer}` +
                `${result.overriddenBy.source !== undefined ? ` (${result.overriddenBy.source})` : ""}\n`,
            );
          }
          process.stdout.write("restart the proxy for this to take effect: golem proxy restart\n");
        } catch (err) {
          if (err instanceof DialError) {
            process.stderr.write(`golem: ${err.message}\n`);
            process.exitCode = 2;
            return;
          }
          throw err;
        }
      },
    );
}

program
  .command("slider")
  .description("Show the Golem savings slider, or set it (0 passthrough … 3 aggressive)")
  .argument("[level]", "new slider level 0–3; omit to show the current level", parseSliderLevel)
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--json", "machine-readable output", false)
  .action(async (level: SliderLevel | undefined, opts: { dir: string; json: boolean }) => {
    try {
      if (level === undefined) {
        const info = await getSliderInfo({ projectDir: opts.dir });
        process.stdout.write(
          opts.json
            ? `${JSON.stringify(info, null, 2)}\n`
            : `slider level ${info.level} (${info.name}) — set by ${info.layer}` +
                `${info.source !== undefined ? ` (${info.source})` : ""}\n`,
        );
        return;
      }
      const result = await setSliderLevel(level, { projectDir: opts.dir });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      if (result.justInitialized === true) {
        process.stdout.write(
          "golem initialized in this project (MCP + skills wired, CLAUDE.local.md updated)\n",
        );
      }
      process.stdout.write(
        `slider level set to ${level} (${SLIDER_LEVEL_NAMES[level]}) in ${result.file}\n`,
      );
      if (level === 0) {
        process.stdout.write(
          `⚠ level 0 (passthrough) is a FULL BYPASS: redaction is OFF, so secrets/PII ` +
            `reach the upstream unredacted. Use level 1 to keep redaction on.\n`,
        );
      }
      if (result.overriddenBy !== undefined) {
        const o = result.overriddenBy;
        process.stdout.write(
          `note: a higher-precedence layer overrides it — effective level is ` +
            `${o.level} (${o.name}) from ${o.layer}` +
            `${o.source !== undefined ? ` (${o.source})` : ""}\n`,
        );
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("stats")
  .description("Show Golem token-savings statistics (per-stage breakdown, CCR activity)")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--project <id>", "limit stats to this project id")
  .option("--window <window>", "savings window: 24h | 7d | all", "24h")
  .option("--brevity", "report billed output tokens by brevity level (Decision 52)", false)
  .option("--cache", "report prompt-cache hit rate and what broke the prefix (R8.1)", false)
  .option("--context", "report what the last request's context window is made of (R8.4)", false)
  .option("--json", "machine-readable output", false)
  .action(
    async (opts: {
      dir: string;
      project?: string;
      window: string;
      brevity: boolean;
      cache: boolean;
      context: boolean;
      json: boolean;
    }) => {
      try {
        if (opts.window !== "24h" && opts.window !== "7d" && opts.window !== "all") {
          throw new InitError(`invalid --window "${opts.window}" (expected 24h | 7d | all)`);
        }
        // Decision 52 — the brevity rollup. Its own report rather than a section
        // of the savings headline: that headline is INPUT-side gross tokens, and
        // mixing an output-side measurement into it is exactly the mixed-scope
        // error verification-notes §25/§30 warns about.
        if (opts.brevity) {
          const { brevityReportRows } = await import("../telemetry/usage-report.js");
          const byBrevity = await openTelemetryStore(opts.dir).aggregateUsageByBrevity(
            opts.project,
          );
          const rows = brevityReportRows(byBrevity);
          if (opts.json) {
            process.stdout.write(`${JSON.stringify({ ...byBrevity, rows }, null, 2)}\n`);
            return;
          }
          process.stdout.write(renderBrevityReport(rows));
          return;
        }
        // R8.4 — the context ledger: a snapshot of the LAST request, not a
        // window, so it is neither a savings figure nor aggregatable. Its own
        // report for the same reason as the two above.
        if (opts.context) {
          const [{ readContextLedger }, { renderContextLedger }] = await Promise.all([
            import("../proxy/index.js"),
            import("./context.js"),
          ]);
          const ledger = await readContextLedger(opts.dir);
          process.stdout.write(
            opts.json ? `${JSON.stringify(ledger, null, 2)}\n` : renderContextLedger(ledger),
          );
          return;
        }
        // R8.1 — the cache rollup, likewise its own report: it mixes an
        // authoritative billed measurement with an explanatory prediction, and
        // folding either into the input-side savings headline would repeat the
        // mixed-scope error §25/§30 warns about.
        if (opts.cache) {
          const { aggregateCacheStats, renderCacheReport } = await import(
            "../telemetry/cache-report.js"
          );
          let cacheEvents: readonly TelemetryEvent[] = [];
          try {
            cacheEvents = await readTelemetryEvents(opts.dir);
          } catch {
            cacheEvents = [];
          }
          const cacheStats = aggregateCacheStats(cacheEvents, opts.project);
          process.stdout.write(
            opts.json ? `${JSON.stringify(cacheStats, null, 2)}\n` : renderCacheReport(cacheStats),
          );
          return;
        }
        const window: BenchWindow = opts.window;
        // R4.3 — fold durable per-tool usage into the report (best-effort: a
        // telemetry read failure just omits the section, never fails `stats`).
        let toolUsage: ToolUsageStats | undefined;
        try {
          toolUsage = await openTelemetryStore(opts.dir).aggregateToolUsage(opts.project);
        } catch {
          toolUsage = undefined;
        }
        // Prefer durable telemetry, windowed to the rolling savings window
        // (Decision 23). Fall back to the live in-process counters only when the
        // store holds no pipeline runs at all (a fresh project) — those counters
        // have no timestamps to window, so they report all-time for this process.
        let events: readonly TelemetryEvent[] = [];
        try {
          events = await readTelemetryEvents(opts.dir);
        } catch {
          events = [];
        }
        const hasRequests = events.some((e) => (e.kind ?? "request") === "request");
        const report = hasRequests
          ? collectWindowedStats(events, {
              window,
              nowMs: Date.now(),
              ...(opts.project !== undefined ? { projectId: opts.project } : {}),
              ...(toolUsage !== undefined ? { toolUsage } : {}),
            })
          : await collectStats(await statsSourceForCli(opts.dir), opts.project, toolUsage);
        process.stdout.write(
          opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderStats(report),
        );
      } catch (err) {
        fail(err);
      }
    },
  );

const benchCmd = program.command("bench").description("Golem benchmarks (spec Decision 21f)");

benchCmd
  .command("cost")
  .description(
    "Cost-governance benchmark: Golem's measured savings vs Claude Code's cost-doc baselines",
  )
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--project <id>", "limit the benchmark to this project id")
  .option("--window <window>", "time window: 24h | 7d | all", "7d")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { dir: string; project?: string; window: string; json: boolean }) => {
    try {
      if (opts.window !== "24h" && opts.window !== "7d" && opts.window !== "all") {
        throw new InitError(`invalid --window "${opts.window}" (expected 24h | 7d | all)`);
      }
      const window: BenchWindow = opts.window;
      // Best-effort: telemetry / CLAUDE.md read failures degrade the report,
      // never fail the command.
      let events: Awaited<ReturnType<typeof readTelemetryEvents>> = [];
      try {
        events = await readTelemetryEvents(opts.dir);
      } catch {
        events = [];
      }
      let claudeMdLines: number | undefined;
      try {
        const text = await readFile(path.join(opts.dir, "CLAUDE.md"), "utf8");
        claudeMdLines = text.split("\n").length;
      } catch {
        claudeMdLines = undefined;
      }
      const report = buildCostBenchmark(events, {
        ...(opts.project !== undefined ? { projectId: opts.project } : {}),
        window,
        nowMs: Date.now(),
        ...(claudeMdLines !== undefined ? { claudeMdLines } : {}),
      });
      process.stdout.write(
        opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderCostBenchmark(report),
      );
    } catch (err) {
      fail(err);
    }
  });

benchCmd
  .command("tools")
  .description(
    "Tools-block token census, and optionally A/B a shrinking transform against " +
      "the tool-selection case set (Workstream B gate, verification-notes §88/§89)",
  )
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option(
    "--shrink <mode>",
    "score a candidate transform: whitespace | first-sentence (descriptions) | " +
      "schema-meta | schema-validation | schema-descriptions (input schemas) — " +
      "omit for census only",
  )
  .option("--repeats <n>", "passes over the case set when scoring (default 1)", "1")
  .option(
    "--role <role>",
    "local role that does the choosing: classifier (default) | drafter | judge — " +
      "substitute when the tier's classifier model is not pulled",
    "classifier",
  )
  .option("--json", "machine-readable output", false)
  .action(
    async (opts: {
      dir: string;
      shrink?: string;
      repeats: string;
      role: string;
      json: boolean;
    }) => {
      try {
        const {
          golemToolCensus,
          renderToolBench,
          SHRINK_MODES,
          shrinkCatalog,
          isSchemaMode,
          compareCatalogs,
          SELECTION_CASES,
          ARGUMENT_CASES,
        } = await import("../tools/index.js");
        const census = await golemToolCensus();
        if (opts.shrink === undefined) {
          const report = { census };
          process.stdout.write(
            opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderToolBench(report),
          );
          return;
        }
        const mode = opts.shrink as (typeof SHRINK_MODES)[number];
        if (!SHRINK_MODES.includes(mode)) {
          throw new InitError(
            `invalid --shrink "${opts.shrink}" (expected ${SHRINK_MODES.join(" | ")})`,
          );
        }
        const repeats = Number.parseInt(opts.repeats, 10);
        if (!Number.isFinite(repeats) || repeats < 1) {
          throw new InitError(`invalid --repeats "${opts.repeats}" (expected a positive integer)`);
        }
        // Scoring needs the local model. Unlike the census, this cannot degrade
        // silently — a comparison with no chooser is not a result.
        const { settings } = await loadConfig({ projectDir: opts.dir });
        const client = new OllamaClient({
          baseUrl: settings.inference.ollama_base_url,
          requestTimeoutMs: settings.inference.request_timeout_ms,
        });
        const facts = await detectCapability(createProbeRunner());
        const inference = new OllamaInferenceService(client, facts);
        const roles = ["classifier", "drafter", "judge", "summarizer", "extractor"] as const;
        const role = opts.role as (typeof roles)[number];
        if (!roles.includes(role)) {
          throw new InitError(`invalid --role "${opts.role}" (expected ${roles.join(" | ")})`);
        }
        // A schema transform is invisible to a description-only chooser, and its
        // real hazard is argument construction rather than selection — so the two
        // gates are switched on together, never separately (R8.S1).
        const schemaMode = isSchemaMode(mode);
        const result = await compareCatalogs({
          inference,
          baseline: census.tools,
          candidate: shrinkCatalog(census.tools, mode),
          cases: SELECTION_CASES,
          repeats,
          role,
          ...(schemaMode
            ? {
                render: "full" as const,
                measuring: "schemas" as const,
                argumentCases: ARGUMENT_CASES,
              }
            : {}),
        });
        const report = {
          census,
          comparison: { mode, cases: SELECTION_CASES.length, role, result },
        };
        process.stdout.write(
          opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderToolBench(report),
        );
      } catch (err) {
        fail(err);
      }
    },
  );

const extCmd = program
  .command("ext")
  .description(
    "External tools Golem can use — spawned or detected, never shipped (spec Decision 53)",
  );

extCmd
  .command("list", { isDefault: true })
  .alias("status")
  .description(
    "Show every managed tool: tier, whether it is installed, whether it is on, and what breaks without it",
  )
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--json", "machine-readable output", false)
  .option("--verbose", "also show purpose, install instructions, upstream and adapter", false)
  .action(async (opts: { dir: string; json: boolean; verbose: boolean }) => {
    try {
      const report = await collectExt(opts.dir);
      process.stdout.write(
        opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderExt(report, opts.verbose),
      );
    } catch (err) {
      fail(err);
    }
  });

const accountCmd = program
  .command("account")
  .description("Switch between configured upstream accounts/providers (R6.2, spec Decision 21d)");

accountCmd
  .command("list")
  .alias("show")
  .description(
    "List configured accounts, which is active, and whether each has a stored credential",
  )
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { dir: string; json: boolean }) => {
    try {
      const report = await collectAccounts(opts.dir);
      process.stdout.write(
        opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderAccounts(report),
      );
    } catch (err) {
      fail(err);
    }
  });

accountCmd
  .command("use")
  .description("Switch the active account (use 'none' to clear and revert to the top-level config)")
  .argument("<id>", "an account id from proxy.accounts, or 'none' to clear")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--no-restart", "do not auto-restart a running proxy to apply the switch")
  .option(
    "--yes",
    "switch even if the account's credential does not resolve (fail-closed override)",
    false,
  )
  .action(async (id: string, opts: { dir: string; restart: boolean; yes: boolean }) => {
    try {
      const target = id === "none" ? null : id;
      const { active } = await useAccount(opts.dir, target, new Date().toISOString(), {
        assumeYes: opts.yes,
      });
      const label =
        active === null
          ? "active account cleared — using the top-level (default) upstream config"
          : `active account: ${active}`;

      // Report the ACTIVE account's real upstream URL (not the top-level base
      // URL that restartProxyDetached returns) so the message matches where
      // traffic will actually go.
      const report = await collectAccounts(opts.dir);
      const activeUrl = report.accounts.find((a) => a.active)?.base_url;
      const dest = activeUrl !== undefined ? ` -> ${activeUrl}` : "";

      // Apply the switch to the live daemon. Only restart when the proxy is
      // actually running (a switch while stopped just persists), and honour
      // --no-restart for scripted use.
      const { port } = await resolvePort(opts.dir);
      const running = await portInUse(port);
      if (opts.restart && running) {
        const { pid } = await restartProxyDetached(opts.dir);
        process.stdout.write(`${label} — proxy restarted (pid ${pid})${dest}\n`);
      } else if (running) {
        process.stdout.write(`${label} (restart the proxy to apply: golem proxy restart)\n`);
      } else {
        process.stdout.write(`${label}.\n`);
      }
    } catch (err) {
      fail(err);
    }
  });

accountCmd
  .command("login")
  .description(
    "Store an account's credential in the OS credential store — prompt, verify against the upstream, then save (Decision 46)",
  )
  .argument("<id>", "an account id from proxy.accounts, or the default provider id")
  .option("--dir <path>", "project directory", process.cwd())
  .option("--no-probe", "store without verifying the key against the upstream first")
  .option(
    "--store <backend>",
    "where to store: 'keychain' (default, the OS store) or 'file' (UNENCRYPTED plaintext, explicit opt-in)",
    "keychain",
  )
  .action(async (id: string, opts: { dir: string; probe: boolean; store: string }) => {
    try {
      const storeTarget = opts.store === "file" ? ("file" as const) : ("keychain" as const);
      if (storeTarget === "file") {
        process.stdout.write(
          "warning: storing UNENCRYPTED plaintext on disk (protected only by file permissions).\n",
        );
      }
      // Non-TTY stdin: take the key from the pipe (`echo <key> | golem account
      // login <id>`) rather than failing. Since Decision 47 removed the env-var
      // backend this is the only non-interactive way to set a credential, and it
      // keeps the secret out of argv. A TTY still prompts, masked.
      const piped = process.stdin.isTTY ? "" : (await readStdin()).trim();
      const result = await loginAccount(opts.dir, id, new Date().toISOString(), {
        probe: opts.probe,
        store: storeTarget,
        ...(piped !== "" ? { secret: piped } : {}),
      });
      process.stdout.write(
        `stored credential for "${result.account}" — ${result.stored_in} (probe: ${result.probe}).\n` +
          // The probe hits a model-list URL, which is NOT where traffic goes; name
          // the real route so an accepted key is not mistaken for a working route.
          (result.request_url !== undefined ? `requests will go to: ${result.request_url}\n` : "") +
          "It resolves automatically on every proxy start; nothing to export.\n",
      );
    } catch (err) {
      fail(err);
    }
  });

accountCmd
  .command("logout")
  .description("Remove an account's stored credential from the OS credential store")
  .argument("<id>", "an account id from proxy.accounts, or the default provider id")
  .option("--dir <path>", "project directory", process.cwd())
  .action(async (id: string, opts: { dir: string }) => {
    try {
      const result = await logoutAccount(opts.dir, id, new Date().toISOString());
      if (result.removed.length === 0) {
        process.stdout.write(`no stored credential found for "${result.account}".\n`);
      } else {
        process.stdout.write(
          `removed credential for "${result.account}" from: ${result.removed.join(", ")}.\n`,
        );
      }
    } catch (err) {
      fail(err);
    }
  });

accountCmd
  .command("add")
  .description(
    "Register a new account in proxy.accounts (non-secret config only — set the key with 'account login')",
  )
  .argument("<id>", "new account id (e.g. kimi, work)")
  .requiredOption("--provider <name>", `provider (${UPSTREAM_PROVIDERS.join(" | ")})`)
  .requiredOption("--base-url <url>", "upstream base URL (e.g. https://api.moonshot.ai/v1)")
  .option("--model <id>", "model id the upstream expects (translating providers)")
  .option(
    "--auth-scheme <scheme>",
    `credential header scheme (${UPSTREAM_AUTH_SCHEMES.join(" | ")}); default: provider default`,
  )
  .option("--dir <path>", "project directory", process.cwd())
  .option(
    "--login",
    "prompt for the credential and store it in the OS credential store right after registering",
    false,
  )
  .action(
    async (
      id: string,
      opts: {
        provider: string;
        baseUrl: string;
        model?: string;
        authScheme?: string;
        dir: string;
        login: boolean;
      },
    ) => {
      try {
        const provider = opts.provider as NewAccount["provider"];
        if (!UPSTREAM_PROVIDERS.includes(provider)) {
          throw new InitError(
            `unknown provider "${opts.provider}"; valid: ${UPSTREAM_PROVIDERS.join(", ")}`,
          );
        }
        const authScheme = opts.authScheme as NewAccount["auth_scheme"];
        if (authScheme !== undefined && !UPSTREAM_AUTH_SCHEMES.includes(authScheme)) {
          throw new InitError(
            `unknown auth scheme "${opts.authScheme}"; valid: ${UPSTREAM_AUTH_SCHEMES.join(", ")}`,
          );
        }
        await addAccount(
          opts.dir,
          {
            id,
            provider,
            base_url: opts.baseUrl,
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            ...(authScheme !== undefined ? { auth_scheme: authScheme } : {}),
          },
          new Date().toISOString(),
        );
        process.stdout.write(
          `registered account "${id}" (${provider} ${opts.baseUrl}). ` +
            `Next: golem account login ${id}  (set its key), then  golem account use ${id}.\n`,
        );
        if (opts.login) {
          const result = await loginAccount(opts.dir, id, new Date().toISOString(), {});
          process.stdout.write(
            `stored credential for "${result.account}" — ${result.stored_in} (probe: ${result.probe}).\n`,
          );
        }
      } catch (err) {
        fail(err);
      }
    },
  );

accountCmd
  .command("remove")
  .description(
    "Remove an account from proxy.accounts, deleting its stored credential first (logout + de-register)",
  )
  .argument("<id>", "an account id from proxy.accounts")
  .option("--dir <path>", "project directory", process.cwd())
  .option(
    "--keep-credential",
    "de-register the account but LEAVE its stored credential in the OS store",
    false,
  )
  .action(async (id: string, opts: { dir: string; keepCredential: boolean }) => {
    try {
      const result = await removeAccount(opts.dir, id, new Date().toISOString(), {
        keepCredential: opts.keepCredential,
      });
      const credential = opts.keepCredential
        ? `Its stored credential was KEPT — remove it with: golem account logout ${id}.`
        : result.credential_removed.length > 0
          ? `Logged out first — credential removed from: ${result.credential_removed.join(", ")}.`
          : "No stored credential to remove.";
      process.stdout.write(
        `removed account "${result.account}" from proxy.accounts` +
          `${result.was_active ? " (was active — reverted to the default upstream)" : ""}. ` +
          `${credential}\n`,
      );
    } catch (err) {
      fail(err);
    }
  });

const noteCmd = program
  .command("note")
  .description("Capture a quick idea/note into the local capture log (spec Decision 20f)")
  .argument("[text...]", "note text to capture (quote it, or pass several words)")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .action(async (text: string[], opts: { dir: string }) => {
    if (text.length === 0) {
      noteCmd.help();
      return;
    }
    try {
      const entry = await appendNote(opts.dir, text.join(" "), new Date().toISOString());
      process.stdout.write(`captured: ${entry.text}\n`);
    } catch (err) {
      fail(err);
    }
  });

noteCmd
  .command("list")
  .description("Show recently captured notes, newest first")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("-n, --limit <count>", "how many notes to show", "20")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { dir: string; limit: string; json: boolean }) => {
    try {
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new InitError(`invalid --limit "${opts.limit}"`);
      }
      const entries = await listNotes(opts.dir, limit);
      process.stdout.write(
        opts.json ? `${JSON.stringify(entries, null, 2)}\n` : renderNotes(entries),
      );
    } catch (err) {
      fail(err);
    }
  });

noteCmd
  .command("distill")
  .description("Distill a captured note into a zone-1 question/artifact draft (local model, R3.5)")
  .argument(
    "[ts]",
    "timestamp of the note to distill (defaults to the most recently captured note)",
  )
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--force", "re-distill even if a draft already exists for this note", false)
  .action(async (ts: string | undefined, opts: { dir: string; force: boolean }) => {
    try {
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
      fail(err);
    }
  });

program
  .command("dashboard")
  .description("Serve the local savings dashboard (loopback only)")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--port <port>", "listen port (overrides config telemetry.dashboard_port)")
  .action(async (opts: { dir: string; port?: string }) => {
    try {
      const { settings } = await loadConfig({ projectDir: opts.dir });
      const port = opts.port === undefined ? settings.telemetry.dashboard_port : Number(opts.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new InitError(`invalid port "${opts.port}"`);
      }
      const source = await statsSourceForCli(opts.dir);
      const handle = await startDashboard({
        port,
        snapshot: async () => {
          // Re-read the slider each poll so external changes show up live.
          const [slider, stats] = await Promise.all([
            getSliderInfo({ projectDir: opts.dir }),
            collectStats(source),
          ]);
          return {
            project_dir: opts.dir,
            slider: { level: slider.level, name: slider.name },
            stats,
            generated_at: new Date().toISOString(),
          };
        },
        // R5.2 — the one consolidated read model every renderer shares.
        sessionState: () => collectSessionStateReport(opts.dir),
      });
      process.stdout.write(`golem dashboard on ${handle.url} (Ctrl+C to stop)\n`);
      process.stdout.write(`  consolidated session state: ${handle.url}api/state\n`);
      const shutdown = (): void => {
        void handle.close().finally(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("watch")
  .description("Full-screen sidecar TUI of Golem's live session state (run in a second pane)")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--interval <ms>", "refresh interval in milliseconds")
  .option("--no-color", "disable ANSI colors")
  .action(async (opts: { dir: string; interval?: string; color?: boolean }) => {
    try {
      const refreshMs = opts.interval === undefined ? undefined : Number(opts.interval);
      if (refreshMs !== undefined && (!Number.isFinite(refreshMs) || refreshMs < 100)) {
        throw new InitError(`invalid --interval "${opts.interval}" (must be ≥ 100 ms)`);
      }
      await runWatch({
        dir: opts.dir,
        ...(refreshMs !== undefined ? { refreshMs } : {}),
        ...(opts.color !== undefined ? { color: opts.color } : {}),
      });
      process.exit(0);
    } catch (err) {
      fail(err);
    }
  });

// R5.1 — durable task queue (WS-F1 / spec 20a): checkpointed prompts that
// survive session/credit limits and resume via headless `claude` (§65).
const taskCmd = program
  .command("task")
  .description("Durable task queue — persist a prompt/agent and resume it later (survives limits)");

taskCmd
  .command("add")
  .description("Queue a durable task (a prompt to run/resume later)")
  .argument("<prompt...>", "the prompt/instructions to persist")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
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
        fail(err);
      }
    },
  );

taskCmd
  .command("list")
  .description(
    "List tasks — committed roadmap tasks (docs/plan/tasks/) and this machine's parked ones",
  )
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--plan", "only committed roadmap tasks", false)
  .option("--local", "only this machine's parked tasks", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { dir: string; plan: boolean; local: boolean; json: boolean }) => {
    try {
      if (opts.plan && opts.local) {
        throw new InitError("--plan and --local are mutually exclusive (omit both for all tasks)");
      }
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
      fail(err);
    }
  });

taskCmd
  .command("show")
  .description("Show one task in detail (roadmap id like R8.5, or a local id prefix)")
  .argument("<id>", "task id or unique prefix")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
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
      fail(err);
    }
  });

// The roadmap's open-work table, generated from the task documents so it cannot
// drift from them (USER-requested 2026-07-30). Detail lives in one document per
// task; ROADMAP.md keeps only a live index of links.
taskCmd
  .command("index")
  .description(
    "Render the roadmap open-work index from docs/plan/tasks/ (and optionally splice it)",
  )
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--summary", "one-screen terminal summary instead of Markdown", false)
  .option(
    "--write [file]",
    "splice the Markdown between the golem:task-index markers in this file (default docs/plan/ROADMAP.md)",
  )
  .option("--json", "machine-readable output", false)
  .action(
    async (opts: { dir: string; summary: boolean; write?: string | boolean; json: boolean }) => {
      try {
        const { renderPlanIndex, renderPlanSummary, splicePlanIndex, groupPlanTasks } =
          await import("./plan-index.js");
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
        if (!spliced) {
          // Appending a second index to a file meant to hold one is worse than
          // refusing — say what is missing and where to put it.
          throw new InitError(
            `${target} has no golem:task-index markers — add these two lines where the ` +
              "index belongs:\n  <!-- golem:task-index:begin -->\n  <!-- golem:task-index:end -->",
          );
        }
        if (text === before) {
          process.stdout.write(`${target} already up to date\n`);
          return;
        }
        await writeFile(target, text, "utf8");
        process.stdout.write(`updated the task index in ${target}\n`);
      } catch (err) {
        fail(err);
      }
    },
  );

taskCmd
  .command("resume")
  .description("Build (and optionally spawn) the headless resume command for a task")
  .argument("<id>", "task id or unique prefix")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
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
          const why =
            task.notBefore !== undefined && task.state !== "done"
              ? `gated until ${task.notBefore}`
              : `state is ${task.state}`;
          process.stdout.write(`task ${task.id} is not resumable (${why})\n`);
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
        fail(err);
      }
    },
  );

taskCmd
  .command("cancel")
  .description("Mark a task cancelled (keeps the record; use it to stop auto-resume)")
  .argument("<id>", "task id or unique prefix")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--delete", "remove the task record entirely instead of marking it cancelled", false)
  .action(async (id: string, opts: { dir: string; delete: boolean }) => {
    try {
      // Scope-aware: cancelling a roadmap task edits its committed document, while
      // cancelling a parked one drops a local JSON file. Writing back to the wrong
      // store would either lose the task or invent an untracked file.
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
      fail(err);
    }
  });

// Closing a task is the other half of `cancel`, and the one a batch close-out needs:
// mark it done in place so the generated index moves it to "Closed" on the next
// `golem task index --write`, instead of someone hand-editing the roadmap.
taskCmd
  .command("done")
  .description("Mark a task done (roadmap id like R8.5, or a local id prefix)")
  .argument("<id>", "task id or unique prefix")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
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
      fail(err);
    }
  });

taskCmd
  .command("run")
  .description("Service queued tasks LOCALLY (Ollama tier) — non-blocking multiplexing (R5.3)")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--concurrency <n>", "max tasks serviced at once (default 2)", "2")
  .option("--limit <n>", "cap how many queued tasks to service this run")
  .action(async (opts: { dir: string; concurrency: string; limit?: string }) => {
    try {
      const concurrency = Number(opts.concurrency);
      if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new InitError(`invalid --concurrency "${opts.concurrency}"`);
      }
      const limit = opts.limit === undefined ? undefined : Number(opts.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw new InitError(`invalid --limit "${opts.limit}"`);
      }
      const inference = await buildInferenceForDir(opts.dir);
      if (inference === null) {
        process.stdout.write(
          "local model unavailable — queued tasks left as-is (start Ollama, then `golem task run`).\n",
        );
        return;
      }
      // LE3 — ground locally-serviced tasks with KB/wiki hits the way `coder`
      // does (R4.2). Best-effort: undefined = service ungrounded, never blocks.
      const ground = await buildTaskGrounding(opts.dir, inference);
      const result = await runQueueLocally(
        new FileTaskStore(opts.dir),
        { inference, ...(ground !== undefined ? { ground } : {}) },
        {
          concurrency,
          ...(limit !== undefined ? { limit } : {}),
        },
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
        `serviced ${result.serviced}/${result.total} queued task(s) locally` +
          `${result.failed > 0 ? ` (${result.failed} failed — see \`golem task show\`)` : ""}.\n`,
      );
    } catch (err) {
      fail(err);
    }
  });

taskCmd
  .command("escalate")
  .description("Hand a task to the Claude tier: fold its local result into the prompt (R5.3 / 21a)")
  .argument("<id>", "task id or unique prefix")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
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
      fail(err);
    }
  });

/** Build an InferenceService for `dir`, or null if the local model is unreachable. */
async function buildInferenceForDir(dir: string): Promise<InferenceService | null> {
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

// R5.4 — cruise-control autonomy (WS-F4 / spec 20d). Threat model: ADR-0002.
const PRE_TOOL_USE_HOOK_COMMAND = "golem hook pre-tool-use";

// Pure command group (no parent options/action) so each subcommand's own
// `--dir` is honored — a parent-level `--dir` shadows the child's (learned the
// hard way in R5.4 e2e). `golem autonomy` alone runs the default `show`.
const autonomyCmd = program
  .command("autonomy")
  .description("Cruise-control autonomy level + approval gate (see ADR-0002)");

autonomyCmd
  .command("show", { isDefault: true })
  .description("Show the current autonomy level")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
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
      if (!enabled) {
        process.stdout.write(
          "⚠ The gate is OFF: Golem adds no approval prompts; your Claude Code allow-list + " +
            "native prompts govern every action. Re-enable with `golem autonomy enable`.\n",
        );
        return;
      }
      if (level !== "manual") {
        process.stdout.write(
          `⚠ Golem is auto-approving some steps at level "${level}". Destructive/outward ` +
            `actions still require your approval (ADR-0002). Set 'manual' to disable.\n`,
        );
      }
      process.stdout.write(
        "the gate needs the PreToolUse hook wired (`golem init` does this by default; " +
          "`golem autonomy wire`/`unwire` toggle it). Turn the gate off without unwiring: " +
          "`golem autonomy disable`.\n",
      );
    } catch (err) {
      fail(err);
    }
  });

autonomyCmd
  .command("enable")
  .description("Turn the autonomy approval gate ON (the default)")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .action(async (opts: { dir: string }) => {
    try {
      await setAutonomyGateEnabled(opts.dir, true);
      const { level } = await readAutonomyState(opts.dir);
      process.stdout.write(
        `autonomy gate ENABLED — level ${level} — ${AUTONOMY_LEVEL_HELP[level]}\n`,
      );
    } catch (err) {
      fail(err);
    }
  });

autonomyCmd
  .command("disable")
  .description("Turn the autonomy approval gate OFF (keeps snooze/coder-first nudges)")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .action(async (opts: { dir: string }) => {
    try {
      await setAutonomyGateEnabled(opts.dir, false);
      process.stdout.write(
        "autonomy gate DISABLED — Golem adds no approval prompts; your Claude Code allow-list + " +
          "native prompts govern. The snooze + coder-first nudges still run. " +
          "Re-enable with `golem autonomy enable`.\n",
      );
    } catch (err) {
      fail(err);
    }
  });

autonomyCmd
  .command("set")
  .description(`Set the autonomy level (${AUTONOMY_LEVELS.join(" | ")})`)
  .argument("<level>", "autonomy level", parseAutonomyLevel)
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .action(async (level: ReturnType<typeof parseAutonomyLevel>, opts: { dir: string }) => {
    try {
      await writeAutonomyLevel(opts.dir, level);
      process.stdout.write(`autonomy level set to ${level} — ${AUTONOMY_LEVEL_HELP[level]}\n`);
      if (level !== "manual") {
        process.stdout.write(
          `⚠ Golem will now auto-approve ${level === "outcome" ? "read + write" : "read-only"} ` +
            `actions once wired. Destructive/outward steps still require your approval.\n`,
        );
      }
    } catch (err) {
      fail(err);
    }
  });

autonomyCmd
  .command("wire")
  .description("Install the PreToolUse gate hook in .claude/settings.json (activates autonomy)")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
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
      fail(err);
    }
  });

autonomyCmd
  .command("unwire")
  .description("Remove the PreToolUse gate hook (deactivates autonomy)")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .action(async (opts: { dir: string }) => {
    try {
      const action = await removeEventHook(
        { projectDir: opts.dir },
        "PreToolUse",
        PRE_TOOL_USE_HOOK_COMMAND,
      );
      process.stdout.write(`${action.kind}: ${action.path} — ${action.detail}\n`);
    } catch (err) {
      fail(err);
    }
  });

autonomyCmd
  .command("log")
  .description("Show the autonomy action log (auditable allow/ask/defer decisions)")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("-n, --limit <count>", "how many entries to show", "50")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { dir: string; limit: string; json: boolean }) => {
    try {
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit <= 0)
        throw new InitError(`invalid --limit "${opts.limit}"`);
      const entries = await readActionLog(opts.dir, limit);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
        return;
      }
      if (entries.length === 0) {
        process.stdout.write("no autonomy decisions logged yet\n");
        return;
      }
      for (const e of entries) {
        process.stdout.write(
          `  ${e.ts}  ${e.decision.padEnd(6)} ${e.action.padEnd(11)} ${e.tool}\n`,
        );
      }
    } catch (err) {
      fail(err);
    }
  });

// R5.5 (SPIKE) — prompt translation (WS-F7 / spec 20g). Always shown for
// inspection, never sent, never on the proxy path. Demand-gated.
const promptCmd = program
  .command("prompt")
  .description(
    "Prompt translation (spike): rewrite a raw note into a clearer prompt (shown, never sent)",
  );

promptCmd
  .command("translate")
  .description(
    "Suggest a clearer prompt for a raw note (local model; you decide whether to use it)",
  )
  .argument("<note...>", "the raw note to translate")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .action(async (note: string[], opts: { dir: string }) => {
    try {
      const inference = await buildInferenceForDir(opts.dir);
      if (inference === null) {
        process.stdout.write("local model unavailable — start Ollama, then retry.\n");
        return;
      }
      const raw = note.join(" ");
      const examples = await readExamples(opts.dir);
      const result = await translatePrompt(raw, { inference, examples });
      if (result.translated === null) {
        process.stdout.write(`could not translate: ${result.error ?? "unknown error"}\n`);
        return;
      }
      await writeLastSuggestion(opts.dir, raw, result.translated);
      process.stdout.write(
        `suggested prompt (grounded in ${result.examplesUsed} accepted example(s)):\n\n` +
          `${result.translated}\n\n` +
          "— Golem never sends this. Copy it if you like it; run `golem prompt accept` to teach your style.\n",
      );
    } catch (err) {
      fail(err);
    }
  });

promptCmd
  .command("accept")
  .description("Record the last suggested translation as an accepted style example")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .action(async (opts: { dir: string }) => {
    try {
      const last = await readLastSuggestion(opts.dir);
      if (last === null) {
        process.stdout.write("nothing to accept — run `golem prompt translate <note>` first.\n");
        return;
      }
      await appendExample(opts.dir, { ...last, ts: new Date().toISOString() });
      process.stdout.write("recorded — future translations will lean toward this style.\n");
    } catch (err) {
      fail(err);
    }
  });

// Guidance = Claude Code project rules (`.claude/rules/golem-<feature>.md`).
// Enabling writes the rule file (auto-loaded every session); disabling removes
// it. Scope: --project (committed, team-wide) or --user (gitignored, just you).
const guidanceCmd = program
  .command("guidance")
  .description("Manage the Golem guidance rules that direct Claude to use features");

const unknownFeature = (name: string): never => {
  process.stderr.write(
    `golem: no guidance feature "${name}" (try: ${GUIDANCE_FEATURES.map((x) => x.name).join(", ")})\n`,
  );
  process.exit(2);
};

const ruleFileExists = async (
  dir: string,
  name: string,
  scope: GuidanceScope,
): Promise<boolean> => {
  try {
    await access(guidanceRulePath(dir, name, scope));
    return true;
  } catch {
    return false;
  }
};

guidanceCmd
  .command("list", { isDefault: true })
  .description("List guidance features and whether each is enabled for this project")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .action(async (opts: { dir: string }) => {
    process.stdout.write("Golem guidance features (.claude/rules/golem-<name>.md):\n\n");
    for (const g of GUIDANCE_FEATURES) {
      const project = await ruleFileExists(opts.dir, g.name, "project");
      const user = await ruleFileExists(opts.dir, g.name, "user");
      const state = project ? "on (project)" : user ? "on (user)" : "off";
      const tag = g.seededByDefault ? "default" : "opt-in ";
      process.stdout.write(`  [${tag}] ${g.name.padEnd(20)} ${state.padEnd(13)} ${g.summary}\n`);
    }
    process.stdout.write(
      "\nEnable:  golem guidance enable <name> [--user]   (default scope: project/committed)\n" +
        "Disable: golem guidance disable <name> [--user]\n" +
        "Show:    golem guidance show <name>\n",
    );
  });

guidanceCmd
  .command("show")
  .description("Print one guidance rule's body")
  .argument("<name>", `feature (${GUIDANCE_FEATURES.map((g) => g.name).join(", ")})`)
  .action((name: string) => {
    const g = guidanceFeature(name);
    if (g === null) unknownFeature(name);
    else process.stdout.write(`${g.snippet}\n`);
  });

guidanceCmd
  .command("enable")
  .description("Write a guidance rule file so Claude uses this feature (auto-loaded)")
  .argument("<name>", "feature name")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option(
    "--user",
    "personal scope (gitignored .local.md) instead of committed project scope",
    false,
  )
  .action(async (name: string, opts: { dir: string; user: boolean }) => {
    try {
      const g = guidanceFeature(name);
      if (g === null) return unknownFeature(name);
      const scope: GuidanceScope = opts.user ? "user" : "project";
      const action = await writeGuidanceRule(opts.dir, g, scope);
      process.stdout.write(`${action.kind}: ${action.path} — ${action.detail}\n`);
      process.stdout.write("restart Claude Code (or reload) to pick up the rule.\n");
    } catch (err) {
      fail(err);
    }
  });

guidanceCmd
  .command("disable")
  .description("Remove a guidance rule file so Claude no longer uses this feature")
  .argument("<name>", "feature name")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--user", "only remove the personal (.local.md) rule; default removes both scopes", false)
  .action(async (name: string, opts: { dir: string; user: boolean }) => {
    try {
      if (guidanceFeature(name) === null) return unknownFeature(name);
      const action = await removeGuidanceRule(opts.dir, name, opts.user ? "user" : "both");
      process.stdout.write(
        action.kind === "skip"
          ? `${name} was not enabled — nothing to remove.\n`
          : `removed: ${action.path}\n`,
      );
    } catch (err) {
      fail(err);
    }
  });

// E1b — validated read/write of Golem settings (`golem config` + `golem coder`).
const configCmd = program
  .command("config")
  .description("Read and write Golem settings with schema validation");

configCmd
  .command("list", { isDefault: true })
  .description("List all effective settings and the layers that supplied them")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { dir: string; json: boolean }) => {
    try {
      const report = await listConfig({ projectDir: opts.dir });
      process.stdout.write(
        opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderConfigList(report),
      );
    } catch (err) {
      fail(err);
    }
  });

configCmd
  .command("get")
  .description("Show the effective value of one setting (e.g. slider.level)")
  .argument("<key>", "dotted section.key")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--json", "machine-readable output", false)
  .action(async (key: string, opts: { dir: string; json: boolean }) => {
    try {
      const report = await getConfig(key, { projectDir: opts.dir });
      process.stdout.write(
        opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderConfigGet(report),
      );
    } catch (err) {
      fail(err);
    }
  });

configCmd
  .command("set")
  .description("Write a setting to a scope (project, local, or user)")
  .argument("<key>", "dotted section.key")
  .argument(
    "<value>",
    "new value (booleans: true/false/1/0/yes/no/on/off; arrays: JSON or comma-separated)",
  )
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option(
    "--scope <scope>",
    "settings scope: project (default, committed), local (gitignored), user (~/.golem)",
    "project",
  )
  .option("--json", "machine-readable output", false)
  .action(
    async (key: string, value: string, opts: { dir: string; scope: string; json: boolean }) => {
      try {
        const scope = parseConfigScope(opts.scope);
        const result = await setConfig(scope, key, value, { projectDir: opts.dir });
        process.stdout.write(
          opts.json ? `${JSON.stringify(result, null, 2)}\n` : renderConfigSet(result),
        );
      } catch (err) {
        fail(err);
      }
    },
  );

configCmd
  .command("unset")
  .description("Remove a setting from a scope so lower layers take effect again")
  .argument("<key>", "dotted section.key")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--scope <scope>", "settings scope: project (default), local, or user", "project")
  .option("--json", "machine-readable output", false)
  .action(async (key: string, opts: { dir: string; scope: string; json: boolean }) => {
    try {
      const scope = parseConfigScope(opts.scope);
      const result = await unsetConfig(scope, key, { projectDir: opts.dir });
      process.stdout.write(
        opts.json ? `${JSON.stringify(result, null, 2)}\n` : renderConfigUnset(result),
      );
    } catch (err) {
      fail(err);
    }
  });

// The machine-readable control surface: labels, widget kinds, current values,
// provenance, and writable scopes for settings + guidance rules + runtime state.
// This is what the VS Code webview renders from, so a new settings key shows up
// there with no extension change (and no version skew between the two).
configCmd
  .command("schema")
  .description("Print every control (settings, guidance, runtime) with labels, kinds, and values")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  // Human listing by default with `--json` opt-in, exactly like every sibling
  // (`config list`, `status`, `stats`). The VS Code webview and the `golem` control
  // panel are the JSON consumers.
  .option("--json", "machine-readable output", false)
  .action(async (opts: { dir: string; json: boolean }) => {
    try {
      // withHeader: this command feeds other UIs, so it reports the full surface —
      // there is no first paint here to protect.
      const surface = await collectControlSurface({
        projectDir: opts.dir,
        version: VERSION,
        withHeader: true,
      });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(surface, null, 2)}\n`);
        return;
      }
      for (const group of surface.groups) {
        process.stdout.write(`${group.title}\n`);
        for (const control of group.controls) {
          const lock = control.locked !== undefined ? " (locked)" : "";
          process.stdout.write(
            `  ${control.id.padEnd(44)} ${control.kind.padEnd(7)} ` +
              `${JSON.stringify(control.value)} — ${control.layer}${lock}\n`,
          );
        }
      }
    } catch (err) {
      fail(err);
    }
  });

function parseConfigScope(raw: string): SettingsScope {
  if (raw === "user" || raw === "project" || raw === "local") return raw;
  throw new InvalidArgumentError(`invalid scope "${raw}" (expected user, project, or local)`);
}

/**
 * `golem local` — the local/LAN model: is it on, where does it live, is it up.
 * A thin front end over `inference.local_coder_enabled` +
 * `inference.ollama_base_url` (see src/cli/local-config.ts); `golem coder` is
 * kept below as an alias for the enable/disable half.
 */
const localCmd = program
  .command("local")
  .description("Enable, disable, and configure the local (or LAN) model");

localCmd
  .command("status", { isDefault: true })
  .description("Show whether the local model is enabled, where it lives, and if it answers")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { dir: string; json: boolean }) => {
    try {
      const report = await collectLocalModel({ projectDir: opts.dir });
      process.stdout.write(
        opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderLocalModel(report),
      );
    } catch (err) {
      fail(err);
    }
  });

for (const state of ["enable", "disable"] as const) {
  localCmd
    .command(state)
    .description(
      state === "enable"
        ? "Enable the local model's coder tool"
        : "Disable the local model's coder tool (hides it from Claude Code and the status surfaces)",
    )
    .option("--dir <path>", "project directory", DEFAULT_DIR)
    .option("--scope <scope>", "settings scope: project (default), local, or user", "project")
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; scope: string; json: boolean }) => {
      try {
        const enabled = state === "enable";
        const result = await setLocalCoderEnabled(enabled, parseConfigScope(opts.scope), {
          projectDir: opts.dir,
        });
        process.stdout.write(
          opts.json
            ? `${JSON.stringify(result, null, 2)}\n`
            : renderLocalCoderWrite(result, enabled),
        );
      } catch (err) {
        fail(err);
      }
    });
}

localCmd
  .command("url")
  .description(
    "Point the local roles at an Ollama endpoint — localhost or another machine on the LAN",
  )
  .argument("<url>", "base URL, e.g. http://localhost:11434 or http://gpubox.lan:11434")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--scope <scope>", "settings scope: project (default), local, or user", "project")
  .option("--no-probe", "skip the reachability check before saving")
  .option("--json", "machine-readable output", false)
  .action(
    async (url: string, opts: { dir: string; scope: string; probe: boolean; json: boolean }) => {
      try {
        const result = await setLocalBaseUrl(url, parseConfigScope(opts.scope), {
          projectDir: opts.dir,
          probe: opts.probe,
        });
        process.stdout.write(
          opts.json ? `${JSON.stringify(result, null, 2)}\n` : renderLocalUrlWrite(result),
        );
      } catch (err) {
        fail(err);
      }
    },
  );

// Kept as a shortcut/alias for the toggle half of `golem local` — `golem coder
// enable|disable|status` predates the group and is in muscle memory (and in the
// guidance rule's text).
program
  .command("coder")
  .description("Enable, disable, or show the local coder tool status (alias of `golem local`)")
  .argument("[state]", "enable | disable | status")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--scope <scope>", "settings scope for enable/disable", "project")
  .option("--json", "machine-readable output", false)
  .action(
    async (state: string | undefined, opts: { dir: string; scope: string; json: boolean }) => {
      try {
        if (state === undefined || state === "status") {
          const report = await collectLocalModel({ projectDir: opts.dir });
          process.stdout.write(
            opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderLocalModel(report),
          );
          return;
        }
        if (state !== "enable" && state !== "disable") {
          throw new InvalidArgumentError(`expected enable, disable, or status; got "${state}"`);
        }
        const enabled = state === "enable";
        const result = await setLocalCoderEnabled(enabled, parseConfigScope(opts.scope), {
          projectDir: opts.dir,
        });
        process.stdout.write(
          opts.json
            ? `${JSON.stringify(result, null, 2)}\n`
            : renderLocalCoderWrite(result, enabled),
        );
      } catch (err) {
        fail(err);
      }
    },
  );

const TIER_NAMES: Readonly<Record<HardwareTier, string>> = {
  0: "P_CPU",
  1: "P_MIN",
  2: "P_MID",
  3: "P_MAX",
};

program
  .command("index")
  .description("Index a file or directory into the Golem knowledge base (local embeddings)")
  .argument("[path]", "file or directory to ingest (default: project root)")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--watch", "keep watching the path for changes (stays running)", false)
  .option("--json", "machine-readable output", false)
  .action(
    async (pathArg: string | undefined, opts: { dir: string; watch: boolean; json: boolean }) => {
      try {
        const { knowledge, embedMode, facts } = await buildKnowledgeStack({ projectDir: opts.dir });
        const embedNote =
          embedMode === "semantic"
            ? "semantic (Ollama bge-m3)"
            : "lexical (built-in, no Ollama — pull bge-m3 for semantic)";

        // Whole-project (re)index with no explicit path and no --watch: route
        // through ensureProjectIndexed so it is INCREMENTAL — only changed/new
        // files are re-embedded (deleted ones dropped), or the whole run is
        // skipped when nothing changed. A full re-embed of a large tree is
        // minutes; a typical edit is seconds. It also does the correct
        // clear+rebuild when the embedder changed (e.g. bge-m3 got pulled).
        if (pathArg === undefined && !opts.watch) {
          const { settings } = await loadConfig({ projectDir: opts.dir });
          const result = await ensureProjectIndexed({
            projectDir: opts.dir,
            projectId: opts.dir,
            knowledge,
            embedMode,
            tier: facts.tier,
            watchPaths: settings.knowledge.watch_paths,
            now: new Date().toISOString(),
          });
          if (opts.json) {
            process.stdout.write(`${JSON.stringify({ ...result, embedMode }, null, 2)}\n`);
          } else {
            const line =
              result.action === "skipped"
                ? `Index already up to date (${embedNote}) — nothing changed.\n`
                : result.action === "synced"
                  ? `Synced index (${embedNote}): ${result.updated ?? 0} file(s) changed, ` +
                    `${result.removed ?? 0} removed — ${result.chunks} chunk(s) re-embedded.\n`
                  : `${result.action === "reindexed" ? "Re-indexed" : "Indexed"} ` +
                    `${result.chunks} chunks from ${result.files} file(s) using ${embedNote}` +
                    `${result.action === "reindexed" ? " (embedder changed)" : ""}.\n`;
            process.stdout.write(line);
            process.stdout.write(
              "The index is persisted under .golem/knowledge, so `search` " +
                "finds it in any later session.\n",
            );
          }
          return;
        }

        // Explicit path or --watch: a targeted (full) ingest of just that path.
        const target = pathArg ?? opts.dir;
        const report = await knowledge.ingest(target, opts.dir, opts.watch);
        // Record the embedder signature so `mcp serve` respects this index (and
        // rebuilds only when the embedder changes).
        await writeManifest(
          opts.dir,
          opts.dir,
          embedderSignature(embedMode, facts.tier),
          [target],
          new Date().toISOString(),
        );
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ ...report, embedMode }, null, 2)}\n`);
        } else {
          process.stdout.write(
            `Indexed ${report.path}: ${report.chunksIndexed} chunks from ` +
              `${report.filesSeen} file(s) (${report.filesSkipped} skipped) ` +
              `using ${embedNote}${report.watching ? ", watching for changes" : ""}.\n`,
          );
          if (!report.watching) {
            process.stdout.write(
              "The index is persisted under .golem/knowledge, so `search` " +
                "finds it in any later session.\n",
            );
          }
        }
      } catch (err) {
        fail(err);
      }
    },
  );

program
  .command("devices")
  .description("Show detected local hardware tier and the models Golem would use")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      const facts = await detectCapability(createProbeRunner());
      const models = modelsForTier(facts.tier);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ ...facts, models }, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        `Hardware tier: ${facts.tier} (${TIER_NAMES[facts.tier]}) — via ${facts.source}\n`,
      );
      if (facts.device !== undefined) process.stdout.write(`  device: ${facts.device}\n`);
      if (facts.memoryMiB !== undefined) process.stdout.write(`  memory: ${facts.memoryMiB} MiB\n`);
      process.stdout.write(`  ${facts.detail}\n`);
      process.stdout.write(`  models for this tier: ${models.join(", ")}\n`);
    } catch (err) {
      fail(err);
    }
  });

const ollamaCmd = program
  .command("ollama")
  .description("Manage the local Ollama runtime Golem uses for drafts");

ollamaCmd
  .command("status")
  .description("Show whether Ollama is installed, reachable, and has this tier's drafter model")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { dir: string; json: boolean }) => {
    try {
      const report = await collectOllamaStatus({ projectDir: opts.dir });
      process.stdout.write(renderOllamaStatus(report, opts.json));
    } catch (err) {
      fail(err);
    }
  });

ollamaCmd
  .command("setup")
  .description("Install Ollama and pull this tier's drafter model (asks for confirmation)")
  .option("--dir <path>", "project directory", DEFAULT_DIR)
  .option("--yes", "skip the confirmation prompt", false)
  .action(async (opts: { dir: string; yes: boolean }) => {
    try {
      const result = await runOllamaSetup({
        projectDir: opts.dir,
        yes: opts.yes,
        onLine: (line) => process.stdout.write(line.endsWith("\n") ? line : `${line}\n`),
      });
      process.stdout.write(renderSetupResult(result));
    } catch (err) {
      if (err instanceof SetupRefusedError) {
        process.stderr.write(`golem: ${err.message}\n`);
        process.exit(2);
      }
      fail(err);
    }
  });

const hookCmd = buildHookCommand({
  // Web-fetch capture ingests into the SAME KB (embedder) the auto-index uses.
  buildKnowledge: async (projectDir) => {
    try {
      return (await buildKnowledgeStack({ projectDir })).knowledge;
    } catch {
      return null; // KB unavailable → capture skips the vector ingest (cache still written)
    }
  },
  // Conditional revalidation of cached WebFetch URLs, gated by the opt-in
  // `knowledge.webcache_revalidate` setting (default off). Kept in the CLI layer
  // so src/hooks stays free of a config dependency.
  revalidate: defaultRevalidate,
  revalidateEnabled: async (projectDir) => {
    try {
      return (await loadConfig({ projectDir })).settings.knowledge.webcache_revalidate;
    } catch {
      return false; // config unreadable → behave as if disabled (pure-TTL)
    }
  },
  // Decision 42: fetch + cache the RAW page ourselves instead of Claude Code's
  // prompt-specific WebFetch answer. On by default; gated by the config key.
  fetchRaw: fetchRawPage,
  fetchRawEnabled: async (projectDir) => {
    try {
      return (await loadConfig({ projectDir })).settings.knowledge.webcache_fetch_raw;
    } catch {
      return true; // config unreadable → default on (Decision 42 default)
    }
  },
});

/** Read all of stdin as UTF-8 (best-effort; empty on TTY/no input). */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// SessionStart (project open): auto-start the proxy if this project had it running.
// Lives here (not src/hooks/) because it drives the proxy daemon + config. Fail-safe.
hookCmd
  .command("session-start")
  .description("SessionStart handler: auto-start the proxy if it was running for this project")
  .action(async () => {
    try {
      let cwd = process.cwd();
      try {
        const j = JSON.parse(await readStdin()) as { cwd?: unknown };
        if (typeof j.cwd === "string" && j.cwd.length > 0) cwd = j.cwd;
      } catch {
        // no/!json payload — the hook's process cwd is the project anyway
      }
      if ((await readProxyDesired(cwd)) !== "running") return; // not wanted → do nothing
      const { settings } = await loadConfig({ projectDir: cwd });
      if ((await proxyStatus(cwd, settings.proxy.port)).running) return; // already up
      await startDetached(cwd, settings.proxy.port, process.argv[1] ?? "");
    } catch {
      // never break session startup over the proxy autostart
    }
  });

program.addCommand(hookCmd);

/**
 * Parse argv and run the matching command.
 *
 * Called by src/cli/main.ts (the `bin` entry), which dynamically imports this
 * module — so the whole CLI graph below is only loaded for invocations that
 * actually need commander. See main.ts for why.
 */
export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  await program.parseAsync([...argv]);
}
