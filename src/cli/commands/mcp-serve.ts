/**
 * golem mcp serve — extracted from program.ts (R8.27).
 */

import type { Command } from "commander";
import { resolveEffectiveCompression } from "../../compression/effective-level.js";
import { findProjectDir, loadConfig, settingsFilePaths } from "../../config/index.js";
import {
  createProbeRunner,
  detectCapability,
  OllamaClient,
  OllamaInferenceService,
} from "../../inference/index.js";
import { createTargetDispatcher } from "../../inference/target-dispatcher.js";
import type { InferenceService, KnowledgeBase } from "../../interfaces/index.js";
import {
  listTargets,
  resolveUpstreamDisplay,
  upstreamAssumesCaching,
} from "../../providers/index.js";
import { openTelemetryStore } from "../../telemetry/index.js";
import { FederatedWikiReader, FileWikiStore } from "../../wiki/index.js";
import { ensureProjectIndexed } from "../auto-index.js";
import { buildKnowledgeStack } from "../build-knowledge.js";
import { InitError } from "../init.js";
import { mcpCompressionService } from "../mcp-compression.js";
import { defaultUserWikiDir, resolveWikiDir, wikiSourcePrefix } from "../wiki.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

export default function register(program: Command): void {
  const mcp = program.command("mcp").description("Golem MCP server");
  mcp
    .command("serve")
    .description("Serve the unified Golem MCP server on stdio (used by .mcp.json)")
    .option("--dir <path>", "project directory (for the CCR store)", _DEFAULT_DIR)
    .action(async (opts: { dir: string }) => {
      try {
        const { settings } = await loadConfig({ projectDir: opts.dir });
        let knowledge: KnowledgeBase | undefined;
        let inference: InferenceService | undefined;
        const wiki = settings.knowledge.enabled
          ? new FileWikiStore({ wikiDir: resolveWikiDir(opts.dir, settings.knowledge.wiki_dir) })
          : undefined;
        if (settings.knowledge.enabled) {
          try {
            const stack = await buildKnowledgeStack({ projectDir: opts.dir });
            knowledge = stack.knowledge;
            inference = stack.inference;
            process.stderr.write(
              `golem: knowledge base ready (${stack.embedMode} embeddings${stack.embedMode === "lexical" ? "; pull bge-m3 + run Ollama for semantic" : ""})\n`,
            );
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
              `golem: knowledge base unavailable, serving without it (${err instanceof Error ? err.message : String(err)})\n`,
            );
          }
        }
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
              `golem: local inference unavailable, coder will be disabled (${err instanceof Error ? err.message : String(err)})\n`,
            );
          }
        }
        const telemetry = openTelemetryStore(opts.dir);
        const coderInference =
          settings.inference.local_coder_enabled && inference !== undefined ? inference : undefined;
        if (settings.inference.local_coder_enabled === false) {
          process.stderr.write(
            "golem mcp serve: local coder disabled by inference.local_coder_enabled\n",
          );
        }
        const { JsonFileSliderStore, serveStdio } = await import("../../mcp/index.js");
        const lspBridge =
          settings.knowledge.repo_map_enabled && settings.knowledge.lsp_enabled
            ? await (async () => {
                const { LspBridge } = await import("../../ext/index.js");
                const bridge = new LspBridge({
                  root: opts.dir,
                  requestTimeoutMs: settings.knowledge.lsp_timeout_ms,
                  ...(settings.knowledge.lsp_servers !== undefined
                    ? {
                        servers: settings.knowledge.lsp_servers.map((row) => ({
                          id: row.id,
                          command: row.command,
                          args: row.args,
                          languageId: row.language_id,
                          extensions: row.extensions,
                        })),
                      }
                    : {}),
                });
                process.once("exit", () => bridge.killAll());
                return bridge;
              })()
            : undefined;
        await serveStdio({
          compression: mcpCompressionService(opts.dir, telemetry),
          telemetry,
          sliderStore: new JsonFileSliderStore(settingsFilePaths({ projectDir: opts.dir }).local),
          compressionGate: (level) => {
            const up = resolveUpstreamDisplay(settings.proxy);
            const assumeCaching = upstreamAssumesCaching(up.provider);
            return resolveEffectiveCompression({
              level,
              upstreamBaseUrl: up.baseUrl,
              ...(assumeCaching !== undefined && { assumeCachingUpstream: assumeCaching }),
              headroomSidecar: settings.compression.headroom_sidecar,
              forceSemanticOnCaching: settings.compression.force_semantic_on_caching,
            });
          },
          projectRootDir: opts.dir,
          localEndpoint: settings.inference.ollama_base_url,
          ...(knowledge !== undefined
            ? {
                knowledge,
                defaultProjectId: opts.dir,
                wikiDir: wikiSourcePrefix(
                  opts.dir,
                  resolveWikiDir(opts.dir, settings.knowledge.wiki_dir),
                ),
              }
            : {}),
          ...(inference !== undefined ? { inference } : {}),
          ...(coderInference !== undefined ? { coder: coderInference } : {}),
          // R9.3: `coder` may draft on any declared target. Only wired when
          // there is more than the synthetic default to choose from — with one
          // target the `target` parameter would be a schema cost with no choice
          // behind it, and `coder`'s definition bills on every request (§110).
          ...(coderInference !== undefined && listTargets(settings.proxy).length > 1
            ? {
                targetDispatcher: createTargetDispatcher({
                  inference: coderInference,
                  settings: settings.proxy,
                  ...(settings.inference.coder_target !== undefined
                    ? { defaultTargetId: settings.inference.coder_target }
                    : {}),
                  audit: (e) => {
                    // ADR-0003 invariant 5 — non-secret attribution for every
                    // dispatch, including which trust floor applied.
                    process.stderr.write(
                      `golem coder: dispatched to ${e.targetId ?? "local"} ` +
                        `(${e.provider ?? "local"}, model ${e.model ?? "?"}) — ${e.reason}\n`,
                    );
                  },
                }),
              }
            : {}),
          ...(settings.inference.local_editor_enabled ? { localEditor: true } : {}),
          ...(settings.knowledge.repo_map_enabled ? { codeRoot: opts.dir } : {}),
          ...(lspBridge !== undefined ? { lsp: lspBridge } : {}),
          ...(inference !== undefined && settings.knowledge.rerank_enabled
            ? { rerank: inference }
            : {}),
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
        _fail(err);
      }
    });
}
