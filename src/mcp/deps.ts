/**
 * Injected implementation boundary (frozen interfaces only).
 *
 * Extracted from server.ts (R8.28) so the tool modules can import the deps type
 * without creating a circular dependency on the server itself.
 */

import type { EffectiveCompression } from "../compression/effective-level.js";
import type { LspBridge } from "../ext/index.js";
import type { TargetDispatcher } from "../inference/target-dispatcher.js";
import type {
  CompressionService,
  InferenceService,
  KnowledgeBase,
  SliderLevel,
  WikiReader,
  WikiStore,
} from "../interfaces/index.js";
import type { TelemetryStore } from "../telemetry/index.js";
import type { SliderStore } from "./slider-store.js";
import { InMemorySliderStore } from "./slider-store.js";
import { InMemoryCompressionService } from "./stub-compression.js";

export interface GolemMcpServerDeps {
  readonly compression: CompressionService;
  readonly sliderStore: SliderStore;
  /**
   * §103 — predicts what a slider level will ACTUALLY do on the configured
   * upstream, so `level` reports the running level instead of the requested one.
   * Levels 2–3 collapse to 1 on a prompt-caching upstream (Decision 31), and a
   * reply saying "aggressive" teaches the model a false belief about its own
   * context budget. Injected (not computed here) because the server takes no
   * config dependency; omitted → the tool reports the nominal level as before.
   */
  readonly compressionGate?: (level: SliderLevel) => EffectiveCompression;
  /**
   * WS-C knowledge base (task B3). When present, the P1 knowledge tools
   * (`search`, `fetch`, `ingest`) are registered.
   * Omitted for the P0 stubs and for runs where the KB is disabled.
   */
  readonly knowledge?: KnowledgeBase;
  /**
   * WS-D tiered inference (task B3). When present, the `coder` tool
   * is registered, letting Claude offload a task to a local model (the
   * "drafter" role). Omitted when local inference is unavailable or when
   * `inference.coder_enabled` is false.
   */
  readonly coder?: InferenceService;
  /**
   * WS-D tiered inference used for non-coder local roles: rerank
   * (`knowledge.rerank_enabled`) and the proxy's local-answer semantic embedder.
   * Independent of {@link coder}; may be present even when the coder tool is
   * disabled.
   */
  readonly inference?: InferenceService;
  /** projectId used by knowledge tools when a call omits `project_id`. */
  readonly defaultProjectId?: string;
  /**
   * Absolute project root: what `ingest` indexes when a call omits `path`, and
   * where `snooze` files its `note` as a durable local task (`.golem/tasks/`).
   * Kept separate from {@link defaultProjectId} on purpose: the CLI happens to
   * use the project directory as the project id today, but ids are opaque —
   * only this field is guaranteed to be a filesystem path.
   */
  readonly projectRootDir?: string;
  /**
   * R8.5 — absolute project root the `code` tool maps. The `code` tool is
   * registered only when this is set (`knowledge.repo_map_enabled`), because a
   * tool definition is a permanent per-request bill (§88/§100) and a map of
   * nothing is worth none of it. Independent of {@link knowledge}: the map is
   * built from the filesystem by tree-sitter, not from the vector index.
   */
  readonly codeRoot?: string;
  /**
   * R8.6 — the language-server bridge behind the `code` tool's `diagnostics` /
   * `definition` / `references` / `hover` modes. Present only when
   * `knowledge.lsp_enabled` is on; without it the tool keeps exactly the schema
   * it had for `map` alone, so nobody pays per-request for modes they disabled.
   * Requires {@link codeRoot}: the LSP modes are modes of that tool, not tools.
   */
  readonly lsp?: LspBridge;
  /**
   * R8.7 — offer `coder`'s `edit` mode (`inference.local_editor_enabled`).
   *
   * Same permanent-bill logic as {@link codeRoot} and {@link lsp}: the mode's
   * three schema properties cost +313 definition tokens on every request (§110),
   * so when this is absent `coder`'s definition is byte-identical to R8.6's.
   * Requires {@link projectRootDir} — an edit must be containable to a project.
   */
  readonly localEditor?: boolean;
  /**
   * R9.3 — lets `coder` draft on any declared target, not only the local model.
   *
   * When present, `coder` gains an optional `target` parameter whose enum lists
   * exactly the targets config declares AND marks agent-selectable, and every
   * non-local dispatch is redacted at that target's trust floor before it leaves
   * the machine (placeholders restored in the reply).
   *
   * Absent → `coder` behaves exactly as it did before R9.3: no `target`
   * parameter in the schema at all, so the definition costs nothing extra, and
   * dispatch goes straight to the local {@link coder} service.
   */
  readonly targetDispatcher?: TargetDispatcher;
  /**
   * POSIX-relative wiki location (spec Decision 28), e.g. `"docs/wiki"` —
   * see `wikiSourcePrefix` in `cli/wiki.ts`. When set, `search` ranks hits
   * under it above equal-scoring non-wiki hits, since the wiki is canonical
   * and the vector index is just a derived cache of it.
   */
  readonly wikiDir?: string;
  /**
   * WS-W W2 wiki authoring surface. When present, the `wiki_read` /
   * `wiki_upsert` tools are registered (spec Decisions 28/29). Omitted when
   * the knowledge base — and so the wiki — is disabled. Writes always target
   * this single (project) store, never {@link wikiSearch}.
   */
  readonly wiki?: WikiStore;
  /**
   * R3.4 (spec Decision 20e's local/P1 tier) — the read-only surface `search`/
   * `fetch` query, e.g. a `FederatedWikiReader` merging the project wiki with
   * the user-scope `~/.golem/wiki/`. Defaults to {@link wiki} when omitted, so
   * existing callers that only ever had one wiki need no changes.
   */
  readonly wikiSearch?: WikiReader;
  /**
   * R3.1 (spec Decision 34): opt-in chat-judge rerank of `search` hits via the
   * local "judge" role (`knowledge.rerank_enabled`, default off). Independent
   * of `slider.level` (Decision 31 — the slider never auto-engages the local
   * model). A rerank failure falls back to the pre-rerank order; it never
   * turns a successful search into an error.
   */
  readonly rerank?: InferenceService;
  /**
   * Task `local-models` — the Ollama endpoint the `devices` tool checks for pulled
   * models (`inference.ollama_base_url`). Injected rather than read here because
   * this server takes no config dependency; omitted → localhost is assumed, which
   * is right for every default install and wrong only for a LAN endpoint.
   */
  readonly localEndpoint?: string;
  /**
   * R4.3 — durable telemetry store. When present, the knowledge/coder tools
   * (`search`/`fetch`/`ingest`/`wiki_read`/`coder`) record a per-call `tool`
   * event (duration, result size; for `coder` also model + draft length), and
   * the `stats` tool surfaces a per-tool summary. Omitted for the P0 stubs.
   */
  readonly telemetry?: TelemetryStore;
}

/** In-memory deps for tests and for running standalone before WS-A lands. */
export function createStandaloneDeps(): GolemMcpServerDeps & {
  readonly compression: InMemoryCompressionService;
} {
  return {
    compression: new InMemoryCompressionService(),
    sliderStore: new InMemorySliderStore(),
  };
}
