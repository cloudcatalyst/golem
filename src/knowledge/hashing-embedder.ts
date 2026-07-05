/**
 * WS-C — pure-TS default embedder (zero-setup lexical search).
 *
 * The KB's semantic path needs a local Ollama model (bge-m3) pulled and running.
 * That's a heavy onboarding step, and until it's done the KB is dormant. This
 * embedder fills the gap: a deterministic **signed feature-hashing** vectorizer
 * (a hashing-trick bag-of-words) that turns text into a fixed-dim, L2-normalized
 * vector with no dependency, no model download, and no network. Cosine over these
 * vectors is lexical/identifier overlap — which for *code* search (you look up a
 * function or symbol name) is genuinely useful, not a toy.
 *
 * It is the DEFAULT `EmbedFn` when no Ollama inference is available; the
 * InferenceService (bge-m3) stays the optional SEMANTIC upgrade behind the same
 * seam (mirrors the FileVectorDriver-vs-LanceDB split). Determinism matters: the
 * same text always yields the same vector across processes, so a persisted index
 * stays queryable.
 *
 * Embedders are NOT interchangeable within one index (different dimensions /
 * spaces); switching between hashing and bge-m3 means re-indexing. The vector
 * driver stores the dimension and a mismatched query simply returns no hits
 * rather than garbage.
 */

import type { EmbedFn } from "./knowledge-base.js";

/** Default hashing dimension — enough to keep token collisions low for a repo KB. */
export const DEFAULT_HASH_DIM = 512;

/**
 * Tokenize for code + prose: split on non-alphanumerics AND on camelCase /
 * PascalCase boundaries so `verifyPassword` → `verify`, `password`. Lowercased,
 * tokens shorter than 2 chars dropped (noise).
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const word of text.split(/[^A-Za-z0-9]+/)) {
    if (word === "") continue;
    for (const part of word.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
      const t = part.toLowerCase();
      if (t.length >= 2) tokens.push(t);
    }
  }
  return tokens;
}

/** FNV-1a 32-bit hash (deterministic, fast, no deps). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in 32-bit range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Signed feature-hashing vector for one text: each token bumps a hashed slot by
 * ±1 (sign from a hash bit, which cancels collision bias), then L2-normalized so
 * cosine similarity is a plain dot product.
 */
export function hashEmbed(text: string, dim: number = DEFAULT_HASH_DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const tok of tokenize(text)) {
    const h = fnv1a(tok);
    const idx = h % dim;
    const sign = (h & 1) === 0 ? 1 : -1;
    v[idx] = (v[idx] ?? 0) + sign;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < dim; i += 1) v[i] = (v[i] ?? 0) * inv;
  }
  return v;
}

/** An {@link EmbedFn} backed by {@link hashEmbed} — the zero-setup default. */
export function hashingEmbedFn(dim: number = DEFAULT_HASH_DIM): EmbedFn {
  return (texts) => Promise.resolve(texts.map((t) => hashEmbed(t, dim)));
}
