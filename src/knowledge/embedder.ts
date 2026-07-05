/**
 * WS-C C3 — real embeddings for the KnowledgeBase, via the WS-D InferenceService.
 *
 * `InferenceService.embed(texts, kind)` already matches the KB's `EmbedFn`
 * signature (text vs code → tier-appropriate embedding model from the catalog),
 * so this is a thin adapter. Rerank is deferred (verification-notes §29): the
 * frozen InferenceService exposes no rerank method, so cross-encoder reranking
 * is a later enhancement; search stays cosine-ranked for now.
 *
 * If local inference is unavailable (no Ollama), `embed` rejects with the
 * service's own error — ingest/search then surface that rather than silently
 * indexing nothing. That is the documented degradation.
 */

import type { InferenceService } from "../interfaces/inference.js";
import type { EmbedFn } from "./knowledge-base.js";

/** Build a KB EmbedFn backed by a WS-D InferenceService. */
export function inferenceEmbedFn(service: InferenceService): EmbedFn {
  return async (texts, kind) => {
    const vectors = await service.embed(texts, kind);
    // Copy into mutable number[][] (InferenceService returns readonly vectors).
    return vectors.map((v) => Array.from(v));
  };
}
