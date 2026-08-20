/**
 * golem mcp serve — extracted from program.ts (R8.27).
 */

import type { Command } from "commander";
import { resolveEffectiveCompression } from "../../compression/effective-level.js";
import { findProjectDir, type GolemSettings, loadConfig } from "../../config/index.js";
import { DEFAULT_KEY_ENV } from "../../credentials/backends.js";
import { createClaudeCliDrafter } from "../../inference/claude-cli.js";
import {
  createProbeRunner,
  detectCapability,
  OllamaClient,
  OllamaInferenceService,
} from "../../inference/index.js";
import {
  createTargetDispatcher,
  type TargetDispatcher,
  type TargetDispatcherOptions,
} from "../../inference/target-dispatcher.js";
import {
  coerceCompressionLevel,
  type InferenceService,
  type KnowledgeBase,
} from "../../interfaces/index.js";
import {
  perGatewayEnvVar,
  resolveUpstreamDisplay,
  upstreamAssumesCaching,
  withDefaultTarget,
} from "../../providers/index.js";
import { readServedModel } from "../../proxy/served-model.js";
import { openTelemetryStore } from "../../telemetry/index.js";
import { FederatedWikiReader, FileWikiStore } from "../../wiki/index.js";
import { ensureProjectIndexed } from "../auto-index.js";
import { buildKnowledgeStack } from "../build-knowledge.js";
import { credentialEnvForProxy } from "../gateways.js";
import { InitError } from "../init.js";
import { mcpCompressionService } from "../mcp-compression.js";
import { defaultUserWikiDir, resolveWikiDir, wikiSourcePrefix } from "../wiki.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

/**
 * Credential resolution for `coder`'s remote dispatch.
 *
 * Decision 47 hands credentials to a *spawned* process in its environment, which
 * works for the proxy daemon because the CLI spawns it. Claude Code spawns this
 * server from `.mcp.json`, so it inherits none of them — every credentialed
 * target went out with no auth header and came back 401 while `golem target
 * list` truthfully reported the key as stored.
 *
 * Resolution itself is `credentialEnvForProxy`'s, deliberately: it already
 * encodes which store id backs the active account versus a named one, and a
 * second implementation of that mapping would drift silently. What changes is
 * only where the secrets land — this closure, never `process.env`, so nothing
 * this server spawns inherits them. Read lazily and once: a session that never
 * dispatches to a remote target never touches the credential store.
 */
function resolveTargetCredential(
  projectDir: string,
): (accountId: string | null) => Promise<string | undefined> {
  let pending: Promise<Record<string, string>> | undefined;
  return async (accountId) => {
    pending ??= credentialEnvForProxy(projectDir);
    const creds = await pending;
    return creds[accountId === null ? DEFAULT_KEY_ENV : perGatewayEnvVar(accountId)];
  };
}

/**
 * R10.8 — the `coder` target dispatcher, built from loaded settings.
 *
 * **Extracted from the `serveStdio` call literal so the wiring is testable**, and
 * that is not incidental: the bug this closes was invisible precisely because it
 * lived in an inline object. `settings.proxy` satisfies `TargetRegistrySettings`
 * structurally — it carries the DEPRECATED `proxy.default_target` leaf — so
 * passing it where `withDefaultTarget(settings)` was meant type-checks perfectly
 * and silently discards the live `inference.default_target`. Nothing throws;
 * every unrouted dispatch simply goes somewhere else and reports success. R9.23
 * moved the key and consolidated five call sites onto the helper; this one was
 * missed because the dispatcher did not read `default_target` at all until now.
 *
 * `overrides` exists for tests (a fake `fetch`, a stub credential resolver). It
 * is spread LAST but deliberately cannot reach `settings` or `workerTargets` —
 * a test that could substitute those would no longer be testing this wiring.
 */
export function createCoderDispatcher(
  settings: GolemSettings,
  inference: InferenceService,
  projectDir: string,
  overrides: Partial<
    Pick<
      TargetDispatcherOptions,
      "fetchImpl" | "resolveKey" | "spawnDrafter" | "sessionModel" | "audit" | "env"
    >
  > = {},
): TargetDispatcher {
  return createTargetDispatcher({
    inference,
    // R10.9 — where `inference` actually listens. Without this the dispatcher can
    // only guess by provider name, and two Ollama servers on different loopback
    // ports become indistinguishable. Wired from the same setting the service
    // itself is built from, so the two cannot disagree.
    localServiceBaseUrl: settings.inference.ollama_base_url,
    // NOT `settings.proxy` — see above.
    settings: withDefaultTarget(settings),
    workerTargets: settings.inference.worker_targets,
    resolveKey: resolveTargetCredential(projectDir),
    // R9.15: a `claude-cli` target drafts by spawning the user's own Claude
    // Code. Wired here, guarded in the dispatcher.
    spawnDrafter: createClaudeCliDrafter({
      timeoutMs: settings.inference.request_timeout_ms,
    }),
    sessionModel: async () => (await readServedModel(projectDir))?.model,
    audit: (e) => {
      // ADR-0003 invariant 5 — non-secret attribution for every dispatch,
      // including which trust floor applied and which step of the R10.8 chain
      // chose the target.
      process.stderr.write(
        `golem coder: dispatched to ${e.targetId ?? "local"} ` +
          `(${e.provider ?? "local"}, model ${e.model ?? "?"}) ` +
          `[route=${e.route}] — ${e.reason}\n`,
      );
    },
    ...overrides,
  });
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
            // R10.6: `mcp serve` builds an index incidentally, so an embedder
            // decision it makes on the user's behalf has to be stated, not
            // inferred from a rebuild that just happens to take a long time.
            if (stack.notice !== undefined) process.stderr.write(`golem kb: ${stack.notice}\n`);
            void ensureProjectIndexed({
              projectDir: opts.dir,
              projectId: opts.dir,
              knowledge: stack.knowledge,
              embedMode: stack.embedMode,
              embedModel: stack.embedModel,
              tier: stack.facts.tier,
              watchPaths: settings.knowledge.watch_paths,
              // R11.2: this is THE automatic caller — it fires on every session
              // start, so it is the one that must be capped. `golem index` (the
              // explicit ask) passes no cap and syncs whatever is pending.
              maxAutoFiles: settings.knowledge.auto_index_max_files,
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
        const { serveStdio } = await import("../../mcp/index.js");
        const lspBridge =
          settings.knowledge.repo_map_enabled && settings.knowledge.lsp_enabled
            ? await (async () => {
                const { LspBridge } = await import("../../pkg/index.js");
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
          // R11.1: read-only. The `level` tool is gone with the slider
          // (ADR-0004), so nothing on the MCP surface can change how much of the
          // pipeline runs — `stats` only reports it.
          compressionLevel: () => coerceCompressionLevel(settings.compression.level),
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
          ...(inference !== undefined ? { coder: inference } : {}),
          // R9.3: `coder` may draft on any declared target.
          //
          // R10.8: wired whenever there is a local service to fall back to at
          // all, not only when several targets exist. The old
          // `listTargets(...).length > 1` guard was sound while the dispatcher's
          // only job was to offer a CHOICE — with one target there was nothing
          // to choose. Now the dispatcher also decides *where an unrouted draft
          // goes*, and skipping it in the single-target case would restore
          // exactly the implicit-local behaviour this task removes, for the one
          // configuration (a fresh project) where it is most surprising. The
          // §110 schema cost is still avoided: `coder` only grows the `target`
          // parameter when there is more than one selectable target, and that
          // decision now lives in `registerCoderTool` where the schema is built.
          ...(inference !== undefined
            ? { targetDispatcher: createCoderDispatcher(settings, inference, opts.dir) }
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
