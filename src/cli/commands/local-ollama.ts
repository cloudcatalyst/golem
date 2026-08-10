/**
 * golem local / ollama / coder / index / devices — extracted from program.ts (R8.27).
 */

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { findProjectDir, loadConfig } from "../../config/index.js";
import type { SettingsScope } from "../../config/write-setting.js";
import { embedderSignature, ensureProjectIndexed, writeManifest } from "../auto-index.js";
import { buildKnowledgeStack } from "../build-knowledge.js";
import { collectDevices, devicesJson, renderDevices } from "../devices.js";
import { InitError } from "../init.js";
import {
  collectLocalModel,
  renderLocalCoderWrite,
  renderLocalModel,
  renderLocalUrlWrite,
  setLocalBaseUrl,
  setLocalCoderEnabled,
} from "../local-config.js";
import {
  collectOllamaStatus,
  renderOllamaStatus,
  renderSetupResult,
  runOllamaSetup,
  SetupRefusedError,
} from "../ollama.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

function parseConfigScope(raw: string): SettingsScope {
  if (raw === "user" || raw === "project" || raw === "local") return raw;
  throw new InvalidArgumentError(`invalid scope "${raw}" (expected user, project, or local)`);
}

export default function register(program: Command): void {
  const localCmd = program
    .command("local")
    .description(
      "Configure the LOCAL (or LAN) model backend — the fallback for workers with no target",
    );

  localCmd
    .command("status", { isDefault: true })
    .description(
      "Show the local backend: whether `coder` is on, where the backend lives, and if it answers",
    )
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        const report = await collectLocalModel({ projectDir: opts.dir });
        process.stdout.write(
          opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderLocalModel(report),
        );
      } catch (err) {
        _fail(err);
      }
    });

  for (const state of ["enable", "disable"] as const) {
    localCmd
      .command(state)
      .description(
        state === "enable"
          ? "Enable the local model's coder tool"
          : "Disable the local model's coder tool",
      )
      .option("--dir <path>", "project directory", _DEFAULT_DIR)
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
          _fail(err);
        }
      });
  }

  localCmd
    .command("url")
    .description(
      "Point the local roles at an Ollama endpoint — localhost or another machine on the LAN",
    )
    .argument("<url>", "base URL, e.g. http://localhost:11434 or http://gpubox.lan:11434")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
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
          _fail(err);
        }
      },
    );

  program
    .command("coder")
    .description("Enable, disable, or show the `coder` tool — and which target each worker uses")
    .argument("[state]", "enable | disable | status")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
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
          if (state !== "enable" && state !== "disable")
            throw new InvalidArgumentError(`expected enable, disable, or status; got "${state}"`);
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
          _fail(err);
        }
      },
    );

  program
    .command("index")
    .description("Index a file or directory into the Golem knowledge base (local embeddings)")
    .argument("[path]", "file or directory to ingest (default: project root)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--watch", "keep watching the path for changes", false)
    .option("--json", "machine-readable output", false)
    .action(
      async (pathArg: string | undefined, opts: { dir: string; watch: boolean; json: boolean }) => {
        try {
          const { knowledge, embedMode, facts } = await buildKnowledgeStack({
            projectDir: opts.dir,
          });
          const embedNote =
            embedMode === "semantic"
              ? "semantic (Ollama bge-m3)"
              : "lexical (built-in, no Ollama — pull bge-m3 for semantic)";
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
              return;
            }
            const line =
              result.action === "skipped"
                ? `Index already up to date (${embedNote}) — nothing changed.\n`
                : result.action === "synced"
                  ? `Synced index (${embedNote}): ${result.updated ?? 0} file(s) changed, ${result.removed ?? 0} removed — ${result.chunks} chunk(s) re-embedded.\n`
                  : `${result.action === "reindexed" ? "Re-indexed" : "Indexed"} ${result.chunks} chunks from ${result.files} file(s) using ${embedNote}${result.action === "reindexed" ? " (embedder changed)" : ""}.\n`;
            process.stdout.write(line);
            process.stdout.write(
              "The index is persisted under .golem/knowledge, so `search` finds it in any later session.\n",
            );
            return;
          }
          const target = pathArg ?? opts.dir;
          const report = await knowledge.ingest(target, opts.dir, opts.watch);
          await writeManifest(
            opts.dir,
            opts.dir,
            embedderSignature(embedMode, facts.tier),
            [target],
            new Date().toISOString(),
          );
          if (opts.json) {
            process.stdout.write(`${JSON.stringify({ ...report, embedMode }, null, 2)}\n`);
            return;
          }
          process.stdout.write(
            `Indexed ${report.path}: ${report.chunksIndexed} chunks from ${report.filesSeen} file(s) (${report.filesSkipped} skipped) using ${embedNote}${report.watching ? ", watching for changes" : ""}.\n`,
          );
          if (!report.watching)
            process.stdout.write(
              "The index is persisted under .golem/knowledge, so `search` finds it in any later session.\n",
            );
        } catch (err) {
          _fail(err);
        }
      },
    );

  program
    .command("devices")
    .description(
      "Show detected local hardware tier and, per role, whether that model is actually pulled",
    )
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        const report = await collectDevices({ projectDir: opts.dir });
        process.stdout.write(
          opts.json ? `${JSON.stringify(devicesJson(report), null, 2)}\n` : renderDevices(report),
        );
      } catch (err) {
        _fail(err);
      }
    });

  const ollamaCmd = program
    .command("ollama")
    .description("Manage the local Ollama runtime Golem uses for drafts");
  ollamaCmd
    .command("status")
    .description("Show whether Ollama is installed, reachable, and has this tier's drafter model")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        const report = await collectOllamaStatus({ projectDir: opts.dir });
        process.stdout.write(renderOllamaStatus(report, opts.json));
      } catch (err) {
        _fail(err);
      }
    });

  ollamaCmd
    .command("setup")
    .description("Install Ollama and pull this tier's drafter model (asks for confirmation)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
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
        _fail(err);
      }
    });
}
