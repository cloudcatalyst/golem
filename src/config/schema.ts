/**
 * Golem settings schema (E1).
 *
 * The settings file shape is a flat two-level object: `section.key`, with
 * snake_case keys (CLAUDE.md convention). Every leaf is described once in
 * {@link SETTINGS_LEAVES}; the loader, env mapping, and `writeSetting` all
 * derive their behavior from that single table, so adding a key means adding
 * one leaf schema + one default + one interface field.
 *
 * Key set (spec-derived where the spec speaks; noted otherwise):
 * - `slider.level` (0–3, Decision 30) — spec §4 / interfaces/policy.ts.
 * - `proxy.*` — port, upstream base URL, timeouts. The spec is silent on the
 *   concrete values; defaults chosen here (see DEFAULT_SETTINGS) and recorded
 *   in docs/verification-notes.md §17.
 * - `inference.ollama_base_url` — spec §6 (Ollama default backend,
 *   URL-addressable for LAN offload, Decision 12).
 * - `knowledge.*` — enabled toggle, optional external vector-DB URL (spec §6:
 *   embedded store by default, Qdrant server mode via config URL), watch paths.
 * - `telemetry.*` — enabled toggle + dashboard port (spec §5).
 *
 * Section names MUST be single snake_case tokens without underscores — the
 * `GOLEM_<SECTION>_<KEY>` env mapping splits on the first underscore after
 * the prefix (see env.ts).
 */

import { z } from "zod";
import { migrateSliderLevel, type SliderLevel } from "../interfaces/policy.js";

const portSchema = z.number().int().min(1).max(65535);
const timeoutMsSchema = z.number().int().positive();

/**
 * One zod schema per settings leaf. This table is the single source of truth
 * for which keys exist and how their values validate/coerce.
 */
export const SETTINGS_LEAVES = {
  slider: {
    /**
     * Global quality/savings level 0–3 (interfaces/policy.ts, Decision 30):
     * off / lossless / balanced / aggressive. Legacy 0–5 values on disk are
     * accepted and remapped onto 0–3 via {@link migrateSliderLevel} so old
     * settings files keep loading (5→3, 4→3, 2→1, …).
     */
    level: z.number().int().min(0).max(5).transform(migrateSliderLevel),
  },
  proxy: {
    /** Local port the Anthropic-compatible proxy listens on. */
    port: portSchema,
    /** Upstream Anthropic-compatible API base URL. */
    upstream_base_url: z.string().url(),
    /** End-to-end request timeout (generous: long SSE streams). */
    request_timeout_ms: timeoutMsSchema,
    /** Upstream TCP/TLS connect timeout. */
    connect_timeout_ms: timeoutMsSchema,
  },
  inference: {
    /** OpenAI-compatible local inference endpoint (Ollama default). */
    ollama_base_url: z.string().url(),
  },
  compression: {
    /**
     * OPT-IN: run the Headroom semantic-compression sidecar at slider ≥2
     * (balanced/aggressive; spec Decision 23). Requires `uv` + `headroom-ai` on
     * the machine; off by
     * default because it adds a Python dependency (CLAUDE.md: no heavy deps by
     * default). Fails open if the sidecar can't start.
     */
    headroom_sidecar: z.boolean(),
    /**
     * OPT-IN, research-only (R2.6, verification-notes §58/§59): bypass the
     * Decision-31 gate that keeps the lossy semantic stage off Anthropic-style
     * caching upstreams, so it can be A/B'd there instead of assumed
     * net-negative. Has no effect unless `headroom_sidecar` is also on and the
     * slider is ≥2. Off by default — flipping it risks the cached-prefix cost
     * cliff (verification-notes §14) until proven net-safe by a real
     * `aggregateUsageBySemanticForced` comparison.
     */
    force_semantic_on_caching: z.boolean(),
  },
  knowledge: {
    /** Master toggle for the vector knowledge base. */
    enabled: z.boolean(),
    /** Optional external vector-DB URL (e.g. Qdrant server); embedded store when unset. */
    vector_db_url: z.string().url().optional(),
    /** Paths auto-ingested and watched for changes. */
    watch_paths: z.array(z.string()),
    /**
     * Project wiki directory (spec Decision 28): the durable, committable
     * knowledge store. Relative values are project-rooted; absolute values are
     * used as-is. Auto-indexed like any other watched path.
     */
    wiki_dir: z.string(),
    /**
     * OPT-IN (R2.3, spec Decision 24 sub-mode 2 / Decision 33): the
     * proxy-as-responder local-answer sub-mode. Independent of `slider.level`
     * (Decision 31 — the slider stays a pure compression dial); off by
     * default because a served answer is un-reviewed until this has real
     * usage evidence (see Decision 33's honest evidence-basis note).
     */
    local_answer_enabled: z.boolean(),
    /**
     * Minimum KB hit score required before `local_answer_enabled` will serve
     * an answer instead of falling through to the upstream. Unvalidated
     * starting point — see `src/knowledge/local-answer.ts`'s
     * `DEFAULT_MIN_CONFIDENCE` doc comment.
     */
    local_answer_min_confidence: z.number().min(0).max(1),
    /**
     * OPT-IN (R3.3): syntax-aware code chunking via `web-tree-sitter` (WASM,
     * TS/JS/TSX grammars). Off by default because the runtime + grammars are
     * a separate, user-installed opt-in — never a `golem-run` dependency
     * (CLAUDE.md: no heavyweight deps in the default install; verification-
     * notes §27 rejects native tree-sitter bindings for the default). Falls
     * back to the heuristic `chunkCode` when the packages aren't installed.
     */
    syntax_aware_chunking: z.boolean(),
    /**
     * OPT-OUT (R3.4, spec Decision 20e's local/P1 tier): federate the
     * user-scope wiki (`~/.golem/wiki/`) into `search`/`fetch` alongside this
     * project's own wiki, read-only. On by default — set false if a user
     * doesn't want personal notes bleeding into a project's search results.
     */
    user_wiki_enabled: z.boolean(),
  },
  telemetry: {
    /** Master toggle for local telemetry collection (savings attribution). */
    enabled: z.boolean(),
    /** Port for the local savings dashboard. */
    dashboard_port: portSchema,
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, z.ZodTypeAny>>>>;

export type SectionName = keyof typeof SETTINGS_LEAVES;

export const SECTION_NAMES = Object.keys(SETTINGS_LEAVES) as readonly SectionName[];

/** Look up the leaf schema for a `section.key` pair; undefined if unknown. */
export function leafSchema(section: string, key: string): z.ZodTypeAny | undefined {
  const sectionLeaves = (SETTINGS_LEAVES as Record<string, Record<string, z.ZodTypeAny>>)[section];
  return sectionLeaves?.[key];
}

/** All leaf paths as dotted `section.key` strings (stable declaration order). */
export function allLeafPaths(): readonly string[] {
  const paths: string[] = [];
  for (const section of SECTION_NAMES) {
    for (const key of Object.keys(SETTINGS_LEAVES[section])) {
      paths.push(`${section}.${key}`);
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Typed settings object (snake_case, mirroring the on-disk shape).
// ---------------------------------------------------------------------------

export interface SliderSettings {
  readonly level: SliderLevel;
}

export interface ProxySettings {
  readonly port: number;
  readonly upstream_base_url: string;
  readonly request_timeout_ms: number;
  readonly connect_timeout_ms: number;
}

export interface InferenceSettings {
  readonly ollama_base_url: string;
}

export interface CompressionSettings {
  readonly headroom_sidecar: boolean;
  readonly force_semantic_on_caching: boolean;
}

export interface KnowledgeSettings {
  readonly enabled: boolean;
  readonly vector_db_url?: string;
  readonly watch_paths: readonly string[];
  readonly wiki_dir: string;
  readonly local_answer_enabled: boolean;
  readonly local_answer_min_confidence: number;
  readonly syntax_aware_chunking: boolean;
  readonly user_wiki_enabled: boolean;
}

export interface TelemetrySettings {
  readonly enabled: boolean;
  readonly dashboard_port: number;
}

export interface GolemSettings {
  readonly slider: SliderSettings;
  readonly proxy: ProxySettings;
  readonly inference: InferenceSettings;
  readonly compression: CompressionSettings;
  readonly knowledge: KnowledgeSettings;
  readonly telemetry: TelemetrySettings;
}

/**
 * Built-in defaults (the lowest layer). Where the spec is silent the choice is
 * recorded in docs/verification-notes.md §17:
 * - proxy.port 4653 / telemetry.dashboard_port 4654 ("GOLE" on a phone keypad).
 * - slider.level 1 (lossless-only: byte-faithful with real savings, spec P0 DoD).
 * - upstream https://api.anthropic.com; Ollama http://localhost:11434.
 */
export const DEFAULT_SETTINGS: GolemSettings = deepFreeze({
  slider: {
    level: 1,
  },
  proxy: {
    port: 4653,
    upstream_base_url: "https://api.anthropic.com",
    request_timeout_ms: 600_000,
    connect_timeout_ms: 10_000,
  },
  inference: {
    ollama_base_url: "http://localhost:11434",
  },
  compression: {
    headroom_sidecar: false,
    force_semantic_on_caching: false,
  },
  knowledge: {
    enabled: true,
    watch_paths: [],
    wiki_dir: "docs/wiki",
    local_answer_enabled: false,
    local_answer_min_confidence: 0.6,
    syntax_aware_chunking: false,
    user_wiki_enabled: true,
  },
  telemetry: {
    enabled: true,
    dashboard_port: 4654,
  },
});

/** Recursively freeze an object graph (arrays included). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
