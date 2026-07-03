#!/usr/bin/env node
/**
 * Entry point for the `golem` command (WS-E).
 *
 * E2: init / uninit, plus the two runtime commands they wire Claude Code to:
 *   - `golem proxy`      — the A1 passthrough proxy (ANTHROPIC_BASE_URL target)
 *   - `golem mcp serve`  — the B1 unified MCP server on stdio (.mcp.json entry)
 * E3 adds status/slider/stats/index/devices and the dashboard.
 */

import { Command } from "commander";
import { NativeLosslessCompression } from "../compression/index.js";
import { loadConfig } from "../config/index.js";
import { VERSION } from "../index.js";
import { JsonFileSliderStore, serveStdio } from "../mcp/index.js";
import { GolemProxy } from "../proxy/index.js";
import { golemInit, golemUninit, InitError, type InitReport } from "./init.js";

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
          "\nDone. Start the proxy with `golem proxy`, then restart Claude Code in this project.\n",
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

program
  .command("proxy")
  .description("Run the Golem proxy (Claude Code's ANTHROPIC_BASE_URL target)")
  .option("--dir <path>", "project directory (for .golem/ config)", process.cwd())
  .option("--port <port>", "listen port (overrides config)")
  .action(async (opts: { dir: string; port?: string }) => {
    try {
      const { settings } = await loadConfig({ projectDir: opts.dir });
      const port = opts.port === undefined ? settings.proxy.port : Number(opts.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new InitError(`invalid port "${opts.port}"`);
      }
      const proxy = new GolemProxy({
        upstreamBaseUrl: settings.proxy.upstream_base_url,
        connectTimeoutMs: settings.proxy.connect_timeout_ms,
        headersTimeoutMs: settings.proxy.request_timeout_ms,
        bodyTimeoutMs: settings.proxy.request_timeout_ms,
      });
      const addr = await proxy.listen(port);
      process.stdout.write(
        `golem proxy listening on http://localhost:${addr.port} -> ${settings.proxy.upstream_base_url}\n`,
      );
      const shutdown = (): void => {
        void proxy.close().finally(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
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
        sliderStore: new JsonFileSliderStore(),
      });
    } catch (err) {
      fail(err);
    }
  });

program
  .command("status")
  .description("Show Golem service status (stub — implemented in WS-E task E3)")
  .action(() => {
    process.stdout.write("golem: status not yet implemented (WS-E task E3)\n");
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
