/**
 * R8.5 — the repo map's RANK stage: personalized PageRank over the reference
 * graph, plus the per-symbol score that decides which rows a file spends its
 * budget on. Extracted verbatim from `./repo-map.js`.
 *
 * Deterministic by construction — fixed iteration count, fixed node order, no
 * early exit on a floating-point threshold that could differ between runs — so
 * the same repo and query rank identically every time (§14's byte stability).
 */

import type { RepoMapOptions } from "./repo-map.js";
import { affinity, type Graph } from "./repo-map-graph.js";
import type { RepoFile } from "./repo-map-scan.js";
import type { SymbolDef } from "./tree-sitter-chunker.js";

const DAMPING = 0.85;
/** Damping for a queried map — less mass through edges, more on the query. */
const STEERED_DAMPING = 0.5;
/** How hard the query affinity scales the final rank (0 = graph only). */
const AFFINITY_GAIN = 8;
const ITERATIONS = 40;

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
export function symbolScore(def: SymbolDef, graph: Graph): number {
  const refs = graph.externalRefs.get(def.name) ?? 0;
  const visibility = def.exported ? 1.5 : def.kind === "const" ? 0.25 : 0.5;
  const member = def.kind === "method" ? 0.6 : 1;
  return visibility * member * (1 + Math.log1p(refs));
}
