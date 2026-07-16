/**
 * Unified Golem MCP server (WS-B task B1).
 *
 * Tool names (IMPLEMENTATION_PLAN §2.5; short-verb names per Decision 27 —
 * do not rename again without a new Decisions Log entry):
 * - P0 tools: `expand`, `stats`, `level` (formerly `golem_expand`,
 *   `golem_stats`, `golem_set_slider`). `devices` (formerly `golem_devices`)
 *   is registered unconditionally alongside them — it needs no injected
 *   service, just the always-available hardware-probe functions.
 * - P1 knowledge tools (task B3): `search`, `fetch`, `ingest` (formerly
 *   `golem_search`, `golem_get_chunk`, `golem_index_path`) — registered only
 *   when a KnowledgeBase is injected (`deps.knowledge`). `coder`
 *   (formerly `golem_delegate`, then `delegate` — Decision 35) is registered
 *   only when an InferenceService is injected (`deps.inference`).
 * - Prompts: `slider`, `index`, `search`, `stats`, `expand`, `bypass`,
 *   `devices`, `coder` — surfaced by Claude Code as `/mcp__golem__<name>`
 *   (verification-notes.md §10). Prompt names are unchanged; a tool and a
 *   prompt sharing a name (e.g. tool `search` + prompt `search`) is fine —
 *   MCP tools and prompts are separate namespaces.
 *
 * Tool inputs are zod-validated at the boundary: the zod schemas below are
 * enforced by the SDK, which maps failures to InvalidParams (-32602) MCP tool
 * errors — surfaced as `isError: true` results embedding the code, per SDK
 * 1.29.0 behavior (verification-notes.md §18); prompt-argument validation
 * failures reject at the protocol level. Business failures (e.g. unknown CCR
 * ref) are returned as `isError: true` tool results so the model can react.
 *
 * Implementations are injected via {@link GolemMcpServerDeps} — WS-A wires the
 * real CompressionService in later; `createStandaloneDeps()` provides the
 * in-memory stubs used by tests and standalone runs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createProbeRunner, detectCapability, modelsForTier } from "../inference/index.js";
import type {
  CompressionService,
  HardwareTier,
  Hit,
  InferenceService,
  KnowledgeBase,
  SliderLevel,
  WikiPage,
  WikiPageType,
  WikiReader,
  WikiStore,
} from "../interfaces/index.js";
import {
  migrateSliderLevel,
  UnknownChunkError,
  UnknownRefError,
  UnknownWikiPageError,
  WikiWriteConflictError,
} from "../interfaces/index.js";
import { isMemoryChunkId } from "../knowledge/knowledge-base.js";
import { rerankHits } from "../knowledge/rerank.js";
import { recordToolCall, type TelemetryStore, type ToolUsageStats } from "../telemetry/index.js";
import { extractWikilinks } from "../wiki/frontmatter.js";
import { refineDraft } from "./coder-refine.js";
import type { SliderStore } from "./slider-store.js";
import { InMemorySliderStore } from "./slider-store.js";
import { InMemoryCompressionService } from "./stub-compression.js";

export const GOLEM_MCP_SERVER_NAME = "golem";
export const GOLEM_MCP_SERVER_VERSION = "0.1.0";

/** Injected implementation boundary (frozen interfaces only). */
export interface GolemMcpServerDeps {
  readonly compression: CompressionService;
  readonly sliderStore: SliderStore;
  /**
   * WS-C knowledge base (task B3). When present, the P1 knowledge tools
   * (`search`, `fetch`, `ingest`) are registered.
   * Omitted for the P0 stubs and for runs where the KB is disabled.
   */
  readonly knowledge?: KnowledgeBase;
  /**
   * WS-D tiered inference (task B3). When present, the `coder` tool
   * is registered, letting Claude offload a task to a local model (the
   * "drafter" role). Omitted when local inference is unavailable or disabled.
   */
  readonly inference?: InferenceService;
  /** projectId used by knowledge tools when a call omits `project_id`. */
  readonly defaultProjectId?: string;
  /**
   * Absolute project root the `ingest` tool indexes when a call omits `path`.
   * Kept separate from {@link defaultProjectId} on purpose: the CLI happens to
   * use the project directory as the project id today, but ids are opaque —
   * only this field is guaranteed to be a filesystem path.
   */
  readonly projectRootDir?: string;
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

const LEVEL_NAMES: Readonly<Record<SliderLevel, string>> = {
  0: "passthrough",
  1: "lossless",
  2: "balanced",
  3: "aggressive",
};

const sliderLevelInput = z
  .number()
  .int()
  .min(0)
  .max(5)
  .describe(
    "Slider level 0–3: 0 passthrough (no redaction — full bypass), 1 lossless, " +
      "2 balanced, 3 aggressive. Legacy 4/5 are accepted and mapped to 3.",
  );

function asSliderLevel(level: number): SliderLevel {
  // Accept a legacy 0–5 value at the boundary and remap onto the 0–3 scale.
  return migrateSliderLevel(level);
}

function textResult(text: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): {
  isError: true;
  content: [{ type: "text"; text: string }];
} {
  return { isError: true, content: [{ type: "text", text }] };
}

/** One user-role text message — the shape every Golem prompt returns. */
function promptMessages(text: string): {
  messages: [{ role: "user"; content: { type: "text"; text: string } }];
} {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

const P1_TOOL_FALLBACK =
  "If that tool is not available in this session, tell the user this Golem capability has not shipped or is not enabled yet, and suggest checking `golem status`.";

/** R4.3 — snake_case tool_usage map for the `stats` tool, or undefined if nothing was recorded. */
function toolUsageToStructured(
  usage: ToolUsageStats | undefined,
): Record<string, Record<string, number>> | undefined {
  if (usage === undefined) return undefined;
  const entries = Object.entries(usage.byTool);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([tool, u]) => [
      tool,
      {
        calls: u.calls,
        total_duration_ms: u.totalDurationMs,
        total_result_bytes: u.totalResultBytes,
        draft_chars: u.draftChars,
      },
    ]),
  );
}

/** R4.3 — a one-line tool-usage summary appended to the `stats` text (empty when none). */
function toolUsageSummaryLine(usage: ToolUsageStats | undefined): string {
  if (usage === undefined) return "";
  const entries = Object.entries(usage.byTool);
  if (entries.length === 0) return "";
  const calls = entries.reduce((n, [, u]) => n + u.calls, 0);
  const draftChars = entries.reduce((n, [, u]) => n + u.draftChars, 0);
  const parts = entries.map(([tool, u]) => `${tool}×${u.calls}`).join(", ");
  const drafted = draftChars > 0 ? ` ~${Math.round(draftChars / 4)} tokens drafted locally.` : "";
  return ` Local tools: ${calls} call(s) (${parts}).${drafted}`;
}

/** Build the unified MCP server: P0 tools + all 8 frozen prompts. */
export function createGolemMcpServer(deps: GolemMcpServerDeps): McpServer {
  const server = new McpServer({
    name: GOLEM_MCP_SERVER_NAME,
    version: GOLEM_MCP_SERVER_VERSION,
  });

  registerTools(server, deps);
  registerPrompts(server);
  return server;
}

function registerTools(server: McpServer, deps: GolemMcpServerDeps): void {
  server.registerTool(
    "expand",
    {
      title: "Expand a Golem CCR reference",
      description:
        "Retrieve the original, uncompressed content behind a Golem CCR " +
        "(compress-cache-retrieve) reference marker such as " +
        "`[golem:ccr ref=abc123 ...]`. Use when compressed context is not " +
        "detailed enough and the full original is needed.",
      inputSchema: {
        ref_id: z.string().min(1).describe("The CCR ref id from the marker, e.g. `abc123`"),
        content_type: z
          .string()
          .optional()
          .describe("MIME content type from the marker, if present (default text/plain)"),
      },
    },
    async ({ ref_id, content_type }) => {
      try {
        const original = await deps.compression.retrieve({
          refId: ref_id,
          contentType: content_type ?? "text/plain",
          originalTokens: 0,
        });
        return textResult(original.content);
      } catch (error) {
        if (error instanceof UnknownRefError) {
          return errorResult(
            `Unknown or expired CCR ref "${ref_id}". The original content is no ` +
              "longer in the Golem store; re-run the tool that produced it if the " +
              "full output is still needed.",
          );
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "stats",
    {
      title: "Golem savings statistics",
      description:
        "Report Golem's cumulative token-savings statistics (tokens before/after " +
        "compression, per-stage attribution, CCR store activity) plus the current " +
        "slider level. Optionally scoped to one project.",
      inputSchema: {
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe("Limit stats to this project id; omit for global stats"),
      },
      outputSchema: {
        project_id: z.string().nullable(),
        slider_level: z.number().int().min(0).max(3),
        slider_level_name: z.string(),
        requests: z.number().int().nonnegative(),
        tokens_before: z.number().int().nonnegative(),
        tokens_after: z.number().int().nonnegative(),
        tokens_saved: z.number().int(),
        per_stage: z.record(
          z.object({
            tokens_before: z.number().int().nonnegative(),
            tokens_after: z.number().int().nonnegative(),
          }),
        ),
        ccr_refs_stored: z.number().int().nonnegative(),
        ccr_refs_retrieved: z.number().int().nonnegative(),
        // R4.3: per-tool local-tool usage; present only when telemetry recorded any.
        tool_usage: z
          .record(
            z.object({
              calls: z.number().int().nonnegative(),
              total_duration_ms: z.number().int().nonnegative(),
              total_result_bytes: z.number().int().nonnegative(),
              draft_chars: z.number().int().nonnegative(),
            }),
          )
          .optional(),
      },
    },
    async ({ project_id }) => {
      const [stats, level, toolUsage] = await Promise.all([
        project_id === undefined ? deps.compression.stats() : deps.compression.stats(project_id),
        deps.sliderStore.get(),
        deps.telemetry?.aggregateToolUsage(project_id),
      ]);
      const tokensSaved = stats.tokensBefore - stats.tokensAfter;
      const toolUsageStructured = toolUsageToStructured(toolUsage);
      const structuredContent = {
        project_id: stats.projectId,
        slider_level: level,
        slider_level_name: LEVEL_NAMES[level],
        requests: stats.requests,
        tokens_before: stats.tokensBefore,
        tokens_after: stats.tokensAfter,
        tokens_saved: tokensSaved,
        per_stage: Object.fromEntries(
          Object.entries(stats.perStage).map(([stage, delta]) => [
            stage,
            { tokens_before: delta.tokensBefore, tokens_after: delta.tokensAfter },
          ]),
        ),
        ccr_refs_stored: stats.ccrRefsStored,
        ccr_refs_retrieved: stats.ccrRefsRetrieved,
        ...(toolUsageStructured !== undefined ? { tool_usage: toolUsageStructured } : {}),
      };
      const scope = stats.projectId === null ? "all projects" : `project ${stats.projectId}`;
      return {
        content: [
          {
            type: "text",
            text:
              `Golem stats (${scope}): slider level ${level} (${LEVEL_NAMES[level]}), ` +
              `${stats.requests} requests, ${tokensSaved} tokens saved ` +
              `(${stats.tokensBefore} before → ${stats.tokensAfter} after), ` +
              `${stats.ccrRefsStored} CCR refs stored / ${stats.ccrRefsRetrieved} retrieved.` +
              toolUsageSummaryLine(toolUsage),
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "level",
    {
      title: "Set the Golem savings slider",
      description:
        "Set Golem's global quality/savings slider (0–3). 0 = passthrough (FULL " +
        "BYPASS — NO redaction; secrets reach the upstream raw), 1 = lossless (redaction " +
        "+ byte-faithful compression), 2 = balanced (adds lossy semantic stages), " +
        "3 = aggressive (adds local drafts + local-first answers). The level " +
        "persists across sessions.",
      inputSchema: { level: sliderLevelInput },
      outputSchema: {
        slider_level: z.number().int().min(0).max(3),
        slider_level_name: z.string(),
      },
    },
    async ({ level }) => {
      const sliderLevel = asSliderLevel(level);
      await deps.sliderStore.set(sliderLevel);
      const warning =
        sliderLevel === 0
          ? " ⚠ Level 0 is a full bypass: redaction is OFF, so secrets/PII reach" +
            " the upstream unredacted. Use level 1 to keep redaction on."
          : "";
      return {
        content: [
          {
            type: "text",
            text: `Golem slider set to level ${sliderLevel} (${LEVEL_NAMES[sliderLevel]}).${warning}`,
          },
        ],
        structuredContent: {
          slider_level: sliderLevel,
          slider_level_name: LEVEL_NAMES[sliderLevel],
        },
      };
    },
  );

  registerDevicesTool(server);

  // R4.3 — where the knowledge/coder tools record their per-call telemetry.
  const tel: ToolTelemetry | undefined =
    deps.telemetry !== undefined
      ? { store: deps.telemetry, projectId: deps.defaultProjectId ?? "default" }
      : undefined;

  if (deps.knowledge !== undefined) {
    registerKnowledgeTools(
      server,
      deps.knowledge,
      deps.defaultProjectId ?? "default",
      deps.wikiDir,
      // Historical fallback: the CLI has always wired the project dir as the
      // project id, so it doubles as the ingest root when none is given.
      deps.projectRootDir ?? deps.defaultProjectId,
      deps.wikiSearch ?? deps.wiki,
      deps.rerank,
      tel,
    );
  }

  if (deps.inference !== undefined) {
    registerCoderTool(
      server,
      deps.inference,
      {
        knowledge: deps.knowledge,
        wiki: deps.wikiSearch ?? deps.wiki,
        wikiDir: deps.wikiDir,
        rerank: deps.rerank,
        defaultProjectId: deps.defaultProjectId ?? "default",
      },
      tel,
    );
  }

  if (deps.wiki !== undefined) {
    registerWikiTools(server, deps.wiki, tel);
  }
}

/** Longest chunk preview echoed in a search result's text/summary. */
const CHUNK_PREVIEW_CHARS = 240;

/**
 * Map a knowledge-backend failure to a user-facing message, or null to rethrow.
 * The KB embed path can fail when local inference is down or a model is not
 * pulled — surface that as an actionable `isError` result, not a crash. Matched
 * by error `name` so this file stays decoupled from WS-C/WS-D concrete classes.
 */
const INFERENCE_TIMEOUT_MESSAGE =
  "The local model timed out — it was reachable but too slow to finish in time " +
  "(cold-loading, or the hardware is slow for this request). This is NOT a missing " +
  "model. Raise `inference.request_timeout_ms` (env GOLEM_INFERENCE_REQUEST_TIMEOUT_MS), " +
  "or do the task directly instead of delegating it.";

/** True when this error (or the error it wraps) is a local-inference timeout. */
function isTimeout(err: Error): boolean {
  return (
    err.name === "InferenceTimeoutError" ||
    (err.cause as Error | undefined)?.name === "InferenceTimeoutError"
  );
}

function backendUnavailableMessage(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  // A timeout can surface directly or wrapped in CapabilityUnavailableError —
  // never let it read as "no model at this tier" (verification-notes §66).
  if (isTimeout(err)) return INFERENCE_TIMEOUT_MESSAGE;
  switch (err.name) {
    case "InferenceEndpointError":
      return (
        "Golem's local inference endpoint (Ollama) is unreachable, so the " +
        "knowledge base cannot embed. Start Ollama and ensure the embedding model " +
        "is pulled (see `golem devices`), then retry."
      );
    case "ModelNotAvailableError":
      return `A local model the knowledge base needs is not installed: ${err.message}`;
    case "NotImplementedYetError":
      return (
        "Golem's knowledge base has no embedding backend available in this run " +
        "(local inference required). Check `golem devices` and that Ollama is running."
      );
    case "CapabilityUnavailableError": {
      const detail = err.cause instanceof Error ? ` Last attempt failed: ${err.cause.message}` : "";
      return (
        "Golem has no local model available for this task at the current hardware " +
        "tier. Check `golem devices` for what's detected, or ask Claude to do this " +
        `task directly instead of delegating it.${detail}`
      );
    }
    default:
      return null;
  }
}

/** One structured search hit (optional geometry omitted when absent). */
function toStructuredHit(hit: Hit): Record<string, unknown> {
  const c = hit.chunk;
  const preview =
    c.text.length > CHUNK_PREVIEW_CHARS ? `${c.text.slice(0, CHUNK_PREVIEW_CHARS)}…` : c.text;
  return {
    chunk_id: c.chunkId,
    score: hit.score,
    scope: hit.scope,
    text_preview: preview,
    ...(c.sourcePath !== undefined ? { source_path: c.sourcePath } : {}),
    ...(c.startLine !== undefined ? { start_line: c.startLine } : {}),
    ...(c.endLine !== undefined ? { end_line: c.endLine } : {}),
  };
}

/** Multiplicative rank boost for hits under the wiki (spec Decision 28). */
const WIKI_RANK_BOOST = 1.25;

function isUnderWikiDir(sourcePath: string | undefined, wikiDir: string): boolean {
  return (
    sourcePath !== undefined && (sourcePath === wikiDir || sourcePath.startsWith(`${wikiDir}/`))
  );
}

/**
 * Re-rank hits so wiki pages surface above equal-scoring non-wiki hits — the
 * wiki is canonical and the vector index is a derived cache of it (Decision
 * 28). A no-op (stable, original order) when `wikiDir` is undefined or no hit
 * falls under it.
 */
export function boostWikiHits(hits: readonly Hit[], wikiDir: string | undefined): Hit[] {
  if (wikiDir === undefined) return [...hits];
  return hits
    .map((hit, index) => ({
      hit,
      index,
      key: (isUnderWikiDir(hit.chunk.sourcePath, wikiDir) ? WIKI_RANK_BOOST : 1) * hit.score,
    }))
    .sort((a, b) => b.key - a.key || a.index - b.index)
    .map((entry) => entry.hit);
}

/**
 * Score assigned to a graph-first wiki hit, before `boostWikiHits` applies
 * its own multiplier on top. Vector hits score at most 1 pre-boost (cosine
 * similarity), so both tiers here clear `1 * WIKI_RANK_BOOST` — an exact
 * title match (the query names a page) ranks above a 1-hop neighbor found
 * only via that page's outgoing wikilinks.
 */
const GRAPH_TITLE_MATCH_SCORE = 2;
const GRAPH_LINKED_PAGE_SCORE = 1.6;

function normalizeTitleKey(title: string): string {
  return title.trim().toLowerCase();
}

/** Inverse of the `chunkId` a graph-first hit's synthetic chunk carries. */
function wikiChunkRelPath(chunkId: string): string | undefined {
  return chunkId.startsWith("wiki:") ? chunkId.slice("wiki:".length) : undefined;
}

/**
 * Build a synthetic search Hit for a wiki page. `sourcePath` mirrors the
 * convention vector-ingested wiki chunks use (`${wikiDir}/${relPath}`), so
 * `boostWikiHits` and de-duplication against real vector hits both work
 * unmodified.
 */
export function pageToHit(page: WikiPage, wikiDir: string, projectId: string, score: number): Hit {
  return {
    chunk: {
      chunkId: `wiki:${page.relPath}`,
      projectId,
      text: page.body,
      sourcePath: `${wikiDir}/${page.relPath}`,
      metadata: { kind: "wiki", title: page.frontmatter.title },
    },
    score,
    scope: "knowledge",
  };
}

/**
 * Graph-first lookup (spec Decision 28 §2, proposal `wiki-knowledge-pivot.md`):
 * before vector search, try an exact/case-insensitive title match against the
 * wiki, then expand one hop along that page's outgoing wikilinks. Cheap and
 * precise — no embedding call — and purely additive: vector search always
 * still runs, so free-text queries that don't name a page keep working.
 * `listPages()` is called once per invocation, not memoized across calls.
 */
export async function graphFirstWikiHits(
  query: string,
  wiki: WikiReader,
  wikiDir: string,
  projectId: string,
): Promise<Hit[]> {
  const pages = await wiki.listPages();
  if (pages.length === 0) return [];
  const byTitle = new Map<string, WikiPage>();
  for (const page of pages) byTitle.set(normalizeTitleKey(page.frontmatter.title), page);

  const matched = byTitle.get(normalizeTitleKey(query));
  if (matched === undefined) return [];

  const hits = [pageToHit(matched, wikiDir, projectId, GRAPH_TITLE_MATCH_SCORE)];
  const seen = new Set([matched.relPath]);
  for (const linkedTitle of extractWikilinks(matched.body)) {
    const linked = byTitle.get(normalizeTitleKey(linkedTitle));
    if (linked === undefined || seen.has(linked.relPath)) continue;
    seen.add(linked.relPath);
    hits.push(pageToHit(linked, wikiDir, projectId, GRAPH_LINKED_PAGE_SCORE));
  }
  return hits;
}

/**
 * The read surfaces `search` (and R4.2's coder grounding) query, bundled so
 * both paths assemble hits identically. `wiki`/`wikiDir`/`rerank` are optional;
 * only `knowledge` is required.
 */
interface HitAssemblyDeps {
  readonly knowledge: KnowledgeBase;
  readonly wiki?: WikiReader | undefined;
  readonly wikiDir?: string | undefined;
  readonly rerank?: InferenceService | undefined;
}

/**
 * The one place hit assembly lives: graph-first wiki lookup → vector search
 * (de-duped against the graph hits) → wiki-rank boost → optional chat-judge
 * rerank. Extracted so `search` and coder grounding compose it rather than
 * duplicating the pipeline (R4.2).
 */
async function assembleHits(
  query: string,
  projectId: string,
  limit: number,
  deps: HitAssemblyDeps,
): Promise<Hit[]> {
  const graphHits =
    deps.wiki !== undefined && deps.wikiDir !== undefined
      ? await graphFirstWikiHits(query, deps.wiki, deps.wikiDir, projectId)
      : [];
  const graphSourcePaths = new Set(graphHits.map((h) => h.chunk.sourcePath));
  const vectorHits = (await deps.knowledge.search(query, projectId, limit)).filter(
    (h) => h.chunk.sourcePath === undefined || !graphSourcePaths.has(h.chunk.sourcePath),
  );
  const boosted = boostWikiHits([...graphHits, ...vectorHits], deps.wikiDir).slice(0, limit);
  return deps.rerank !== undefined ? await rerankHits(deps.rerank, query, boosted) : boosted;
}

/** R4.2 grounding budget — the drafter models are small; keep the injected block modest. */
const GROUNDING_MAX_HITS = 4;
const GROUNDING_CHAR_BUDGET = 4000;
const GROUNDING_PER_HIT_CHARS = 1200;

interface Grounding {
  /** Labeled context block to append to the drafter prompt. */
  readonly block: string;
  /** Source labels injected, echoed in the tool's structured output. */
  readonly sources: string[];
  /** Total characters of injected context. */
  readonly chars: number;
}

/** A hit's human-readable location label (`path:line`, or the chunk id). */
function hitLabel(hit: Hit): string {
  const { sourcePath, startLine, chunkId } = hit.chunk;
  if (sourcePath === undefined) return chunkId;
  return startLine !== undefined ? `${sourcePath}:${startLine}` : sourcePath;
}

/**
 * R4.2 — retrieval-augmented drafting. Run the same {@link assembleHits} path
 * `search` uses over the task text and pack the top hits into a size-capped,
 * clearly-labeled context block for the local drafter. Returns null when there
 * is nothing to inject or on ANY failure: grounding is best-effort and must
 * never turn a draft into an error (degrades to the ungrounded behavior).
 */
async function gatherGrounding(
  query: string,
  projectId: string,
  deps: HitAssemblyDeps,
): Promise<Grounding | null> {
  try {
    const hits = await assembleHits(query, projectId, GROUNDING_MAX_HITS, deps);
    if (hits.length === 0) return null;
    const parts: string[] = [];
    const sources: string[] = [];
    let budget = GROUNDING_CHAR_BUDGET;
    for (const hit of hits) {
      if (budget <= 0) break;
      const label = hitLabel(hit);
      const snippet = hit.chunk.text.slice(0, Math.min(GROUNDING_PER_HIT_CHARS, budget));
      if (snippet === "") continue;
      parts.push(`// ${label}\n${snippet}`);
      sources.push(label);
      budget -= snippet.length;
    }
    if (parts.length === 0) return null;
    const block =
      "---\nRelevant project context, retrieved locally from Golem's knowledge base. " +
      "It may be incomplete or stale — verify against the real files before relying on it:\n\n" +
      parts.join("\n\n");
    return { block, sources, chars: block.length };
  } catch {
    return null; // best-effort: never fail a draft because grounding failed
  }
}

/** R4.3 — where a tool records its per-call telemetry, and under which project. */
interface ToolTelemetry {
  readonly store: TelemetryStore;
  readonly projectId: string;
}

/**
 * R4.3 — record a `tool` telemetry event for `result` and return it unchanged,
 * so a handler can `return instrumented(tel, "search", startMs, <result>)` at
 * any of its return sites. Measures wall-clock duration and structured-result
 * size; for `coder` it also captures the model and the drafted-locally char
 * count (the "drafted-locally" bucket). Fire-and-forget: a telemetry write
 * never delays or fails the tool result. No-op when `tel` is undefined.
 */
function instrumented<
  R extends {
    readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
    readonly structuredContent?: Record<string, unknown>;
  },
>(tel: ToolTelemetry | undefined, toolName: string, startMs: number, result: R): R {
  if (tel !== undefined) {
    const sc = result.structuredContent;
    const isCoder = toolName === "coder";
    void recordToolCall(
      tel.store,
      {
        projectId: tel.projectId,
        tool: toolName,
        durationMs: Date.now() - startMs,
        resultBytes: sc !== undefined ? JSON.stringify(sc).length : 0,
        ...(isCoder && sc !== undefined && typeof sc.model === "string" ? { model: sc.model } : {}),
        ...(isCoder && sc !== undefined && typeof sc.text === "string"
          ? { draftChars: sc.text.length }
          : {}),
      },
      new Date().toISOString(),
    ).catch(() => {});
  }
  return result;
}

/** Register the P1 knowledge tools (task B3) against an injected KnowledgeBase. */
function registerKnowledgeTools(
  server: McpServer,
  knowledge: KnowledgeBase,
  defaultProjectId: string,
  wikiDir?: string,
  projectRootDir?: string,
  wiki?: WikiReader,
  rerank?: InferenceService,
  tel?: ToolTelemetry,
): void {
  server.registerTool(
    "search",
    {
      title: "Search the Golem knowledge base",
      description:
        "Semantic search over Golem's local vector knowledge base (indexed code, " +
        "docs, and notes). Returns the most relevant chunks with a preview and a " +
        "`chunk_id`; call fetch for a chunk's full text. Runs entirely " +
        "on local embeddings — nothing leaves the machine.",
      inputSchema: {
        query: z.string().min(1).describe("What to search for"),
        k: z.number().int().min(1).max(50).optional().describe("Max hits to return (default 8)"),
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe("Project to search; omit to use this session's project"),
      },
      outputSchema: {
        project_id: z.string(),
        query: z.string(),
        count: z.number().int().nonnegative(),
        hits: z.array(
          z.object({
            chunk_id: z.string(),
            score: z.number(),
            scope: z.string(),
            text_preview: z.string(),
            source_path: z.string().optional(),
            start_line: z.number().int().optional(),
            end_line: z.number().int().optional(),
          }),
        ),
      },
    },
    async ({ query, k, project_id }) => {
      const startMs = Date.now();
      const projectId = project_id ?? defaultProjectId;
      const limit = k ?? 8;
      try {
        const hits = await assembleHits(query, projectId, limit, {
          knowledge,
          wiki,
          wikiDir,
          rerank,
        });
        const structuredHits = hits.map(toStructuredHit);
        const summary =
          hits.length === 0
            ? `**Golem** Found no knowledge-base hits for "${query}" in project ${projectId}.`
            : `**Golem** Found ${hits.length} hit(s) for "${query}":\n` +
              hits
                .map((h, i) => {
                  const loc = h.chunk.sourcePath
                    ? `${h.chunk.sourcePath}${h.chunk.startLine ? `:${h.chunk.startLine}` : ""}`
                    : h.chunk.chunkId;
                  return `${i + 1}. [${h.score.toFixed(3)}] ${loc} (chunk ${h.chunk.chunkId})`;
                })
                .join("\n");
        return instrumented(tel, "search", startMs, {
          content: [{ type: "text", text: summary }],
          structuredContent: {
            project_id: projectId,
            query,
            count: hits.length,
            hits: structuredHits,
          },
        });
      } catch (err) {
        const msg = backendUnavailableMessage(err);
        if (msg !== null) return errorResult(msg);
        throw err;
      }
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Get a Golem knowledge chunk",
      description:
        "Retrieve the full text (and source location) of a single knowledge-base " +
        "chunk by its `chunk_id`, as returned by search.",
      inputSchema: {
        chunk_id: z.string().min(1).describe("The chunk id from a search hit"),
      },
      outputSchema: {
        chunk_id: z.string(),
        project_id: z.string(),
        text: z.string(),
        source_path: z.string().optional(),
        start_line: z.number().int().optional(),
        end_line: z.number().int().optional(),
      },
    },
    async ({ chunk_id }) => {
      const startMs = Date.now();
      // Graph-first search hits carry a synthetic `wiki:<relPath>` chunk id
      // (they were never ingested into the vector store), so fetch must
      // resolve those straight from the wiki rather than knowledge.getChunk.
      // Memory-scope hits carry a synthetic `memory:<id>` chunk id too (R3.6) —
      // Headroom's verified Memory API has no point-lookup-by-id (only
      // search/save/clear/delete), so there is no store to fetch a fresh copy
      // from. The hit's text_preview already holds up to CHUNK_PREVIEW_CHARS of
      // the fact; re-run search for more.
      if (isMemoryChunkId(chunk_id)) {
        return errorResult(
          `Memory-scope hit "${chunk_id}" cannot be fetched individually — Headroom's ` +
            "memory API supports search only, not lookup by id. Its preview from search " +
            `already contains up to ${CHUNK_PREVIEW_CHARS} characters; re-run search with a ` +
            "narrower query for more context.",
        );
      }
      const wikiRelPath = wikiChunkRelPath(chunk_id);
      if (wikiRelPath !== undefined && wiki !== undefined && wikiDir !== undefined) {
        try {
          const chunk = pageToHit(
            await wiki.readPage(wikiRelPath),
            wikiDir,
            defaultProjectId,
            0,
          ).chunk;
          return instrumented(tel, "fetch", startMs, {
            content: [{ type: "text", text: chunk.text }],
            structuredContent: {
              chunk_id: chunk.chunkId,
              project_id: chunk.projectId,
              text: chunk.text,
              ...(chunk.sourcePath !== undefined ? { source_path: chunk.sourcePath } : {}),
            },
          });
        } catch (err) {
          if (err instanceof UnknownWikiPageError) {
            return errorResult(
              `Unknown chunk "${chunk_id}". It may have been re-indexed or evicted; ` +
                "re-run search to get current chunk ids.",
            );
          }
          throw err;
        }
      }
      try {
        const chunk = await knowledge.getChunk(chunk_id);
        return instrumented(tel, "fetch", startMs, {
          content: [{ type: "text", text: chunk.text }],
          structuredContent: {
            chunk_id: chunk.chunkId,
            project_id: chunk.projectId,
            text: chunk.text,
            ...(chunk.sourcePath !== undefined ? { source_path: chunk.sourcePath } : {}),
            ...(chunk.startLine !== undefined ? { start_line: chunk.startLine } : {}),
            ...(chunk.endLine !== undefined ? { end_line: chunk.endLine } : {}),
          },
        });
      } catch (err) {
        if (err instanceof UnknownChunkError) {
          return errorResult(
            `Unknown chunk "${chunk_id}". It may have been re-indexed or evicted; ` +
              "re-run search to get current chunk ids.",
          );
        }
        const msg = backendUnavailableMessage(err);
        if (msg !== null) return errorResult(msg);
        throw err;
      }
    },
  );

  server.registerTool(
    "ingest",
    {
      title: "Index a path into the Golem knowledge base",
      description:
        "Ingest a file or directory tree into Golem's local vector knowledge base " +
        "so search can find it. Chunks code and docs and embeds them locally. " +
        "Optionally keep watching the path for changes.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .optional()
          .describe("File or directory to ingest (default: this session's project root)"),
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe("Project to index into; omit to use this session's project"),
        watch: z
          .boolean()
          .optional()
          .describe("Keep a file watcher on the path for incremental re-index (default false)"),
      },
      outputSchema: {
        path: z.string(),
        project_id: z.string(),
        files_seen: z.number().int().nonnegative(),
        chunks_indexed: z.number().int().nonnegative(),
        files_skipped: z.number().int().nonnegative(),
        watching: z.boolean(),
      },
    },
    async ({ path, project_id, watch }) => {
      const startMs = Date.now();
      const projectId = project_id ?? defaultProjectId;
      const target = path ?? projectRootDir;
      if (target === undefined) {
        return errorResult(
          "No `path` was given and this server has no project root configured — " +
            "pass `path` explicitly.",
        );
      }
      try {
        const report = await knowledge.ingest(target, projectId, watch ?? false);
        return instrumented(tel, "ingest", startMs, {
          content: [
            {
              type: "text",
              text:
                `**Golem** Indexed ${report.path} into project ${report.projectId}: ` +
                `${report.chunksIndexed} chunks from ${report.filesSeen} file(s) ` +
                `(${report.filesSkipped} skipped)${report.watching ? ", watching for changes" : ""}.`,
            },
          ],
          structuredContent: {
            path: report.path,
            project_id: report.projectId,
            files_seen: report.filesSeen,
            chunks_indexed: report.chunksIndexed,
            files_skipped: report.filesSkipped,
            watching: report.watching,
          },
        });
      } catch (err) {
        const msg = backendUnavailableMessage(err);
        if (msg !== null) return errorResult(msg);
        throw err;
      }
    },
  );
}

const WIKI_PAGE_TYPES: [WikiPageType, ...WikiPageType[]] = [
  "schema",
  "concept",
  "entity",
  "source",
  "synthesis",
  "question",
  "artifact",
  "adr",
  "debrief",
];

function structuredWikiPage(page: WikiPage): {
  rel_path: string;
  title: string;
  type: WikiPageType;
  tags: string[];
  sources: string[];
  created: string;
  updated: string;
  body: string;
} {
  return {
    rel_path: page.relPath,
    title: page.frontmatter.title,
    type: page.frontmatter.type,
    tags: [...page.frontmatter.tags],
    sources: [...page.frontmatter.sources],
    created: page.frontmatter.created,
    updated: page.frontmatter.updated,
    body: page.body,
  };
}

/** WS-W W2: wiki authoring tools over an injected WikiStore (spec Decisions 28/29). */
function registerWikiTools(server: McpServer, wiki: WikiStore, tel?: ToolTelemetry): void {
  server.registerTool(
    "wiki_read",
    {
      title: "Read a Golem wiki page",
      description:
        "Read one page from the project's committed wiki (spec Decision 28) by its " +
        "title or its wiki-relative path. The wiki is the canonical knowledge store " +
        "— check it before falling back to search or the outside world.",
      inputSchema: {
        title_or_path: z
          .string()
          .min(1)
          .describe(
            'A page title (e.g. "Prompt Caching") or a wiki-relative path ' +
              '(e.g. "concepts/Prompt Caching.md")',
          ),
      },
      outputSchema: {
        rel_path: z.string(),
        title: z.string(),
        type: z.enum(WIKI_PAGE_TYPES),
        tags: z.array(z.string()),
        sources: z.array(z.string()),
        created: z.string(),
        updated: z.string(),
        body: z.string(),
      },
    },
    async ({ title_or_path }) => {
      const startMs = Date.now();
      try {
        const page = await wiki.readPage(title_or_path);
        return instrumented(tel, "wiki_read", startMs, {
          content: [{ type: "text", text: page.body }],
          structuredContent: structuredWikiPage(page),
        });
      } catch (err) {
        if (err instanceof UnknownWikiPageError) {
          return errorResult(
            `No wiki page found for "${title_or_path}". Check docs/wiki/WIKI.md's ` +
              "index, or search for it before proposing a new page.",
          );
        }
        const msg = backendUnavailableMessage(err);
        if (msg !== null) return errorResult(msg);
        throw err;
      }
    },
  );

  server.registerTool(
    "wiki_upsert",
    {
      title: "Write a Golem wiki page",
      description:
        "Create or refine a page in the project's committed wiki (spec Decisions " +
        "28/29). Writes are plan-gated: only call this after proposing the page (or " +
        "the addition) to the user and getting approval — never write unprompted. " +
        "If a page already exists at rel_path, the new body is appended under a " +
        "dated separator and tags/sources are merged in; this never replaces " +
        "existing content wholesale. title/type must match the existing page's " +
        "when one is already there.",
      inputSchema: {
        rel_path: z
          .string()
          .min(1)
          .describe('Wiki-relative path, e.g. "concepts/Prompt Caching.md"'),
        title: z.string().min(1),
        type: z.enum(WIKI_PAGE_TYPES),
        tags: z.array(z.string()).optional().describe("Tags to add (default none)"),
        sources: z
          .array(z.string())
          .optional()
          .describe("URLs or repo paths this content comes from (default none)"),
        body: z.string().min(1).describe("Markdown body; frontmatter is generated"),
      },
      outputSchema: {
        rel_path: z.string(),
        title: z.string(),
        type: z.enum(WIKI_PAGE_TYPES),
        tags: z.array(z.string()),
        sources: z.array(z.string()),
        created: z.string(),
        updated: z.string(),
        body: z.string(),
        appended: z.boolean(),
      },
    },
    async ({ rel_path, title, type, tags, sources, body }) => {
      let existedBefore = true;
      try {
        await wiki.readPage(rel_path);
      } catch (err) {
        if (err instanceof UnknownWikiPageError) {
          existedBefore = false;
        } else {
          const msg = backendUnavailableMessage(err);
          if (msg !== null) return errorResult(msg);
          throw err;
        }
      }
      try {
        const page = await wiki.upsertPage({
          relPath: rel_path,
          frontmatter: { title, type, tags: tags ?? [], sources: sources ?? [] },
          body,
        });
        return {
          content: [
            {
              type: "text",
              text: `Golem: ${existedBefore ? "updated" : "created"} wiki page ${page.relPath}.`,
            },
          ],
          structuredContent: { ...structuredWikiPage(page), appended: existedBefore },
        };
      } catch (err) {
        if (err instanceof WikiWriteConflictError) return errorResult(err.message);
        const msg = backendUnavailableMessage(err);
        if (msg !== null) return errorResult(msg);
        throw err;
      }
    },
  );
}

/** R4.2 — grounding surface passed to the coder tool (all optional but `defaultProjectId`). */
interface CoderGroundingDeps {
  readonly knowledge?: KnowledgeBase | undefined;
  readonly wiki?: WikiReader | undefined;
  readonly wikiDir?: string | undefined;
  readonly rerank?: InferenceService | undefined;
  readonly defaultProjectId: string;
}

function registerCoderTool(
  server: McpServer,
  inference: InferenceService,
  grounding: CoderGroundingDeps,
  tel?: ToolTelemetry,
): void {
  server.registerTool(
    "coder",
    {
      title: "Draft code or tests with a local model",
      description:
        'Delegate a task to Golem\'s local tiered Ollama inference (the "drafter" ' +
        "role — currently backed by a qwen2.5-coder-family model tuned for cheap " +
        "first-draft code generation) instead of doing everything yourself. Use it " +
        "to offload simple or initial work — e.g. a first coding draft — then " +
        "refine the result. By default it grounds the draft in relevant hits from " +
        "Golem's local knowledge base (project code, docs, wiki) so the draft fits " +
        "this codebase; pass `ground: false` to skip that. Nothing leaves the " +
        "machine, but the local model may be slower or lower-quality than you: " +
        "treat the result as a draft to review, not a final answer.",
      inputSchema: {
        task: z.string().min(1).describe("The task or instructions for the local model"),
        context: z
          .string()
          .optional()
          .describe("Extra context to include, e.g. relevant code or file contents"),
        ground: z
          .boolean()
          .optional()
          .describe(
            "Inject relevant project context from Golem's knowledge base into the " +
              "prompt (default true). Set false to draft without grounding.",
          ),
        refine: z
          .boolean()
          .optional()
          .describe(
            "Run one extra local judge→revise pass on the draft (default false). " +
              "Improves quality on non-trivial tasks at the cost of ~2× local latency; " +
              "skip it for small drafts.",
          ),
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe("Project whose knowledge base to ground against; omit to use this session's"),
      },
      outputSchema: {
        text: z.string(),
        model: z.string(),
        role: z.string(),
        // R4.2: present only when grounding actually injected context.
        grounding: z
          .object({
            sources: z.array(z.string()),
            injected_chars: z.number().int().nonnegative(),
          })
          .optional(),
        // R4.4: present only when a refinement pass ran (refine: true).
        refinement: z
          .object({
            rounds: z.number().int().nonnegative(),
            critique_summary: z.string().optional(),
            issues: z.array(z.object({ severity: z.string(), description: z.string() })).optional(),
          })
          .optional(),
      },
    },
    async ({ task, context, ground, refine, project_id }) => {
      const startMs = Date.now();
      const grounded =
        ground !== false && grounding.knowledge !== undefined
          ? await gatherGrounding(task, project_id ?? grounding.defaultProjectId, {
              knowledge: grounding.knowledge,
              wiki: grounding.wiki,
              wikiDir: grounding.wikiDir,
              rerank: grounding.rerank,
            })
          : null;
      const sections: string[] = [];
      if (context !== undefined && context !== "") sections.push(`---\nContext:\n${context}`);
      if (grounded !== null) sections.push(grounded.block);
      const prompt = sections.length === 0 ? task : `${task}\n\n${sections.join("\n\n")}`;
      try {
        const result = await inference.chat("drafter", [{ role: "user", content: prompt }]);
        // R4.4: one optional local judge→revise pass. Best-effort — refineDraft
        // returns the original text with rounds:0 on any failure.
        const refined = refine === true ? await refineDraft(inference, task, result.text) : null;
        const finalText = refined !== null ? refined.text : result.text;
        const groundedNote =
          grounded !== null ? ` Grounded on ${grounded.sources.length} local source(s).` : "";
        const refinedNote =
          refined !== null && refined.rounds > 0
            ? ` Refined ${refined.rounds} round(s) (judge: ${refined.critiqueSummary ?? "issues found"}).`
            : refined !== null
              ? " Judge found nothing worth revising."
              : "";
        return instrumented(tel, "coder", startMs, {
          content: [
            {
              type: "text",
              text: `**Golem** Used ${result.model} locally — verify independently.${groundedNote}${refinedNote}\n\n${finalText}`,
            },
          ],
          structuredContent: {
            text: finalText,
            model: result.model,
            role: result.role,
            ...(grounded !== null
              ? { grounding: { sources: grounded.sources, injected_chars: grounded.chars } }
              : {}),
            ...(refined !== null
              ? {
                  refinement: {
                    rounds: refined.rounds,
                    ...(refined.critiqueSummary !== undefined
                      ? { critique_summary: refined.critiqueSummary }
                      : {}),
                    ...(refined.issues !== undefined ? { issues: [...refined.issues] } : {}),
                  },
                }
              : {}),
          },
        });
      } catch (err) {
        const msg = backendUnavailableMessage(err);
        if (msg !== null) return errorResult(msg);
        throw err;
      }
    },
  );
}

/** `golem devices` CLI's tier→name map (src/cli/main.ts), duplicated here since it is a local const there. */
const DEVICE_TIER_NAMES: Readonly<Record<HardwareTier, string>> = {
  0: "P_CPU",
  1: "P_MIN",
  2: "P_MID",
  3: "P_MAX",
};

/**
 * P0 tool: report the detected local hardware tier and the models Golem
 * would use for it — the MCP twin of the `golem devices` CLI command.
 * Registered unconditionally: detection needs no injected service, only the
 * always-available hardware-probe functions, and `detectCapability` never
 * throws (every failure path degrades to P_CPU).
 */
function registerDevicesTool(server: McpServer): void {
  server.registerTool(
    "devices",
    {
      title: "Show detected local hardware",
      description:
        "Report Golem's detected local hardware tier (GPU/accelerator, memory) and " +
        "the local models Golem would use at that tier. Same info as the " +
        "`golem devices` CLI command.",
      outputSchema: {
        tier: z.number().int().min(0).max(3),
        tier_name: z.string(),
        source: z.string(),
        device: z.string().optional(),
        memory_mib: z.number().optional(),
        detail: z.string(),
        models: z.array(z.string()),
      },
    },
    async () => {
      const facts = await detectCapability(createProbeRunner());
      const models = modelsForTier(facts.tier);
      const tierName = DEVICE_TIER_NAMES[facts.tier];
      const lines = [`Hardware tier: ${facts.tier} (${tierName}) — via ${facts.source}`];
      if (facts.device !== undefined) lines.push(`  device: ${facts.device}`);
      if (facts.memoryMiB !== undefined) lines.push(`  memory: ${facts.memoryMiB} MiB`);
      lines.push(`  ${facts.detail}`);
      lines.push(`  models for this tier: ${models.join(", ")}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          tier: facts.tier,
          tier_name: tierName,
          source: facts.source,
          detail: facts.detail,
          models,
          ...(facts.device !== undefined ? { device: facts.device } : {}),
          ...(facts.memoryMiB !== undefined ? { memory_mib: facts.memoryMiB } : {}),
        },
      };
    },
  );
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "slider",
    {
      title: "Golem slider",
      description: "Show or set Golem's quality/savings slider (0–3)",
      argsSchema: {
        level: z
          .string()
          .optional()
          .describe("New slider level 0–3; omit to show the current level"),
      },
    },
    ({ level }) =>
      promptMessages(
        level === undefined || level === ""
          ? "Call the stats tool and report the current Golem slider level, " +
              "then briefly list what each level 0–3 enables " +
              "(0 passthrough — full bypass, NO redaction; 1 lossless; 2 balanced; 3 aggressive)."
          : `Set the Golem savings slider to level ${level} using the level ` +
              "tool (it accepts integers 0–3; if the requested value is not a valid " +
              "level, tell the user instead of guessing). Then confirm the new level " +
              "and summarize in one sentence what changes at that level. If the level " +
              "is 0, warn that redaction is disabled at level 0.",
      ),
  );

  server.registerPrompt(
    "stats",
    {
      title: "Golem savings stats",
      description: "Show Golem token-savings statistics",
      argsSchema: {
        project_id: z
          .string()
          .optional()
          .describe("Limit stats to this project id; omit for global stats"),
      },
    },
    ({ project_id }) =>
      promptMessages(
        `Call the stats tool${
          project_id === undefined || project_id === "" ? "" : ` with project_id "${project_id}"`
        } and present the results concisely: current slider level, total tokens ` +
          "saved (before → after), request count, per-stage attribution if any, " +
          "and CCR store activity.",
      ),
  );

  server.registerPrompt(
    "expand",
    {
      title: "Expand a Golem CCR reference",
      description: "Retrieve the original content behind a Golem CCR ref marker",
      argsSchema: {
        ref_id: z.string().describe("The CCR ref id, e.g. abc123 from `[golem:ccr ref=abc123]`"),
      },
    },
    ({ ref_id }) =>
      promptMessages(
        `Call the expand tool with ref_id "${ref_id}" and show the retrieved ` +
          "original content to the user. If the ref is unknown or expired, say so " +
          "and suggest re-running the tool that produced the content.",
      ),
  );

  server.registerPrompt(
    "bypass",
    {
      title: "Bypass Golem compression",
      description: "Temporarily bypass Golem's compression pipeline",
    },
    () =>
      promptMessages(
        "The user wants to bypass Golem's compression. Explain the two options " +
          "and pick per intent: (1) a per-request bypass that leaves the " +
          "persistent slider alone — direct API callers add the `x-golem-bypass` " +
          "header. (2) a persistent change — `level 1` keeps redaction on while " +
          "compression stays byte-faithful; `level 0` turns Golem fully OFF but " +
          "ALSO disables redaction (secrets reach the upstream raw), so only use " +
          "0 for a deliberate full bypass. Prefer level 1 unless a true full " +
          "bypass is intended; confirm the choice and remind the user to restore " +
          "their previous level afterwards.",
      ),
  );

  // P1 prompts (frozen names; backing tools ship with tasks B3 / WS-C / WS-D).
  server.registerPrompt(
    "index",
    {
      title: "Index into the Golem knowledge base",
      description: "Ingest a path into Golem's local vector knowledge base",
      argsSchema: {
        path: z.string().optional().describe("File or directory to ingest (default: project root)"),
      },
    },
    ({ path }) =>
      promptMessages(
        `Ingest ${
          path === undefined || path === "" ? "the current project root" : `"${path}"`
        } into the Golem knowledge base using the ingest tool, then ` +
          `report what was indexed. ${P1_TOOL_FALLBACK}`,
      ),
  );

  server.registerPrompt(
    "search",
    {
      title: "Search the Golem knowledge base",
      description: "Federated semantic search over Golem's local knowledge base",
      argsSchema: {
        query: z.string().describe("What to search for"),
      },
    },
    ({ query }) =>
      promptMessages(
        `Search the Golem knowledge base for "${query}" using the search tool ` +
          "and summarize the most relevant hits (use fetch for full " +
          `chunk contents when needed). ${P1_TOOL_FALLBACK}`,
      ),
  );

  server.registerPrompt(
    "devices",
    {
      title: "Golem hardware capabilities",
      description: "Show detected local hardware tier and available local models",
    },
    () =>
      promptMessages(
        "Report the local hardware capabilities Golem detected (tier, GPU/VRAM, " +
          `available local models) using the devices tool. ${P1_TOOL_FALLBACK}`,
      ),
  );

  server.registerPrompt(
    "coder",
    {
      title: "Draft code or tests with a local model",
      description:
        "Delegate a code/test drafting task to a local model via Golem's tiered inference",
      argsSchema: {
        task: z.string().optional().describe("The task to delegate to a local model"),
      },
    },
    ({ task }) =>
      promptMessages(
        `Delegate ${
          task === undefined || task === "" ? "the user's current task" : `this task: "${task}"`
        } to a local model using the coder tool and relay the result, ` +
          `noting it was produced locally. ${P1_TOOL_FALLBACK}`,
      ),
  );
}
