/**
 * golem slider / brevity / compression / stats — extracted from program.ts (R8.27).
 */

import type { Command } from "commander";
import { findProjectDir, loadConfig } from "../../config/index.js";
import { readContextLedger } from "../../proxy/index.js";
import { aggregateCacheStats, renderCacheReport } from "../../telemetry/cache-report.js";
import {
  type BenchWindow,
  type ModelCatalog,
  openTelemetryStore,
  readTelemetryEvents,
  type TelemetryEvent,
  type ToolUsageStats,
} from "../../telemetry/index.js";
import { loadModelCatalog } from "../../telemetry/model-catalog.js";
import { brevityReportRows } from "../../telemetry/usage-report.js";
import { renderContextLedger } from "../context.js";
import { InitError } from "../init.js";
import { statsSourceForCli } from "../mcp-compression.js";
import { collectStats, collectWindowedStats, renderBrevityReport, renderStats } from "../stats.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

export default function register(program: Command): void {
  for (const kind of ["brevity", "compression"] as const) {
    program
      .command(kind)
      .description(
        kind === "brevity"
          ? "Show or set the output-side brevity dial (off|lite|full|ultra)"
          : "Show or set the input-side compression dial (off|1|2|3)",
      )
      .argument("[value]", "new value; omit to show the current one")
      .option("--dir <path>", "project directory", _DEFAULT_DIR)
      .option("--project", "write the committed project scope instead of local", false)
      .option("--json", "machine-readable output", false)
      .action(
        async (
          value: string | undefined,
          opts: { dir: string; project: boolean; json: boolean },
        ) => {
          const {
            brevityEffectNote,
            compressionEffectNote,
            describeDial,
            DIAL_VALUES,
            DialError,
            getDialInfo,
            setDial,
          } = await import("../dials.js");
          // R11.1: one note per dial, so `compression off` explains that redaction
          // still runs — the question a reader of that word actually has.
          const effectNote = (value: string): string =>
            kind === "brevity" ? brevityEffectNote(value as never) : compressionEffectNote(value);
          try {
            if (value === undefined) {
              const info = await getDialInfo(kind, { projectDir: opts.dir });
              if (opts.json) {
                process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
                return;
              }
              process.stdout.write(
                `${describeDial(info)}${info.source !== undefined ? ` (${info.source})` : ""}\n`,
              );
              process.stdout.write(`${effectNote(info.effective)}\n`);
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
            process.stdout.write(`${effectNote(result.info.effective)}\n`);
            if (result.overriddenBy !== undefined)
              process.stdout.write(
                `⚠ a higher layer wins — the effective value comes from ${result.overriddenBy.layer}${result.overriddenBy.source !== undefined ? ` (${result.overriddenBy.source})` : ""}\n`,
              );
            // R11.1: the proxy re-reads the dials live (DIAL_RELOAD_TTL_MS in
            // proxy-runtime.ts), so there is nothing to restart — telling the user
            // otherwise would send them to do work Golem no longer needs.
            process.stdout.write("in effect within a second — no proxy restart needed\n");
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
    .command("stats")
    .description("Show Golem token-savings statistics (per-stage breakdown, CCR activity)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
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
          if (opts.window !== "24h" && opts.window !== "7d" && opts.window !== "all")
            throw new InitError(`invalid --window "${opts.window}" (expected 24h | 7d | all)`);
          if (opts.brevity) {
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
          if (opts.context) {
            const ledger = await readContextLedger(opts.dir);
            let window: { catalog: ModelCatalog; warnFraction: number } | undefined;
            try {
              const { settings } = await loadConfig({ projectDir: opts.dir });
              window = {
                catalog: await loadModelCatalog(opts.dir),
                warnFraction: settings.models.context_warn_fraction,
              };
            } catch {
              window = undefined;
            }
            process.stdout.write(
              opts.json
                ? `${JSON.stringify(ledger, null, 2)}\n`
                : renderContextLedger(ledger, window),
            );
            return;
          }
          if (opts.cache) {
            let cacheEvents: readonly TelemetryEvent[] = [];
            try {
              cacheEvents = await readTelemetryEvents(opts.dir);
            } catch {
              cacheEvents = [];
            }
            const cacheStats = aggregateCacheStats(cacheEvents, opts.project);
            process.stdout.write(
              opts.json
                ? `${JSON.stringify(cacheStats, null, 2)}\n`
                : renderCacheReport(cacheStats),
            );
            return;
          }
          const window: BenchWindow = opts.window;
          let toolUsage: ToolUsageStats | undefined;
          try {
            toolUsage = await openTelemetryStore(opts.dir).aggregateToolUsage(opts.project);
          } catch {
            toolUsage = undefined;
          }
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
          _fail(err);
        }
      },
    );
}
