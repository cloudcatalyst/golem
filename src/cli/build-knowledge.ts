/**
 * CLI integration glue (task B3): assemble a real KnowledgeBase from the WS-C
 * store + WS-D local inference, so `golem mcp serve`, `golem index`, and
 * `golem devices` share one construction path.
 *
 * Embedder selection (zero-setup by default): if Ollama is reachable AND the
 * tier's embedding model is pulled, use the SEMANTIC bge-m3 embedder (WS-D C3);
 * otherwise fall back to the pure-TS hashing embedder (LEXICAL) so `search`
 * works out of the box with no model download. The choice is made ONCE here so an
 * index is never built with mixed embedders. The durable FileVectorDriver
 * persists under `<project>/.golem/knowledge`, so an index survives across
 * sessions (§26 refinement).
 */

import { HeadroomMemorySidecar } from "../compression/headroom-adapter.js";
import { loadConfig } from "../config/index.js";
import {
  type CapabilityFacts,
  createProbeRunner,
  detectCapability,
  embedModelFor,
  OllamaClient,
  OllamaInferenceService,
} from "../inference/index.js";
import type { InferenceService, KnowledgeBase } from "../interfaces/index.js";
import { hashingEmbedFn, openKnowledgeBase } from "../knowledge/index.js";

export type EmbedMode = "semantic" | "lexical";

export interface KnowledgeStack {
  readonly knowledge: KnowledgeBase;
  readonly inference: InferenceService;
  readonly facts: CapabilityFacts;
  /** Which embedder backs the KB this run: bge-m3 semantic, or hashing lexical. */
  readonly embedMode: EmbedMode;
}

export interface BuildKnowledgeOptions {
  readonly projectDir: string;
  /** Override the Ollama base URL (default: resolved config `inference.ollama_base_url`). */
  readonly ollamaBaseUrl?: string;
}

/**
 * Is Ollama reachable AND is `model` pulled? A short GET to `/api/tags` — never
 * throws, resolves false on any timeout/error (Ollama absent is the common,
 * non-error case). Matches by name prefix so `bge-m3` matches `bge-m3:latest`.
 */
export async function ollamaHasModel(baseUrl: string, model: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("/api/tags", baseUrl), {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { models?: Array<{ name?: unknown }> };
    return (body.models ?? []).some((m) => typeof m.name === "string" && m.name.startsWith(model));
  } catch {
    return false;
  }
}

/**
 * Build the local inference service + knowledge base for a project. Resolves
 * config for the Ollama endpoint, detects the hardware tier once, and picks the
 * embedder by probing Ollama. Never throws for Ollama being offline.
 */
export async function buildKnowledgeStack(options: BuildKnowledgeOptions): Promise<KnowledgeStack> {
  const { settings } = await loadConfig({ projectDir: options.projectDir });
  const baseUrl = options.ollamaBaseUrl ?? settings.inference.ollama_base_url;

  const client = new OllamaClient({
    baseUrl,
    requestTimeoutMs: settings.inference.request_timeout_ms,
  });
  const facts = await detectCapability(createProbeRunner());
  const inference = new OllamaInferenceService(client, facts);

  // Semantic only if the query embed model is actually available; else lexical.
  const textEmbedModel = embedModelFor(facts.tier, "text");
  const semantic = await ollamaHasModel(baseUrl, textEmbedModel);
  const embedMode: EmbedMode = semantic ? "semantic" : "lexical";

  // R3.6 (Decisions 13/18): opt-in MEMORY-scope federation via the Headroom
  // `[memory]` sidecar — a separate, heavier install than `headroom_sidecar`
  // (verification-notes §4), so it gets its own settings leaf and its own
  // sidecar process. Fails open (HeadroomMemorySidecar.search resolves null)
  // if the sidecar can't start, same as HeadroomSidecar's compress().
  const memorySearch = settings.knowledge.memory_federation_enabled
    ? new HeadroomMemorySidecar()
    : undefined;

  const knowledge = openKnowledgeBase({
    projectDir: options.projectDir,
    // Choose ONE embedder for the whole index (mixing spaces would corrupt it).
    ...(semantic ? { inference } : { embed: hashingEmbedFn() }),
    syntaxAwareChunking: settings.knowledge.syntax_aware_chunking,
    ...(memorySearch !== undefined ? { memorySearch } : {}),
  });

  return { knowledge, inference, facts, embedMode };
}
