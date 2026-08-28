/**
 * Golem settings schema (E1).
 *
 * The settings file shape is a flat two-level object: `section.key`, with
 * snake_case keys (CLAUDE.md convention). Every leaf is described once in
 * {@link SETTINGS_LEAVES}; the loader, env mapping, and `writeSetting` all
 * derive their behavior from that single table, so adding a key means adding
 * one leaf schema + one default. The {@link GolemSettings} type is DERIVED from
 * the table (see below) rather than hand-written, so there is no third place to
 * keep in step and no way for the two to disagree.
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

import {
  PROXY_PROVIDERS,
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
  // R11.1 / ADR-0004: `slider.level` is GONE. It was a preset over the two dials
  // below, so two controls described one thing; and on a caching upstream its
  // top half was inert, so the headline number needed a paragraph of
  // explanation. `compression.level` and `brevity.level` are now set directly.
  // A file still carrying `slider.level` is migrated once, by resolving it
  // through the real resolvers, in src/config/migrations.ts.
  proxy: {
    /**
     * R11.1 / ADR-0004 — forward EVERY request byte-faithfully: no redaction, no
     * compression, no brevity. The single deliberate exception to the redaction
     * hard rule (CLAUDE.md), inherited from what slider level 0 used to mean.
     *
     * It is a setting of its own, rather than a value of `compression.level`,
     * because compression and redaction are different guarantees: folding them
     * into one word is how a user turns off *redaction* while believing they
     * turned off *compression*. And it is persisted, rather than reusing the
     * in-process `golem on`/`golem off` toggle, because that toggle forgets at
     * every proxy restart — and the proxy restarts on project open.
     *
     * Never the default. Surfaced loudly wherever it is on, and settable only
     * from the CLI — a tool call must not be able to switch redaction off
     * (R8.33).
     */
    bypass_all: z.boolean(),
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
    // R9.15: PROXY_PROVIDERS, not UPSTREAM_PROVIDERS — `claude-cli` is a target
    // provider only (it spawns a process; there is no endpoint to forward to).
    upstream_provider: z.enum(PROXY_PROVIDERS),
    /**
     * R6.1 case (a): how the upstream credential is presented — `inherit`
     * (forward the client's own auth unchanged; the Anthropic default),
     * `x-api-key`, `api-key` (Azure Foundry), or `bearer` (OpenRouter /
     * Azure Entra). `inherit` on a non-Anthropic provider falls back to that
     * provider's default scheme. The credential itself is NOT a setting (it is
     * a secret): set it with `golem gateway login <provider>`, which stores it
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
     * `golem gateway login <id>` (Decisions 46/47) — secrets are never a setting
     * and never an env var. Legitimate switching only; there is no automated
     * quota-evasion (ADR-0003 ToS scope).
     *
     * The inferred element type is the structural twin of `GatewayEntry`
     * (`src/providers/gateways.ts`), which is what the consumers there take.
     */
    gateways: z
      .array(
        z.object({
          id: z.string().min(1),
          provider: z.enum(UPSTREAM_PROVIDERS),
          base_url: z.string().url(),
          models: z.array(z.string().min(1)).optional(),
          auth_scheme: z.enum(UPSTREAM_AUTH_SCHEMES).optional(),
        }),
      )
      .optional(),
    // R9.1 renamed `active_account` → `default_target`; R9.6 retired the leaf and
    // moved the fallback into src/config/migrations.ts, so an existing file
    // naming the old key still works and says so exactly once.
    /**
     * R9.1 (proposal `multi-target-routing.md`): the target registry — one table
     * for every model Golem can reach, local or upstream. A local model is just
     * a target whose provider is `ollama`.
     *
     * A target is **entirely non-secret**: it answers *which endpoint + model*,
     * and points at a `proxy.gateways` id for *whose credential*. Several targets
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
     * in `proxy.gateways` already appear in `golem target list` without being
     * restated here.
     *
     * The inferred element type is the structural twin of `TargetEntry`
     * (`src/providers/targets.ts`), which is what the registry there takes.
     */
    targets: z
      .array(
        z.object({
          id: z.string().min(1),
          gateway: z.string().min(1),
          model: z.string().min(1).optional(),
          trust: z.enum(TARGET_TRUST_LEVELS).optional(),
          agent_selectable: z.boolean().optional(),
        }),
      )
      .optional(),

    /** End-to-end request timeout (generous: long SSE streams). */
    request_timeout_ms: timeoutMsSchema,
    /** Upstream TCP/TLS connect timeout. */
    connect_timeout_ms: timeoutMsSchema,
    /**
     * R9.23: DEPRECATED — moved to `inference.default_target`. Kept as a
     * valid leaf so the migration table can forward old settings files.
     */
    default_target: z.string().min(1).optional(),
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
     *
     * R10.8: a worker with NO entry here no longer means "the local model". It
     * falls through to `inference.default_target` and then to the harness's own
     * upstream, so leaving this empty is a routing decision like any other.
     */
    worker_targets: z.record(z.string().min(1), z.string().min(1)).default({}),
    /**
     * R9.23: moved from `proxy.default_target` to `inference.default_target`.
     *
     * R10.8: this is now step 3 of the dispatch chain, and until R10.8 it was
     * skipped entirely — an unrouted `coder` draft went to the local model, so
     * the one setting whose job is to name the default did nothing. The order is
     * an explicit target on the call, then `worker_targets[worker]`, then this,
     * then the harness's own upstream (`proxy.upstream_*`). Unset means the
     * last of those, which always exists.
     *
     * Fail-closed like every other target reference: an id in neither
     * `proxy.targets` nor `proxy.gateways` raises, naming what IS configured —
     * never a silent slide to the local model. A local backend is reached by
     * pointing a target at it and naming that target here; it is a destination,
     * not a default.
     */
    default_target: z.string().min(1).optional(),
    /**
     * R13.12 — the one key users are told about for "who does the coding work".
     *
     * Accepts either shape, and which one it is decides the MECHANISM:
     *
     *  - a **target id** from the registry (`openrouter:qwen/qwen3.7-flash`) →
     *    the existing dispatch path, unchanged. Golem calls the model itself.
     *  - a **model id** (`claude-sonnet-5`, `sonnet`) → the harness runs a
     *    subagent on that model. `golem init` writes
     *    `.claude/agents/golem-coder.md` carrying it, so the delegation is native:
     *    a full agentic loop with tools and its own context, and — because a
     *    subagent's traffic still goes through `ANTHROPIC_BASE_URL` — redaction,
     *    compression and telemetry all still apply.
     *  - **unset** → `coder` declines and the work stays in the current session
     *    (R13.11). That is the settled default, not a gap.
     *
     * A target id wins when the value resolves to one, because a declared target
     * is a deliberate act and silently reading it as a model name would send work
     * somewhere the user did not choose. A value that resolves to neither raises,
     * naming both sets — the same fail-closed discipline as every other target
     * reference here.
     *
     * `worker_targets.coder` still takes precedence: it is the low-level, generic
     * per-worker map (R9.4) and this is the friendly alias for the one worker that
     * exists today. Setting both to different destinations is reported rather than
     * silently resolved.
     */
    default_coder: z.string().min(1).optional(),
    /**
     * R13.12 — the instruction prompt that frames EVERY coder task, whichever
     * mechanism runs it: the `system` field of a `coder` dispatch, and the body of
     * the generated subagent definition.
     *
     * Unset uses `DEFAULT_CODER_PROMPT` (`src/inference/coder-prompt.ts`), which
     * also documents why this is a setting rather than a skill. Keep it SHORT: the
     * same text frames a 7B local drafter and a frontier model, and a long
     * preamble is the reliable way to make the small one fail.
     */
    coder_prompt: z.string().optional(),
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
     * R11.1 / ADR-0004: the INPUT-side dial, now set DIRECTLY. `"auto"` is gone
     * along with the slider it followed.
     *
     * - `off` — redaction only; nothing else touches the request. Nameable for
     *   the first time in R11.1.
     * - `1` — + lossless (byte-faithful) compression. The default.
     * - `2` / `3` — + the lossy semantic stages, which Decision 31 gates OFF on
     *   a prompt-caching upstream, so what RAN can still differ from what was
     *   SET (`resolveEffectiveCompression`, §103). Every surface says which.
     *
     * **No value here can disable redaction** — see `proxy.bypass_all`. That is
     * now a property of the type rather than of a clamp.
     */
    level: z.enum(["off", "1", "2", "3"]),
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
     * R11.1 / ADR-0004 removed `"auto"` (which followed the slider preset).
     * Ships `off`: Decision 52 requires a real telemetry rollup
     * (`golem stats --brevity`) before the dial is trusted, because the
     * technique can go net-negative on already-terse workloads
     * (verification-notes §87).
     */
    level: z.enum(["off", "lite", "full", "ultra"]),
  },
  knowledge: {
    /** Master toggle for the vector knowledge base. */
    enabled: z.boolean(),
    /** Optional external vector-DB URL (e.g. Qdrant server); embedded store when unset. */
    vector_db_url: z.string().url().optional(),
    /** Paths auto-ingested and watched for changes. */
    watch_paths: z.array(z.string()),
    /**
     * R11.2 — how many changed files the AUTOMATIC session-start sync
     * (`golem mcp serve`) may re-embed before it defers to an explicit
     * `golem index`. `0` removes the cap.
     *
     * Embedding is the expensive part: ~10 minutes of continuous GPU for 114
     * files with bge-m3 on a mid tier. That job used to start unannounced on
     * every new session, and a branch switch rewrites mtimes wholesale, so an
     * ordinary `git checkout` was enough to trigger it. 50 keeps the routine
     * edit-a-few-files case automatic (the point of auto-index) while a churn
     * of hundreds waits for the user to ask for it.
     */
    auto_index_max_files: z.number().int().min(0),
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
  security: {
    /**
     * R13.4 — port for the mutual-TLS WRITE surface. Separate from the observe
     * dashboard on purpose: read and write are different servers, so "read-only"
     * is a property of the server rather than of a route table that can grow.
     */
    write_port: portSchema,
    /**
     * Bind the write surface to every interface rather than loopback.
     *
     * OFF by default. Unlike the dashboard's LAN opt-in this exposes a surface
     * that can ACT, so it is bounded by two independent claims rather than by
     * the bind: a client certificate this project's device CA issued, and a live
     * unlock window. Neither can be obtained over the network — enrolment is
     * local-only, forever (ADR-0006 section 3c-1, invariant 8).
     */
    write_lan: z.boolean(),
    /**
     * How long an unlock window lasts before the passcode is required again,
     * however active the session was. Short by default: this is the window in
     * which a picked-up unlocked phone can send.
     */
    unlock_window_minutes: z.number().int().positive(),
    /** Idle timeout — no authorised request for this long relocks, sooner than above. */
    idle_relock_minutes: z.number().int().positive(),
    /**
     * How recently the passcode must have been TYPED for a high-risk act (gate-map
     * item 5 — originating a session). Deliberately far shorter than the unlock
     * window: continuing to read a stream and starting a new agent session in a
     * repository are not the same authority.
     */
    step_up_max_age_minutes: z.number().int().positive(),
    /** Lifetime of an issued device certificate. An unrevoked lost device still expires. */
    device_cert_days: z.number().int().positive(),
  },
  telemetry: {
    /** Master toggle for local telemetry collection (savings attribution). */
    enabled: z.boolean(),
    /** Port for the local savings dashboard. */
    dashboard_port: portSchema,
    /**
     * R12.5 — bind the dashboard to every interface instead of loopback, so a
     * phone on the same network can reach it as a read-only companion app.
     *
     * OFF by default and deliberately not something a phone can turn on: this
     * is the one setting that takes a surface which has only ever been reachable
     * from the machine it runs on and makes it reachable from the network. What
     * it exposes is bounded by construction rather than by policy — the server
     * has no write route and refuses every method but GET/HEAD — but "read-only"
     * still means the project directory, the blocked tool call and its argument,
     * and the savings figures are readable by anything on that LAN.
     *
     * `golem dashboard --lan` sets it for one run without changing config.
     */
    dashboard_lan: z.boolean(),
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
     * tool call outside `PARK_EXEMPT_TOOLS` (`src/hooks/pre-tool-use.ts` —
     * `mcp__golem__snooze` plus the `ToolSearch`/`expand` pair needed to reach it,
     * R9.23) is denied until the agent parks or the window resets. Set false for ADVISORY — a
     * single one-shot redirect to `snooze` per window that the agent can work
     * past. Only ever fires on a fresh prediction — a stale/cold feed never hard-blocks
     * (it still just warns once). NOTE: a PreToolUse deny cannot stop the model
     * from spending tokens reacting to it — enforcement funnels the model to
     * snooze quickly, it is not a hard token freeze.
     */
    enforce: z.boolean(),
    /**
     * Task `subagent-park`: refuse to START a subagent when the session window
     * cannot pay for it. **Default true.** The park (`enforce`) is a tool-call
     * gate and a subagent never reaches it — a child hits the limit on a MODEL
     * request and dies before it can propose a call to deny, taking uncommitted
     * work with it (observed 2026-08-22, two of three dispatched agents). The
     * spawn, however, IS a tool call the parent makes, so that is where the
     * decision belongs. Refusal states what it measured, because a refusal that
     * does not will be worked around. Fails to ON: a config-read failure cannot
     * deadlock a session here, since the gate touches exactly one tool.
     */
    spawn_gate: z.boolean(),
    /**
     * Share of a session (5h) window one subagent is assumed to cost. **Measured,
     * not guessed:** the three agents of 2026-08-22 consumed ~171k, ~186k and
     * ~186k subagent tokens over 85–94 tool calls each — roughly 15–20% of a
     * window apiece. A spawn is refused when `utilization + spawn_cost_fraction ×
     * (in-flight + 1) > 1`. Lower it if your subagents are genuinely cheaper;
     * raising it makes the gate more conservative.
     */
    spawn_cost_fraction: z.number().min(0.01).max(1),
  },
  claude: {
    /**
     * Which of Claude Code's two project-scope settings files `golem init` owns:
     * `local` (`.claude/settings.local.json`, gitignored — the default) or
     * `project` (`.claude/settings.json`, committed).
     *
     * Everything init writes for Claude Code goes to the chosen file: the `env`
     * block, the `mcp__golem__*` permission rule, the hooks, the status line, the
     * default permission mode. Local is the default because all of it is
     * machine-local — a per-project port assigned on THIS machine, a
     * machine-absolute CA path, hooks that need `golem` on PATH — and because
     * `settings.local.json` sits ABOVE `settings.json` in Claude Code's
     * precedence ladder (notes §13), so nothing about how the values are read
     * changes. Choose `project` to put the wiring in version control for a team
     * that all has `golem` installed.
     *
     * READERS are unaffected: every Golem surface that asks "is this project
     * wired?" checks both files in Claude Code's own precedence order. Only the
     * write target moves — and init sweeps the other file, so flipping this key
     * MOVES the wiring rather than duplicating it (re-run `golem init`).
     */
    settings_scope: z.enum(["local", "project"]),
  },
  plugins: {
    /**
     * R8.11 / ADR-0005 — the master switch for third-party in-process plugins.
     *
     * "On" by default only because the default `load` list is EMPTY: with
     * nothing named, nothing loads. This key exists so a suspected plugin can be
     * stopped without editing the list — the thing you reach for when you want
     * it gone now.
     */
    enabled: z.boolean(),
    /**
     * Plugin specifiers to load, in order. **Nothing is discovered**: Golem never
     * scans `node_modules`, never follows a naming convention, and never
     * downloads a plugin. A specifier is a bare npm name resolved from THIS
     * project, or a local path.
     *
     * A plugin runs inside Golem's process, which means inside the redaction
     * path, and there is **no sandbox** — loading one is exactly as dangerous as
     * importing a dependency you installed yourself. Read
     * `docs/decisions/ADR-0005-plugin-seams-and-the-redaction-path.md` before
     * adding an entry.
     */
    load: z.array(z.string().min(1)),
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
//
// DERIVED from {@link SETTINGS_LEAVES}, never restated by hand: the table is
// declared `as const satisfies …`, so each leaf keeps its narrow zod type
// through the `satisfies` check and `z.infer` recovers the real value type. A
// leaf added, removed, or retyped above therefore cannot drift away from the
// type the rest of the codebase consumes — the two used to be two hand-kept
// descriptions of one shape, which is exactly the kind of pair that rots.
//
// Per-key documentation lives on the leaf schemas above (the source of truth);
// the section aliases below carry only the section-level note.
// ---------------------------------------------------------------------------

/** Keys of `T` whose value type admits `undefined` — i.e. `.optional()` leaves. */
type UndefinedKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T];

/**
 * Re-express `{ k: T | undefined }` (what `z.infer` gives an `.optional()`
 * leaf) as `{ k?: T }`. Under `exactOptionalPropertyTypes` those are different
 * types, and the hand-written interfaces this replaces used the optional form.
 */
type OptionalizeUndefined<T> = {
  [K in Exclude<keyof T, UndefinedKeys<T>>]: T[K];
} & {
  [K in UndefinedKeys<T>]?: Exclude<T[K], undefined>;
};

/**
 * Deep `readonly`, matching how settings are handed out (`DEFAULT_SETTINGS` and
 * every loaded config are `deepFreeze`d). `z.infer` alone yields mutable objects
 * and arrays. Optional properties keep their `?` (the mapping is homomorphic)
 * and shed the `| undefined` that would otherwise not be assignable to an
 * `exactOptionalPropertyTypes` optional.
 */
type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<Exclude<T[K], undefined>> }
    : T;

/**
 * `z.infer` on a leaf read out of the table. The conditional is what lets the
 * indexed access be inferred through the generic section/key parameters — the
 * `satisfies` clause proves every leaf is a `ZodTypeAny`, but TypeScript will
 * not use it on an unresolved index.
 */
type InferLeaf<L> = L extends z.ZodTypeAny ? z.infer<L> : never;

export type GolemSettings = DeepReadonly<{
  [S in SectionName]: OptionalizeUndefined<{
    [K in keyof (typeof SETTINGS_LEAVES)[S]]: InferLeaf<(typeof SETTINGS_LEAVES)[S][K]>;
  }>;
}>;

/** Proxy listener, upstream selection (R6.1), and the gateway/target registries (R9.1). */
export type ProxySettings = GolemSettings["proxy"];

/** Local inference endpoint, per-worker target routing (R9.4), provider table (R8.15). */
export type InferenceSettings = GolemSettings["inference"];

/** The input-side dial (R11.1/ADR-0004) plus the Headroom sidecar opt-in (Decision 23/53). */
export type CompressionSettings = GolemSettings["compression"];

/** Decision 52 — the output-side brevity dial. */
export type BrevitySettings = GolemSettings["brevity"];

/** Vector KB, wiki, local-answer (Decision 33), repo map / LSP (R8.5/R8.6), web cache. */
export type KnowledgeSettings = GolemSettings["knowledge"];

/** R13.4 — device + user authentication for the write surface (ADR-0007 §7). */
export type SecuritySettings = GolemSettings["security"];

/** Local telemetry collection and the savings dashboard (spec §5). */
export type TelemetrySettings = GolemSettings["telemetry"];

/** Control-panel presentation: pet, colour policy, advanced controls. */
export type UiSettings = GolemSettings["ui"];

/** R8.8 — the model catalog (price + context limits) settings. */
export type ModelsSettings = GolemSettings["models"];

/** Decision 45 — the document-and-hold park at the usage limit. */
export type SnoozeSettings = GolemSettings["snooze"];

/** Which Claude Code settings file `golem init` owns (local vs committed). */
export type ClaudeSettings = GolemSettings["claude"];

/**
 * Built-in defaults (the lowest layer). Where the spec is silent the choice is
 * recorded in docs/plan/verification-notes.md §17:
 * - proxy.port 4653 / telemetry.dashboard_port 4654 ("GOLE" on a phone keypad).
 * - compression.level 1 (lossless-only: byte-faithful with real savings, spec P0 DoD).
 * - upstream https://api.anthropic.com; Ollama http://localhost:11434.
 */
export const DEFAULT_SETTINGS: GolemSettings = deepFreeze({
  proxy: {
    // ADR-0004: never the default. The one setting that can switch redaction off.
    bypass_all: false,
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
    worker_targets: {},
    local_editor_enabled: false,
    providers: [],
  },
  compression: {
    headroom_sidecar: false,
    force_semantic_on_caching: false,
    // R11.1: was "auto" (follow the slider). Set directly now; 1 is what "auto"
    // resolved to on a default install, so the default install is unchanged.
    level: "1",
    // Empty by default: Golem's mode presets are the whole behaviour until a
    // user deliberately reaches past them (Decision 53).
    headroom_config: {},
  },
  // Decision 52: ships OFF — brevity is opt-in until the rollup shows a real net
  // saving on this project's own traffic.
  brevity: {
    level: "off",
  },
  knowledge: {
    enabled: true,
    watch_paths: [],
    auto_index_max_files: 50,
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
  security: {
    // 4655 — the dashboard's 4654 plus one; write sits beside read, never on it.
    write_port: 4655,
    // Loopback. A surface that can ACT is never exposed by default.
    write_lan: false,
    unlock_window_minutes: 15,
    idle_relock_minutes: 5,
    step_up_max_age_minutes: 2,
    device_cert_days: 90,
  },
  telemetry: {
    enabled: true,
    dashboard_port: 4654,
    // Loopback. Widening the bind is an explicit act, never a default.
    dashboard_lan: false,
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
    spawn_gate: true,
    // ~171k–186k tokens per subagent, measured 2026-08-22 (task `subagent-park`).
    spawn_cost_fraction: 0.18,
  },
  claude: {
    // Machine-local wiring belongs in the gitignored file (see the leaf comment).
    settings_scope: "local",
  },
  // ADR-0005: an EMPTY load list is the default, so a fresh install runs no
  // third-party in-process code at all. `enabled` is the kill switch; naming a
  // specifier is the opt-in.
  plugins: {
    enabled: true,
    load: [],
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
