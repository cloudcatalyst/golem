#!/usr/bin/env node

/**
 * Entry point for the `golem` command (WS-E).
 *
 * E2: init / uninit, plus the runtime commands they wire Claude Code to:
 *   - `golem proxy`      — the A1 proxy running the A3 redaction→compression
 *                          pipeline (Claude Code's ANTHROPIC_BASE_URL target)
 *   - `golem mcp serve`  — the B1 unified MCP server on stdio (.mcp.json entry)
 * E3: status / slider / stats / dashboard (+ index/devices stubs for WS-C/D).
 */

import { spawn } from "node:child_process";
import { Command, InvalidArgumentError } from "commander";
import { HeadroomSidecar } from "../compression/headroom-adapter.js";
import { NativeLosslessCompression } from "../compression/index.js";
import { loadConfig, policyFromSettings, settingsFilePaths } from "../config/index.js";
import { startDashboard } from "../dashboard/index.js";
import { buildHookCommand } from "../hooks/index.js";
import { VERSION } from "../index.js";
import {
  createProbeRunner,
  detectCapability,
  embedModelFor,
  modelsForTier,
} from "../inference/index.js";
import type { HardwareTier } from "../interfaces/inference.js";
import type { KnowledgeBase } from "../interfaces/knowledge.js";
import type { SliderLevel } from "../interfaces/policy.js";
import { JsonFileSliderStore, serveStdio } from "../mcp/index.js";
import { createGolemPipeline } from "../pipeline/index.js";
import { GolemProxy } from "../proxy/index.js";
import {
  openTelemetryStore,
  recordPipelineEvent,
  telemetryStatsSource,
} from "../telemetry/index.js";
import { embedderSignature, ensureProjectIndexed, writeManifest } from "./auto-index.js";
import { buildKnowledgeStack } from "./build-knowledge.js";
import { golemInit, golemUninit, InitError, type InitReport } from "./init.js";
import {
  portInUse,
  proxyStatus,
  removeProxyPid,
  startDetached,
  stopProxy,
  waitForPortFree,
  writeProxyPid,
} from "./proxy-daemon.js";
import { readProxyDesired, writeProxyDesired } from "./proxy-state.js";
import { getSliderInfo, SLIDER_LEVEL_NAMES, setSliderLevel } from "./slider.js";
import { collectStats, liveStatsSource, renderStats, type StatsSource } from "./stats.js";
import { collectStatus, renderStatus } from "./status.js";
import { collectGolemState, parseSessionInput, renderStatusLine } from "./statusline.js";

const program = new Command();

program.name("golem").description("Golem — edge offload for Claude (golem.run)").version(VERSION);

function printReport(report: InitReport): void {
  for (const action of report.actions) {
    process.stdout.write(`  ${action.kind.padEnd(6)} ${action.path} — ${action.detail}\n`);
  }
  if (report.dryRun) {
    process.stdout.write("dry run: nothing was written.\n");
  }
}

function fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

/**
 * Pick the stats source for read commands: durable telemetry (A4) once it has
 * recorded at least one request, else the in-memory live source (E3). This lets
 * `golem stats` show cross-session history when the proxy has run, and still
 * work before any telemetry exists.
 */
async function statsSourceForCli(projectDir: string): Promise<StatsSource> {
  const store = openTelemetryStore(projectDir);
  try {
    const agg = await store.aggregate();
    if (agg.requests > 0) return telemetryStatsSource(store);
  } catch {
    // fall through to live
  }
  return liveStatsSource(projectDir);
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
          const pid = await startDetached(opts.dir, settings.proxy.port, process.argv[1] ?? "");
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

/** Is a command resolvable on PATH? (spawns `<cmd> --version`, resolves false on failure.) */
function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ["--version"], { stdio: "ignore", shell: true, windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

/** Is Ollama up with the tier's text embed model pulled? (mirrors build-knowledge's probe.) */
async function ollamaEmbedReady(dir: string): Promise<boolean> {
  try {
    const { settings } = await loadConfig({ projectDir: dir });
    const facts = await detectCapability(createProbeRunner());
    const model = embedModelFor(facts.tier, "text");
    const res = await fetch(new URL("/api/tags", settings.inference.ollama_base_url), {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { models?: Array<{ name?: unknown }> };
    return (body.models ?? []).some((m) => typeof m.name === "string" && m.name.startsWith(model));
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

/** Run the proxy in the foreground: bind, write a pid file, serve until stopped. */
async function runProxyForeground(dir: string, portOpt?: string): Promise<void> {
  const { settings } = await loadConfig({ projectDir: dir });
  const { port } = await resolvePort(dir, portOpt);

  // Idempotent: refuse (cleanly) if a proxy is already up on this port.
  if (await portInUse(port)) {
    process.stdout.write(`golem proxy: already running on port ${port}\n`);
    return;
  }

  const telemetry = openTelemetryStore(dir);
  // OPT-IN semantic sidecar (Headroom) for slider ≥3 — off unless configured.
  // Started lazily on first ≥3 request; fails open so the proxy never depends on it.
  const semantic = settings.compression.headroom_sidecar ? new HeadroomSidecar() : undefined;
  const pipeline = createGolemPipeline({
    compression: NativeLosslessCompression.forProjectDir(dir),
    policy: () => policyFromSettings(settings),
    projectId: dir,
    onEvent: (event) => {
      void recordPipelineEvent(telemetry, event, new Date().toISOString()).catch(() => {});
    },
    ...(semantic !== undefined ? { semantic } : {}),
  });
  if (semantic !== undefined) {
    process.stdout.write(
      "golem proxy: Headroom semantic sidecar enabled (slider ≥3, opt-in, fail-open)\n",
    );
  }
  const proxy = new GolemProxy({
    upstreamBaseUrl: settings.proxy.upstream_base_url,
    connectTimeoutMs: settings.proxy.connect_timeout_ms,
    headersTimeoutMs: settings.proxy.request_timeout_ms,
    bodyTimeoutMs: settings.proxy.request_timeout_ms,
    pipeline,
    onPipelineError: (err) => {
      process.stderr.write(
        `golem proxy: pipeline error — forwarded request unchanged (passthrough): ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    },
  });
  const addr = await proxy.listen(port);
  await writeProxyPid(dir, { pid: process.pid, port: addr.port, ts: new Date().toISOString() });
  process.stdout.write(
    `golem proxy listening on http://localhost:${addr.port} -> ${settings.proxy.upstream_base_url} (slider level ${settings.slider.level})\n`,
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
  .option("--dir <path>", "project directory (for .golem/ config)", process.cwd())
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
        const pid = await startDetached(opts.dir, port, process.argv[1] ?? "");
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
  .option("--dir <path>", "project directory", process.cwd())
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
  .option("--dir <path>", "project directory", process.cwd())
  .option("--port <port>", "listen port (overrides config)")
  .option("--foreground", "restart in the foreground instead of detached", false)
  .action(async (opts: { dir: string; port?: string; foreground: boolean }) => {
    try {
      await writeProxyDesired(opts.dir, "running", new Date().toISOString());
      const { port, upstream } = await resolvePort(opts.dir, opts.port);
      await stopProxy(opts.dir);
      // Also clear anything still holding the port (a proxy started without a
      // pid file), then wait for release.
      await waitForPortFree(port);
      if (opts.foreground) {
        await runProxyForeground(opts.dir, opts.port);
        return;
      }
      const pid = await startDetached(opts.dir, port, process.argv[1] ?? "");
      if (pid === null) fail(new InitError(`proxy did not come up on port ${port}`));
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
  .option("--dir <path>", "project directory", process.cwd())
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
  .option("--dir <path>", "project directory (for the CCR store)", process.cwd())
  .action(async (opts: { dir: string }) => {
    try {
      // stdio owns stdout (MCP JSON-RPC) — NEVER write there here; warnings go to
      // stderr. Build the KB before connecting so a KB failure degrades to
      // "serve without knowledge tools" rather than crashing the server.
      const { settings } = await loadConfig({ projectDir: opts.dir });
      let knowledge: KnowledgeBase | undefined;
      if (settings.knowledge.enabled) {
        try {
          const stack = await buildKnowledgeStack({ projectDir: opts.dir });
          knowledge = stack.knowledge;
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
      await serveStdio({
        compression: NativeLosslessCompression.forProjectDir(opts.dir),
        // Project-scope settings file — the same file (and nested slider.level
        // key) the E1 loader and `golem slider` use (verification-notes §20).
        sliderStore: new JsonFileSliderStore(settingsFilePaths({ projectDir: opts.dir }).project),
        ...(knowledge !== undefined ? { knowledge, defaultProjectId: opts.dir } : {}),
      });
    } catch (err) {
      fail(err);
    }
  });

program
  .command("status")
  .description("Show Golem status: config + provenance, proxy reachability, project wiring, slider")
  .option("--dir <path>", "project directory", process.cwd())
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

function parseSliderLevel(raw: string): SliderLevel {
  const level = Number(raw);
  if (!Number.isInteger(level) || level < 0 || level > 5) {
    throw new InvalidArgumentError("level must be an integer from 0 to 5");
  }
  return level as SliderLevel;
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

program
  .command("slider")
  .description("Show the Golem savings slider, or set it (0 passthrough … 5 max savings)")
  .argument("[level]", "new slider level 0–5; omit to show the current level", parseSliderLevel)
  .option("--dir <path>", "project directory", process.cwd())
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
      process.stdout.write(
        `slider level set to ${level} (${SLIDER_LEVEL_NAMES[level]}) in ${result.file}\n`,
      );
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
  .option("--dir <path>", "project directory", process.cwd())
  .option("--project <id>", "limit stats to this project id")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { dir: string; project?: string; json: boolean }) => {
    try {
      const report = await collectStats(await statsSourceForCli(opts.dir), opts.project);
      process.stdout.write(
        opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderStats(report),
      );
    } catch (err) {
      fail(err);
    }
  });

program
  .command("dashboard")
  .description("Serve the local savings dashboard (loopback only)")
  .option("--dir <path>", "project directory", process.cwd())
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
      });
      process.stdout.write(`golem dashboard on ${handle.url} (Ctrl+C to stop)\n`);
      const shutdown = (): void => {
        void handle.close().finally(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (err) {
      fail(err);
    }
  });

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
  .option("--dir <path>", "project directory", process.cwd())
  .option("--watch", "keep watching the path for changes (stays running)", false)
  .option("--json", "machine-readable output", false)
  .action(
    async (pathArg: string | undefined, opts: { dir: string; watch: boolean; json: boolean }) => {
      try {
        const { knowledge, embedMode, facts } = await buildKnowledgeStack({ projectDir: opts.dir });
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
          const embedNote =
            embedMode === "semantic"
              ? "semantic (Ollama bge-m3)"
              : "lexical (built-in, no Ollama — pull bge-m3 for semantic)";
          process.stdout.write(
            `Indexed ${report.path}: ${report.chunksIndexed} chunks from ` +
              `${report.filesSeen} file(s) (${report.filesSkipped} skipped) ` +
              `using ${embedNote}${report.watching ? ", watching for changes" : ""}.\n`,
          );
          if (!report.watching) {
            process.stdout.write(
              "The index is persisted under .golem/knowledge, so `golem_search` " +
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

const hookCmd = buildHookCommand({
  // Web-fetch capture ingests into the SAME KB (embedder) the auto-index uses.
  buildKnowledge: async (projectDir) => {
    try {
      return (await buildKnowledgeStack({ projectDir })).knowledge;
    } catch {
      return null; // KB unavailable → capture skips the vector ingest (cache still written)
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

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
