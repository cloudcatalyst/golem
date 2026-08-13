/**
 * golem slider / brevity / compression / stats — extracted from program.ts (R8.27).
 */

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { findProjectDir, loadConfig } from "../../config/index.js";
import { migrateSliderLevel, type SliderLevel } from "../../interfaces/policy.js";
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
import { getSliderInfo, SLIDER_LEVEL_NAMES, setSliderLevel } from "../slider.js";
import { collectStats, collectWindowedStats, renderBrevityReport, renderStats } from "../stats.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

function parseSliderLevel(raw: string): SliderLevel {
  const level = Number(raw);
  if (!Number.isInteger(level) || level < 0 || level > 5) {
    throw new InvalidArgumentError("level must be an integer from 0 to 3 (legacy 4/5 map to 3)");
  }
  return migrateSliderLevel(level);
}

export default function register(program: Command): void {
  for (const kind of ["brevity", "compression"] as const) {
    program
      .command(kind)
      .description(
        kind === "brevity"
          ? "Show or set the output-side brevity dial (auto|off|lite|full|ultra)"
          : "Show or set the input-side compression dial (auto|1|2|3)",
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
          const { brevityEffectNote, describeDial, DIAL_VALUES, DialError, getDialInfo, setDial } =
            await import("../dials.js");
          try {
            if (value === undefined) {
              const info = await getDialInfo(kind, { projectDir: opts.dir });
              if (opts.json) {
                process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
                return;
              }
              process.stdout.write(
                `${describeDial(info)} — set by ${info.layer}${info.source !== undefined ? ` (${info.source})` : ""}\n`,
              );
              if (kind === "brevity")
                process.stdout.write(
                  `${brevityEffectNote(info.effective as never, info.sliderLevel)}\n`,
                );
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
            if (kind === "brevity")
              process.stdout.write(
                `${brevityEffectNote(result.info.effective as never, result.info.sliderLevel)}\n`,
              );
            if (result.overriddenBy !== undefined)
              process.stdout.write(
                `⚠ a higher layer wins — the effective value comes from ${result.overriddenBy.layer}${result.overriddenBy.source !== undefined ? ` (${result.overriddenBy.source})` : ""}\n`,
              );
            process.stdout.write(
              "restart the proxy for this to take effect: golem proxy restart\n",
            );
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
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (level: SliderLevel | undefined, opts: { dir: string; json: boolean }) => {
      try {
        if (level === undefined) {
          const info = await getSliderInfo({ projectDir: opts.dir });
          process.stdout.write(
            opts.json
              ? `${JSON.stringify(info, null, 2)}\n`
              : `slider level ${info.level} (${info.name}) — set by ${info.layer}${info.source !== undefined ? ` (${info.source})` : ""}\n`,
          );
          return;
        }
        const result = await setSliderLevel(level, { projectDir: opts.dir });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        if (result.justInitialized === true)
          process.stdout.write(
            "golem initialized in this project (MCP + skills wired, CLAUDE.local.md updated)\n",
          );
        process.stdout.write(
          `slider level set to ${level} (${SLIDER_LEVEL_NAMES[level]}) in ${result.file}\n`,
        );
        if (level === 0)
          process.stdout.write(
            `⚠ level 0 (passthrough) is a FULL BYPASS: redaction is OFF, so secrets/PII reach the upstream unredacted. Use level 1 to keep redaction on.\n`,
          );
        if (result.overriddenBy !== undefined) {
          const o = result.overriddenBy;
          process.stdout.write(
            `note: a higher-precedence layer overrides it — effective level is ${o.level} (${o.name}) from ${o.layer}${o.source !== undefined ? ` (${o.source})` : ""}\n`,
          );
        }
        const ec = result.effectiveCompression;
        if (ec.degraded)
          process.stdout.write(
            `⚠ on this upstream that behaves as level ${ec.effective} (${SLIDER_LEVEL_NAMES[ec.effective]}), not ${ec.nominal} (${SLIDER_LEVEL_NAMES[ec.nominal]}): ${ec.reason ?? ""}\n  The setting is kept — it applies as chosen on a non-caching account (golem gateway use <id>).\n`,
          );
      } catch (err) {
        _fail(err);
      }
    });

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
