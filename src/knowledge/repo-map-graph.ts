/**
 * R8.5 — the repo map's GRAPH stage: the file-to-file reference graph, and the
 * query affinity that steers the rank across it. Extracted verbatim from
 * `./repo-map.js`.
 *
 * An **import** edge for every resolved module specifier; a **reference** edge
 * for every identifier a file uses that another file defines, weighted
 * `sqrt(occurrences)` so one hot loop does not outrank ten independent call
 * sites. Identifiers defined in more than {@link MAX_DEFINERS} files are dropped
 * as too generic to carry signal.
 *
 * Pure: a function of (file contents, options) alone, because the map it feeds
 * must be byte-stable (§14).
 */

import path from "node:path";
import { toPosix } from "./ingest.js";
import type { RepoMapOptions } from "./repo-map.js";
import type { RepoFile } from "./repo-map-scan.js";

/** An identifier defined in more files than this is too generic to be an edge. */
export const MAX_DEFINERS = 5;
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

export interface Graph {
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
export function affinity(files: readonly RepoFile[], options: RepoMapOptions): Map<string, number> {
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
