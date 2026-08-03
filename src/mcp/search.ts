/**
 * Search, fetch, and ingest tools + hit assembly + wiki boost + graph-first
 * lookup + grounding. Extracted from server.ts (R8.28).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  Hit,
  InferenceService,
  KnowledgeBase,
  WikiPage,
  WikiReader,
} from "../interfaces/index.js";
import { UnknownChunkError, UnknownWikiPageError } from "../interfaces/index.js";
import { isMemoryChunkId } from "../knowledge/knowledge-base.js";
import { rerankHits } from "../knowledge/rerank.js";
import { extractWikilinks } from "../wiki/frontmatter.js";
import { errorResult, instrumented, type ToolTelemetry } from "./shared.js";

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

export function backendUnavailableMessage(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
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
export interface HitAssemblyDeps {
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

export interface Grounding {
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
 *
 * Exported so non-MCP callers reuse the exact same path (LE3: `golem task run`'s
 * local multiplexing grounds queued tasks identically to `coder`).
 */
export async function gatherGrounding(
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

/** Register the P1 knowledge tools (task B3) against an injected KnowledgeBase. */
export function registerKnowledgeTools(
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
