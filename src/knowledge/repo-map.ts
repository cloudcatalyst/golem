/**
 * R8.5 — the repo map: whole-repo symbol skeleton, ranked by a reference graph
 * and rendered to a token budget.
 *
 * ## Why a map instead of a read
 * §95 measured `Read` as the second-biggest tool consumer (27,056 tokens across
 * 18 results; 40,708 across 20 in a later capture) **and** the surface an
 * external Bash-output compactor structurally cannot reach (§90). §93 established
 * that ~83% of input cost is re-reading an already-cached context, so a read
 * avoided pays on every later turn, not once. A map that lets the model name the
 * right file without opening three wrong ones is therefore the largest
 * un-attacked bucket Golem owns.
 *
 * That is a claim, not a fact, so `golem bench map` measures it — token cost and
 * retrieval accuracy in the same view (Decision 52's rule). The honest answer may
 * be "partially": the memo's open question 3 asks whether a map *displaces* reads
 * or whether the model reads the file anyway.
 *
 * ## Ranking
 * A file-to-file graph, then a personalized power-iteration rank (the shape Aider
 * uses, reimplemented here):
 *  - an **import** edge for every resolved module specifier;
 *  - a **reference** edge for every identifier a file uses that another file
 *    defines, weighted `sqrt(occurrences)` so one hot loop does not outrank ten
 *    independent call sites;
 *  - identifiers defined in more than {@link MAX_DEFINERS} files are dropped as
 *    too generic to carry signal (`index`, `name`, …).
 * The personalization vector is where the live query lands: query tokens matching
 * a path or a symbol name, plus any explicitly focused paths, get mass — so the
 * same repo renders a different map for "redaction" than for "slider".
 *
 * ## Byte stability (hard constraint)
 * The map renders into a cached prefix's neighbourhood, so an unstable rendering
 * re-prefills and is strictly worse than doing nothing (§14). Everything here is
 * a pure function of (file contents, options): no clock, no randomness, no
 * scores printed, and every ordering has a total tie-break (rank, then path;
 * line, then name). Same repo + same query ⇒ byte-identical map.
 *
 * ## Degradation
 * tree-sitter is a tier-2 optional dep (Decision 53). Absent, `extractFileFacts`
 * returns null for every file and {@link buildRepoMap} reports
 * `available: false` with a reason — a no-op, never an error path.
 */

import { stat } from "node:fs/promises";
import { estimateTokens } from "../compression/tokens.js";
import { MAX_FILE_BYTES } from "./ingest.js";
import { buildGraph, type Graph } from "./repo-map-graph.js";
import { rankFiles, symbolScore } from "./repo-map-rank.js";
import { type RepoFile, scanRepoFiles } from "./repo-map-scan.js";
import type { SymbolDef } from "./tree-sitter-chunker.js";

/* The scan/graph/rank stages are re-exported so `./repo-map.js` stays the one
 * import path for the map: every caller, barrel export, bench and test that
 * imported from here before the split keeps working unchanged. */
export {
  buildGraph,
  type Graph,
  MAX_DEFINERS,
  queryTokens,
  resolveImport,
  wordParts,
} from "./repo-map-graph.js";
export { rankFiles } from "./repo-map-rank.js";
export {
  clearRepoMapCache,
  MAX_FILES_PARSED,
  type RepoFile,
  scanRepoFiles,
} from "./repo-map-scan.js";

/** Default token budget for a rendered map (the memo's 1–1.5k band). */
export const DEFAULT_MAP_BUDGET_TOKENS = 1_400;
/** Hard ceiling a caller may ask for — above this the map stops being a saving. */
export const MAX_MAP_BUDGET_TOKENS = 8_000;
/**
 * Most symbol rows one file may contribute before the rest are counted only.
 * Deliberately small: a map answers "which file", so breadth beats depth —
 * measured on this repo, an unbounded cap spent the whole 1.4k budget on five
 * hub files, where this shows ~25. The full signature list of one file is a
 * `Read` (or the oversized-Read skeleton), not the map's job.
 */
export const DEFAULT_MAX_SYMBOLS_PER_FILE = 8;
/** No single file may take more than this share of the budget. */
export const MAX_FILE_BUDGET_SHARE = 0.12;
export interface RepoMapOptions {
  /** Token budget for the rendered map; default {@link DEFAULT_MAP_BUDGET_TOKENS}. */
  readonly budgetTokens?: number;
  /** Live query — personalizes the rank toward matching paths and symbols. */
  readonly query?: string;
  /** Paths (POSIX, root-relative) to weight heavily, e.g. files already open. */
  readonly focusPaths?: readonly string[];
  /** Per-file symbol cap; default {@link DEFAULT_MAX_SYMBOLS_PER_FILE}. */
  readonly maxSymbolsPerFile?: number;
}

/** A file with its graph rank and its selected rows. */
export interface RankedFile {
  readonly file: RepoFile;
  readonly rank: number;
  /** Selected definitions, in source order. */
  readonly shown: readonly SymbolDef[];
  /** Definitions this file has that were not selected. */
  readonly hidden: number;
}

export interface RepoMapUnavailable {
  readonly available: false;
  /** Why there is no map — surfaced verbatim to the caller. */
  readonly reason: string;
}

export interface RepoMapReady {
  readonly available: true;
  readonly text: string;
  readonly filesScanned: number;
  readonly filesShown: number;
  readonly symbolsTotal: number;
  readonly symbolsShown: number;
  /** Estimated tokens of `text` (the honest cost of showing it). */
  readonly tokens: number;
  readonly budgetTokens: number;
}

export type RepoMapResult = RepoMapReady | RepoMapUnavailable;

function lineLabel(line: number): string {
  return String(line).padStart(5);
}

/** One file's rows, exactly as they appear in the map. */
export function renderFileBlock(entry: RankedFile): string {
  const lines = [`${entry.file.sourcePath}  (${entry.file.lines} lines)`];
  for (const def of entry.shown) {
    lines.push(`${lineLabel(def.line)}  ${def.signature}`);
  }
  if (entry.hidden > 0) lines.push(`         +${entry.hidden} more symbol(s)`);
  return `${lines.join("\n")}\n`;
}

/**
 * Signature skeleton for ONE file — the oversized-`Read` swap's payload. Not a
 * product surface of its own (RTK's `read -l aggressive` covers per-file
 * signatures); it exists so the digest's head/tail excerpt becomes navigable:
 * every symbol with its line number, so the cheap recovery is a narrow re-read
 * rather than an `expand` that re-enters the whole original (§95: one expand,
 * 6,356 tokens).
 */
export function renderFileSkeleton(
  defs: readonly SymbolDef[],
  maxChars: number,
): { readonly text: string; readonly shown: number; readonly hidden: number } {
  const ordered = [...defs].sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : 1));
  const rows: string[] = [];
  let used = 0;
  let shown = 0;
  for (const def of ordered) {
    const row = `${lineLabel(def.line)}  ${def.signature}`;
    if (used + row.length + 1 > maxChars) break;
    rows.push(row);
    used += row.length + 1;
    shown += 1;
  }
  return { text: rows.join("\n"), shown, hidden: ordered.length - shown };
}

const HEADER_NOTE =
  "Ranked by an import/reference graph, not by directory. Line numbers are 1-based:\n" +
  "prefer Read with offset/limit (or grep) over opening a whole file.";

/** Select and render, respecting the token budget. Pure. */
export function renderRepoMap(
  files: readonly RepoFile[],
  graph: Graph,
  rank: ReadonlyMap<string, number>,
  options: RepoMapOptions = {},
): RepoMapReady {
  const budget = Math.min(
    Math.max(options.budgetTokens ?? DEFAULT_MAP_BUDGET_TOKENS, 200),
    MAX_MAP_BUDGET_TOKENS,
  );
  const maxPerFile = Math.max(options.maxSymbolsPerFile ?? DEFAULT_MAX_SYMBOLS_PER_FILE, 1);
  const symbolsTotal = files.reduce((n, f) => n + f.facts.defs.length, 0);

  const ordered = [...files].sort((a, b) => {
    const delta = (rank.get(b.sourcePath) ?? 0) - (rank.get(a.sourcePath) ?? 0);
    if (delta !== 0) return delta;
    return a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0;
  });

  // Reserve the header's own cost so the budget is the WHOLE map, not the body.
  const reserved = estimateTokens(`${HEADER_NOTE}\n`) + 60;
  let used = reserved;
  const blocks: string[] = [];
  let filesShown = 0;
  let symbolsShown = 0;

  for (const file of ordered) {
    if (file.facts.defs.length === 0) continue;
    const byScore = [...file.facts.defs].sort((a, b) => {
      const delta = symbolScore(b, graph) - symbolScore(a, graph);
      if (delta !== 0) return delta;
      return a.line - b.line || (a.name < b.name ? -1 : 1);
    });
    // Shrink this file's row count until the block fits what is left; a file
    // that cannot show even one row ends the map rather than truncating a row.
    const perFileCeiling = Math.max(60, Math.floor(budget * MAX_FILE_BUDGET_SHARE));
    let count = Math.min(byScore.length, maxPerFile);
    let block: string | null = null;
    let blockTokens = 0;
    while (count > 0) {
      const shown = [...byScore.slice(0, count)].sort(
        (a, b) => a.line - b.line || (a.name < b.name ? -1 : 1),
      );
      const candidate = renderFileBlock({
        file,
        rank: rank.get(file.sourcePath) ?? 0,
        shown,
        hidden: file.facts.defs.length - shown.length,
      });
      const tokens = estimateTokens(candidate);
      if (tokens <= perFileCeiling && used + tokens <= budget) {
        block = candidate;
        blockTokens = tokens;
        symbolsShown += shown.length;
        break;
      }
      count = count > 8 ? Math.floor(count / 2) : count - 1;
    }
    if (block === null) break;
    blocks.push(block);
    used += blockTokens;
    filesShown += 1;
  }

  const notShown = files.length - filesShown;
  const header =
    `[Golem repo map — ${files.length} file(s), ${symbolsTotal} symbol(s); showing ` +
    `${filesShown} file(s) / ${symbolsShown} symbol(s) within a ~${budget}-token budget]`;
  const footer =
    notShown > 0
      ? `\n${notShown} file(s) not shown (lower graph rank). Re-run with a query to ` +
        "re-rank toward a topic, or a larger budget."
      : "";
  const text = `${header}\n${HEADER_NOTE}\n\n${blocks.join("\n")}${footer}\n`;

  return {
    available: true,
    text,
    filesScanned: files.length,
    filesShown,
    symbolsTotal,
    symbolsShown,
    tokens: estimateTokens(text),
    budgetTokens: budget,
  };
}

/** Scan → graph → rank → render. Returns `available: false` instead of throwing. */
export async function buildRepoMap(
  root: string,
  options: RepoMapOptions = {},
): Promise<RepoMapResult> {
  let isDir: boolean;
  try {
    isDir = (await stat(root)).isDirectory();
  } catch {
    return { available: false, reason: `map root "${root}" is not readable` };
  }
  if (!isDir) return { available: false, reason: `map root "${root}" is not a directory` };

  const files = await scanRepoFiles(root);
  if (files.length === 0) {
    return {
      available: false,
      reason:
        "no symbols could be extracted. Either this tree has no TS/JS files, or the " +
        "optional tree-sitter packages are not installed (npm install web-tree-sitter " +
        "tree-sitter-typescript tree-sitter-javascript). The map is a tier-2 optional " +
        "feature — without it nothing else changes.",
    };
  }
  const graph = buildGraph(files);
  const rank = rankFiles(files, graph, options);
  return renderRepoMap(files, graph, rank, options);
}

/** Re-exported so callers do not need the ingest module for the size cap. */
export { MAX_FILE_BYTES };
