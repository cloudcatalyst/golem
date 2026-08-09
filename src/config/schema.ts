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
 *   in docs/plan/verification-notes.md §17.
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
import type {
  TargetEntry,
  UpstreamAccount,
  UpstreamAuthScheme,
  UpstreamProvider,
} from "../providers/index.js";
import {
  TARGET_TRUST_LEVELS,
  UPSTREAM_AUTH_SCHEMES,
  UPSTREAM_PROVIDERS,
} from "../providers/index.js";

const portSchema = z.number().int().min(1).max(65535);
const timeoutMsSchema = z.number().int().positive();
/** `#rgb` / `#rrggbb` — the only colour form the TUI/webview both understand. */
const hexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "expected a hex colour like #a78bfa");

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
    /**
     * R6.1 case (a): which Anthropic-**protocol** upstream Golem fronts
     * (spec Decisions 22/32, verification-notes §73). All of these speak the
     * Anthropic Messages API, so the proxy stays byte-faithful; the provider
     * only selects auth-header mapping (see {@link upstream_auth_scheme}) and
     * the semantic-stage caching assumption. `anthropic` (default) is the
     * transparent passthrough. Genuine OpenAI/Gemini/Ollama translation is
     * case (b), not this key.
     */
    upstream_provider: z.enum(UPSTREAM_PROVIDERS),
    /**
     * R6.1 case (a): how the upstream credential is presented — `inherit`
     * (forward the client's own auth unchanged; the Anthropic default),
     * `x-api-key`, `api-key` (Azure Foundry), or `bearer` (OpenRouter /
     * Azure Entra). `inherit` on a non-Anthropic provider falls back to that
     * provider's default scheme. The credential itself is NOT a setting (it is
     * a secret): set it with `golem account login <provider>`, which stores it
     * in the OS credential store (Decisions 46/47 — there is no env-var path).
     */
    upstream_auth_scheme: z.enum(UPSTREAM_AUTH_SCHEMES),
    /**
     * R6.1 case (b): the model id to send to a translating (OpenAI-schema)
     * upstream. Claude Code sends a `claude-*` model an OpenAI/Ollama backend
     * does not have, so it is overridden here (e.g. `qwen2.5-coder:7b` for
     * Ollama, `gpt-5.2` for OpenAI). Required in practice for `openai`/`ollama`;
     * ignored by Anthropic-protocol providers (they receive the model as-is).
     */
    upstream_model: z.string().min(1).optional(),
    /**
     * R6.1 case (b) b4-kimi: reasoning depth for a reasoning upstream (Kimi k3,
     * o-series) — `low`/`high`/`max`. Sent as OpenAI `reasoning_effort`; omit
     * for non-reasoning backends (some reject the field). No effect on the
     * Anthropic-native path.
     */
    upstream_reasoning_effort: z.enum(["low", "high", "max"]).optional(),
    /**
     * R6.1 case (b) b4-kimi: map a reasoning upstream's `reasoning_content` (the
     * thinking trace) to Anthropic `thinking` blocks so the editor shows it.
     * Default on; only fires when the upstream actually returns reasoning
     * content. Set false if a client mishandles unrequested thinking blocks.
     */
    map_reasoning_to_thinking: z.boolean(),
    /**
     * R6.2 (spec Decision 21d; ADR-0003): the account registry for switching
     * between the user's own accounts/providers. Each entry is NON-SECRET
     * identity only (id, provider, base_url, optional model/auth_scheme); the
     * credential for account `<id>` lives in the OS credential store, set with
     * `golem account login <id>` (Decisions 46/47) — secrets are never a setting
     * and never an env var. Legitimate switching only; there is no automated
     * quota-evasion (ADR-0003 ToS scope).
     */
    accounts: z
      .array(
        z.object({
          id: z.string().min(1),
          provider: z.enum(UPSTREAM_PROVIDERS),
          base_url: z.string().url(),
          model: z.string().min(1).optional(),
          auth_scheme: z.enum(UPSTREAM_AUTH_SCHEMES).optional(),
        }),
      )
      .optional(),
    /**
     * R6.2: which `accounts` entry is active (its config overrides the top-level
     * `upstream_*`). Unset → the top-level config. Set but unknown → the
     * top-level config + a loud warning (never a silent switch to a different
     * account — ADR-0003 fail-closed). Switch it with `golem account use <id>`.
     */
    active_account: z.string().min(1).optional(),
    /**
     * R9.1 (proposal `multi-target-routing.md`): the target registry — one table
     * for every model Golem can reach, local or upstream. A local model is just
     * a target whose provider is `ollama`.
     *
     * A target is **entirely non-secret**: it answers *which endpoint + model*,
     * and points at a `proxy.accounts` id for *whose credential*. Several targets
     * may share one account (one key backing several model ids), which is why the
     * two registries are separate. There is deliberately no key field — a secret
     * here would be a plaintext secret in settings, which ADR-0003 invariant 1
     * forbids.
     *
     * `trust` (`vendor | local | lan | third-party`) is stored and surfaced in
     * R9.1 and consumed as a redaction floor in R9.3, where a target may only
     * ever RAISE the floor. Omitted → {@link defaultTrustFor}, which errs toward
     * more redaction.
     *
     * Inert in R9.1: nothing routes on this yet (R9.2/R9.3 consume it). Entries
     * in `proxy.accounts` already appear in `golem target list` without being
     * restated here.
     */
    targets: z
      .array(
        z.object({
          id: z.string().min(1),
          provider: z.enum(UPSTREAM_PROVIDERS),
          base_url: z.string().url(),
          model: z.string().min(1).optional(),
          account: z.string().min(1).optional(),
          auth_scheme: z.enum(UPSTREAM_AUTH_SCHEMES).optional(),
          trust: z.enum(TARGET_TRUST_LEVELS).optional(),
          agent_selectable: z.boolean().optional(),
        }),
      )
      .optional(),
    /**
     * R9.1: which target serves a request that names none. Supersedes
     * {@link active_account} (spec Decision 21d), which is still read when this
     * is unset — that fallback IS the migration shim, so an existing config keeps
     * working untouched. Unknown id → fail-closed (no silent substitution).
     */
    default_target: z.string().min(1).optional(),
    /** End-to-end request timeout (generous: long SSE streams). */
    request_timeout_ms: timeoutMsSchema,
    /** Upstream TCP/TLS connect timeout. */
    connect_timeout_ms: timeoutMsSchema,
  },
  inference: {
    /** OpenAI-compatible local inference endpoint (Ollama default). */
    ollama_base_url: z.string().url(),
    /**
     * Per-request timeout for local inference (chat/embeddings). Generous by
     * default: local generation is non-streaming here, so this bounds the WHOLE
     * completion — a cold model load plus a grounded `coder` draft on slow
     * developer hardware can legitimately take a minute-plus (verification-notes
     * §66). Connection-level failures still fail fast regardless. Raise it on
     * slow boxes; env override `GOLEM_INFERENCE_REQUEST_TIMEOUT_MS`.
     */
    request_timeout_ms: timeoutMsSchema,
    /**
     * Whether the `coder` MCP tool (local model drafting) is enabled. Default
     * true. Set false to hide the tool from Claude Code and keep the status line
     * from showing a local backend. Independent of rerank/local-answer; Ollama
     * must still be reachable for coder to actually work.
     */
    local_coder_enabled: z.boolean(),
    /**
     * R9.4 — which `proxy.targets` id each **tool worker** defaults to, keyed by
     * worker name (`{ coder = "openrouter-qwen3" }`). A worker with no entry
     * uses the local tiered model, exactly as before, so this changes nothing
     * until it is set.
     *
     * The point of the setting is that "the default coder model" becomes a real,
     * settable thing rather than permanently-local: after R9.3 a draft can run
     * on any declared target, and a status line that always says "local" would
     * be describing a constraint that no longer exists.
     *
     * **A map, not one leaf per worker.** More workers are expected (a `writer`
     * for documents, and so on); a scalar each would grow a schema leaf, a
     * UI-model entry, a status field and two status-surface branches per worker,
     * while a map grows by one line of config. The cost is that a key naming no
     * worker would be silently ignored, so keys are validated against
     * `KNOWN_WORKERS` and reported — see `inference/workers.ts`.
     *
     * Fail-closed like every other target reference: an unknown TARGET id is an
     * error naming what is configured, never a silent fall back to the local
     * model — that would send the work somewhere the user did not choose while
     * reporting success. A non-local target is redacted at its trust floor on
     * every dispatch (R9.3), so setting this never weakens redaction.
     */
    worker_targets: z.record(z.string().min(1), z.string().min(1)).default({}),
    /**
     * OPT-IN (R8.7, default **false**): offer `coder`'s `edit` mode — the local
     * model rewrites one small file, Golem validates the result (syntax must
     * still parse, no definition may disappear) and only then writes it.
     *
     * Off by default for a measured reason, not a cautious one: the mode's three
     * extra schema properties cost **+313 definition tokens on every request**
     * (§110), a permanent bill in the shape §100 rejected, while the saving is
     * conditional on the mode being used AND the local edit being right.
     * `golem bench edit` clears the bar for whole-file edits on ~10–40-line
     * TypeScript files and nothing larger, so the people who benefit turn it on
     * deliberately. When it is off, the schema is byte-identical to R8.6's.
     */
    local_editor_enabled: z.boolean(),
    /** R8.15: user-declared provider table for local-model role routing. */
    providers: z
      .array(
        z.object({
          id: z.string(),
          api: z.enum(["openai-completions", "openai-embeddings", "openai", "ollama", "anthropic"]),
          base_url: z.string(),
          models: z.array(
            z.object({
              id: z.string(),
              roles: z.array(z.string()).optional(),
              context_window: z.number().int().positive().optional(),
            }),
          ),
        }),
      )
      .default([]),
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
    /**
     * Decision 52: the INPUT-side dial, decoupled from the slider. `"auto"`
     * (default) means "follow the slider level", which is the pre-Decision-52
     * behaviour; a numeric value PINS the compression level, and the slider
     * stops driving it until it is set back to `"auto"`.
     *
     * **0 is deliberately not offerable.** Level 0 is the Decision-30
     * passthrough — the one row where redaction is off — and that bypass belongs
     * to the slider, where it is surfaced loudly. Allowing it here would make
     * redaction-off reachable from a config key that says nothing about
     * redaction. `resolveCompressionLevel` also clamps a 0 defensively, so both
     * layers refuse it.
     */
    level: z.enum(["auto", "1", "2", "3"]),
    /**
     * Decision 53: **opaque passthrough** to Headroom's `CompressConfig`.
     *
     * Deliberately not enumerated. Golem's worker script — not the version pin —
     * used to be the coupling point: it hand-listed two config fields, so every
     * other option Headroom supports (and every option a future release adds) was
     * unreachable without editing `headroom-worker.py`. The worker now introspects
     * the installed `CompressConfig` and forwards whatever it accepts, layering
     * these keys OVER Golem's per-slider-mode presets, so one knob can be
     * overridden without replacing the mode's behaviour.
     *
     * Keys the installed Headroom does not accept are **reported and skipped**,
     * never forwarded (forwarding would raise and cost the whole request); the
     * adapter logs the ignored set once per distinct set, so a typo is visible
     * instead of silently doing nothing. `golem ext --verbose` shows the pin;
     * `HeadroomSidecar.health()` reports `supported_config` from the running
     * package.
     *
     * Has no effect unless `headroom_sidecar` is on AND the semantic stage
     * actually runs (see `force_semantic_on_caching` and Decision 31).
     */
    headroom_config: z.record(z.unknown()),
  },
  brevity: {
    /**
     * Decision 52: the OUTPUT-side dial. Appends a fixed, marker-fenced brevity
     * directive to the request's `system` block so the model answers more
     * tersely — it saves *output* tokens (never cached, ~5× input) and costs a
     * small number of *input* tokens that land inside the cached prefix.
     *
     * `"auto"` follows the slider preset (off at 0–1, lite at 2, full at 3);
     * `off|lite|full|ultra` pins it. **Ships as a pinned `"off"`**, not `"auto"`:
     * Decision 52 requires a real telemetry rollup (`golem stats --brevity`)
     * before the dial is trusted, because the technique can go net-negative on
     * already-terse workloads (verification-notes §87). `ultra` is never a
     * preset — it is reachable only by pinning it here.
     */
    level: z.enum(["auto", "off", "lite", "full", "ultra"]),
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
     * The proxy-as-responder local-answer sub-mode (R2.3, spec Decision 24
     * sub-mode 2 / Decision 33). Independent of `slider.level` (Decision 31 —
     * the slider stays a pure compression dial). **ON by default** as of
     * Decision 33's acceptance (2026-07-17, USER decision): the safety posture
     * that gated it is now in place — extractive-only (never generative, so it
     * can't fabricate), single-turn, confidence-gated (`local_answer_min_confidence`),
     * restricted to durable prose (`isProseSource` — wiki/spec/docs, never
     * code/tests/plan docs), and always labelled "verify independently". A topic
     * with no durable wiki/spec page declines and falls through to the upstream
     * model, so coverage tracks the wiki (the wiki-first loop, Decision 28).
     * Set false to turn it off entirely.
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
     * OPT-OUT (R8.5): register the `code` MCP tool, whose `map` mode renders a
     * graph-ranked, budgeted signature skeleton of the repo so the model can
     * find a file without reading three wrong ones. On by default, but it is a
     * real cost either way — a tool definition bills on every request (§88/§100)
     * — so set false to stop paying for it. The map itself needs the tier-2
     * tree-sitter packages; without them the tool reports no map rather than
     * failing (Decision 53).
     */
    repo_map_enabled: z.boolean(),
    /**
     * OPT-OUT (R8.5): when an oversized `Read` is swapped for a digest, include
     * the file's symbol skeleton (every definition with its line number) beside
     * the head/tail excerpt, so the cheap recovery is a narrow re-read rather
     * than an `expand` that re-enters the whole original (§95 measured one
     * expand at 6,356 tokens). Needs tree-sitter; degrades to the plain digest.
     */
    read_skeleton_enabled: z.boolean(),
    /**
     * OPT-IN (R8.6): add the LSP modes — `diagnostics`, `definition`,
     * `references`, `hover` — to the `code` tool, answered by a language server
     * the USER installed and Golem merely spawns (tier-2, Decision 53). Off by
     * default for two reasons: a language server is a long-lived process nobody
     * asked for, and the extra modes widen the `code` tool's schema, which bills
     * on every request (§88/§100). Without a server on `PATH` each mode reports
     * why rather than failing. Lives beside `repo_map_enabled` because it gates
     * the same tool: the map says what exists, the LSP says what refers to what.
     */
    lsp_enabled: z.boolean(),
    /**
     * R8.6: extra language-server rows, layered over the built-in
     * `typescript-language-server` one (a row with the same `id` replaces it).
     * `command` is resolved on `PATH` (`PATHEXT`-aware) or given as an explicit
     * path; `args` is an argument ARRAY, never a shell string. This is how
     * `gopls` or `rust-analyzer` arrive — as a user's config, not a Golem
     * release, because a row Golem asserts but cannot exercise is the kind of
     * unverified claim Decision 53's registry exists to prevent.
     */
    lsp_servers: z
      .array(
        z.object({
          id: z.string().min(1),
          command: z.string().min(1),
          args: z.array(z.string()).default([]),
          language_id: z.string().min(1),
          extensions: z.array(z.string().min(1)).min(1),
        }),
      )
      .optional(),
    /**
     * R8.6: per-request budget for an LSP call, in ms. The whole point of the
     * bridge is that a hung language server is a no-op rather than a hang, and
     * this is the number that makes it so. The `initialize` handshake gets its
     * own, larger allowance internally (a cold tsserver loading a big project).
     */
    lsp_timeout_ms: timeoutMsSchema,
    /**
     * OPT-OUT (R3.4, spec Decision 20e's local/P1 tier): federate the
     * user-scope wiki (`~/.golem/wiki/`) into `search`/`fetch` alongside this
     * project's own wiki, read-only. On by default — set false if a user
     * doesn't want personal notes bleeding into a project's search results.
     */
    user_wiki_enabled: z.boolean(),
    /**
     * OPT-IN (R3.1, spec Decision 34): chat-judge rerank of `search` hits via
     * the local "judge" role. Independent of `slider.level` (Decision 31 —
     * the slider never auto-engages the local model at any level); off by
     * default because it adds a local-model call (latency) to every search
     * and has no usage evidence yet (same "opt-in until proven" footing as
     * `local_answer_enabled`).
     */
    rerank_enabled: z.boolean(),
    /**
     * OPT-IN (R3.6, spec Decisions 13/18): MEMORY-scope federated search via
     * the optional Headroom `[memory]` sidecar (sentence-transformers,
     * transitively torch — much heavier than `headroom_sidecar`'s bare
     * `headroom-ai`, verification-notes §4). Off by default — without it,
     * `search()` degrades to KNOWLEDGE-only, same as today. Independent of
     * `headroom_sidecar`: the two run as separate opt-in processes.
     */
    memory_federation_enabled: z.boolean(),
    /**
     * OPT-IN (R4 follow-up): before serving a cached WebFetch URL, revalidate it
     * with a conditional request (`If-None-Match`/`If-Modified-Since`); on `304`
     * serve the cache, on `200` let the fetch re-run (re-cache + re-ingest), and
     * honor `Cache-Control`/`Expires`. Off by default because it adds a network
     * round-trip to the PreToolUse(WebFetch) path; when off, freshness stays
     * pure-TTL (a changed page can be served stale until the TTL lapses).
     */
    webcache_revalidate: z.boolean(),
    /**
     * Decision 42: on a WebFetch, fetch the RAW page ourselves in the
     * PostToolUse hook and cache/ingest THAT — instead of caching Claude Code's
     * prompt-specific WebFetch answer (which is wrong for a later fetch with a
     * different prompt, and a poor KB source). On by default; set false to fall
     * back to the legacy answer-capture behavior. A raw fetch that fails caches
     * nothing (an honest miss), never the answer.
     */
    webcache_fetch_raw: z.boolean(),
  },
  telemetry: {
    /** Master toggle for local telemetry collection (savings attribution). */
    enabled: z.boolean(),
    /** Port for the local savings dashboard. */
    dashboard_port: portSchema,
  },
  ui: {
    /**
     * Draw the Golem "pet" (the 3x8 block-character mascot) in the `golem` control
     * panel header. Set false on terminals that can't render Unicode block
     * elements (legacy Windows consoles on codepage 437/850) — `golem
     * --no-pet` does the same for one run.
     */
    pet: z.boolean(),
    /** Pet colour as a hex triplet; ink downgrades 24-bit → 256 → 16 as needed. */
    pet_color: hexColorSchema,
    /**
     * Colour policy for the panel: `auto` respects the terminal (and `NO_COLOR`
     * / `FORCE_COLOR`), `always` forces colour even when piped, `never` renders
     * plain text.
     */
    color: z.enum(["auto", "always", "never"]),
    /** Show advanced/rarely-touched controls when the panel opens. */
    advanced: z.boolean(),
  },
  models: {
    /**
     * R8.8: URL of a models.dev-shaped catalog `golem models refresh` fetches.
     * **Nothing fetches it implicitly** — a cost report must never make a network
     * call (tier 3b: no runtime dependency). Golem's own built-in table always
     * wins on a collision, so a wrong third-party price cannot reach a cost
     * claim; the fetched half only fills gaps for models Golem has not priced.
     */
    catalog_url: z.string().url(),
    /**
     * R8.8: how old the price data may be before surfaces warn. Prices move, and
     * a silently-stale figure is the failure mode this exists to prevent; the
     * warning never suppresses the number, it labels it.
     */
    catalog_max_age_days: z.number().int().positive(),
    /**
     * R8.8: fraction of a model's context window at which `golem stats
     * --context` warns. Only fires when the catalog knows the window — an
     * unknown limit produces no warning rather than a guessed one.
     */
    context_warn_fraction: z.number().min(0.1).max(1),
  },
  snooze: {
    /**
     * Enforce the document-and-hold park at the usage limit (spec Decision 45).
     * **Default true (USER decision).** When true it is ENFORCING — while the
     * session (5h) window is at/above the threshold on a FRESH reading, every
     * non-`snooze` tool call is denied until the agent parks (calls
     * `mcp__golem__snooze`) or the window resets. Set false for ADVISORY — a
     * single one-shot redirect to `snooze` per window that the agent can work
     * past. Only ever fires on a fresh prediction — a stale/cold feed never hard-blocks
     * (it still just warns once). NOTE: a PreToolUse deny cannot stop the model
     * from spending tokens reacting to it — enforcement funnels the model to
     * snooze quickly, it is not a hard token freeze.
     */
    enforce: z.boolean(),
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
  readonly upstream_provider: UpstreamProvider;
  readonly upstream_auth_scheme: UpstreamAuthScheme;
  readonly upstream_model?: string;
  readonly upstream_reasoning_effort?: "low" | "high" | "max";
  readonly map_reasoning_to_thinking: boolean;
  readonly accounts?: readonly UpstreamAccount[];
  readonly active_account?: string;
  readonly targets?: readonly TargetEntry[];
  readonly default_target?: string;
  readonly request_timeout_ms: number;
  readonly connect_timeout_ms: number;
}

export interface InferenceSettings {
  readonly ollama_base_url: string;
  readonly request_timeout_ms: number;
  readonly local_coder_enabled: boolean;
  /** R9.4: worker name → target id (see `inference/workers.ts`). */
  readonly worker_targets: Readonly<Record<string, string>>;
  readonly local_editor_enabled: boolean;
  /** R8.15: user-declared provider table for local-model role routing. */
  readonly providers: readonly {
    readonly id: string;
    readonly api: string;
    readonly base_url: string;
    readonly models: readonly {
      readonly id: string;
      readonly roles?: readonly string[];
      readonly context_window?: number;
    }[];
  }[];
}

export interface CompressionSettings {
  readonly headroom_sidecar: boolean;
  readonly force_semantic_on_caching: boolean;
  readonly level: "auto" | "1" | "2" | "3";
  /** Decision 53 — opaque `CompressConfig` passthrough; see the schema comment. */
  readonly headroom_config: Readonly<Record<string, unknown>>;
}

/** Decision 52 — the output-side brevity dial. */
export interface BrevitySettings {
  readonly level: "auto" | "off" | "lite" | "full" | "ultra";
}

export interface KnowledgeSettings {
  readonly enabled: boolean;
  readonly vector_db_url?: string;
  readonly watch_paths: readonly string[];
  readonly wiki_dir: string;
  readonly local_answer_enabled: boolean;
  readonly local_answer_min_confidence: number;
  readonly syntax_aware_chunking: boolean;
  readonly repo_map_enabled: boolean;
  readonly read_skeleton_enabled: boolean;
  readonly lsp_enabled: boolean;
  readonly lsp_servers?: readonly {
    readonly id: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly language_id: string;
    readonly extensions: readonly string[];
  }[];
  readonly lsp_timeout_ms: number;
  readonly user_wiki_enabled: boolean;
  readonly rerank_enabled: boolean;
  readonly memory_federation_enabled: boolean;
  readonly webcache_revalidate: boolean;
  readonly webcache_fetch_raw: boolean;
}

export interface TelemetrySettings {
  readonly enabled: boolean;
  readonly dashboard_port: number;
}

export interface UiSettings {
  readonly pet: boolean;
  readonly pet_color: string;
  readonly color: "auto" | "always" | "never";
  readonly advanced: boolean;
}

/** R8.8 — the model catalog (price + context limits) settings. */
export interface ModelsSettings {
  readonly catalog_url: string;
  readonly catalog_max_age_days: number;
  readonly context_warn_fraction: number;
}

export interface SnoozeSettings {
  readonly enforce: boolean;
}

export interface GolemSettings {
  readonly slider: SliderSettings;
  readonly proxy: ProxySettings;
  readonly inference: InferenceSettings;
  readonly compression: CompressionSettings;
  readonly brevity: BrevitySettings;
  readonly knowledge: KnowledgeSettings;
  readonly telemetry: TelemetrySettings;
  readonly ui: UiSettings;
  readonly models: ModelsSettings;
  readonly snooze: SnoozeSettings;
}

/**
 * Built-in defaults (the lowest layer). Where the spec is silent the choice is
 * recorded in docs/plan/verification-notes.md §17:
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
    upstream_provider: "anthropic",
    upstream_auth_scheme: "inherit",
    map_reasoning_to_thinking: true,
    request_timeout_ms: 600_000,
    connect_timeout_ms: 10_000,
  },
  inference: {
    ollama_base_url: "http://localhost:11434",
    request_timeout_ms: 600_000,
    local_coder_enabled: true,
    worker_targets: {},
    local_editor_enabled: false,
    providers: [],
  },
  compression: {
    headroom_sidecar: false,
    force_semantic_on_caching: false,
    level: "auto",
    // Empty by default: Golem's mode presets are the whole behaviour until a
    // user deliberately reaches past them (Decision 53).
    headroom_config: {},
  },
  // Decision 52: ships OFF, not "auto" — the preset table is opt-in until the
  // brevity rollup shows a real net saving on this project's own traffic.
  brevity: {
    level: "off",
  },
  knowledge: {
    enabled: true,
    watch_paths: [],
    wiki_dir: "docs/wiki",
    local_answer_enabled: true,
    local_answer_min_confidence: 0.6,
    syntax_aware_chunking: false,
    repo_map_enabled: true,
    read_skeleton_enabled: true,
    lsp_enabled: false,
    lsp_timeout_ms: 15_000,
    user_wiki_enabled: true,
    rerank_enabled: false,
    memory_federation_enabled: false,
    webcache_revalidate: false,
    webcache_fetch_raw: true,
  },
  telemetry: {
    enabled: true,
    dashboard_port: 4654,
  },
  ui: {
    pet: true,
    // Violet-400: readable purple on both light and dark terminal backgrounds.
    pet_color: "#a78bfa",
    color: "auto",
    advanced: false,
  },
  models: {
    // The JSON API of the open catalog the R8d memo names; verified 2026-07-31
    // (§106) to carry `cost.{input,output,cache_read,cache_write}` and
    // `limit.{context,output}`. Fetched only by `golem models refresh`.
    catalog_url: "https://models.dev/api.json",
    catalog_max_age_days: 45,
    context_warn_fraction: 0.8,
  },
  snooze: {
    enforce: true,
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
