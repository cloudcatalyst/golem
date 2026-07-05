/**
 * CLI integration glue (task B3): assemble a real KnowledgeBase from the WS-C
 * store + WS-D local inference, so `golem mcp serve`, `golem index`, and
 * `golem devices` share one construction path.
 *
 * The embedder is WS-D's Ollama-backed InferenceService (C3): capability is
 * detected once (cheap, degrades to CPU tier), and the durable pure-TS
 * FileVectorDriver persists the index under `<project>/.golem/knowledge`, so an
 * index built in one session is found by the next (§26 refinement; LanceDB stays
 * the optional scale upgrade). Building this NEVER contacts Ollama; only an
 * actual search/ingest embeds, so failures (endpoint down, model not pulled)
 * surface at call time as actionable tool errors, not at startup.
 */

import { loadConfig } from "../config/index.js";
import {
  type CapabilityFacts,
  createProbeRunner,
  detectCapability,
  OllamaClient,
  OllamaInferenceService,
} from "../inference/index.js";
import type { InferenceService, KnowledgeBase } from "../interfaces/index.js";
import { openKnowledgeBase } from "../knowledge/index.js";

export interface KnowledgeStack {
  readonly knowledge: KnowledgeBase;
  readonly inference: InferenceService;
  readonly facts: CapabilityFacts;
}

export interface BuildKnowledgeOptions {
  readonly projectDir: string;
  /** Override the Ollama base URL (default: resolved config `inference.ollama_base_url`). */
  readonly ollamaBaseUrl?: string;
}

/**
 * Build the local inference service + knowledge base for a project. Resolves
 * config for the Ollama endpoint (unless overridden) and detects the hardware
 * tier once. Throws only on genuinely broken config (e.g. an unsupported
 * `knowledge.vector_db_url` server driver); Ollama being offline is not an error
 * here — it surfaces when a tool actually embeds.
 */
export async function buildKnowledgeStack(options: BuildKnowledgeOptions): Promise<KnowledgeStack> {
  const { settings } = await loadConfig({ projectDir: options.projectDir });
  const baseUrl = options.ollamaBaseUrl ?? settings.inference.ollama_base_url;

  const client = new OllamaClient({ baseUrl });
  const facts = await detectCapability(createProbeRunner());
  const inference = new OllamaInferenceService(client, facts);

  const knowledge = openKnowledgeBase({
    projectDir: options.projectDir,
    inference,
    // vector_db_url (Qdrant server) is not implemented yet (§26); passing it
    // would throw at open time, so the embedded default is used until the
    // native/server driver lands. Config toggle stays honest via `golem status`.
  });

  return { knowledge, inference, facts };
}
