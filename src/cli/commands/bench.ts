/**
 * golem bench — extracted from program.ts (R8.27).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { findProjectDir, loadConfig } from "../../config/index.js";
import {
  createProbeRunner,
  detectCapability,
  OllamaClient,
  OllamaInferenceService,
  OllamaNativeClient,
  resolveTierAvailability,
  roleWarning,
} from "../../inference/index.js";
import type { HardwareTier, Role } from "../../interfaces/inference.js";
import {
  benchRepoMap,
  buildRepoMap,
  extractFileFacts,
  hasParseError,
  RETRIEVAL_CASES,
  renderRepoMapBench,
} from "../../knowledge/index.js";
import {
  buildCostBenchmark,
  type ModelCatalog,
  readTelemetryEvents,
  renderCostBenchmark,
} from "../../telemetry/index.js";
import { loadModelCatalog } from "../../telemetry/model-catalog.js";
import {
  ARGUMENT_CASES,
  benchEdits,
  compareCatalogs,
  EDIT_CASES,
  golemToolCensus,
  isEditFormat,
  isExternalMode,
  isSchemaMode,
  renderEditBench,
  renderToolBench,
  resolveCavemanShrink,
  SELECTION_CASES,
  SHRINK_MODES,
  shrinkCatalog,
} from "../../tools/index.js";
import { InitError } from "../init.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

async function _warnLocalRoleAvailability(
  tier: HardwareTier,
  endpoint: string,
  role: Role,
): Promise<void> {
  try {
    const availability = await resolveTierAvailability(tier, {
      endpoint,
      listModels: () =>
        new OllamaNativeClient({ baseUrl: endpoint, requestTimeoutMs: 2500 }).listModels(),
    });
    const warning = roleWarning(availability, role);
    if (warning !== null) process.stderr.write(`golem bench: ${warning}\n`);
  } catch {
    /* best-effort */
  }
}

export default function register(program: Command): void {
  const benchCmd = program.command("bench").description("Golem benchmarks (spec Decision 21f)");

  benchCmd
    .command("cost")
    .description(
      "Cost-governance benchmark: Golem's measured savings vs Claude Code's cost-doc baselines",
    )
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--project <id>", "limit the benchmark to this project id")
    .option("--window <window>", "time window: 24h | 7d | all", "7d")
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; project?: string; window: string; json: boolean }) => {
      try {
        if (opts.window !== "24h" && opts.window !== "7d" && opts.window !== "all")
          throw new InitError(`invalid --window "${opts.window}" (expected 24h | 7d | all)`);
        const window = opts.window as "24h" | "7d" | "all";
        let events: Awaited<ReturnType<typeof readTelemetryEvents>> = [];
        try {
          events = await readTelemetryEvents(opts.dir);
        } catch {
          events = [];
        }
        let claudeMdLines: number | undefined;
        try {
          claudeMdLines = (await readFile(path.join(opts.dir, "CLAUDE.md"), "utf8")).split(
            "\n",
          ).length;
        } catch {
          claudeMdLines = undefined;
        }
        let catalog: ModelCatalog | undefined;
        try {
          catalog = await loadModelCatalog(opts.dir);
        } catch {
          catalog = undefined;
        }
        const report = buildCostBenchmark(events, {
          ...(opts.project !== undefined ? { projectId: opts.project } : {}),
          window,
          nowMs: Date.now(),
          ...(claudeMdLines !== undefined ? { claudeMdLines } : {}),
          ...(catalog !== undefined ? { catalog } : {}),
        });
        process.stdout.write(
          opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderCostBenchmark(report),
        );
      } catch (err) {
        _fail(err);
      }
    });

  benchCmd
    .command("map")
    .description(
      "R8.5 gate: what the repo map costs, and whether it lets the model name the right file WITHOUT reading it",
    )
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--score", "run the retrieval A/B (needs the local model); omit for cost only", false)
    .option("--repeats <n>", "passes over the case set when scoring (default 1)", "1")
    .option("--role <role>", "local role: classifier (default) | drafter | judge", "classifier")
    .option("--budget <n>", "token budget for the rendered map (default 1400)")
    .option("--print", "also print the map itself", false)
    .option("--json", "machine-readable output", false)
    .action(
      async (opts: {
        dir: string;
        score: boolean;
        repeats: string;
        role: string;
        budget?: string;
        print: boolean;
        json: boolean;
      }) => {
        try {
          let budgetTokens: number | undefined;
          if (opts.budget !== undefined) {
            const parsed = Number.parseInt(opts.budget, 10);
            if (!Number.isFinite(parsed) || parsed < 200)
              throw new InitError(`invalid --budget "${opts.budget}" (expected an integer ≥ 200)`);
            budgetTokens = parsed;
          }
          const repeats = Number.parseInt(opts.repeats, 10);
          if (!Number.isFinite(repeats) || repeats < 1)
            throw new InitError(
              `invalid --repeats "${opts.repeats}" (expected a positive integer)`,
            );
          const roles = ["classifier", "drafter", "judge", "summarizer", "extractor"] as const;
          const role = opts.role as (typeof roles)[number];
          if (!roles.includes(role))
            throw new InitError(`invalid --role "${opts.role}" (expected ${roles.join(" | ")})`);
          let inference: OllamaInferenceService | undefined;
          if (opts.score) {
            const { settings } = await loadConfig({ projectDir: opts.dir });
            const client = new OllamaClient({
              baseUrl: settings.inference.ollama_base_url,
              requestTimeoutMs: settings.inference.request_timeout_ms,
            });
            const facts = await detectCapability(createProbeRunner());
            inference = new OllamaInferenceService(client, facts);
            await _warnLocalRoleAvailability(facts.tier, settings.inference.ollama_base_url, role);
          }
          const report = await benchRepoMap({
            root: opts.dir,
            cases: RETRIEVAL_CASES,
            repeats,
            role,
            ...(inference !== undefined ? { inference } : {}),
            ...(budgetTokens !== undefined ? { budgetTokens } : {}),
          });
          process.stdout.write(
            opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderRepoMapBench(report),
          );
          if (opts.print) {
            const map = await buildRepoMap(
              opts.dir,
              budgetTokens !== undefined ? { budgetTokens } : {},
            );
            process.stdout.write(`\n${map.available ? map.text : `No map: ${map.reason}\n`}`);
          }
        } catch (err) {
          _fail(err);
        }
      },
    );

  benchCmd
    .command("edit")
    .description(
      "R8.7 gate: can the LOCAL model turn a ~50-token instruction into an edit Golem's validator accepts?",
    )
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--repeats <n>", "passes over the case set (default 1)", "1")
    .option("--role <role>", "local role: drafter (default) | judge | classifier", "drafter")
    .option("--format <format>", "limit to one format: search-replace | udiff | whole")
    .option("--strict-match", "require byte-exact search text", false)
    .option("--json", "machine-readable output", false)
    .action(
      async (opts: {
        dir: string;
        repeats: string;
        role: string;
        format?: string;
        strictMatch: boolean;
        json: boolean;
      }) => {
        try {
          const repeats = Number.parseInt(opts.repeats, 10);
          if (!Number.isFinite(repeats) || repeats < 1)
            throw new InitError(
              `invalid --repeats "${opts.repeats}" (expected a positive integer)`,
            );
          const roles = ["classifier", "drafter", "judge", "summarizer", "extractor"] as const;
          const role = opts.role as (typeof roles)[number];
          if (!roles.includes(role))
            throw new InitError(`invalid --role "${opts.role}" (expected ${roles.join(" | ")})`);
          if (opts.format !== undefined && !isEditFormat(opts.format))
            throw new InitError(
              `invalid --format "${opts.format}" (expected search-replace | udiff | whole)`,
            );
          const { settings } = await loadConfig({ projectDir: opts.dir });
          const client = new OllamaClient({
            baseUrl: settings.inference.ollama_base_url,
            requestTimeoutMs: settings.inference.request_timeout_ms,
          });
          const facts = await detectCapability(createProbeRunner());
          const inference = new OllamaInferenceService(client, facts);
          await _warnLocalRoleAvailability(facts.tier, settings.inference.ollama_base_url, role);
          const symbolCheck = async (ext: string, content: string): Promise<string[] | null> => {
            const f = await extractFileFacts(ext, content);
            return f === null ? null : f.defs.map((d) => d.name);
          };
          const report = await benchEdits({
            inference,
            cases: EDIT_CASES,
            repeats,
            role,
            matchStrategy: opts.strictMatch ? "exact" : "exact-then-trimmed",
            parseCheck: hasParseError,
            symbolCheck,
            ...(opts.format !== undefined && isEditFormat(opts.format)
              ? { formats: [opts.format] }
              : {}),
          });
          process.stdout.write(
            opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderEditBench(report),
          );
        } catch (err) {
          _fail(err);
        }
      },
    );

  benchCmd
    .command("tools")
    .description("Tools-block token census, and optionally A/B a shrinking transform")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option(
      "--shrink <mode>",
      "candidate transform: whitespace | first-sentence | schema-meta | schema-validation | schema-descriptions | ext-caveman-shrink",
    )
    .option("--shrink-path <file>", "for an ext-* mode: path to the external module")
    .option("--repeats <n>", "passes over the case set (default 1)", "1")
    .option("--role <role>", "local role: classifier (default) | drafter | judge", "classifier")
    .option("--lsp", "count the R8.6 LSP modes", false)
    .option("--editor", "count the R8.7 edit mode", false)
    .option("--json", "machine-readable output", false)
    .action(
      async (opts: {
        dir: string;
        shrink?: string;
        shrinkPath?: string;
        repeats: string;
        role: string;
        lsp: boolean;
        editor: boolean;
        json: boolean;
      }) => {
        try {
          const census = await golemToolCensus({ lsp: opts.lsp, editor: opts.editor });
          if (opts.shrink === undefined) {
            process.stdout.write(
              opts.json ? `${JSON.stringify({ census }, null, 2)}\n` : renderToolBench({ census }),
            );
            return;
          }
          const mode = opts.shrink as (typeof SHRINK_MODES)[number];
          if (!SHRINK_MODES.includes(mode))
            throw new InitError(
              `invalid --shrink "${opts.shrink}" (expected ${SHRINK_MODES.join(" | ")})`,
            );
          const repeats = Number.parseInt(opts.repeats, 10);
          if (!Number.isFinite(repeats) || repeats < 1)
            throw new InitError(
              `invalid --repeats "${opts.repeats}" (expected a positive integer)`,
            );
          const { settings } = await loadConfig({ projectDir: opts.dir });
          const client = new OllamaClient({
            baseUrl: settings.inference.ollama_base_url,
            requestTimeoutMs: settings.inference.request_timeout_ms,
          });
          const facts = await detectCapability(createProbeRunner());
          const inference = new OllamaInferenceService(client, facts);
          const roles = ["classifier", "drafter", "judge", "summarizer", "extractor"] as const;
          const role = opts.role as (typeof roles)[number];
          if (!roles.includes(role))
            throw new InitError(`invalid --role "${opts.role}" (expected ${roles.join(" | ")})`);
          await _warnLocalRoleAvailability(facts.tier, settings.inference.ollama_base_url, role);
          const schemaMode = isSchemaMode(mode);
          let external: ReturnType<typeof resolveCavemanShrink> = null;
          if (isExternalMode(mode)) {
            external = resolveCavemanShrink(
              opts.shrinkPath !== undefined ? { explicitPath: opts.shrinkPath } : undefined,
            );
            if (external === null)
              throw new InitError(
                `--shrink ${mode} needs caveman-shrink installed (it is never vendored): npm i -g caveman-shrink, or pass --shrink-path <file>`,
              );
            process.stderr.write(`golem bench tools: using ${external.resolvedFrom}\n`);
          }
          const result = await compareCatalogs({
            inference,
            baseline: census.tools,
            candidate: shrinkCatalog(
              census.tools,
              mode,
              external !== null ? { externalTransform: external.compress } : undefined,
            ),
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
          process.stdout.write(
            opts.json
              ? `${JSON.stringify({ census, comparison: { mode, cases: SELECTION_CASES.length, role, result } }, null, 2)}\n`
              : renderToolBench({
                  census,
                  comparison: { mode, cases: SELECTION_CASES.length, role, result },
                }),
          );
        } catch (err) {
          _fail(err);
        }
      },
    );
}
