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

import { Command, InvalidArgumentError } from "commander";
import { NativeLosslessCompression } from "../compression/index.js";
import { loadConfig, policyFromSettings, settingsFilePaths } from "../config/index.js";
import { startDashboard } from "../dashboard/index.js";
import { buildHookCommand } from "../hooks/index.js";
import { VERSION } from "../index.js";
import type { SliderLevel } from "../interfaces/policy.js";
import { JsonFileSliderStore, serveStdio } from "../mcp/index.js";
import { createGolemPipeline } from "../pipeline/index.js";
import { GolemProxy } from "../proxy/index.js";
import {
  openTelemetryStore,
  recordPipelineEvent,
  telemetryStatsSource,
} from "../telemetry/index.js";
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
  .action(async (opts: { dir: string; dryRun: boolean }) => {
    try {
      const { settings } = await loadConfig({ projectDir: opts.dir });
      const report = await golemInit({
        projectDir: opts.dir,
        dryRun: opts.dryRun,
        proxyPort: settings.proxy.port,
      });
      printReport(report);
      if (!report.dryRun) {
        process.stdout.write(
          "\nDone. Start the proxy with `golem proxy`, then restart Claude Code in this project.\n" +
            "The Golem status line is now in your terminal; for a VS Code panel, install the\n" +
            "extension in vscode-extension/ (see its README) and reload the window.\n",
        );
      }
    } catch (err) {
      fail(err);
    }
  });

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
  const pipeline = createGolemPipeline({
    compression: NativeLosslessCompression.forProjectDir(dir),
    policy: () => policyFromSettings(settings),
    projectId: dir,
    onEvent: (event) => {
      void recordPipelineEvent(telemetry, event, new Date().toISOString()).catch(() => {});
    },
  });
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
      await serveStdio({
        compression: NativeLosslessCompression.forProjectDir(opts.dir),
        // Project-scope settings file — the same file (and nested slider.level
        // key) the E1 loader and `golem slider` use (verification-notes §20).
        sliderStore: new JsonFileSliderStore(settingsFilePaths({ projectDir: opts.dir }).project),
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

program
  .command("index")
  .description("Index files into the Golem knowledge base (not implemented yet — ships with WS-C)")
  .allowExcessArguments(true)
  .action(() => {
    process.stderr.write(
      "golem index is not implemented yet: the vector knowledge base ships with " +
        "workstream WS-C (golem_index_path / golem_search; docs/IMPLEMENTATION_PLAN.md §3).\n",
    );
    process.exitCode = 1;
  });

program
  .command("devices")
  .description("Show detected local hardware and models (not implemented yet — ships with WS-D)")
  .action(() => {
    process.stderr.write(
      "golem devices is not implemented yet: hardware detection and tiered local " +
        "inference ship with workstream WS-D (golem_devices; docs/IMPLEMENTATION_PLAN.md §3).\n",
    );
    process.exitCode = 1;
  });

program.addCommand(buildHookCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
