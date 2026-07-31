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

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { estimateTokens } from "../compression/tokens.js";
import { MAX_FILE_BYTES, scanFiles, toPosix } from "./ingest.js";
import {
  extractFileFacts,
  type FileFacts,
  isSymbolExtractable,
  type SymbolDef,
} from "./tree-sitter-chunker.js";

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
/** An identifier defined in more files than this is too generic to be an edge. */
export const MAX_DEFINERS = 5;
/** Files parsed at most, newest-mtime-first, so a monorepo cannot hang a call. */
export const MAX_FILES_PARSED = 1_500;

const DAMPING = 0.85;
/** Damping for a queried map — less mass through edges, more on the query. */
const STEERED_DAMPING = 0.5;
/** How hard the query affinity scales the final rank (0 = graph only). */
const AFFINITY_GAIN = 8;
const ITERATIONS = 40;

/** One scanned, parsed file. */
export interface RepoFile {
  /** POSIX path relative to the map root. */
  readonly sourcePath: string;
  readonly lines: number;
  readonly facts: FileFacts;
}

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

/* ---------------------------------- scan ---------------------------------- */

/**
 * Parsed facts keyed by absolute path, invalidated on mtime/size — the cheap
 * half of "incrementally refreshed" (ADR-0001's watcher is the other half).
 * Parsing this repo costs ~1.5s cold; a second map in the same process, e.g. the
 * model asking again with a different query, then costs the walk alone.
 */
const factsCache = new Map<
  string,
  { readonly mtimeMs: number; readonly size: number; readonly file: RepoFile }
>();

/** Drop the parse cache — for tests and for an explicit re-index. */
export function clearRepoMapCache(): void {
  factsCache.clear();
}

/**
 * Parse every symbol-extractable file under `root`. Reuses the ingest walk, so
 * the map covers exactly the tree the knowledge base indexes (same `SKIP_DIRS`,
 * same size cap) and inherits the watcher's notion of the project.
 */
export async function scanRepoFiles(root: string): Promise<RepoFile[]> {
  const all = await scanFiles(root);
  const targets = all
    .filter((f) => isSymbolExtractable(path.extname(f.sourcePath).toLowerCase()))
    .sort((a, b) => (a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0))
    .slice(0, MAX_FILES_PARSED);

  const out: RepoFile[] = [];
  for (const target of targets) {
    const cached = factsCache.get(target.abs);
    if (
      cached !== undefined &&
      cached.mtimeMs === target.mtimeMs &&
      cached.size === target.size &&
      cached.file.sourcePath === target.sourcePath
    ) {
      out.push(cached.file);
      continue;
    }
    let content: string;
    try {
      content = await readFile(target.abs, "utf8");
    } catch {
      continue; // vanished or unreadable — not an error path
    }
    const facts = await extractFileFacts(path.extname(target.sourcePath).toLowerCase(), content);
    if (facts === null) continue; // tree-sitter absent or parse failure — drop the file
    const file: RepoFile = {
      sourcePath: target.sourcePath,
      lines: content.split("\n").length,
      facts,
    };
    factsCache.set(target.abs, { mtimeMs: target.mtimeMs, size: target.size, file });
    out.push(file);
  }
  return out;
}

/* ---------------------------------- graph --------------------------------- */

/**
 * Resolve a module specifier to a file in the map, honouring this repo's ESM
 * convention of importing `./x.js` for `./x.ts`. Bare specifiers (packages)
 * resolve to nothing — an npm dependency is not a node in this graph.
 */
export function resolveImport(
  fromPath: string,
  specifier: string,
  known: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const joined = toPosix(path.posix.join(path.posix.dirname(fromPath), specifier));
  const base = joined.replace(/\.(js|mjs|cjs|jsx|ts|mts|cts|tsx)$/u, "");
  const candidates = [
    joined,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
  for (const candidate of candidates) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

interface Graph {
  /** from → to → weight. */
  readonly edges: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** symbol name → files defining it. */
  readonly definers: ReadonlyMap<string, readonly string[]>;
  /** symbol name → number of OTHER files referencing it. */
  readonly externalRefs: ReadonlyMap<string, number>;
}

function addEdge(
  edges: Map<string, Map<string, number>>,
  from: string,
  to: string,
  w: number,
): void {
  if (from === to) return;
  let row = edges.get(from);
  if (row === undefined) {
    row = new Map<string, number>();
    edges.set(from, row);
  }
  row.set(to, (row.get(to) ?? 0) + w);
}

export function buildGraph(files: readonly RepoFile[]): Graph {
  const known = new Set(files.map((f) => f.sourcePath));
  // Only EXPORTED, non-member definitions are edge targets. A file-local `const
  // body = …` cannot be referenced from another module, so counting the repo's
  // hundreds of `body` identifiers as references to it is a pure false edge —
  // measured on this repo it floated test files above `src/interfaces/`. Method
  // names are excluded for the same reason: `property_identifier` refs match any
  // object's property, not that class's method.
  const definers = new Map<string, string[]>();
  for (const file of files) {
    for (const def of file.facts.defs) {
      if (!def.exported || def.kind === "method") continue;
      const list = definers.get(def.name);
      if (list === undefined) definers.set(def.name, [file.sourcePath]);
      else if (!list.includes(file.sourcePath)) list.push(file.sourcePath);
    }
  }

  const edges = new Map<string, Map<string, number>>();
  const externalRefs = new Map<string, number>();
  for (const file of files) {
    for (const specifier of file.facts.imports) {
      const target = resolveImport(file.sourcePath, specifier, known);
      if (target !== null) addEdge(edges, file.sourcePath, target, 1);
    }
    for (const [name, count] of Object.entries(file.facts.refs)) {
      const targets = definers.get(name);
      if (targets === undefined || targets.length > MAX_DEFINERS) continue;
      const external = targets.filter((t) => t !== file.sourcePath);
      if (external.length === 0) continue;
      externalRefs.set(name, (externalRefs.get(name) ?? 0) + 1);
      const weight = Math.sqrt(count) / external.length;
      for (const target of external) addEdge(edges, file.sourcePath, target, weight);
    }
  }
  return { edges, definers, externalRefs };
}

/* ----------------------------------- rank --------------------------------- */

/** Query tokens: lowercase words of 3+ chars, deduped, order-preserving. */
export function queryTokens(query: string | undefined): string[] {
  if (query === undefined) return [];
  const seen = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^a-z0-9_]+/u)) {
    if (raw.length >= 3) seen.add(raw);
  }
  return [...seen];
}

/**
 * Split an identifier or a path into lowercase word parts:
 * `runPostToolUseHook` → run, post, tool, use, hook. Matching whole parts
 * instead of raw substrings is what stops a query's function words from
 * dominating: `the` is a substring of `pathExists` and `and` of `expand`, and
 * both scored — measured, that ranked `src/cli/init.ts` above the file the
 * question was about.
 */
export function wordParts(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((part) => part.length > 0);
}

/** A query token matches a part when either is the other's prefix (≥3 chars). */
function partMatches(part: string, token: string): boolean {
  return part === token || part.startsWith(token) || (part.length >= 3 && token.startsWith(part));
}

/**
 * Per-file query affinity, unnormalized. Zero when nothing was asked.
 *
 * Tokens are IDF-weighted, which is not decoration — it is what makes a
 * natural-language question work. "where is the oversized tool output digest
 * built" contains `tool` (matches a third of this repo) and `digest` (matches
 * two files); weighting them equally is how a hub module wins a question it has
 * nothing to do with.
 */
function affinity(files: readonly RepoFile[], options: RepoMapOptions): Map<string, number> {
  const tokens = queryTokens(options.query);
  const focus = new Set(options.focusPaths ?? []);
  const lowered = files.map((file) => ({
    sourcePath: file.sourcePath,
    pathParts: new Set(wordParts(file.sourcePath)),
    nameParts: new Set(file.facts.defs.flatMap((d) => wordParts(d.name))),
  }));
  const matchesToken = (parts: ReadonlySet<string>, token: string): boolean => {
    for (const part of parts) {
      if (partMatches(part, token)) return true;
    }
    return false;
  };

  const idf = new Map<string, number>();
  for (const token of tokens) {
    let matches = 0;
    for (const file of lowered) {
      if (matchesToken(file.pathParts, token) || matchesToken(file.nameParts, token)) matches += 1;
    }
    if (matches === 0) continue;
    idf.set(token, Math.log(1 + files.length / matches));
  }

  const weights = new Map<string, number>();
  for (const file of lowered) {
    let weight = 0;
    if (focus.has(file.sourcePath)) weight += 8;
    for (const [token, rarity] of idf) {
      if (matchesToken(file.pathParts, token)) weight += rarity;
      // A symbol NAME match is the strongest cheap signal a map has: it is
      // how "where is the digest built" reaches `buildDigest`.
      if (matchesToken(file.nameParts, token)) weight += 2 * rarity;
    }
    if (weight > 0) weights.set(file.sourcePath, weight);
  }
  return weights;
}

/**
 * The teleport vector: uniform when there is nothing to steer by, otherwise the
 * normalized query affinity.
 */
function personalize(
  files: readonly RepoFile[],
  weights: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  let total = 0;
  for (const w of weights.values()) total += w;
  if (total === 0) {
    const uniform = files.length === 0 ? 0 : 1 / files.length;
    return new Map(files.map((f) => [f.sourcePath, uniform]));
  }
  return new Map([...weights].map(([p, w]) => [p, w / total]));
}

/**
 * Personalized PageRank by power iteration, then a multiplicative query prior.
 * Deterministic: fixed iteration count, fixed node order, no early exit on a
 * floating-point threshold that could differ between runs.
 *
 * Two mechanisms, because one is not enough — measured on this repo. Teleporting
 * only toward query-matched files still let hub modules win: `src/interfaces/`
 * and `src/cli/init.ts` receive from everywhere, so they outrank the file that
 * actually defines the thing asked about. So a queried map ALSO (a) drops the
 * damping factor, keeping more mass on the teleport set, and (b) scales the
 * final rank by the file's own affinity. Without a query neither applies and
 * this is plain PageRank over the reference graph.
 */
export function rankFiles(
  files: readonly RepoFile[],
  graph: Graph,
  options: RepoMapOptions = {},
): ReadonlyMap<string, number> {
  const nodes = files.map((f) => f.sourcePath);
  const weights = affinity(files, options);
  const personalization = personalize(files, weights);
  const steered = weights.size > 0;
  const damping = steered ? STEERED_DAMPING : DAMPING;
  const outWeight = new Map<string, number>();
  for (const [from, row] of graph.edges) {
    let sum = 0;
    for (const w of row.values()) sum += w;
    outWeight.set(from, sum);
  }

  let rank = new Map<string, number>(nodes.map((n) => [n, personalization.get(n) ?? 0]));
  for (let iter = 0; iter < ITERATIONS; iter += 1) {
    const next = new Map<string, number>();
    let dangling = 0;
    for (const node of nodes) {
      const own = rank.get(node) ?? 0;
      if ((outWeight.get(node) ?? 0) === 0) dangling += own;
      next.set(node, (1 - damping) * (personalization.get(node) ?? 0));
    }
    for (const node of nodes) {
      const share = damping * dangling * (personalization.get(node) ?? 0);
      next.set(node, (next.get(node) ?? 0) + share);
    }
    for (const [from, row] of graph.edges) {
      const own = rank.get(from);
      const total = outWeight.get(from) ?? 0;
      if (own === undefined || total === 0) continue;
      for (const [to, w] of row) {
        if (!next.has(to)) continue;
        next.set(to, (next.get(to) as number) + (damping * own * w) / total);
      }
    }
    rank = next;
  }
  if (!steered) return rank;

  let maxWeight = 0;
  for (const w of weights.values()) maxWeight = Math.max(maxWeight, w);
  const scaled = new Map<string, number>();
  for (const node of nodes) {
    const prior = 1 + AFFINITY_GAIN * ((weights.get(node) ?? 0) / (maxWeight || 1));
    scaled.set(node, (rank.get(node) ?? 0) * prior);
  }
  return scaled;
}

/**
 * A definition's own weight inside its file: how widely it is referenced, with
 * the module's public surface preferred. A file-local, untyped `const` is the
 * lowest-value row a map can spend a line on (measured: `const url`, `const
 * pkg` in scripts), so it is heavily discounted rather than excluded — a script
 * whose whole content is top-level consts should still get a row.
 */
function symbolScore(def: SymbolDef, graph: Graph): number {
  const refs = graph.externalRefs.get(def.name) ?? 0;
  const visibility = def.exported ? 1.5 : def.kind === "const" ? 0.25 : 0.5;
  const member = def.kind === "method" ? 0.6 : 1;
  return visibility * member * (1 + Math.log1p(refs));
}

/* ---------------------------------- render -------------------------------- */

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

/* -------------------------------- entry point ----------------------------- */

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
