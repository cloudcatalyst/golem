/**
 * R3.1 (spec Decision 34) — optional chat-judge rerank of `search` hits via
 * the local "judge" role, using the already-frozen `InferenceService.chat()`
 * + `jsonSchema` mechanism (see `distill.ts`) rather than a new reranker
 * interface. Decoupled from `slider.level` (Decision 31: the slider never
 * auto-engages the local model) via the independent `knowledge.rerank_enabled`
 * setting.
 *
 * Unlike `distillPage` et al., a rerank failure must never turn an already-
 * successful search into an error: any problem here (unreachable model,
 * malformed JSON, invented or dropped chunkIds) falls back to the pre-rerank
 * order instead of throwing.
 */

import { z } from "zod";
import type { ChatMessage, InferenceService } from "../interfaces/inference.js";
import type { Hit } from "../interfaces/knowledge.js";

const MAX_CHUNK_PREVIEW_CHARS = 300;

const RERANK_JSON_SCHEMA = {
  name: "rerank_order",
  schema: {
    type: "object",
    properties: {
      order: {
        type: "array",
        items: { type: "string" },
        description:
          "Every chunkId from the candidate list, copied verbatim, reordered from most to " +
          "least relevant to the query.",
      },
    },
    required: ["order"],
  },
} as const;

const rerankResultSchema = z.object({
  order: z.array(z.string()),
});

function buildPrompt(query: string, hits: readonly Hit[]): ChatMessage[] {
  const candidates = hits
    .map(
      (hit, i) =>
        `${i + 1}. chunkId=${hit.chunk.chunkId}\n${hit.chunk.text.slice(0, MAX_CHUNK_PREVIEW_CHARS)}`,
    )
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        "You judge search result relevance. Given a query and a numbered list of candidate " +
        "chunks (each with a chunkId), return every chunkId from the list, reordered from most " +
        "to least relevant to the query. Copy chunkIds verbatim — never invent one, never drop one.",
    },
    {
      role: "user",
      content: `Query: ${query}\n\nCandidates:\n${candidates}`,
    },
  ];
}

/**
 * Reorder `hits` by chat-judge relevance to `query`. Falls back to the
 * original order — unchanged, never throws — on any failure: unreachable
 * model, malformed JSON, or a response that doesn't account for every
 * original chunkId exactly once. 0 or 1 hits short-circuit without a model call.
 */
export async function rerankHits(
  inference: InferenceService,
  query: string,
  hits: readonly Hit[],
): Promise<Hit[]> {
  if (hits.length <= 1) {
    return [...hits];
  }
  try {
    const result = await inference.chat("judge", buildPrompt(query, hits), {
      jsonSchema: RERANK_JSON_SCHEMA,
    });
    const parsed = rerankResultSchema.safeParse(JSON.parse(result.text));
    if (!parsed.success) {
      return [...hits];
    }
    const byId = new Map(hits.map((hit) => [hit.chunk.chunkId, hit]));
    const seen = new Set<string>();
    const reordered: Hit[] = [];
    for (const id of parsed.data.order) {
      const hit = byId.get(id);
      if (hit !== undefined && !seen.has(id)) {
        seen.add(id);
        reordered.push(hit);
      }
    }
    // The model must account for every original hit exactly once; a dropped
    // or invented chunkId means the ordering isn't trustworthy.
    if (reordered.length !== hits.length) {
      return [...hits];
    }
    return reordered;
  } catch {
    return [...hits];
  }
}
