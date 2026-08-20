/**
 * Presentation metadata for the settings schema — the layer that lets a UI
 * render Golem's config without hard-coding a label for every key.
 *
 * [schema.ts]{@link ./schema.ts} owns *validation* ({@link SETTINGS_LEAVES}: one
 * zod schema per leaf) and carries rich prose in its doc comments — but comments
 * are invisible at runtime, so every UI would otherwise re-type them. This module
 * adds the runtime-introspectable half:
 *
 * - {@link SETTING_META} — label / summary / detail / grouping hints, keyed by the
 *   same dotted `section.key` paths. It is `satisfies`-checked against a mapped
 *   type over {@link SETTINGS_LEAVES}, so adding a leaf without describing it is a
 *   COMPILE error and the two tables cannot drift.
 * - {@link deriveKind} — the widget kind, DERIVED from the leaf's zod schema
 *   (boolean → toggle, enum → picker, `.url()` → url, …) so a type change can't
 *   leave a stale widget behind. `SettingMeta.kind` overrides it only where zod
 *   can't express the intent (a hex colour is just a string).
 *
 * The settings loader, env mapping, and `writeSetting` are untouched by this file:
 * precedence and provenance already work (see loader.ts). This is presentation
 * only, and `src/config/control-surface.ts` is what UIs actually consume.
 */

import { z } from "zod";
import { SECTION_NAMES, type SETTINGS_LEAVES, type SectionName } from "./schema.js";

// ---------------------------------------------------------------------------
// Leaf paths as a literal union (so the meta table is exhaustively checked).
// ---------------------------------------------------------------------------

type LeafPathsOf<T> = {
  [S in keyof T & string]: `${S}.${keyof T[S] & string}`;
}[keyof T & string];

/** Every valid dotted `section.key`, as a literal union. */
export type LeafPath = LeafPathsOf<typeof SETTINGS_LEAVES>;

// ---------------------------------------------------------------------------
// Widget kinds, derived from zod.
// ---------------------------------------------------------------------------

/**
 * How a UI should render a leaf. `opaque` means "show the value, don't offer to
 * edit it here" — structured values (the account registry) that a dedicated
 * command owns.
 */
export type SettingKind =
  | "toggle"
  | "number"
  | "text"
  | "url"
  | "enum"
  | "list"
  | "color"
  | "opaque";

/**
 * Strip the wrappers that don't change how a value is edited — `.optional()`,
 * `.default()`, and `.transform()` (ZodEffects, e.g. slider.level's legacy
 * remap) — down to the schema that describes the value itself.
 */
export function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodTypeAny;
    } else if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as z.ZodTypeAny;
    } else if (current instanceof z.ZodEffects) {
      current = current.innerType() as z.ZodTypeAny;
    } else {
      return current;
    }
  }
}

/** True when a string schema carries zod's `.url()` check. */
function isUrlString(schema: z.ZodString): boolean {
  return schema._def.checks.some((check) => check.kind === "url");
}

/**
 * The widget kind implied by a leaf's zod schema. Callers should prefer
 * {@link settingKind}, which lets {@link SettingMeta.kind} override this.
 */
export function deriveKind(schema: z.ZodTypeAny): SettingKind {
  const base = unwrapSchema(schema);
  if (base instanceof z.ZodBoolean) return "toggle";
  if (base instanceof z.ZodEnum) return "enum";
  if (base instanceof z.ZodNumber) return "number";
  if (base instanceof z.ZodString) return isUrlString(base) ? "url" : "text";
  if (base instanceof z.ZodArray) {
    // A list of plain strings is editable as comma-separated text; anything
    // richer (the account registry's objects) is not.
    return unwrapSchema(base.element as z.ZodTypeAny) instanceof z.ZodString ? "list" : "opaque";
  }
  return "opaque";
}

/** The allowed values for an `enum` leaf, in declaration order; undefined otherwise. */
export function enumOptionsFor(schema: z.ZodTypeAny): readonly string[] | undefined {
  const base = unwrapSchema(schema);
  return base instanceof z.ZodEnum ? (base.options as readonly string[]) : undefined;
}

/** Inclusive numeric bounds a UI can clamp/validate against, when zod declares them. */
export function numericRangeFor(
  schema: z.ZodTypeAny,
): { readonly min?: number; readonly max?: number; readonly int: boolean } | undefined {
  const base = unwrapSchema(schema);
  if (!(base instanceof z.ZodNumber)) return undefined;
  let min: number | undefined;
  let max: number | undefined;
  let int = false;
  for (const check of base._def.checks) {
    if (check.kind === "min") min = check.value;
    else if (check.kind === "max") max = check.value;
    else if (check.kind === "int") int = true;
  }
  return {
    ...(min !== undefined && { min }),
    ...(max !== undefined && { max }),
    int,
  };
}

// ---------------------------------------------------------------------------
// The metadata table.
// ---------------------------------------------------------------------------

export interface SettingMeta {
  /** Short human name for the row (sentence case, no trailing period). */
  readonly label: string;
  /** One line of "what does this do", shown next to or under the label. */
  readonly summary: string;
  /** Longer help text for a detail pane / tooltip. */
  readonly detail?: string;
  /** Hide behind "show advanced" — correct-by-default keys nobody should need. */
  readonly advanced?: boolean;
  /** Loud warning to show before and after changing this (e.g. redaction off). */
  readonly danger?: string;
  /** What must restart for a change to take effect. */
  readonly restart?: "proxy" | "mcp";
  /**
   * Another control id owns this key's editing UI (so it isn't listed twice with
   * two different affordances). The Settings group omits these; the named
   * control edits the same underlying key.
   */
  readonly ownedBy?: string;
  /** Override {@link deriveKind} where zod can't express the intent. */
  readonly kind?: SettingKind;
}

/**
 * One entry per settings leaf. Prose here is condensed from schema.ts's doc
 * comments — that file stays the authority on *why* a default is what it is.
 */
export const SETTING_META = {
  // --- proxy ----------------------------------------------------------------
  "proxy.bypass_all": {
    label: "Bypass everything (no redaction)",
    summary: "Forward every request byte-faithfully — redaction included in what is skipped",
    detail:
      "R11.1 / ADR-0004: the explicit home for what slider level 0 used to mean. It is a " +
      "setting of its own, not a compression value, because compression and redaction are " +
      "different guarantees — `compression off` still redacts. Never the default; a tool " +
      "call cannot set it (R8.33), only the CLI or this panel.",
    danger:
      "This disables REDACTION: secrets and PII reach the upstream unredacted. If you want " +
      "no compression but still want redaction, set compression to `off` instead.",
    restart: "proxy",
  },
  "proxy.port": {
    label: "Proxy port",
    summary: "Local port the Anthropic-compatible proxy listens on",
    detail: "Claude Code's ANTHROPIC_BASE_URL points here. `golem init` wires it per project.",
    restart: "proxy",
  },
  "proxy.upstream_base_url": {
    label: "Upstream base URL",
    summary: "Where the proxy forwards requests",
    detail: "Overridden by the active account, if one is set.",
    restart: "proxy",
  },
  "proxy.upstream_provider": {
    label: "Upstream provider",
    summary: "Which API dialect the upstream speaks",
    detail:
      "Selects auth-header mapping and the caching assumption. `anthropic` is the " +
      "byte-faithful passthrough; openai/ollama/openrouter are translated.",
    restart: "proxy",
  },
  "proxy.upstream_auth_scheme": {
    label: "Upstream auth scheme",
    summary: "How the credential is presented (inherit / x-api-key / api-key / bearer)",
    detail:
      "`inherit` forwards the client's own auth unchanged. The credential itself is " +
      "never a setting — use `golem gateway login`.",
    advanced: true,
    restart: "proxy",
  },
  "proxy.upstream_model": {
    label: "Upstream model",
    summary: "Model id to send to a translating (OpenAI-schema) upstream",
    detail: "Ignored by Anthropic-protocol providers, which receive the model as-is.",
    restart: "proxy",
  },
  "proxy.upstream_reasoning_effort": {
    label: "Reasoning effort",
    summary: "Depth for a reasoning upstream (sent as OpenAI reasoning_effort)",
    detail: "Leave unset for non-reasoning backends — some reject the field.",
    advanced: true,
    restart: "proxy",
  },
  "proxy.map_reasoning_to_thinking": {
    label: "Map reasoning to thinking blocks",
    summary: "Show a reasoning upstream's trace as Anthropic thinking blocks",
    advanced: true,
    restart: "proxy",
  },
  "proxy.default_target": {
    label: "Default target (deprecated)",
    summary: "Moved to inference.default_target",
    detail: "R9.23: use inference.default_target instead",
    restart: "proxy",
  },
  "proxy.gateways": {
    label: "Gateway registry",
    summary: "Non-secret upstream connection config — managed by `golem gateway`",
    detail:
      "Credentials live in the OS credential store, never here. Add and remove entries " +
      "with `golem gateway add` / `golem gateway remove`.",
    kind: "opaque",
  },
  "proxy.targets": {
    label: "Target registry",
    summary: "Every model Golem can reach, local or upstream — managed by `golem target`",
    detail:
      "A target is non-secret: it names a model id and a gateway reference. Several targets " +
      "may share one gateway. Inert until R9.2/R9.3 route on it. Entries in the gateway " +
      "registry already appear in `golem target list`.",
    kind: "opaque",
  },
  "inference.default_target": {
    label: "Default target",
    summary: "Which target serves a request that names none",
    detail:
      "Supersedes the retired `proxy.active_account`, which an existing settings file may " +
      "still name — R9.6's migration table reads it and says so. An unknown id fails closed. " +
      "R10.8: also step 3 of the `coder` dispatch chain (explicit target → worker_targets → " +
      "this → the harness's own upstream). Unset means the harness upstream; a local model " +
      "is reached by naming a target that points at it, never by leaving this blank.",
    advanced: true,
    restart: "proxy",
  },
  "proxy.request_timeout_ms": {
    label: "Request timeout",
    summary: "End-to-end request budget in ms (generous: long SSE streams)",
    advanced: true,
    restart: "proxy",
  },
  "proxy.connect_timeout_ms": {
    label: "Connect timeout",
    summary: "Upstream TCP/TLS connect budget in ms",
    advanced: true,
    restart: "proxy",
  },

  // --- inference ------------------------------------------------------------
  "inference.ollama_base_url": {
    label: "Local model endpoint",
    summary: "Ollama base URL — localhost or a LAN machine",
    detail: "`golem local url <url>` sets this after probing that it answers.",
    restart: "mcp",
  },
  "inference.request_timeout_ms": {
    label: "Local inference timeout",
    summary: "Per-request budget in ms for local generation and embeddings",
    detail:
      "Bounds the WHOLE completion (local generation here is non-streaming), so a cold " +
      "model load plus a grounded draft can legitimately take a minute-plus.",
    advanced: true,
  },
  "inference.worker_targets": {
    label: "Worker targets",
    summary: "Which target each tool worker (coder, …) drafts on by default",
    detail:
      "Keyed by worker name. R10.8: a worker with no entry falls through to " +
      "`inference.default_target` and then to the harness's own upstream — no longer to the " +
      "local model. A non-local target is redacted at its trust floor on every dispatch, and " +
      "an unknown target id fails closed. See `golem target list`.",
    kind: "opaque",
    restart: "mcp",
  },
  "inference.local_editor_enabled": {
    label: "Local editor mode",
    summary: 'Offer `coder`\'s `mode: "edit"` — a validated local rewrite of one small file',
    detail:
      "Off by default because the mode's schema costs ~313 tokens on EVERY request (§110), " +
      "while the saving only lands when it is used. Golem validates every edit (syntax must " +
      "still parse, no definition may disappear) and writes nothing unless `apply: true`. " +
      "Measured on ~10–40-line TypeScript files; bigger files are declined, not guessed at.",
    restart: "mcp",
  },
  "inference.providers": {
    label: "Local model providers",
    summary: "Provider table for role routing (coder/drafter/judge)",
    detail:
      "Each entry maps one endpoint + one or more models to a role. " +
      "The first model whose roles array includes the requested role wins. " +
      "Absent → Ollama + tier-catalog defaults.",
    advanced: true,
  },

  // --- compression ----------------------------------------------------------
  "compression.headroom_sidecar": {
    label: "Headroom semantic sidecar",
    summary: "Run the semantic-compression sidecar at level ≥2 (opt-in)",
    detail:
      "Requires `uv` + `headroom-ai` on the machine — off by default to keep Python out " +
      "of the core install. Fails open if the sidecar can't start.",
  },
  "compression.force_semantic_on_caching": {
    label: "Force semantic stage on caching upstreams",
    summary: "Research only — bypass the Decision-31 gate",
    detail:
      "No effect unless the Headroom sidecar is on and compression is ≥2. Risks the " +
      "cached-prefix cost cliff; only for A/B measurement.",
    advanced: true,
  },
  "compression.level": {
    label: "Compression level",
    summary: "off (redaction only) · 1 lossless · 2 balanced · 3 aggressive",
    detail:
      "R11.1: the input-side dial, set directly (ADR-0004 retired the slider). " +
      "until you set it back to auto. 0 is not offerable — passthrough belongs to the " +
      "slider, where turning redaction off is surfaced loudly.",
    restart: "proxy",
  },
  "compression.headroom_config": {
    label: "Headroom config passthrough",
    summary: "Advanced: opaque CompressConfig overrides forwarded to the sidecar",
    detail:
      "Decision 53. Deliberately not enumerated: the worker introspects the installed " +
      "Headroom and forwards whatever its CompressConfig accepts, so a new upstream option " +
      "works without a Golem release. Keys this Headroom does not accept are logged and " +
      "skipped, never forwarded. Layered over Golem's per-mode presets, and inert unless " +
      "the sidecar is on and the semantic stage actually runs.",
    kind: "opaque",
    advanced: true,
    restart: "proxy",
  },

  // --- brevity --------------------------------------------------------------
  "brevity.level": {
    label: "Brevity level",
    summary: "auto (follow the slider) · off · lite · full · ultra",
    detail:
      "Decision 52: the output-side dial. Appends a fixed brevity directive to the system " +
      "prompt so the model answers more tersely — it shortens replies, it does not " +
      "compress the request. Saves output tokens (never cached, ~5× input) and costs a " +
      "little input. Ships off: measure with `golem stats --brevity` before trusting it, " +
      "since it can go net-negative on already-terse work. Code, commands and errors are " +
      "always exempted.",
    restart: "proxy",
  },

  // --- knowledge ------------------------------------------------------------
  "knowledge.enabled": {
    label: "Vector knowledge base",
    summary: "Master switch for local search, ingest, and the web cache",
    restart: "mcp",
  },
  "knowledge.vector_db_url": {
    label: "External vector DB",
    summary: "Qdrant server URL; the embedded store is used when unset",
    advanced: true,
    restart: "mcp",
  },
  "knowledge.watch_paths": {
    label: "Watched paths",
    summary: "Directories auto-ingested and re-indexed on change",
  },
  "knowledge.auto_index_max_files": {
    label: "Auto-index file cap",
    summary: "Changed files the session-start sync embeds before it defers to `golem index`",
    detail:
      "Re-embedding is minutes of GPU time (measured: ~10 minutes for 114 files with bge-m3), " +
      "and a branch switch rewrites mtimes wholesale — so past this many changes the automatic " +
      "sync stops rather than starting a long job nobody asked for, and says how to run it. " +
      "0 removes the cap.",
    advanced: true,
    restart: "mcp",
  },
  "knowledge.wiki_dir": {
    label: "Wiki directory",
    summary: "The durable, committed knowledge store (Decision 28)",
    detail: "Relative values are project-rooted. Auto-indexed like any other watched path.",
  },
  "knowledge.local_answer_enabled": {
    label: "Answer locally from the wiki",
    summary: "Let the proxy answer retrieval-shaped questions without calling the model",
    detail:
      "Extractive prose quoted from the wiki/spec/docs — never generated. Single-turn, " +
      "confidence-gated, always labelled 'verify independently'. Declines rather than guess, " +
      "so coverage tracks how current the wiki is.",
    restart: "proxy",
  },
  "knowledge.local_answer_min_confidence": {
    label: "Local-answer confidence floor",
    summary: "Minimum KB score before an answer is served instead of the model",
    advanced: true,
    restart: "proxy",
  },
  "knowledge.syntax_aware_chunking": {
    label: "Syntax-aware code chunking",
    summary: "Chunk code by syntax via web-tree-sitter (opt-in, extra install)",
    detail: "Falls back to the heuristic chunker when the packages aren't installed.",
    advanced: true,
  },
  "knowledge.repo_map_enabled": {
    label: "Repo map tool",
    summary: "Offer the `code` tool: a graph-ranked signature map of the repo",
    detail:
      "Lets the model find the right file without reading the wrong ones. Needs the " +
      "optional tree-sitter packages; without them the tool reports no map. A tool " +
      "definition costs tokens on every request, so turn it off if unused.",
    restart: "mcp",
  },
  "knowledge.read_skeleton_enabled": {
    label: "Symbol skeleton on oversized reads",
    summary: "Add each definition and its line number to a swapped-out Read",
    detail: "Makes the cheap recovery a narrow re-read instead of expanding the whole original.",
    advanced: true,
  },
  "knowledge.lsp_enabled": {
    label: "LSP modes on the code tool",
    summary: "Offer diagnostics / definition / references / hover via a language server",
    detail:
      "You install the server (e.g. typescript-language-server); Golem only spawns it, and " +
      "reports why rather than failing when it is absent. Adds modes to the existing `code` " +
      "tool rather than new tools, but a wider schema still bills on every request.",
    restart: "mcp",
  },
  "knowledge.lsp_servers": {
    label: "Language server rows",
    summary: "Extra servers by file extension, layered over the built-in TypeScript row",
    detail: "How gopls or rust-analyzer are added — config, not a Golem release.",
    advanced: true,
    restart: "mcp",
  },
  "knowledge.lsp_timeout_ms": {
    label: "LSP request timeout",
    summary: "Budget for one language-server call before it degrades to a no-op",
    advanced: true,
    restart: "mcp",
  },
  "knowledge.user_wiki_enabled": {
    label: "Federate the user wiki",
    summary: "Include ~/.golem/wiki/ in search results, read-only",
    detail: "Turn off if personal notes shouldn't appear in this project's searches.",
  },
  "knowledge.rerank_enabled": {
    label: "Rerank search hits locally",
    summary: "Judge and reorder search hits with the local model (opt-in)",
    detail: "Adds a local-model call to every search, so it costs latency.",
  },
  "knowledge.memory_federation_enabled": {
    label: "MEMORY-scope federation",
    summary: "Federated memory search via the heavy Headroom [memory] sidecar (opt-in)",
    detail:
      "Pulls sentence-transformers and transitively torch — much heavier than the base " +
      "sidecar. Without it, search stays KNOWLEDGE-only.",
    advanced: true,
  },
  "knowledge.webcache_revalidate": {
    label: "Revalidate cached pages",
    summary: "Conditional-GET a cached URL before serving it",
    detail:
      "Adds a network round-trip to every WebFetch. When off, freshness is pure-TTL and a " +
      "changed page can be served stale until the TTL lapses.",
    advanced: true,
  },
  "knowledge.webcache_fetch_raw": {
    label: "Cache raw fetched pages",
    summary: "Cache the page itself, not Claude's prompt-specific WebFetch answer",
    detail:
      "Decision 42. A raw fetch that fails caches nothing (an honest miss) rather than " +
      "caching the answer.",
    advanced: true,
  },

  // --- telemetry ------------------------------------------------------------
  "telemetry.enabled": {
    label: "Local telemetry",
    summary: "Record savings attribution locally (never leaves the machine)",
  },
  "telemetry.dashboard_port": {
    label: "Dashboard port",
    summary: "Port for the local savings dashboard",
    advanced: true,
  },

  // --- ui -------------------------------------------------------------------
  "ui.pet": {
    label: "Show the pet",
    summary: "Draw the block-character mascot in the panel header",
    detail: "Turn off on terminals that can't render Unicode block elements.",
  },
  "ui.pet_color": {
    label: "Pet colour",
    summary: "Hex colour for the mascot",
    kind: "color",
  },
  "ui.color": {
    label: "Panel colour",
    summary: "auto respects the terminal · always forces · never renders plain",
  },
  "ui.advanced": {
    label: "Show advanced controls",
    summary: "Reveal rarely-touched controls when the panel opens",
  },

  // --- models ---------------------------------------------------------------
  "models.catalog_url": {
    label: "Model catalog URL",
    summary: "models.dev-shaped price/context catalog `golem models refresh` fetches",
    detail:
      "Nothing fetches it implicitly — a cost report never makes a network call. Golem's " +
      "own built-in prices always win, so a wrong third-party figure cannot reach a cost claim.",
    advanced: true,
  },
  "models.catalog_max_age_days": {
    label: "Catalog staleness warning",
    summary: "Days before price data is labelled stale",
    detail: "The warning labels the number; it never suppresses or adjusts it.",
    advanced: true,
  },
  "models.context_warn_fraction": {
    label: "Context warning threshold",
    summary: "Fraction of the model's context window at which `golem stats --context` warns",
    detail: "Only fires when the catalog knows the window — an unknown limit warns not at all.",
  },

  // --- snooze ---------------------------------------------------------------
  "snooze.enforce": {
    label: "Enforce the usage-limit park",
    summary: "Deny tool calls until the session parks at the limit (Decision 45)",
    detail:
      "Off is ADVISORY — one nudge per window that the agent can work past. Only ever " +
      "fires on a fresh rate-limit reading; a stale feed just warns.",
  },

  // --- claude ---------------------------------------------------------------
  "claude.settings_scope": {
    label: "Claude settings file",
    summary:
      "Where `golem init` writes Claude Code's wiring: local (gitignored) or project (committed)",
    detail:
      "Covers the env block, the mcp__golem__* permission, every hook, the status line and the " +
      "default mode. Local is the default — the wiring is machine-specific (per-project port, " +
      "absolute CA path, `golem` on PATH) and settings.local.json outranks settings.json anyway. " +
      "Readers always check both files; re-run `golem init` after changing this and the wiring " +
      "MOVES to the other file.",
    advanced: true,
  },
} as const satisfies { readonly [P in LeafPath]: SettingMeta };

/** Metadata for one leaf; undefined for an unknown path. */
export function settingMeta(path: string): SettingMeta | undefined {
  return (SETTING_META as Readonly<Record<string, SettingMeta>>)[path];
}

/** The effective widget kind for a leaf: {@link SettingMeta.kind} or {@link deriveKind}. */
export function settingKind(path: string, schema: z.ZodTypeAny): SettingKind {
  return settingMeta(path)?.kind ?? deriveKind(schema);
}

// ---------------------------------------------------------------------------
// Section metadata (grouping + display order).
// ---------------------------------------------------------------------------

export interface SectionMeta {
  readonly title: string;
  readonly summary: string;
  /** Lower sorts first; sections absent from the order fall to the end. */
  readonly order: number;
}

export const SECTION_META = {
  knowledge: {
    title: "Knowledge",
    summary: "Vector search, the wiki, local answers, and the web cache",
    order: 10,
  },
  inference: { title: "Local model", summary: "The Ollama endpoint and the coder tool", order: 20 },
  compression: {
    title: "Compression",
    summary: "The input-side dial and the optional semantic-compression sidecar",
    order: 30,
  },
  brevity: {
    title: "Brevity",
    summary: "The output-side dial — how tersely the model replies",
    order: 35,
  },
  proxy: { title: "Proxy & upstream", summary: "Port, upstream, and timeouts", order: 40 },
  telemetry: { title: "Telemetry", summary: "Local savings attribution and dashboard", order: 50 },
  snooze: { title: "Usage limits", summary: "Parking behaviour at the session limit", order: 60 },
  models: {
    title: "Model catalog",
    summary: "Per-model price and context limits (R8.8) — cached, never fetched implicitly",
    order: 65,
  },
  ui: { title: "Appearance", summary: "How this panel looks", order: 70 },
  claude: {
    title: "Claude Code wiring",
    summary: "Which .claude settings file `golem init` writes",
    order: 75,
  },
} as const satisfies { readonly [S in SectionName]: SectionMeta };

export function sectionMeta(section: string): SectionMeta | undefined {
  return (SECTION_META as Readonly<Record<string, SectionMeta>>)[section];
}

/** Section names in display order (see {@link SectionMeta.order}). */
export function sectionsInDisplayOrder(): readonly SectionName[] {
  return [...SECTION_NAMES].sort(
    (a, b) => (sectionMeta(a)?.order ?? 999) - (sectionMeta(b)?.order ?? 999),
  );
}
