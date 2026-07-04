/**
 * WS-D D2 — tiered model catalog: role → concrete Ollama model, per detected
 * hardware tier. Values are ADVISORY defaults (spec Decision 6) — re-verify the
 * current best models at build time. This is deliberately a plain data table so
 * it is trivial to edit without touching routing logic.
 *
 * Smaller tiers get smaller quantized models; P_CPU uses the smallest viable
 * models so the feature degrades rather than disappears. Embedding + reranker
 * models are tier-independent (they are small) but live here for one source of
 * truth.
 */

import { type HardwareTier, type Role, HardwareTier as Tier } from "../interfaces/inference.js";

/** Concrete model ids per role, for one tier. */
export type RoleModels = Readonly<Record<Role, string>>;

export interface TierCatalogEntry {
  readonly chat: RoleModels;
  /** Model for `embed(_, "text")`. */
  readonly textEmbed: string;
  /** Model for `embed(_, "code")`. */
  readonly codeEmbed: string;
}

// Advisory defaults — Qwen2.5 / Llama3.x / Gemma2 families at Q4-class quant.
// Re-verify at build time (spec Decision 6).
const P_CPU: TierCatalogEntry = {
  chat: {
    summarizer: "qwen2.5:1.5b",
    extractor: "qwen2.5:1.5b",
    classifier: "qwen2.5:1.5b",
    drafter: "qwen2.5:1.5b",
    judge: "qwen2.5:3b",
  },
  textEmbed: "nomic-embed-text",
  codeEmbed: "nomic-embed-text",
};

const P_MIN: TierCatalogEntry = {
  chat: {
    summarizer: "qwen2.5:3b",
    extractor: "qwen2.5:3b",
    classifier: "qwen2.5:3b",
    drafter: "llama3.2:3b",
    judge: "qwen2.5:7b",
  },
  textEmbed: "bge-m3",
  codeEmbed: "nomic-embed-text",
};

const P_MID: TierCatalogEntry = {
  chat: {
    summarizer: "qwen2.5:7b",
    extractor: "qwen2.5:7b",
    classifier: "qwen2.5:7b",
    drafter: "llama3.1:8b",
    judge: "qwen2.5:14b",
  },
  textEmbed: "bge-m3",
  codeEmbed: "bge-m3",
};

const P_MAX: TierCatalogEntry = {
  chat: {
    summarizer: "qwen2.5:14b",
    extractor: "qwen2.5:14b",
    classifier: "qwen2.5:14b",
    drafter: "qwen2.5:14b",
    judge: "qwen2.5:32b",
  },
  textEmbed: "bge-m3",
  codeEmbed: "bge-m3",
};

const CATALOG: Readonly<Record<HardwareTier, TierCatalogEntry>> = Object.freeze({
  [Tier.PCpu]: P_CPU,
  [Tier.PMin]: P_MIN,
  [Tier.PMid]: P_MID,
  [Tier.PMax]: P_MAX,
});

/** The catalog entry for a tier. */
export function catalogForTier(tier: HardwareTier): TierCatalogEntry {
  return CATALOG[tier];
}

/** Concrete chat model for a role at a tier. */
export function chatModelFor(tier: HardwareTier, role: Role): string {
  return CATALOG[tier].chat[role];
}

/** Concrete embedding model for a kind at a tier. */
export function embedModelFor(tier: HardwareTier, kind: "text" | "code"): string {
  const entry = CATALOG[tier];
  return kind === "code" ? entry.codeEmbed : entry.textEmbed;
}

/** Every distinct model a tier needs (for pull-on-demand pre-checks). */
export function modelsForTier(tier: HardwareTier): readonly string[] {
  const entry = CATALOG[tier];
  return [...new Set([...Object.values(entry.chat), entry.textEmbed, entry.codeEmbed])];
}
