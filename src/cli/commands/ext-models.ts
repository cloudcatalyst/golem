/**
 * golem ext / models — extracted from program.ts (R8.27).
 */

import type { Command } from "commander";
import { findProjectDir, loadConfig } from "../../config/index.js";
import {
  BUILTIN_MODEL_CATALOG,
  fetchModelCatalog,
  loadModelCatalog,
  mergeCatalogs,
  writeModelCatalog,
} from "../../telemetry/model-catalog.js";
import { collectExt, renderExt } from "../ext.js";
import { InitError } from "../init.js";
import { renderModelCatalog, renderRefreshResult } from "../models.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

export default function register(program: Command): void {
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
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .option("--verbose", "also show purpose, install instructions, upstream and adapter", false)
    .action(async (opts: { dir: string; json: boolean; verbose: boolean }) => {
      try {
        const report = await collectExt(opts.dir);
        process.stdout.write(
          opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderExt(report, opts.verbose),
        );
      } catch (err) {
        _fail(err);
      }
    });

  const modelsCmd = program
    .command("models")
    .description(
      "Per-model price and context limits — Golem's own cached data, never a runtime dependency (R8.8)",
    );
  modelsCmd
    .command("list", { isDefault: true })
    .alias("show")
    .description("Show catalogued models with their price and context window")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--filter <text>", "case-insensitive substring over '<provider> <id>'")
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; filter?: string; json: boolean }) => {
      try {
        const catalog = await loadModelCatalog(opts.dir);
        const { settings } = await loadConfig({ projectDir: opts.dir });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
          return;
        }
        process.stdout.write(
          renderModelCatalog(catalog, {
            nowMs: Date.now(),
            maxAgeDays: settings.models.catalog_max_age_days,
            ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
          }),
        );
      } catch (err) {
        _fail(err);
      }
    });

  modelsCmd
    .command("refresh")
    .description("Fetch `models.catalog_url` once and cache it locally")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--url <url>", "override models.catalog_url for this run")
    .action(async (opts: { dir: string; url?: string }) => {
      try {
        const { settings } = await loadConfig({ projectDir: opts.dir });
        const url = opts.url ?? settings.models.catalog_url;
        const nowIso = new Date().toISOString();
        const fetched = await fetchModelCatalog(url, { nowIso });
        await writeModelCatalog(opts.dir, fetched);
        const merged = mergeCatalogs(BUILTIN_MODEL_CATALOG, fetched);
        process.stdout.write(
          renderRefreshResult({
            url,
            fetched: fetched.entries.length,
            added: merged.entries.length - BUILTIN_MODEL_CATALOG.entries.length,
            builtin: BUILTIN_MODEL_CATALOG.entries.length,
            fetchedAt: nowIso,
          }),
        );
      } catch (err) {
        _fail(err);
      }
    });
}
