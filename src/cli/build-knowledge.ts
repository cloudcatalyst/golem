/**
 * CLI integration glue (task B3): assemble a real KnowledgeBase from the WS-C
 * store + WS-D local inference, so `golem mcp serve`, `golem index`, and
 * `golem devices` share one construction path.
 *
 * Embedder selection (zero-setup by default): if Ollama is reachable AND an
 * embedding model is pulled, use the SEMANTIC embedder (WS-D C3); otherwise fall
 * back to the pure-TS hashing embedder (LEXICAL) so `search` works out of the box
 * with no model download. WHICH semantic model is decided by `planBuildEmbedder`
 * (R10.6): an existing index's own embedder outranks the detected hardware tier's,
 * because the tier is a probe that degrades on failure and the index's embedder is
 * a recorded fact. The choice is made ONCE here so an index is never built with
 * mixed embedders. The durable FileVectorDriver persists under
 * `<project>/.golem/knowledge`, so an index survives across sessions (§26
 * refinement).
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
import { planBuildEmbedder, resolvePersistedEmbedder } from "./auto-index.js";

export type EmbedMode = "semantic" | "lexical";

export interface KnowledgeStack {
  readonly knowledge: KnowledgeBase;
  /**
   * Local inference for CHAT, on the detected tier. Never the pinned embedder
   * service: pinning is a fact about this project's index, not about what this
   * machine can run (R10.6, mirroring the proxy's R10.4 split).
   */
  readonly inference: InferenceService;
  readonly facts: CapabilityFacts;
  /** Which embedder backs the KB this run: bge-m3 semantic, or hashing lexical. */
  readonly embedMode: EmbedMode;
  /**
   * R10.6 — the embed model actually backing `knowledge`; null for the lexical
   * hashing embedder. Pass to `ensureProjectIndexed`/`writeManifest` so the
   * manifest records the embedder that really wrote the vectors.
   */
  readonly embedModel: string | null;
  /**
   * R10.6 — one user-facing line, present ONLY when this build departs from the
   * tier's embedder or changes an existing index's vector space. Callers MUST
   * surface it: making that case visible is the entire point.
   */
  readonly notice?: string;
}

export interface BuildKnowledgeOptions {
  readonly projectDir: string;
  /** Override the Ollama base URL (default: resolved config `inference.ollama_base_url`). */
  readonly ollamaBaseUrl?: string;
  /** Collection to check for an existing embedder (default: `projectDir`, as every caller indexes). */
  readonly projectId?: string;
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

  // R10.6: choose the embedder by INDEX IDENTITY first, detected tier second —
  // the build-side counterpart of R10.4's query rule. The old code asked only
  // "is the tier's embed model available?", so a capability probe that hiccupped
  // (it degrades to the CPU tier, it never throws) re-pointed the tier at a
  // 768-dim model, changed the signature, and silently re-embedded every chunk
  // of a 1024-dim index at the narrower width. See `planBuildEmbedder` for why
  // narrowing is refused while widening is not.
  const plan = await planBuildEmbedder(
    await resolvePersistedEmbedder(options.projectDir, options.projectId ?? options.projectDir),
    embedModelFor(facts.tier, "text"),
    (model) => ollamaHasModel(baseUrl, model),
  );
  const semantic = plan.action !== "lexical";
  const embedMode: EmbedMode = semantic ? "semantic" : "lexical";
  const embedModel = plan.action === "lexical" ? null : plan.model;
  // Only a PIN needs to override the catalog: the other plans already resolve to
  // the tier's own model. Both kinds are pinned together — one index is one
  // vector space, so its text and code chunks must come from one model.
  const embedInference =
    plan.action === "pin"
      ? new OllamaInferenceService(client, facts, {
          embedModels: { text: plan.model, code: plan.model },
        })
      : inference;

  // R3.6 (Decisions 13/18): opt-in MEMORY-scope federation via the Headroom
  // `[memory]` sidecar — a separate, heavier install than `headroom_sidecar`
  // (verification-notes §4), so it gets its own settings leaf and its own
  // sidecar process. Fails open (HeadroomMemorySidecar.search resolves null)
  // if the sidecar can't start, same as HeadroomSidecar's compress().
  // `projectDir` stamps the worker's command line with its owning project, so a
  // stray one can later be reaped without touching another project's (R10.3).
  const memorySearch = settings.knowledge.memory_federation_enabled
    ? new HeadroomMemorySidecar({ projectDir: options.projectDir })
    : undefined;

  const knowledge = openKnowledgeBase({
    projectDir: options.projectDir,
    // Choose ONE embedder for the whole index (mixing spaces would corrupt it).
    ...(semantic ? { inference: embedInference } : { embed: hashingEmbedFn() }),
    syntaxAwareChunking: settings.knowledge.syntax_aware_chunking,
    ...(memorySearch !== undefined ? { memorySearch } : {}),
  });

  return {
    knowledge,
    inference,
    facts,
    embedMode,
    embedModel,
    ...(plan.action !== "use-current" && plan.notice !== undefined ? { notice: plan.notice } : {}),
  };
}
