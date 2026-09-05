# Golem Verification Notes (live-doc findings)

Live-document verification record required by CLAUDE.md and IMPLEMENTATION_PLAN T0.1.
All findings below were checked against live docs on **2026-07-03** unless noted.
Add new dated entries below; never rewrite history — corrections get a new entry.
(Entries §1–§16 predate the Golem rename — read "EOL" as "Golem", see §17.)

---

## ⚠ Contradictions with spec v1.0 (resolved in spec Decisions Log v1.1 — do not build on the old claims)

| # | Spec claim | Reality (verified 2026-07-03) | Resolution |
|---|---|---|---|
| C1 | §1.2/§9.2: Headroom memory "supports a native **Qdrant backend** (`HEADROOM_QDRANT_*`)"; adopt it on EOL's shared Qdrant | **Refuted.** Headroom memory is embedded **SQLite + HNSW + FTS5** (`db_path`, `hnsw_*` keys; extras `[memory]` = sqlite-vec + sentence-transformers). No `HEADROOM_QDRANT_*` env vars exist anywhere in docs/README/pyproject. Qdrant appears only in a `.devcontainer` "memory-stack" and a `memory-stack` extra | Spec Decision 13: adopt Headroom memory **on its own embedded backend**; `search_local` federates across two stores (EOL Qdrant KB + Headroom memory API) instead of one Qdrant instance. WS-C task C4 rescoped |
| C2 | §5.1: slash commands named `/eol:slider`, `/eol:stats`, … | **Colon-namespaced command names are not supported** in current Claude Code. Namespacing is directory-based: `.claude/skills/eol/slider/SKILL.md` → `/eol/slider` (legacy `.claude/commands/` still works, same rule). MCP prompts surface as `/mcp__eol__slider` | Spec Decision 14: command surface is `/eol/<cmd>` (+ `/mcp__eol__<cmd>` from MCP prompts). All `/eol:*` mentions in docs are to be read as `/eol/<cmd>` |
| C3 | §1.2: "Kompress (ONNX INT8, no torch) stays the default text compressor" | **Unconfirmed.** Kompress-v2-base is a HuggingFace ModernBERT model documented as **requiring PyTorch** under `[ml]`. `onnxruntime` ships in Headroom's `[proxy]` extra (which EOL does not install), and no doc claims INT8. Headroom also added a native deterministic **TextCrusher** prose compressor recently | Spec wording softened. EOL's default install gets Headroom's non-ML compressors (SmartCrusher/TextCrusher/code/CCR); Kompress-class ML compression slots under EOL `[ml]` |
| C4 | §1.2/§6: Headroom base is "lightweight (tiktoken, pydantic, click, ast-grep)" | **Incomplete.** Base also pulls `litellm>=1.86.2,<2.0` (py<3.14), `rich`, `opentelemetry-api`. Torch-free, but litellm is a hefty dependency tree. Also: `[memory]` pulls **sentence-transformers (torch)** and `[mcp]` extra is required for Headroom's MCP server | Accepted: EOL pins `headroom-ai[code]` (base + tree-sitter) in default deps; anything pulling torch (incl. Headroom `[memory]`) goes under EOL `[ml]` |

Minor doc-level notes that are **not** contradictions but adjust tasks: `headroom wrap claude` conflict CONFIRMED (see §5); tool search is disabled by Claude Code by default when `ANTHROPIC_BASE_URL` is non-first-party (see §12) — new work item for WS-A/WS-E.

---

## 1. headroom-ai version & pin (2026-07-03)

- **Latest PyPI release: `0.28.0`** (released 2026-06-29). 158 releases, ~weekly cadence.
  Sources: https://pypi.org/pypi/headroom-ai/json, https://pypi.org/project/headroom-ai/#history
- **EOL pin: `headroom-ai[code]==0.28.0`** (pyproject.toml; asserted by `tests/contract/test_headroom_pin.py`). *[SUPERSEDED same-day by the TypeScript pivot — see §16: no Headroom dep in the default install; this version becomes the P2 sidecar pin.]*
- **0.29.0 is imminent**: main-branch pyproject already says 0.29.0 and CHANGELOG has a `0.29.0 (2026-07-03)` entry. First T-C4 upgrade-playbook run should be scheduled at the first sprint boundary.
- License Apache-2.0; `requires-python >=3.10`; prebuilt `win_amd64` wheels (Rust core via maturin) — Windows support confirmed at the artifact level.
- Repo note: changelog compare-links also reference `headroomlabs-ai/headroom` — possible org migration; watch when bumping the pin.

## 2. Headroom library API (for the WS-A adapter) (2026-07-03)

Source: https://headroom-docs.vercel.app/docs/api-reference

- Top-level: `from headroom import HeadroomClient, SmartCrusher, CacheAligner, RollingWindow, TransformPipeline, HeadroomConfig, Tokenizer, count_tokens_text`; configs in `headroom.config` (`IntelligentContextConfig`, `ScoringWeights`, `SmartCrusherConfig`, `CacheAlignerConfig`); `headroom.transforms.IntelligentContextManager`.
- Best embedding fit for EOL: **direct transform use** — `SmartCrusher().crush(data=..., query=...)`, `CacheAligner().align(messages)`, `RollingWindow(cfg).apply(messages, max_tokens=...)`, `TransformPipeline([...]).transform(messages)` — not the `HeadroomClient` wrapper (that wraps an OpenAI-style client; EOL owns its own proxy loop).
- README mentions a bare `compress(messages)` entry point, but the API reference shows no standalone signature — **verify against source in A2 before relying on it**.
- **CCR programmatic retrieve is only documented for the TypeScript SDK** (`headroom_retrieve(hash, query)` tool + LRU store config `storeMaxEntries: 1000`, `storeTtlSeconds: 3600`). Python-native retrieval API must be confirmed from source in A2. Compressed output carries inline markers like `[1000 items compressed to 20. Retrieve more: hash=abc123]` (https://headroom-docs.vercel.app/docs/ccr).

## 3. Headroom config surface → slider mapping (2026-07-03)

Source: https://headroom-docs.vercel.app/docs/configuration

- No single "aggressiveness" dial; per-stage **typed config objects** are the mapping target for `SliderPolicy`:
  - `SmartCrusherConfig`: `max_items_after_crush`, `min_tokens_to_crush`, `relevance_tier`, `preserve_fields`
  - `CacheAlignerConfig`: `enabled`, `dynamic_patterns`
  - `RollingWindowConfig`: `min_keep_turns`, `output_buffer_tokens`, `prefer_drop_tool_outputs`
  - `IntelligentContextConfig`: `keep_system`, `keep_last_turns`, `use_importance_scoring`, `scoring_weights`, `compress_threshold`, `recency_decay_rate`
  - Code compression: `preserve_imports`, `preserve_signatures`, `preserve_type_annotations`, `docstring_mode`, `target_compression_rate`
  - Per-tool overrides: `headroom_tool_profiles={"tool": {"skip_compression": True}}`
- Env vars: `HEADROOM_LOG_LEVEL`, `HEADROOM_STORE_URL`, `HEADROOM_DEFAULT_MODE`, `HEADROOM_MODEL_LIMITS` (path or inline JSON), `HEADROOM_BASE_URL`, `HEADROOM_API_KEY`, `HEADROOM_SAVINGS_PATH`, `HEADROOM_TELEMETRY`, `HEADROOM_OUTPUT_SHAPER`, `HEADROOM_EMBEDDER_RUNTIME`. Model-limit file: `~/.headroom/models.json`.
- **Telemetry is opt-in (off by default) since 0.27/0.28** — don't rely on older opt-out behavior.

## 4. Headroom memory subsystem (2026-07-03)

Source: https://headroom-docs.vercel.app/docs/memory

- Exists as spec'd functionally: inline fact extraction via injected system-prompt instruction + `<memory>` block; categories PREFERENCE/FACT/CONTEXT/ENTITY/DECISION/INSIGHT; scopes User/Session/Agent/Turn; API `.memory.search()/.add()/.get_all()/.clear()/.stats()`, `supersede()` versioning.
- **Backend: embedded SQLite (CRUD/filter) + HNSW (vector) + FTS5 (keyword). No Qdrant backend** (contradiction C1). Config keys: `db_path`, `vector_dimension`, `hnsw_ef_construction`, `hnsw_m`, `hnsw_ef_search`. Extras: `[memory]` = sqlite-vec + sentence-transformers (⚠ torch); `[vector]` = hnswlib (needs C++ toolchain).
- Guidance writers: `headroom learn` writes between `<!-- headroom:learn:start/end -->` markers. **Docs and README disagree on default target** (docs: `CLAUDE.md` + `MEMORY.md`; README: `CLAUDE.local.md` with `--target CLAUDE.md`) — WS-B task B2 must re-verify at build time before coordinating EOL's guidance writer.

## 5. `headroom wrap claude` — conflict CONFIRMED (2026-07-03)

- `headroom wrap claude|copilot|cursor|cline|continue|aider|opencode|vibe` starts **Headroom's own proxy** and launches the agent pointed at it (flags: `--memory`, `--code-graph`, `--1m`, `--tool-search`); hot-syncs settings via loopback `POST /admin/runtime-env`. `unwrap` commands exist.
- **EOL and `headroom wrap` are mutually exclusive** — both want to own `ANTHROPIC_BASE_URL`. `eol init` must detect an existing Headroom proxy/wrap configuration (base URL pointing at localhost + Headroom admin endpoint answering, or `~/.headroom` wrap state) and refuse with a clear message to `headroom unwrap` first. EOL never shells out to `headroom wrap`; it embeds the library.
- Manual path documented: `headroom proxy --port 8787` + `ANTHROPIC_BASE_URL=http://localhost:8787 claude` — same conflict.

## 6. `--code-graph` (spec §1.2 P1 evaluation item) (2026-07-03)

- Exists as a `headroom wrap` flag. Third-party guides say it wires in **codebase-memory-mcp** (knowledge-graph code index: call chains, impact analysis). **No first-party docs page** — the P1 "evaluate before building EOL's indexer" task (C2 decision memo) must inspect source.

## 7. Headroom MCP server (2026-07-03)

- Tools exactly as spec'd: `headroom_compress`, `headroom_retrieve`, `headroom_stats` (stats now reports rolling/window/lifetime savings). Run: `headroom mcp serve` (stdio) / `--transport http --port 8080` (stateless by default). Requires the **`[mcp]` extra**. `headroom mcp install` registers with Claude Code. Source: https://headroom-docs.vercel.app/docs/mcp

## 8. Claude Code hooks (2026-07-03)

Sources: https://code.claude.com/docs/en/hooks.md, https://code.claude.com/docs/en/hooks-guide.md

- ~23 hook events. Relevant to EOL: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `PreCompact`/`PostCompact`, `Notification`.
- Config schema (any settings scope: user/project/local/managed):
  ```json
  {"hooks": {"PostToolUse": [{"matcher": "<tool-name-or-regex>", "timeout": 600,
      "hooks": [{"type": "command", "command": "<exe>", "async": false}]}]}}
  ```
- Hook stdin: JSON with `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, … Exit code 2 = block; JSON stdout controls behavior.
- **Decision 10 CONFIRMED FEASIBLE:** `PostToolUse` can replace tool output before it enters model context via `hookSpecificOutput.updatedToolOutput` — this is the mechanism for WS-B task B2 (swap oversized tool outputs for CCR refs). `PreToolUse` supports `permissionDecision` and `updatedInput`.

## 9. `claude mcp add` & `.mcp.json` (2026-07-03)

Sources: https://code.claude.com/docs/en/mcp-quickstart.md, https://code.claude.com/docs/en/mcp.md

- Stdio: `claude mcp add eol -- <command> <args...>` · HTTP: `claude mcp add --transport http eol http://localhost:<port>/mcp` · headers via `--header "K: V"`.
- Scopes: `--scope local` (default, `~/.claude.json` per-project), `--scope user`, `--scope project` (writes `.mcp.json`, committable).
- `.mcp.json`: `{"mcpServers": {"eol": {"type": "stdio"|"http"|"sse"|"websocket", "command"/"url": ..., "env": {...}, "headers": {...}, "alwaysLoad": true}}}` (`alwaysLoad` needs v2.1.121+).

## 10. MCP prompts → slash commands (2026-07-03)

- CONFIRMED: MCP prompts surface as `/mcp__<servername>__<promptname>`, discovered dynamically at session start; space-separated args parsed per the prompt's declared parameters. So EOL's prompts appear as `/mcp__eol__slider`, `/mcp__eol__stats`, etc. Source: https://code.claude.com/docs/en/mcp.md § "Use MCP prompts as commands".

## 11. Custom slash commands / skills (2026-07-03)

Source: https://code.claude.com/docs/en/skills.md

- Custom commands are unified into **skills**. Locations: legacy `.claude/commands/<name>.md` (still works) or `.claude/skills/<name>/SKILL.md`. Namespacing via **directories**: `.claude/skills/eol/slider/SKILL.md` → **`/eol/slider`**. **Colon names (`/eol:slider`) are not valid** (contradiction C2).
- Frontmatter: `description`, `model`, `allowedTools`, `subagent`, `alwaysLoad`, `invocationMode` (`user`|`auto`). Body supports `$ARGUMENTS`, bash execution, `@path` file references.
- `eol init` therefore installs: `.claude/skills/eol/<cmd>/SKILL.md` short names + MCP prompts for the `/mcp__eol__*` forms.

## 12. `ANTHROPIC_BASE_URL` & proxy operation (2026-07-03)

Sources: https://code.claude.com/docs/en/llm-gateway-connect.md, https://code.claude.com/docs/en/network-config.md

- CONFIRMED: Claude Code honors `ANTHROPIC_BASE_URL` (shell env or `settings.json` → `"env"`). Credentials: `ANTHROPIC_AUTH_TOKEN` (Bearer) / `ANTHROPIC_API_KEY` (x-api-key) / `apiKeyHelper`.
- ⚠ **NEW CONSTRAINT:** when `ANTHROPIC_BASE_URL` points at a non-first-party host, Claude Code **disables tool search** by default; `ENABLE_TOOL_SEARCH=true` re-enables it **only if the proxy forwards `tool_reference` blocks correctly**. → WS-A A1 must pass `tool_reference` blocks byte-faithful; WS-E E2 should set `ENABLE_TOOL_SEARCH=true` alongside the base URL, and docs must mention it.
- Also disabled behind a gateway: Remote Control; voice dictation needs gateway credential vars unset. Document as known limitations of proxy mode.
- `ANTHROPIC_CUSTOM_HEADERS` exists — candidate mechanism for `x-eol-bypass` / per-request headers.

## 13. Claude Code settings hierarchy (2026-07-03)

Source: https://code.claude.com/docs/en/settings.md

- Precedence (high→low): managed → CLI args → `.claude/settings.local.json` → `.claude/settings.json` → `~/.claude/settings.json`. Permissions **merge** across scopes rather than override. `permissions`/`hooks`/`apiKeyHelper` hot-reload; `model`/`outputStyle` need restart.
- EOL mirrors this: `~/.eol/settings.json` → `<project>/.eol/settings.json` → `<project>/.eol/settings.local.json` → env (`EOL_<SECTION>_<KEY>`) → per-request headers (spec §5.1) — consistent with live conventions.

## 14. Anthropic prompt caching × compression (2026-07-03)

Sources: https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md, .../tool-use-with-prompt-caching.md, .../token-counting.md

- `cache_control: {"type": "ephemeral"}`; max **4 breakpoints**; min cacheable prefix 1,024 tokens (Opus 4.8/Sonnet 5 class) or 4,096 (some older/smaller models); TTL 5 min (default) or 1 h (2× write cost); reads 0.1×, writes 1.25×/2×. No beta header needed.
- Cache key hierarchy **tools → system → messages**, exact/byte-identical prefix match; cache scope is **workspace-level** (shared across API keys in a workspace — a multi-user EOL hub naturally shares hits; document).
- **Binding design rule for WS-A (encoded in `CompressionService` contract):** re-compressing previously-sent turns MUST reproduce byte-identical output, or every request becomes a full cache write. Store/replay each turn's compressed form; compress only new content. This is what Headroom's CacheAligner exists for — slider mapping must never configure lossless stages non-deterministically.
- Claude Code caches automatically; `DISABLE_PROMPT_CACHING=1` (+ per-model variants) strips `cache_control` — the proxy must pass caching markers through untouched and never inject markers when the client disabled them.

## 15. Messages API SSE / tool-use shapes (for recorded-shape tests) (2026-07-03)

Sources: https://platform.claude.com/docs/en/build-with-claude/streaming.md, .../fine-grained-tool-streaming.md

- Event types to pass byte-faithful: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `ping`, `error`.
- Delta subtypes: `text_delta`, `input_json_delta` (partial JSON — never parse/reassemble in the proxy), `thinking_delta`, `signature_delta` (thinking integrity — never touch).
- Block types: `text`, `tool_use`, `thinking`, `server_tool_use`, `web_search_tool_result` (encrypted server-side results — pass through unchanged).
- Recent additions the recorded suite must cover: fine-grained tool streaming (`eager_input_streaming`), thinking signatures, server tool results, `tool_reference` blocks (see §12).
- Proxy rules: no buffering/merging/reordering of events, no stripping `ping`, pass `error` events immediately.

---

## 16. Headroom TypeScript SDK — NOT a compression library (2026-07-03, post language pivot)

Context: spec Decision 16 (2026-07-03) switched EOL's implementation language to
TypeScript (user decision); this entry records the T0.1b parity verification that
finalized Decision 18.

- npm package **`headroom-ai` 0.22.4** (published 2026-06-03; only 2 releases ever:
  0.1.0 then 0.22.4), Apache-2.0, Node >=18, zero runtime deps, types shipped.
  Lives in `sdk/typescript/` of the monorepo. Sources:
  https://registry.npmjs.org/headroom-ai, repo README (2026-07-03).
- **It is a thin HTTP client to the Python proxy** — installation docs verbatim:
  "The TypeScript SDK sends messages to the Headroom proxy over HTTP for
  compression"; requires `pip install "headroom-ai[proxy]"` + `headroom proxy
  --port 8787` (or Headroom Cloud). **No compression runs in Node.**
- Python-only, no TS equivalent: proxy, MCP server, memory subsystem, ALL
  compressors (SmartCrusher, CodeCompressor, Kompress, TextCrusher, CacheAligner).
  TS-side: `compress()`/`simulate()` (remote calls), `withHeadroom()` Anthropic/
  OpenAI wrappers, CCR client config (`injectTool`, `storeMaxEntries`,
  `storeTtlSeconds` — store lives in the proxy), `SharedContext`, `CompressionHooks`.
- ⚠ The TS Anthropic wrapper **converts `tool_use`/`tool_result` to OpenAI format
  and back** for compression — a byte-fidelity risk EOL avoids by not using the
  wrapper on the proxy path.
- Version drift risk: npm 0.22.4 vs PyPI **0.29.0 (released today, 2026-07-03)**;
  no documented client↔proxy compatibility matrix.
- Repo renamed: `chopratejas/headroom` → **`headroomlabs-ai/headroom`** (redirect
  active). Update watch/pin references.
- **Resolution (spec Decision 18 FINAL):** P0 = EOL-native TS lossless stage
  (dedup, compaction, cache alignment, CCR store) — no Headroom dependency in the
  default install. P2+ = optional pinned Python sidecar (`headroom-ai[proxy]`,
  0.28.0 at verification; re-verify at integration) spawned/managed by EOL for
  ML-heavy slider ≥3 stages, with the npm client (pin 0.22.4) as typed transport.
  MEMORY-scope federation (Decision 13) also moves behind the optional sidecar.
- Dependency versions captured for the scaffold (registry.npmjs.org, 2026-07-03):
  `@modelcontextprotocol/sdk` **1.29.0** (MIT, healthy, releases every 1–2 weeks);
  `@anthropic-ai/sdk` **0.110.0** (MIT, healthy); `@lancedb/lancedb` **0.31.0**
  (Apache-2.0, per-platform napi prebuilds via optionalDependencies — native dep,
  weigh against the heavyweight-deps rule in the C1 decision memo).

## 17. Project renamed EOL → Golem (2026-07-03, user decision — spec Decision 19)

- All entries above predate the rename: read "EOL" as "Golem". Renamed surfaces
  are enumerated in spec Decision 19 (`golem_*` tools, `/golem/<cmd>`,
  `/mcp__golem__<cmd>`, `GOLEM_*` env, `~/.golem/`, `x-golem-bypass`).
- Domain **golem.run** registered for onboarding/docs.
- npm naming (checked https://registry.npmjs.org, 2026-07-03): `golem` is TAKEN
  (unrelated package, last published 2022) and `golem-cli` is TAKEN (2026-03).
  **`golem-run` and `@golem-run/*` were available**; package published as
  `golem-run` with bin `golem` → onboarding is `npx golem-run init`. If the
  stale `golem` name is ever obtained via npm's dispute process, add it as an
  alias package — do not rename `golem-run`.
- The npm **org name `golem` is NOT available** (checked by the user via
  npmjs.com org creation, 2026-07-03), so `@golem/run` is off the table —
  `golem-run` stands as the canonical package name. Recommended: register the
  `golem-run` org to reserve `@golem-run/*` for future satellite packages
  (ML add-on, sidecar bridge, dashboard).

## 18. E1 config loader — decisions where the spec is silent (2026-07-03, WS-E)

Recorded by agent-ux while implementing `src/config/` (task E1). Proposed spec
additions; none contradict the spec.

- **User config dir is the literal `~/.golem`** (via `os.homedir()`), NOT
  env-paths platform config dirs (`%APPDATA%` etc.). Spec §5.1/Decision 19 pin
  the path as `~/.golem/settings.json`, mirroring Claude Code's `~/.claude/`.
  env-paths stays in deps for cache/data/log dirs in later WS-E tasks.
- **Default ports:** proxy `4653`, dashboard `4654` ("GOLE" on a phone keypad;
  spec is silent). Both overridable (`proxy.port`, `telemetry.dashboard_port`).
- **Default slider level: 1** (lossless-only — byte-faithful with real
  savings, matching the P0 DoD emphasis).
- **Key set** (all snake_case, flat `section.key`): `slider.level`,
  `slider.local_only_opt_in`, `proxy.port`, `proxy.upstream_base_url`
  (default `https://api.anthropic.com`), `proxy.request_timeout_ms` (600000),
  `proxy.connect_timeout_ms` (10000), `inference.ollama_base_url`
  (`http://localhost:11434`), `knowledge.enabled` (true),
  `knowledge.vector_db_url` (unset = embedded store),
  `knowledge.watch_paths` ([]), `telemetry.enabled` (true),
  `telemetry.dashboard_port`.
- **Env mapping** (full rules in `src/config/env.ts`): names matched
  case-insensitively (Windows semantics everywhere); split at the first `_`
  after `GOLEM_` → section names never contain underscores; coercion is
  target-type-driven (bool tokens, finite numbers, JSON-or-CSV arrays,
  verbatim strings); empty value = unset; case-colliding names with different
  values are a hard error.
- **Unknown sections/keys warn, never fail** (collected on the loaded config
  for `golem status`), so files from newer versions load and `writeSetting`
  round-trips preserve foreign keys. Type/range errors on known keys are hard
  failures naming the file (or env var) and the `section.key`.
## 19. @modelcontextprotocol/sdk 1.29.0 — actual API surface (2026-07-03, WS-B B1)

Verified against the installed package's shipped types/source (`node_modules/
@modelcontextprotocol/sdk/dist/esm/`), not docs-from-memory:

- **Registration API:** `McpServer.registerTool(name, {title, description,
  inputSchema, outputSchema, annotations}, cb)` and `registerPrompt(name,
  {title, description, argsSchema}, cb)` are current; the positional
  `.tool()`/`.prompt()` overloads are `@deprecated`. `inputSchema`/`argsSchema`
  accept plain zod raw shapes (zod dependency `^3.25 || ^4`; a project pin of
  `^3.24` dedupes below the SDK's floor — Golem bumped to `^3.25.0`).
- **Tool-call error mapping (matters for tests):** the SDK validates zod
  `inputSchema` itself, but its `tools/call` handler catches ALL errors —
  including its own `McpError(InvalidParams)` from validation — and returns
  them as a `CallToolResult` with `isError: true` whose text embeds the code
  (e.g. `MCP error -32602: Input validation error: Invalid arguments for tool
  ...`). Only `UrlElicitationRequired` is re-thrown as a protocol error.
  **Prompt argument validation DOES surface as a JSON-RPC -32602 protocol
  error** (`prompts/get` rejects). Unknown tool name → `isError` result too.
- **Tools with `outputSchema` must return `structuredContent`** (SDK enforces
  on every non-error call and validates it against the schema).
- **Transports:** `StdioServerTransport` (`server/stdio.js`);
  `StreamableHTTPServerTransport` (`server/streamableHttp.js`) is now a thin
  Node wrapper over `WebStandardStreamableHTTPServerTransport` via
  `@hono/node-server`; stateful mode = `sessionIdGenerator` +
  `onsessioninitialized` (session id in `mcp-session-id` header), stateless =
  `sessionIdGenerator: undefined`. `isInitializeRequest` is exported from
  `types.js` for the open-a-session-only-on-initialize gate.
  `InMemoryTransport.createLinkedPair()` (`inMemory.js`) is the in-process
  test harness; `Client` lives in `client/index.js`,
  `StreamableHTTPClientTransport` in `client/streamableHttp.js`.
- ⚠ **`exactOptionalPropertyTypes` friction:** the SDK's transport classes
  declare optional callbacks/fields as `T | undefined` while the `Transport`
  interface declares them as `prop?:`, so `server.connect(transport)` fails
  TS2379 under Golem's tsconfig for `StreamableHTTPServerTransport` and
  `StreamableHTTPClientTransport` (StdioServerTransport is fine). Workaround:
  `connect(transport as Transport)` at the call site (`src/mcp/serve.ts`).
- SDK runtime deps are pure-JS (hono, express, jose, ajv, eventsource, zod…) —
  no native modules; compatible with the no-heavyweight-native-deps rule.

## 20. Slider-key reconciliation: MCP store ↔ config loader (2026-07-04, WS-E E3)

B1's `JsonFileSliderStore` originally persisted a FLAT root-level `slider_level`
key in `~/.golem/settings.json`, while the E1 config schema
(`src/config/schema.ts`) validates the NESTED `slider.level` leaf. Left as-is,
`/mcp__golem__slider` (level) and `loadConfig()`/`golem slider` would
read/write two different keys and disagree.

Reconciliation (sanctioned cross-workstream fix; the `SliderStore` interface is
unchanged):

- `JsonFileSliderStore` now reads and writes `slider.level` (nested), matching
  the config schema exactly. `get()` still falls back to the legacy flat
  `slider_level` (`LEGACY_SLIDER_LEVEL_KEY`) if present, and `set()` deletes
  that flat key so the file migrates to the nested shape on first write.
  Reads/writes merge with — and preserve — all other keys (including other
  `slider.*` keys like `local_only_opt_in`) via read-merge-write + temp-file
  rename, so it round-trips cleanly with `writeSetting` and the loader.
- The CLI wires the MCP store to the PROJECT settings file
  (`<project>/.golem/settings.json`) via `settingsFilePaths({ projectDir }).project`
  — the same file `golem slider` writes with `writeSetting("project", …)` and
  the loader's project layer reads. Standalone/default construction still uses
  the user-scope file (`~/.golem/settings.json`).
- `golem slider [level]` reads through `loadConfig` (so it can report WHICH
  layer set the effective level and warn when a higher-precedence layer — e.g.
  a `GOLEM_SLIDER_LEVEL` env var — overrides the value just written).

Net result: `golem slider`, `/mcp__golem__slider`, and `loadConfig` all observe
one value in one file/key. Covered by `tests/integration/cli-slider.test.ts`
and the updated `tests/integration/mcp-slider-store.test.ts`.

## 21. `golem status`/`stats` and dashboard v0 (2026-07-04, WS-E E3)

- **`golem status`** composes the E1 loader's provenance (per `section.key`
  layer + source), the init.ts file checks (reused via a new read-only
  `golemInitStatus` that never throws on malformed files), a short loopback
  HTTP probe of the configured proxy port (any HTTP answer = reachable; refused/
  timeout = not running), and the effective slider level. `--json` emits the
  full snake_case report.
- **`golem stats`** reads savings through a thin `StatsSource` seam
  (`{ kind, note, stats(projectId?) }`) so A4's telemetry store can be plugged
  in later without touching command code. For now `liveStatsSource(projectDir)`
  wraps the A2 `NativeLosslessCompression` (accurate per-stage attribution but
  in-memory per process); every report carries a `note` that durable history
  starts when telemetry (A4) lands. Do NOT import from `src/telemetry/` yet.
- **`golem dashboard`** (v0) serves, loopback-only (`127.0.0.1`), one
  self-contained inline-styled HTML page plus a JSON API — zero new runtime
  deps (`node:http` only). Endpoints: `GET /` (page), `GET /api/stats`
  (snapshot JSON the page polls every 2s), everything else → 404. Default port
  is `telemetry.dashboard_port` (4654). Covered by
  `tests/integration/dashboard.test.ts` (starts on port 0).
- **`golem index` / `golem devices`** are explicit not-implemented stubs that
  print a pointer to WS-C / WS-D and exit non-zero.

## 22. WS-D hardware capability detection — cross-OS strategy & limits (2026-07-04, WS-D D1)

CLI-probe-only detection (no native GPU/ML deps, per CLAUDE.md). All probes
spawn with argument arrays (`shell:false`), enforce a 3s timeout, and resolve
to `{ ok:false }` on ENOENT/non-zero/timeout — `detectCapability` therefore
**cannot throw and always yields a tier**, defaulting to P_CPU.

- **NVIDIA (Windows + Linux):** `nvidia-smi --query-gpu=memory.total,name
  --format=csv,noheader,nounits`; pick the largest-VRAM GPU. Tier by usable
  memory: <8 GiB → P_MIN, 8–16 GiB → P_MID, >16 GiB → P_MAX.
- **Apple Silicon (macOS):** `uname -m` == `arm64`, then `sysctl -n hw.memsize`;
  ~70% of unified memory is treated as usable (conservative; the real GPU-wire
  ceiling varies by OS version).
- **Known limits / TODOs (deferred, not P0-blocking):** no AMD ROCm / Intel Arc
  detection yet (both fall to P_CPU — safe degrade); Windows non-NVIDIA GPUs are
  not probed (WMI/DXGI path is the §6 "Windows GPU detection reliability"
  unknown — left open deliberately, CPU fallback is correct meanwhile); the
  Apple 70% factor is a heuristic, not measured. All of these degrade *down*, so
  the failure mode is "smaller model / CPU," never a crash.
- **Model catalog (D2)** is advisory (spec Decision 6): Qwen2.5 / Llama3.x /
  bge-m3 / nomic-embed-text at Q4-class quant, as a plain data table in
  `catalog.ts` — re-verify current-best models at build time.
- **Fallback ladder (D3):** tier model → step down one tier on
  `ModelNotAvailableError` → `HaikuFallbackRequired` (if opted in; the service
  does NOT make the cloud call, it signals the credentialed caller) → else
  `CapabilityUnavailableError`. A reachable-but-broken endpoint
  (`InferenceEndpointError`) stops the local ladder rather than hammering it.

## 23. Redaction breaks agent observability when the dev session is routed through Golem (2026-07-04, product finding)

Observed while dogfooding: with `ANTHROPIC_BASE_URL` pointed at the Golem proxy,
the redaction stage rewrites the developing agent's OWN request content, so
secret-shaped strings (and even innocuous high-entropy path segments in some
cases) come back as `[REDACTED:...]`. Consequence: an agent working *inside* the
redacting loop cannot see ground-truth content, which makes secret-handling
work (notably **T-C3**, which is entirely secret patterns) unreliable to do from
that session — it cannot distinguish "redacted in my view" from "on disk."

Redaction acting on the request path is CORRECT (that is the whole point;
byte-faithful local file writes are unaffected). The finding is about developer
ergonomics / observability, not a redaction bug. Options to consider (design,
not yet decided):
- a Golem-aware bypass when the client is Golem's own dev session (e.g. honor a
  well-known header/env so the developing agent sees ground truth);
- a louder, structured signal in responses that content was redacted (count +
  kinds) so the agent knows its view is filtered rather than guessing;
- guidance: do secret-pattern work (T-C3) from a session NOT routed through the
  proxy (the escape hatch: remove `ANTHROPIC_BASE_URL`, restart).

Ties to the fail-open work (proxy already degrades safely on pipeline error) and
to Decision 20d/20c ergonomics. T-C3 is therefore parked until a clean session.

## 24. T-C3 redaction security review — outcome (2026-07-04, done in a clean session)

Adversarial audit added as `tests/unit/pipeline/redaction-audit.test.ts` (the
attacker's-view corpus; complements the per-rule smoke in `redaction.test.ts`).
Invariant checked: no raw secret survives verbatim, at any nesting depth.

**Bug found & FIXED (would have leaked a live secret):** the group-redaction
path used `match.replace(target, placeholder)`, which replaces the FIRST
occurrence of the captured value inside the match. For a connection string like
`postgres://ab:ab@localhost/app` (password == username) it redacted the
USERNAME and left the real password in the clear. Rewrote `applyRule`
(`src/pipeline/redaction.ts`) to redact the EXACT captured span using match
indices (`d` flag + `matchAll`), so the password span is redacted and the rest
of the match (username, host) is preserved. Regression tests cover the
password-equals-username case, the dotless-host (`localhost`) case where the
email rule cannot mask the leak, and the username-less `redis://:pw@` form.

**Verified strengths:** deterministic + idempotent (re-redacting is a no-op →
prompt-cache prefix stability holds); depth-recursive over the JSON body; the
entropy backstop catches uncontexted 32+ char mixed secrets while NOT flagging
git SHAs / UUIDs (false-positive guard tested).

**Residual coverage gaps (documented, NOT fixed — low risk, entropy net is the
backstop; add rules as needed):**
- No dedicated rule for Google API keys (`AIza…`), Stripe keys (`sk_live_…` —
  underscore, so the `sk-` OpenAI rule does not match), GCP `ya29.` tokens, or
  Azure connection strings. High-entropy instances are caught by the entropy
  sweep; low-entropy or short ones may pass. Adding provider rules is a
  mechanical follow-up (append to `REDACTION_RULES` + a corpus case).
  **Fixed 2026-07-11, R1.4 — see §56.**
- Redaction operates on JSON string values only; a secret split across a
  concatenation the client never assembles is out of scope (so is anything the
  client sends already base64-wrapped without a provider prefix — entropy net
  applies).

No ReDoS: every pattern uses bounded or disjoint quantifiers (private-key uses a
lazy body between fixed anchors; jwt uses dot-separated disjoint classes).

## 25. A4 telemetry — durable per-stage savings (2026-07-04, WS-A A4)

Backend choice: **append-only JSONL**, not `node:sqlite`. `node:sqlite` is
present on Node 22–24 but flagged EXPERIMENTAL and emits a runtime
`ExperimentalWarning` on import — unacceptable noise for a CLI/daemon at P0. The
plan explicitly sanctioned the JSONL fallback. It sits behind a narrow
`TelemetryStore` interface (`record`/`aggregate`/`close`) so a future
`node:sqlite` backend can drop in unchanged once the API stabilizes.

- File: `<project>/.golem/telemetry/events.jsonl`, one JSON event per line.
  Appends serialized via an internal promise chain (no interleaved lines under
  concurrency — tested with 25 concurrent records). Corrupt/partial trailing
  line is skipped on read, never throws (crash-mid-write safe).
- Wiring: the `golem proxy` pipeline `onEvent` records each run
  fire-and-forget (`.catch(()=>{})` — telemetry never blocks or breaks the
  request path); `shutdown` drains the write chain via `telemetry.close()`.
  `golem stats` / `golem dashboard` prefer the durable telemetry source once it
  has ≥1 request, else fall back to E3's in-memory live source
  (`statsSourceForCli`). Verified live: a real proxied request with a duplicated
  tool_result persisted an event and `golem stats` reported `source:telemetry`,
  444 tokens saved (dedup 400→53).
- **Known limitation (indicative, not exact):** the request-level
  `tokensBefore`/`After` rollup uses first-stage-before / last-stage-after, but
  stages report on different content slices (redaction sees the whole JSON body;
  dedup/compaction see the messages array), so the summed request total is an
  approximation. **Per-stage deltas are exact.** A precise request total would
  need the pipeline to emit an explicit whole-request before/after pair — a
  small A3 follow-up, noted here rather than silently shipping a wrong headline
  number.
- `ccrRefsRetrieved` is 0 in telemetry: retrievals happen via the `expand`
  MCP tool, not the pipeline, so they are not in this event stream yet. Wiring
  expand→telemetry is a follow-up.

## 26. WS-C C1 — embedded vector store decision memo (2026-07-04)

Resolves spec Decision 17 / §6 known unknown "LanceDB vs sqlite-vec". **Both
ship native binaries**, so whichever wins MUST be an OPTIONAL dependency (lazy
import behind the `VectorDriver` seam) — the default `npx golem-run` install
stays pure-TS (CLAUDE.md hard rule).

**Candidates (verify install footprint at build time before pinning):**
- **LanceDB** (`@lancedb/lancedb`): embedded columnar vector DB, prebuilt N-API
  binaries per platform (Win/mac/Linux, x64+arm64), no external service, native
  ANN index (IVF/HNSW), on-disk Lance format. Purpose-built for vector search;
  scales to large indexes; richest metadata filtering. Heavier install (~tens of
  MB of prebuilt binary per platform).
- **sqlite-vec** (`sqlite-vec` + a SQLite binding): a tiny C extension loaded
  into SQLite. Very small footprint, dead-simple mental model (it's just
  SQLite), trivially inspectable files. But brute-force / limited ANN at C1's
  writing, weaker at large-corpus scale, and needs a SQLite host binding
  (node:sqlite is experimental; better-sqlite3 is another native dep).

**Recommendation: LanceDB** as the embedded driver, for three reasons that map
to Golem's goals: (1) it's a vector store first, so recall/scale on a real code
+ docs corpus is far better than brute-force sqlite-vec; (2) its prebuilt N-API
binaries install cleanly on all three OSes without a compiler, preserving the
zero-friction init story once the add-on is opted into; (3) it needs no separate
SQLite host binding, avoiding the node:sqlite-experimental / better-sqlite3
question entirely. sqlite-vec stays the documented fallback if LanceDB's binary
size or platform coverage becomes a problem.

**How the native-dep constraint is satisfied (implemented in C1):**
- `package.json` gets `@lancedb/lancedb` in **`optionalDependencies`** (NOT
  `dependencies`) when the driver lands — it is absent from the default install
  and pulled only when the user opts into the KB add-on.
- The engine loads via a lazy dynamic `import()` inside a `LanceVectorDriver`
  behind the `VectorDriver` seam; if the module is missing, construction throws
  a clear "vector store add-on not installed — run `npm i @lancedb/lancedb`"
  error (KnowledgeBase then degrades / is unavailable rather than crashing the
  whole app). Qdrant **server** mode stays selectable by `knowledge.vector_db_url`
  (spec Decision 12) via a separate driver.
- Per-project collections under `<project>/.golem/knowledge/` (`knowledgeDir()`),
  `KNOWLEDGE_SCHEMA_VERSION` on every driver for forward-compatible open.

**Delivered in C1 (this task):** the `VectorDriver` seam, a functional
`InMemoryVectorDriver` (cosine search, per-project isolation — the P0 non-durable
default and the test double), `GolemKnowledgeBase` with the READ path real
(text `search` via an injected `EmbedFn` + `getChunk`) and KNOWLEDGE-only
degradation. **Deferred:** `ingest` (heading/code chunking → C2), the `EmbedFn`
wiring to WS-D (C3), the real `LanceVectorDriver` + optionalDependency, the
Qdrant-server driver (stub throws), and wiring `describeKnowledgeBaseContract`
(needs C2+C3 — the harness drives ingest + text search end to end).

## 27. WS-C C2 — ingestion, chunking & watcher decisions (2026-07-04)

**Code-chunking decision (resolves §6 "tree-sitter WASM vs native prebuilds" +
the Decision-2 "evaluate Headroom `--code-graph` first" item):**
- **P1 default: a dependency-free heuristic chunker** (`chunker.ts` `chunkCode`)
  — splits at column-0 top-level declaration boundaries, falls back to
  overlapping line windows for oversized constructs. Zero deps, cross-platform,
  good-enough recall for RAG; keeps the default `npx golem-run` install pure-TS
  (CLAUDE.md).
- **tree-sitter (WASM) is the opt-in upgrade**, not the default: `web-tree-sitter`
  + per-language grammars give true syntax-aware chunks but add WASM payload and
  per-language setup. Ship it behind the same "KB add-on" opt-in as the LanceDB
  driver (§26) when precise code chunking is wanted. Native prebuilt
  tree-sitter bindings are rejected for the default (native-dep rule).
- **Headroom `--code-graph`** (evaluated per Decision 2): it wires in a
  Python-only knowledge-graph MCP (codebase-memory-mcp; verification-notes §6),
  so it belongs behind the **P2 sidecar**, not the P0/P1 pure-TS path. Not used
  for C2's default chunker; revisit for the call-graph/impact-analysis use case
  under the sidecar.

**Chunkers delivered (all pure TS):** heading-aware markdown (`chunkMarkdown` —
section per heading, oversized sections windowed, heading captured in metadata),
heuristic code (`chunkCode`), and windowed text (`chunkText`), dispatched by
extension in `chunkFile`. Every chunk carries 1-based `[startLine,endLine]` and
a `kind` ("text"|"code") so ingestion embeds with the right model. `.html`/`.rst`
currently route through the text chunker (a real HTML/PDF-text extractor is a
follow-up).

**Ingestion (`ingest.ts`):** `planIngest(root)` walks a file or directory,
skips vendored/build/VCS/dot dirs and >1 MB files, chunks each chunkable file,
and returns prepared chunks with POSIX-relative `sourcePath`. `GolemKnowledgeBase.ingest`
traverses → chunks → embeds (per-kind batches via the injected `EmbedFn`) →
upserts vectors, returning an `IngestReport`. Deterministic `chunkId` =
sha256(project∥source∥startLine∥text)[:20]. **This closes the frozen
`describeKnowledgeBaseContract`** (ingest+search+getChunk end to end), using a
deterministic lexical embedder as the WS-D stand-in until C3 wires real
embeddings.

**File-watcher decision (deferred impl):** `node:fs.watch({recursive:true})` is
the zero-dep default candidate (recursive works on Windows + macOS natively, and
on Linux since Node 20) — but it is famously flaky (duplicate/missing events,
rename semantics), so a debounce + re-stat layer is required, and **chokidar**
remains the robust opt-in if fs.watch proves unreliable in practice. `ingest(…,
watch:true)` currently throws `NotImplementedYetError("file watching",
"C2-followup")` rather than silently not-watching; the watcher lands as a small
follow-up behind the existing `watch` flag.

## 28. Claude Code status line — the native terminal-wrapper surface (2026-07-04, for Decision 21c)

Source: https://code.claude.com/docs/en/statusline (fetched 2026-07-04). The
status line is the canonical way to render a persistent "wrapper" under the
Claude Code prompt in the terminal.

- **Config** (`settings.json`): `{"statusLine": {"type":"command",
  "command":"golem statusline","padding":0,"refreshInterval":<sec>}}`. Runs the
  command frequently during a session; the doc warns to cache slow ops and keep
  output short. Multi-line output IS supported; ANSI colors allowed; script must
  write to stdout.
- **stdin JSON** (the payload our command parses) — key fields:
  - `model.id` / `model.display_name`
  - `workspace.current_dir` / `project_dir` / `git_worktree` / `repo.{host,owner,name}`
  - `cost.{total_cost_usd,total_duration_ms,total_lines_added,total_lines_removed}`
  - `context_window.{total_input_tokens,total_output_tokens,context_window_size,
    used_percentage,remaining_percentage, current_usage.{input_tokens,output_tokens,
    cache_creation_input_tokens,cache_read_input_tokens}}` — **`cache_read_input_tokens`
    reflects prompt-cache hits, which Golem's byte-stable compression directly
    optimizes; a natural KPI to surface.**
  - `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}` — **feeds the
    "running out of tokens / quota" awareness for Decisions 20a/21a/21e.**
  - `exceeds_200k_tokens`, `effort.level`, `thinking.enabled`, `session_id`,
    `version`, `output_style.name`, `vim`.
- **Implication:** a `golem statusline` command merges this per-session stdin
  with Golem's own state (savings/slider/upstream/proxy-reachable/storage) to
  render the terminal wrapper. `golem init` installs the `statusLine` config
  (same pattern as the PostToolUse hook).

## 29. WS-C C3 — real embeddings wired; rerank deferred (2026-07-04)

`InferenceService.embed(texts, kind)` (WS-D) matches the KB's `EmbedFn` exactly,
so C3 is a thin adapter (`inferenceEmbedFn`) plus an `inference?` option on
`openKnowledgeBase` (explicit `embed` wins for tests; else derived from
`inference`; else ingest/search raise NotImplementedYetError). The lexical
stand-in from C2 is now test-only. Verified with a fake InferenceService driving
ingest→search end to end.

- **Degradation:** if local inference is unavailable (no Ollama), `embed`
  rejects with the service's own error, which ingest/search surface — rather
  than silently indexing nothing. Documented, intentional.
- **Rerank deferred (rationale):** the FROZEN `InferenceService` exposes only
  `chat`/`embed`/`capabilities` — no `rerank`. Cross-encoder reranking therefore
  can't ride the existing contract; it's a follow-up (either a new optional
  reranker surface, or a chat-judge rerank at slider ≥3). Search stays
  cosine-ranked meanwhile — correct, just not reranked.
- **Real embedder construction** (detect tier → Ollama client → service) is the
  caller's job; B3's `search`/`ingest` MCP tools will build it.
  The KB does not auto-spawn inference (no surprise network calls at construction).

## 30. Savings metric fix — the "91%" was an artifact (2026-07-04, dogfooding)

The §25 "approximate rollup" was worse than approximate — it was wrong. The
telemetry aggregate stitched **redaction's `tokensBefore` (the WHOLE request
body) to compaction's `tokensAfter` (a ~35k messages slice)** — different
scopes — yielding a fictitious 91% on real Foundry traffic.

Fix: the pipeline now emits an explicit **`requestTokens` = estimate(original
body) → estimate(final forwarded body)** — the only apples-to-apples number —
and telemetry aggregates that (legacy events without the field fall back to the
old stitch). Per-stage deltas remain as a breakdown but must never be summed
(they measure different scopes: redaction=whole body, dedup=the deduped span,
compaction=the messages array).

**What the honest numbers revealed on the dogfooding traffic (~1.5M input
tokens over 6 requests):**
- **Real end-to-end savings ≈ 12%**, and **~100% of it is the redaction stage**
  (1,520,615 → 1,335,689 tokens). Dedup + compaction — the actual lossless
  compression — saved ~a few hundred tokens total (≈0.01%): a single Claude Code
  request has little *exact* duplication, and prompt caching already covers
  cross-turn repetition.
- **Open concern (separate investigation):** redaction removing ~12% is the
  **entropy sweep over-matching** high-entropy spans (code, base64, hashes, long
  tokens ≥32 chars) and replacing them with `[REDACTED:high-entropy:N]`. This
  both inflates "savings" (it's redaction, not compression) and may be stripping
  legitimate content the model needs — a possible quality regression. Candidate
  tuning: raise the entropy threshold / min length, require a secret-context
  cue, or make the entropy sweep slider-gated. Not changed yet — flagged.

## §31 — Redaction over-match resolved: the "12%" was integrity hashes (2026-07-05)

Ran the current redaction stage against representative repo content to quantify
the §30 concern deterministically (not waiting on live traffic):

| Content | Before→After | Redacted | High-entropy matches |
|---|---|---|---|
| `src/pipeline/redaction-rules.ts` | 2102→2108 | 0% | 0 (1 pattern match) |
| `src/pipeline/redaction.ts` | 1948→1948 | 0% | 0 (1 pattern match) |
| `src/compression/native-lossless.ts` | 3727→3727 | 0% | 0 |
| **`package-lock.json`** | **27742→24196** | **13%** | **207** |

So the entropy sweep does **not** over-match normal source code (good). The
entire "savings" came from **one source: npm `integrity` values** (`sha512-<b64>`
SRI hashes) in lockfiles — 207 of them in package-lock.json alone. These are
**content hashes, not secrets**: redacting them isn't compression, mislabels
non-secrets as `[REDACTED:high-entropy]`, and would hide a hash Claude might need.

**Fix (this commit):** `isHighEntropyToken` now excludes SRI/integrity-prefixed
tokens (`sha1|sha224|sha256|sha384|sha512|md5-…`) before the entropy check. A
real API key never carries an SRI algo prefix, so secret coverage is unaffected;
the T-C3 corpus gains a guard case. Post-fix package-lock.json redacts 0%.

**Honest consequence:** with the integrity-hash false positive gone, redaction
touches ~nothing on typical dev traffic (only genuine secrets, which are rare),
and dedup/compaction already contribute ~0% on single requests. **Golem's real
token savings on normal Claude Code traffic is therefore ≈0% today.** That is the
honest baseline. Where the value must come from next: cross-request CCR store
reuse (repeated file/context spans across a session), not per-request lossless
compression. This reframes the compression roadmap — flagged for the slider/CCR
work, not a bug.

## §32 — Spike: cross-request CCR reuse is NOT worth building (2026-07-05)

Followed §31 by spiking the "cross-request CCR reuse" thesis empirically against a
real 6.5 MB Claude Code session transcript (this project's own, 1731 messages in
the final-request history view). Measured what dedup could actually save.

**Key structural fact:** Claude Code resends the **entire conversation history**
on every request. So "cross-request reuse" is not a separate case — prior
requests' content is already present in the current request's messages array, and
the existing within-request dedup already sees it. There is no extra content to
catch across requests.

**Measured on real traffic (final-request history = 344,494 content tokens):**

| Signal | Value |
|---|---|
| Exact-dup of large (≥256-char) user-side spans (what dedup elides today) | **0.2%** (2 redundant of 280 spans) |
| Repeated reads of the *same path* (≥256 chars) | ~15,456 tok (~10% of span vol) **but near-dups of *changed/re-sliced* files** — eliding = stale content to the model |
| **Unsafe upper bound:** exact-dup across ALL blocks incl. assistant `tool_use` inputs | **2.5%** of total (8,486 tok) |
| Token distribution | tool_use inputs **44%**, tool_result 32%, user text 12%, assistant text 10% |

**Conclusions:**
1. **Exact dedup is structurally near-useless here (0.2%; 2.5% even unsafely).** A
   coding session has almost no verbatim-repeated large spans.
2. The ~10% "repeated reads" are files that **changed between reads** (e.g.
   `verification-notes.md` read 11× while being appended to) or different slices —
   exact dedup correctly skips them; fuzzy elision would feed the model **stale
   content**. Not a safe lever.
3. The dominant sink (44%) is **assistant `tool_use` inputs** (Edit/Write bodies),
   which the fidelity rule deliberately never touches — and dedup of them is still
   only the 2.5% ceiling.
4. **Anthropic prompt caching already amortizes the stable prefix to ~0.1×.** Any
   Golem elision that changes prefix bytes would *break* the cache — turning a
   0.1× hit into a 1.0× miss for the whole suffix. So compression here doesn't
   just fail to help; naive cross-request dedup is net-*negative*.

**Recommendation (needs a spec Decision — flagged, not applied):** do **not**
build cross-request CCR dedup. Reposition compression from a headline pillar to a
**situational** feature that only pays on **non-caching upstreams** (some
OpenRouter models / Foundry deployments without prompt caching), where the resent
history is re-billed at full price. On Anthropic-with-caching the honest savings
is ~0%. Golem's durable value is **redaction (secrets never leave the machine),
local tools (KB / tiered Ollama / expand), routing (front Foundry/OpenRouter), and
honest observability** — not per-request token compression. CCR store stays (it
backs `expand` and lossy-level reversibility), but "cut token spend via
compression" as the lead claim does not survive contact with real cached traffic.

## §33 — B3: knowledge base wired to Claude (2026-07-05)

Realized the "local tools" pillar (the durable value from Decision 23): the
unified MCP server now exposes the three P1 knowledge tools, backed by a real
local-inference embedder.

- **Tools:** `search` (semantic search → hits with `chunk_id` + preview),
  `fetch` (full chunk by id), `ingest` (ingest a file/dir).
  Registered only when a `KnowledgeBase` is injected (`deps.knowledge`), so the
  P0 stub server is unchanged. Backend failures (Ollama down / model not pulled /
  no embedder) come back as actionable `isError` results, never crashes.
- **Embedder:** WS-C `openKnowledgeBase` + WS-D `OllamaInferenceService`, assembled
  in `src/cli/build-knowledge.ts`. Capability is detected once at startup; on this
  box `golem devices` reports **P_MID** (RTX 3070 Laptop, 8192 MiB) → embed model
  `bge-m3`. Building the stack does NOT contact Ollama — only a real search/ingest
  embeds, so an offline endpoint degrades at call time.
- **CLI:** `golem devices` (real tier + tier models) and `golem index` (real
  ingest) replace the WS-C/WS-D stubs. `golem mcp serve` builds the KB when
  `knowledge.enabled` (default true) and registers the tools; verified live over
  stdio — `tools/list` returns all six tool names, no stderr.
- **Known limit (§26 follow-up):** the default vector driver is the in-memory
  `InMemoryVectorDriver`, so an index built in one process is not reloaded by the
  next. Search must run in the same long-lived `golem mcp serve` session that
  indexed. The durable native driver (LanceDB/sqlite-vec) is the next KB task;
  `knowledge.vector_db_url` (Qdrant server) still raises NotImplementedYet.
- **Not lossy/quality risk:** search is additive context retrieval; it does not
  touch the redaction→compression proxy path or the frozen interfaces.

## §34 — Headroom spike: live-verified surface + MEASURED savings (2026-07-05)

The Decision-23 bet ("real savings come from Headroom's lossy/semantic stages")
spiked against live docs + a real install + the real transcript.

**Current versions (re-verify vs pins).** PyPI `headroom-ai` is now **0.30.0**
(pin was 0.28.0; 0.29/0.30 released since). npm `headroom-ai` is still **0.22.4**
(latest) — a thin HTTP client to the proxy. Python **3.10+**; this box has Python
3.13 + `uv`/`uvx` 0.11.26. `uvx --from "headroom-ai[proxy]==0.30.0" headroom
proxy` installs (86 pkgs, ~8 s cached) and runs. **No PyTorch present → the ML
compression stage (LLMLingua/Kompress) is unavailable; heuristic pipeline only.**
Pin update (0.28.0→0.30.0) is a T-C4 action — noted, not yet applied.

**The integration seam (verified by introspection).** `headroom.compress(messages,
model="…", model_limit=200000, config=CompressConfig(...))` — *"No proxy, no
config needed. Just pass messages and get compressed messages back."* Runs the
full pipeline **in-process, no LLM call, no cost**, and returns `CompressResult`
with **`.messages`** (compressed, same format), `tokens_before/after/saved`,
`compression_ratio`, and **`transforms_applied`**. This is BOTH the integration
path and the offline measurement path. `CompressConfig` knobs:
`compress_user_messages`(False), `compress_system_messages`(True),
`protect_recent`(4), `target_ratio`, `min_tokens_to_compress`(250),
`kompress_model`, `savings_profile` ∈ {general, balanced, coding, agent-90}.

**`headroom proxy` is a full forwarding Anthropic proxy** (endpoints:
`/v1/messages`→upstream, `/livez /readyz /health /stats /stats-history
/metrics`; **no standalone `/compress` route**). It conflicts with Golem's proxy
(both own `/v1/messages`) — confirms §5. So we do **not** chain proxies; we call
`compress()` in-process via a Python sidecar worker, and Golem keeps the forward
(redaction-first, byte-faithful, telemetry all preserved). The npm 0.22.4 client
is **not** used — avoids the 0.22.4↔0.30.0 handshake risk entirely.

**MEASURED on the real 6.5 MB session** (2008-message final-request history;
Headroom's tokenizer counts 787,169 input tokens): the heuristic pipeline saves
**43,217 tokens = 5.48%**, and — importantly — that number is **FLAT across every
`savings_profile`, `target_ratio`, and `compress_user_messages` setting** (those
knobs drive the absent ML stage). The 5.48% decomposes into two transforms:
- **`read_lifecycle` (53 elisions)** — detects the *same file re-read multiple
  times* and drops the **stale/superseded** earlier copies, keeping the latest.
  This is the §32 pattern (files re-read while changing) turned into *safe*
  savings — semantic, not byte-dedup. It is the reason Headroom beats our native
  ~0%.
- **`router` (~338)** — SmartCrusher-class structural/JSON compression of content
  blocks.

**Conclusions:**
1. **Heuristic-only Headroom delivers a real, measured ~5.5% on our traffic** —
   modest but non-zero, and strictly better than the native lossless stage (§32's
   ~0%). The win is semantic (stale-read elision + structural), which is exactly
   what byte-dedup cannot do.
2. **The advertised big numbers (agent-90 ≈ 90%) need the `[ml]` extra** (PyTorch
   + LLMLingua/Kompress) — a heavyweight GPU/ML dep that CLAUDE.md mandates be
   **opt-in, never in the default install**. Its ceiling is **unmeasured** (no
   torch here) and must be measured on a torch-enabled box before any claim.
3. **NET-savings caveat (Decision-23 gate, §31/§32 lesson — UNRESOLVED).**
   *[ANSWERED 2026-07-30 — see §103: measured net-NEGATIVE on caching traffic,
   8.7×–11.3× worse than not compressing, because divergence starts at message 6.
   The gross number below stands; the net question it flagged is now closed.]* The
   5.48% is a **gross input-token** reduction. Headroom *rewrites* content
   (`router`) and *drops mid-history reads* (`read_lifecycle`), which changes
   prefix bytes → risks breaking Anthropic prompt-cache (0.1×→1.0× on the whole
   suffix). Headroom ships `CacheAligner`/`AnthropicCacheOptimizer` to mitigate,
   but the **net** effect on *cached* traffic is unmeasured and could flip the
   gross gain to net-negative — the same trap as the §31 artifact. **No net
   savings may be claimed until this is measured live** (compare real billed
   cache_read vs uncached tokens with/without Headroom).

**Recommendation:** integrate `headroom.compress()` behind the `CompressionService`
adapter as the **slider ≥3** stage via a **persistent Python sidecar worker**
(spawn/health/restart like the proxy daemon; opt-in `pip/uvx install
headroom-ai`), heuristic-only in the default install with `[ml]` as a further
opt-in. Ship it **behind an explicit opt-in and a live cache-aware A/B** before
any savings number reaches golem.run copy.

## §35 — ML ceiling MEASURED: Kompress ≈ irrelevant on code traffic (2026-07-05)

Followed the "measure ML ceiling first" decision. Installed `headroom-ai[ml]`
(torch 2.12.1+cpu; ONNX Kompress model `chopratejas/kompress-v2-base`, ~60 s
preload) and measured on the real transcript.

**How ML enables.** `KompressCompressor(KompressConfig(...)).compress(text)` works
directly (`is_kompress_available()` = True via ONNX). But the pipeline
`compress()` did **not** route to Kompress in any config combo tried
(`kompress_model=…`, `compress_user_messages=True`, `target_ratio=0.2–0.5`,
`savings_profile=agent-90`) — transforms stayed `read_lifecycle` + `router`, ~0.7 s,
flat 5.3%. The routing gate to Kompress is undocumented/unclear; the direct
compressor is the reliable handle. There is also a **hard ~20 s per-call CPU
deadline** (not the `HEADROOM_COMPRESSION_TIMEOUT_SECONDS` env) after which Kompress
keeps the remainder verbatim.

**The killer number — prose is a rounding error in code traffic.** Direct Kompress
on the FULL prose corpus (every `text` block ≥200 chars): **40,617 → 38,336 tok**
(deadline-limited; on the portions it processes it achieves ~16.6%). But that
prose is **only 40,617 of 815,658 total tokens = ~5.0% of the request.** The other
~95% is code/tool-data (Edit/Write bodies, file contents, tool JSON). Kompress
(LLMLingua-style) compresses **natural-language prose only**, so even compressing
*all* prose by ~16% ≈ **0.8% of the total request**. Negligible.

**Conclusion (overrides the "prioritize ML" instinct for THIS workload):**
- **The ML tier does not pay for Claude Code / code-editing traffic.** Its target
  (prose) is ~5% of the tokens; the ~90% "agent-90" headline is for
  prose/chat-heavy agent workloads, not code editing. Measured ML upside here:
  **<1% of total**, bought with a torch dependency, CPU latency (no CUDA on the
  Windows wheel; ~437 words/s, 20 s/call deadline), and lossy prose.
- **The only meaningful, safe lever on this traffic is `read_lifecycle`** (drop
  stale copies of re-read files) — **heuristic, ~5.3%, no torch.** SmartCrusher/
  router (structural JSON) is folded into that number.
- **Compressing the code buckets** (the 95%) is where the volume is, but that is
  the model's *active edit material* — lossy code = broken edits — so it is not a
  safe lever; `read_lifecycle` (dropping *superseded* reads) is the safe subset.

**Revised recommendation:** build the **heuristic Headroom stage (no torch)** as the
slider ≥3 compressor — it delivers the real ~5.3% (read_lifecycle + structural) and
is the honest lever for code traffic. **Do NOT prioritize the `[ml]` tier for this
workload**; keep it a far opt-in for prose/chat-heavy users. The Decision-23
net-cache A/B gate (§34.3) still applies before any published number.

## §36 — Headroom sidecar integration LANDED (heuristic, opt-in) (2026-07-05)

Built the heuristic Headroom stage end-to-end:
- **`src/compression/headroom-worker.py`** — a stdlib-only HTTP worker that keeps
  `headroom.compress()` warm and returns compressed messages + token deltas.
- **`src/compression/headroom-adapter.ts`** — `HeadroomSidecar` (the ONLY file
  that knows Headroom, per CLAUDE.md): spawns the worker via `uv run --with
  headroom-ai==<pin>`, health-checks, and implements the neutral
  `SemanticCompressor` seam (`src/compression/semantic.ts`). **Fail-open**: any
  spawn/health/request failure → `compress()` resolves `null`.
- **Pipeline** runs it as stage 3 only when `semanticCompression !== "off"`
  (slider ≥3) and a compressor is injected; levels ≤2 are byte-identical
  (unit-tested). **Opt-in** via `compression.headroom_sidecar` (default false).
- Pin bumped **0.28.0 → 0.30.0** in `src/compression/index.ts` (T-C4 note: the
  npm client 0.22.4 is unused — we call `compress()` in-process).
- Tests: adapter lifecycle + fail-open against a fake Node worker (no
  uv/python/CI dep); pipeline stage-3 behavior with a fake compressor. 318 green.

**Live end-to-end** (real sidecar, first 1000 msgs of the transcript, level 3,
Golem's honest whole-request estimateTokens): **351,227 → 228,082 tokens
(~35%)**, all four stages firing, 3.3 s. **Do not headline this number yet** — it
needs the same skepticism as §31:
- It is Golem's **char-based** estimate, not Headroom's tokenizer (which reported
  only ~5.3% on the full transcript). The gap is `read_lifecycle` dropping whole
  **stale file-read** bodies — a big *char* reduction Headroom's own
  `tokens_saved` under-counts. So the gross forwarded body really is much smaller,
  but the two numbers measure different things.
- It is **gross forwarded tokens**, NOT net cost. Dropping mid-history reads
  changes prefix bytes → prompt-cache miss risk (§34.3). **The net-of-cache A/B
  is still required before any published claim.**
- It is **lossy** (the model loses superseded file copies) — acceptable at the
  opt-in ≥3 level, but a quality watch item.

Status: mechanism shipped and safe (opt-in, fail-open); the honest *net* savings
number is still gated on the live cache-aware A/B.

## §37 — Live traffic exposed unbounded entropy over-redaction (2026-07-05)

First real Foundry traffic through the fixed pipeline (path fix §36 + Headroom on,
L3): 10 requests, **29% whole-request savings**. But the per-stage breakdown was a
red flag — `redaction` alone claimed **~21%** (496k tokens), the exact §31 smell.

**Root cause.** `ENTROPY_CANDIDATE_RE = /[A-Za-z0-9+/=_-]{32,}/g` had **no upper
bound**. On real traffic it matched **222 "tokens" averaging 3,544 chars, max
22,524 chars** — i.e. base64 images, minified/encoded blobs, inline attachments.
Shannon entropy on such blobs is high, so the sweep **wholesale-redacted them**.
This is lossy over-redaction: it strips content Claude needs (a real quality
risk), and silently inflated "savings" (the redaction stage was doing ~35% of the
reduction on the reconstructed transcript, all of it non-secret data).

**Fix (§37).** Cap entropy candidates to a credential-plausible length with
lookarounds so the WHOLE unbroken run must be 32–128 chars:
`/(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,128}(?![A-Za-z0-9+/=_-])/g`. A longer
run (a blob) has a candidate char just past 128 → lookahead fails → not matched at
all (never a 128-char slice out of a 20 KB image). Every provider secret fits well
under 128 (Anthropic/AWS/GitHub/Slack/JWT have their own bounded rules; PEM bodies
too). Post-fix the same transcript redacts **35.66% → 0.03%** — only genuine
secrets (emails, keys, JWTs, 23 real credential-length high-entropy tokens). Two
guard tests added (big blob survives; 48-char secret still caught). This is the
same class of bug as §31 (integrity hashes) — redaction must strip *secrets*, not
*data*.

**Consequence for the savings story:** the honest Foundry number after this fix is
compression (dedup/compaction/semantic), NOT redaction. Re-baseline telemetry.

## §42 — `golem init` completeness audit + fixes (2026-07-05)

Audited init against the full feature set; closed the gaps a fresh
`npx golem-run init` hit:

- **VS Code extension shipped + installed.** `package.json` `files` now includes
  the extension's runtime files (was `["dist"]` only — the extension didn't ship
  at all). init installs it by COPYING into VS Code's global extensions dir
  (`~/.vscode/extensions/<id>`, dependency-free, `deploy:local` style) when VS Code
  is detected via the (optional) `InitProbe.vscodeExtensionsDir`; idempotent skip
  when already installed; `uninit` removes it. The old message pointing users at a
  non-existent `vscode-extension/` dir is gone.
- **Foundry / generic gateway (Decision 22).** `init --foundry <resource-url>`
  wires Claude Code's Foundry env (`CLAUDE_CODE_USE_FOUNDRY` +
  `ANTHROPIC_FOUNDRY_BASE_URL=<proxy>/anthropic`, NOT `ANTHROPIC_BASE_URL`) and
  sets the proxy `upstream_base_url` in `.golem/settings.local.json`.
  `init --upstream <url>` fronts a generic Anthropic-compatible gateway
  (Claude Code keeps `ANTHROPIC_BASE_URL=<proxy>`). Previously Foundry users wired
  everything by hand.
- **`init --start-proxy`** brings the detached daemon up right after wiring.
- **Capability hints:** the summary detects `uv` (→ enable semantic compression)
  and Ollama+embed-model (→ semantic KB, else the lexical default + a pull hint).
- **Secrets stay manual:** init never writes API keys (Foundry users add theirs to
  `.golem/settings.local.json`, gitignored). Tests inject a probe so uninit never
  touches the real `~/.vscode/extensions`.

## §47 — Per-project proxy: own port, persisted run-state, auto-start on open (2026-07-06)

User decision (per-project-proxy model over a single shared multi-tenant daemon):
each project gets its own proxy on its own port, with persisted run-state and
auto-start on project open. Partitioning (KB/webcache/CCR/telemetry under
`<project>/.golem/`) was already per-project — no change needed there.

- **Per-project port.** `defaultProjectPort(projectDir)` = `4653 + sha256(dir) %
  1000` — deterministic, stable, so two projects don't collide on one port. init
  assigns + persists it to `.golem/settings.json` `proxy.port` (an explicit
  `proxy.port` still wins); every surface reads it via config. Collisions across
  projects are unlikely at 1000 ports and surface as a bind error, not cross-talk
  (the pid file is the source of truth for "ours").
- **Persisted desired run-state.** `.golem/state/proxy.json` `{desired}` —
  `golem proxy start/restart` write "running", `stop` writes "stopped". This is
  the "was it running for this project" intent, distinct from the live pid file.
- **Auto-start on open.** A `SessionStart` (matcher `startup|resume`) hook,
  `golem hook session-start`: reads the desired state; if "running" and the proxy
  isn't already up, starts it detached on the project's port. Fail-safe (never
  breaks session start); no-op if already running or desired=stopped.
- init wires the SessionStart hook (uninit removes it); the VS Code panel/menu
  toggle and `golem proxy start/stop` all flow through the same persisted state.
- Verified: port determinism/range/uniqueness + state round-trip unit-tested;
  init wires SessionStart + persists proxy.port (cli-init tests updated to the
  per-project port). 366 tests.

## §46 — Status-bar accuracy + VS Code proxy toggle (2026-07-06)

Two dogfooding fixes + a feature, all surfaced when the user switched Claude Code
back to direct Anthropic (proxy bypassed/off):

- **Stale "waiting" self-heals.** The blocked flag (Notification hook sets,
  UserPromptSubmit clears) stuck on after a model/session switch. The status line
  now only shows "⏸ waiting" if the flag's `ts` is within `BLOCKED_STALE_MS`
  (10 min); older = stale = hidden. Per Decision 21b the local indicator is only a
  subtle hint anyway (Claude Code shows prompts natively).
- **Upstream label hidden when the proxy is off.** The line read the proxy's
  configured `upstream_base_url` and showed "→foundry" even with the proxy DOWN
  and Claude Code going direct — misleading. Now the `→<upstream>` segment renders
  only when the proxy is running (`active`), so an off proxy shows just
  `⬡ Golem: <level> · proxy off`.
- **Proxy toggle in VS Code.** The panel gained a Proxy Start/Stop button, and the
  status-bar click now opens an actions QuickPick (Start/Stop proxy · Set slider ·
  Open panel · Refresh) instead of just focusing the panel. Both run
  `golem proxy start --detach` / `golem proxy stop --dir <workspace>`. New commands
  `golem.toggleProxy` + `golem.menu`.

## §45 — init preserves an existing Foundry wiring (2026-07-06)

Dogfooding bug: running plain `golem init` (no `--foundry`) on a project already
wired for Foundry (`CLAUDE_CODE_USE_FOUNDRY=true` + `ANTHROPIC_FOUNDRY_BASE_URL`)
added a stray `ANTHROPIC_BASE_URL` alongside the Foundry env — two competing base
URLs. Fix: init now computes the upstream mode AFTER reading the existing env —
explicit `--foundry`/`--upstream` still win, but absent them, an existing Foundry
wiring is PRESERVED (Foundry mode, no `ANTHROPIC_BASE_URL` added). A foreign
Foundry base URL (pointing at a non-Golem proxy) still trips the conflict check.
Re-running `golem init` on a Golem-Foundry project is now an idempotent no-op.

## §44 — Hook capabilities for KB-backed web cache (verified 2026-07-05)

Verified against live docs (code.claude.com/docs/en/hooks) for the "query KB
before WebFetch + capture fetches" feature:

- **PreToolUse can block a tool** with
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`
  — the tool does NOT run and **Claude is shown the reason text**. Values:
  allow/deny/ask/defer. Also supports `updatedInput` (rewrite args, tool still
  runs) and `additionalContext`. There is **no** field to substitute a tool's
  OUTPUT at PreToolUse — so to "serve from cache" we **deny and put the cached
  content in `permissionDecisionReason`** (Claude reads it; the fetch is skipped).
- **PostToolUse** receives `tool_input` + **`tool_response`** (the fetched
  content) on stdin; can rewrite via `updatedToolOutput` or add `additionalContext`.
  A store-only capture hook just reads `tool_response` and writes NO stdout, so it
  never conflicts with the existing CCR-swap PostToolUse hook.
- stdin common fields: `session_id`, `cwd`, `hook_event_name`, `tool_name`,
  `tool_input`, `tool_response`. Matcher `"WebFetch"` is an exact tool-name match.
- WebFetch `tool_input` carries the `url` (+ `prompt`); `tool_response` shape is
  tool-dependent (string, or `{output|content|text|...}`) — probe like §20.

Design: PreToolUse(WebFetch) = exact-URL cache gate (fast file lookup, deny+serve
when fresh); PostToolUse(WebFetch) = capture into web-cache + vector KB (same
embedder as auto-index, injected, so the collection isn't corrupted by mixed dims).

## §43 — Incremental KB freshness (edits tracked, not full-rebuilt) (2026-07-05)

§41 auto-indexed on first run / embedder change but skipped otherwise, so files
edited after the initial index went stale until a manual `golem index`. Now the
manifest also stores a per-file state map (`sourcePath → {mtime,size}`), and
`ensureProjectIndexed` does an **incremental sync** when the signature matches:
re-index only changed/new files and drop deleted files' chunks. No-op when
nothing changed; full rebuild still on first run / embedder change.

Design (frozen interfaces intact):
- Chunk ids are content-based, so an edited file yields NEW ids — the old chunks
  must be DELETED, not left as orphans. The frozen `VectorDriver` has no delete,
  so deletion is an **optional capability** `DeletableVectorDriver.deleteBySourcePath`
  (both InMemory + File drivers implement it; `isDeletable` structural check).
- `sourcePath` is relative to the ingest root's baseDir, so single-file re-ingest
  uses `chunkFilesRelativeTo(files, baseDir)` to match the original paths.
- KB exposes `IncrementalIngest` (`incrementalReady`, `reindexFiles`,
  `removeSourcePaths`) only when driver is deletable + embedder present;
  `supportsIncremental` gates it. Incremental requires a single directory root;
  multi-root or non-deletable driver falls back to a full rebuild — still correct.
- Change signal = mtime **or** size delta (size catches coarse-mtime filesystems).
- Verified e2e with the real hashing KB + FileVectorDriver: new file synced,
  edited file's stale chunk deleted (no orphan), deleted file's chunks dropped,
  no-op when unchanged, embedder change → full rebuild. Driver `deleteBySourcePath`
  unit-tested (removes only that file, persists across reload).

Still a follow-up: intra-session live watch (fs.watch) — today freshness is
per-`mcp serve`-startup (each Claude Code session re-syncs), which is the sweet
spot without a long-running watcher.

## §41 — Auto-index on serve + semantic-upgrade "just works" (2026-07-05)

Two tied features via one mechanism — an index `manifest.json` beside each
collection recording the **embedder signature** it was built with.

- **Auto-index (`mcp serve`):** on startup, if no manifest (first run) the project
  is indexed in the BACKGROUND (never blocks startup) so `search` is
  populated without a manual `golem index`. Paths = configured `knowledge.watch_paths`,
  else the project root (ingest already skips node_modules/.git/dist/dotfiles +
  oversized files, so root is safe). No-op when the signature already matches — no
  wasteful re-embedding each session.
- **Semantic upgrade:** the signature encodes the embedder (`lexical:hash-v1-512`
  vs `semantic:bge-m3`). When the user pulls bge-m3 + runs Ollama, `build-knowledge`
  flips to semantic → signature mismatch → auto-index **clears the stale-dimension
  vectors and rebuilds** with bge-m3. Pulling the model is all that's needed.
- `golem index` also writes the manifest so a manual index is respected (rebuilt
  only on embedder change). `golem index`/`mcp serve` report the embed mode.
- **Verified live:** fresh project → first serve indexed (search found the file
  immediately); second serve skipped; forcing semantic → re-indexed. Unit tests
  cover signature/first-run/skip/reindex. Follow-up: incremental refresh on file
  edits (watch) — today re-index is per-embedder, not per-edit.

## §40 — Zero-setup KB: pure-TS hashing embedder default (2026-07-05)

After §39 the KB persisted but was still **dormant** — embeddings needed Ollama +
a pulled `bge-m3` (heavy onboarding; a fresh `npx golem-run` couldn't search at
all). Added a pure-TS **signed feature-hashing** embedder (`hashing-embedder.ts`)
as the DEFAULT `EmbedFn`: code-aware tokenization (splits camelCase/snake_case),
FNV-1a hashing to a fixed 512-dim L2-normalized vector, deterministic across
processes. Cosine over it = lexical/identifier overlap — genuinely useful for
*code* search (you look up a symbol name). No dep, no model, no network.

- `openKnowledgeBase` default embedder: explicit `embed` → `inference` (bge-m3
  SEMANTIC) → **hashing (LEXICAL)**. `build-knowledge.ts` probes Ollama `/api/tags`
  once and picks semantic ONLY if the tier's embed model is actually pulled, else
  lexical — so the index is never built with mixed embedders. `embedMode` is
  surfaced in `golem index` output and the `mcp serve` startup log.
- bge-m3 stays the OPTIONAL semantic upgrade (mirrors FileVectorDriver-vs-LanceDB).
  Switching embedders means re-indexing; a dim mismatch returns no hits (cosine
  0), never a crash.
- **Verified live (zero Ollama):** indexed this repo's `src/pipeline` (34 chunks)
  and searched — `"shannon entropy high-entropy token"` → `redaction-rules.ts:226`
  (exactly where `shannonEntropy`/`isHighEntropyToken` live), `"redact secrets
  before compression"` → `redaction.ts`. The knowledge pillar now works out of the
  box. Headroom: still N/A (no embedder service).

## §39 — Durable vector store: pure-TS default (§26 refinement, 2026-07-05)

§26 chose LanceDB, but correctly noted both LanceDB and sqlite-vec are NATIVE
binaries → OPTIONAL-only (CLAUDE.md). That leaves the **default install with no
persistence** — the KB fell back to in-memory, so an index died with the
`mcp serve` session. Not good enough for the durable-driver goal.

**Refinement (implemented): the default durable driver is pure-TS.**
`FileVectorDriver` persists each project's `{chunk, vector}` records as JSONL +
`meta.json` under `<project>/.golem/knowledge/<hash(projectId)>/`, loads them into
memory on open, and runs the SAME brute-force cosine as the in-memory driver. At
dev-KB scale (one project, ~10³–10⁴ chunks) brute-force is sub-millisecond; LanceDB
ANN only pays off at ~10⁵⁺ vectors, so **LanceDB stays the OPTIONAL scale upgrade**
behind the unchanged `VectorDriver` seam. Net: persistence for everyone, still
zero native deps in `dependencies`.

- Atomic writes (tmp + rename); schema-version + embedding-dim in `meta.json`; a
  version mismatch or corrupt JSONL line degrades to empty/skip, never crashes.
- `openKnowledgeBase` now defaults to `FileVectorDriver(knowledgeDir(projectDir))`;
  `InMemoryVectorDriver` stays for injected/test use. Verified e2e: index in one
  KB instance, a fresh instance over the same dir finds it (restart-equivalent).
- **Headroom applicability (user asked "use Headroom where sensible"):** NOT here.
  Headroom is a compression service with no vector store; its `[memory]`
  SQLite+HNSW backend serves the conversational **memory** scope, which remains
  the separate C4 federation target (Decision 13), not the KB store.

## §38 — Balanced-mode (level 3) safety check for dogfooding (2026-07-05)

User is running level 3 live and asked to flag any oddity caused by it. Ran a
realistic slice (repeated file read + tool_use/tool_result pairs + assistant/user
text) through `headroom.compress(protect_recent=4)` (pin 0.30.0) and diffed.

**Findings — safe on tool-heavy traffic:**
- Headroom's **router excludes tool content** (`router:excluded:tool`): both
  `tool_result` file reads passed through at full length; **tool_use ↔ tool_result
  pairing preserved** on both sides. No malformed request risk.
- User text untouched at level 3 (`compress_user_messages=False`). Only
  system-side/assistant prose beyond the last 4 turns is a compression candidate;
  short conversations compress to **0** (nothing beyond the protected window).
- The live ~8% savings therefore come from **older non-tool prose**, not from
  touching code/tool context.

**Caveat to watch (the one real risk):** if Headroom *does* elide something into
its own CCR, `expand` cannot retrieve it — Golem's expand is wired to the
TS CCR store, not Headroom's (verification-notes §32 open item). On tool-heavy
traffic this rarely triggers (tool content is excluded), but on very long
prose-heavy sessions a compressed earlier turn is not recoverable from the model
side. Symptoms to attribute to balanced mode if seen: (a) referencing a stale file
version, (b) "forgetting" mid-conversation detail from >4 turns back, (c) any
Foundry 4xx that disappears at level ≤2. Mitigation if it bites: `golem slider 1`
(same redaction, no semantic stage).

## §48 — Decision 26 manual-verification checklist: real Ollama install/pull (2026-07-09)

Per CLAUDE.md/plan: `install-runner.ts`'s real spawn/download path and a real
multi-GB `/api/pull` get no unit test (same treatment `headroom-adapter.ts`'s
real spawn path already gets — see §36). These are **manual-only, never run
in CI**. One checklist entry per OS; check off (with date + outcome) the first
time each is actually run for real.

| OS | Manual check | Expected | Status |
|---|---|---|---|
| Windows | `golem ollama status` on a machine without Ollama, then `golem ollama setup` (confirm at the TTY prompt) — this machine (RTX 3070 Laptop GPU, 8192 MiB VRAM → P_MID tier) | status reports `installed:false`; setup runs `winget install -e --id Ollama.Ollama ...`, waits for the daemon, pulls the tier's drafter model (`qwen2.5-coder:7b`), smoke-test passes | **DONE 2026-07-09 — see below** |
| macOS | Same, on a Mac without Ollama and with Homebrew present | setup runs `brew install ollama`; same pull/smoke-test path | NOT YET RUN — no macOS hardware in this session |
| macOS (no Homebrew) | `golem ollama setup` on a Mac without Homebrew | falls back to the manual plan (prints `https://ollama.com/download`), does not attempt any command, exits cleanly | NOT YET RUN |
| Linux | `golem ollama setup` on a fresh Linux box | downloads `https://ollama.com/install.sh` to `os.tmpdir()`, runs it via `spawn("sh", [scriptPath])`, cleans up the temp file, then pulls + smoke-tests | NOT YET RUN |
| Windows (no winget) | `golem ollama setup` on Windows without winget on PATH | falls back to the manual plan, no command executed | NOT YET RUN |

**Windows run, this machine, 2026-07-09.** `golem ollama status` before setup
reported `installed:false`, `tier:2 (P_MID)`, `targetModel:qwen2.5-coder:7b`.
`golem ollama setup --yes` ran `winget install -e --id Ollama.Ollama
--accept-package-agreements --accept-source-agreements` (real output: "Found
Ollama [Ollama.Ollama] Version 0.31.2" → downloaded → "Successfully
installed"), waited for the daemon, pulled `qwen2.5-coder:7b` (streamed
`pulling manifest` → `pulling <digest>` → `verifying sha256 digest` →
`writing manifest` → `success`), then ran the post-pull smoke test
(`OllamaClient.chat()` asking for "OK") — passed, model replied `"OK"`.
Rendered output: "Installed Ollama (Install Ollama via winget
(Ollama.Ollama)).", "Pulled model qwen2.5-coder:7b.", "Smoke test passed —
model replied: \"OK\"". Note: `golem ollama status` run again in the *same*
already-open shell still reported `installed:false` because winget's PATH
update hadn't propagated to that shell's already-inherited environment — this
is real, expected Windows PATH-refresh behavior (the exact case
`renderSetupResult`'s fallback message anticipates), not a Golem bug;
`reachable` and `modelPulled` both correctly flipped to `true` since those
checks go over HTTP, not PATH.

**End-to-end proxy verification (plan step 5), same session.** This repo's own
`.golem/settings.json` is slider level 5 + `local_only_opt_in:true`, and the
dogfooded proxy was already running (`golem proxy status` → pid 40288, port
4930). Sent a real self-contained request straight to it:
`POST http://localhost:4930/v1/messages` with a throwaway/dummy `x-api-key`
and the prompt "What is the plural of the word octopus? Answer in one short
sentence." Response came back as `model:"qwen2.5-coder:7b"` with text
`"Answered locally by qwen2.5-coder:7b — Golem local-first mode; verify
independently.\n\nThe plural of \"octopus\" is \"octopodes.\""` — i.e. Mode B
(`runLocalFirstStage`) served the request entirely locally. The dummy API key
being accepted confirms the request never reached `api.anthropic.com` at all
(Decision 25's stage runs, and returns, before the upstream forward). This
closes the previously-blocked "verify end-to-end local drafting" item from
Decision 25/the Decision 26 plan.

**R1.6 attempt, 2026-07-11 — still blocked, no non-Windows hardware.**
`docs/plan/R1_BATCH.md`'s R1.6 asked for the macOS/Linux/Windows-without-winget
rows to be run. This session's environment is Windows-only (`win32`, no macOS
or Linux box, no CI runner access from here) — none of the three remaining
rows are actually executable from this session. Per R1_BATCH.md §1's
log-and-move-on guidance, logging this as blocked rather than guessing at
behavior on hardware this session doesn't have; the three rows stay NOT YET
RUN. See also [[R1.6 — macOS/Linux Ollama verification blocked]].

## §49 — Live finding: high-entropy redaction false-positives on repo paths (2026-07-10)

Observed live while dogfooding at slider level 0 (redaction-only): the entropy
sweep replaced an ordinary repo path (`docs/wiki/decisions/ADR-0001-file-watcher.md`,
written inside a planning doc) with `[REDACTED:high-entropy:N]` in the model's
request context. The file on disk was untouched (verified by grep counts — the
response path is byte-faithful); only the model's VIEW of the conversation was
corrupted, which is enough to break an agent: it cannot open a path it sees as
a placeholder, and every subsequent request re-redacts it.

Root cause: `ENTROPY_CANDIDATE_RE` (src/pipeline/redaction-rules.ts) includes
`/`, `-`, `_` in the candidate charset, so a multi-segment path forms one
32–128-char "token"; a path with mixed case + digits (ADR numbers, versioned
filenames) passes `isHighEntropyToken`'s three-charclass check, and such paths
can measure ≥ 4.2 bits/char on their own alphabet.

Not fixed on the spot because tuning redaction is T-C3-gated (CLAUDE.md: never
weaken the redaction stage outside a reviewed change) — a fix must add these
as NEGATIVE cases to tests/unit/pipeline/redaction-corpus.ts while proving no
POSITIVE (real-secret) case regresses; note standard-base64 secrets also
contain `/`, so a blanket slash exclusion is wrong. Filed as task T7 in
docs/plan/NEXT_BATCH.md.

T7 (2026-07-10): fixed via `isPathLikeToken` in redaction-rules.ts — splits
a candidate on `/-_` and excludes it from the entropy check only if every
resulting chunk is purely alphabetic or purely numeric (the signature of a
real path/slug; random secret material essentially never lands every chunk in
one character class). Negative cases (repo path, versioned/slugged filename)
and a positive regression case (mixed-chunk dash-delimited secret still
redacts) added to tests/unit/pipeline/redaction-audit.test.ts. See wiki
[[Redaction Stage]] and debriefs/2026-07-10-T7.md for the full writeup.

## §50 — Live finding: credit-card rule false-positive on sparse digit runs (2026-07-10)

Discovered incidentally while diagnosing the §49 investigation above (dumping
raw file bytes as space-separated decimal ASCII codes at slider level 5 for a
ground-truth check): several spans were replaced with
`[REDACTED:credit-card:N]` even though the content was byte values, not card
numbers.

Root cause: the `credit-card` rule's pattern
(`(?<![\d.-])\d(?:[ -]?\d){12,18}(?![\d.-])`, src/pipeline/redaction-rules.ts)
allows unbounded single-space or single-dash separators between digits before
the Luhn gate (`luhnValid`) runs. A long run of small space-separated numbers
(e.g. ASCII codes) can coincidentally contain a 13-19-digit window that passes
the Luhn checksum by chance, producing a false positive on data that has
nothing to do with payment cards.

Not fixed on the spot — out of T7's scope (a different rule, discovered
incidentally, not part of the plan's T7 task description) and tuning
redaction is T-C3-gated. Needs its own task: likely tightening the separator
run length or requiring separator consistency (all-space or all-dash, not
mixed) before the Luhn check. No task ID assigned yet.

**Fixed 2026-07-11, R1.3 — see §55.**

## §51 — T6 decision memo: `node:fs.watch` vs `chokidar` for file watching (2026-07-11)

Required before starting T6 (plan §6 known unknown, flagged in §27 as a
"deferred impl"). Recorded here with the accompanying ADR
(`docs/wiki/decisions/ADR-0001-file-watcher.md`) per the T6 task brief.

**Live-checked against https://nodejs.org/api/fs.html (fetched 2026-07-11)
and https://github.com/nodejs/node issues, refining §27's note:**

- `fs.watch`'s `recursive` option is natively supported on **Windows and
  macOS** only, going back to early Node versions.
- **Linux** support was NOT always present — §27 said "since Node 20" from
  memory; the actual history is: unsupported and silently no-op-ish pre-Node
  14, then Node 14+ throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` explicitly
  when `recursive: true` is requested on an unsupported platform. Native
  Linux recursive-watch support was added by nodejs/node PR #45098, landing
  in the Node 20 line. It shipped with real reliability bugs — nodejs/node
  issue #48437 documents recursive watch timing out / misbehaving on Ubuntu
  in Node 20.3.0. No first-party confirmation found that these are fully
  resolved as of the Node 22 LTS this repo targets (CLAUDE.md: Node ≥22) —
  treat Linux recursive watching as **unverified-reliable** until this repo's
  own cross-platform CI proves otherwise.
- Non-recursive `fs.watch` (watch one directory, no `recursive` option) is
  reliable cross-platform including Linux, at the cost of having to walk the
  tree yourself and add/remove a watcher per subdirectory as they appear/
  disappear.
- `fs.watch` is independently known to be flaky at the event level on every
  platform (duplicate events, missing events on rapid changes, `rename` vs
  `change` semantics differing by OS) — this was already noted in §27 and is
  unaffected by the recursive-support question above; a debounce + re-stat
  layer is required regardless of which backend is chosen.
- `chokidar` (pure JS, no native bindings) normalizes all of the above at the
  cost of one added dependency. CLAUDE.md's "no heavyweight native deps in
  the default install" rule targets *native* deps specifically — chokidar
  would be allowed in the default install per that rule's own wording, but
  the T6 brief still calls for a memo before adding any new dependency, which
  this is.

**Recommendation (see ADR-0001 for the accepted decision):** ship
`node:fs.watch` as the zero-dep default — `recursive: true` on Windows/macOS,
a manual per-directory watch-and-rewalk on Linux — behind an internal
`FileWatcher` interface so the backend is swappable without touching
callers. Debounce + re-stat on every backend. Fall back to `chokidar` later,
behind the same interface, only if this repo's own Linux CI run (or
dogfooding) shows native watching is unreliable in practice — not
pre-emptively.

## §52 — Slider simplified 6→4 levels + level-0 full bypass + local+upstream status (2026-07-11)

Implemented spec **Decision 30** (USER decision). The 0–5 slider collapses to
**0–3**: `0 passthrough`, `1 lossless`, `2 balanced`, `3 aggressive`. Evidence for
the merges: old 1≡2 in the live path (`toolResultCache` was specced but never
consumed by `NativeLosslessCompression` — grep confirmed it appears only in
`policy.ts`, `mcp/stub-compression.ts`, and the contract test), and old 4/5
differed only by `localOnlyAnswers`, already gated by `local_only_opt_in`.

- **Level 0 now runs nothing, redaction included** — the one sanctioned exception
  to the redaction hard rule (CLAUDE.md amended). Never default; warned loudly at
  `golem slider 0`, `status`, `statusline`, and the `level`/`slider`/`bypass` MCP
  surfaces.
- **Migration is clamp-based and idempotent** (`migrateSliderLevel`): it runs on
  every read (config transform + slider store), so a lossless old→new remap is
  impossible (shared integers, different meanings). 0–3 pass through; legacy 4/5
  clamp to 3. Real configs migrate right (default 1→1; this repo's 5→3). Env
  coercion needed a fix — `config/env.ts` `baseType()` now peels `ZodEffects` so a
  `z.number().transform(...)` leaf still coerces string env values before the
  transform runs.
- **Local+upstream status:** a bounded, never-throwing `/api/tags` probe
  (`src/cli/local-model.ts`, cached ≤60 s for the per-turn status line) drives a
  "local + upstream" indicator at ANY level in `golem status`, `statusline`, and
  the VS Code status bar. Below level 3 it means local is *available*, not serving
  every request.
- Frozen `src/interfaces/policy.ts` changed (contract tests updated first, flagged
  per the hard rule). Full gate green: `tsc`, lint, 77 files / 730 tests.

## §53 — Slider is a pure compression dial; semantic gated off caching upstreams (2026-07-11)

Implemented spec **Decision 31** (USER decision), two coupled changes:

- **Local drafts / local-first removed from the slider** (supersedes Decision
  25's *automatic* proxy intercept). Deleted `src/pipeline/local-intercept.ts`,
  pipeline stages 4/5, `ProxyRequest.localResponse`, `StageConfig.localDrafts`/
  `localOnlyAnswers`, `SliderPolicy.localOnlyOptIn`, `effectiveStages`, the
  `slider.local_only_opt_in` config key, and the `golem status` `local_first`
  block. Frozen `policy.ts` changed (contract tests first, flagged). The local
  model is now invoked ONLY via the explicit `delegate` MCP tool; Decision 26's
  Ollama bootstrap is unchanged. Removed 2 test files (~36 tests).
- **Semantic compression gated off caching upstreams.** `isCachingUpstream()`
  in `pipeline.ts` (host contains `anthropic.com`, or unknown → assume caching)
  disables the lossy stage on Anthropic and runs it only on non-caching
  gateways — because `read_lifecycle` rewrites mid-history content and breaks the
  byte-identical cached prefix (§14/§32/§34). This is the Decision 22/23
  "situational compression" positioning in code.
- Gate green: `tsc`, lint, 75 files / 694 vitest tests, 14 VS Code tests.

**OPEN (verify before building the R2 cache-safe structural tier):** can Headroom
be configured to **disable `read_lifecycle`** (keep only deterministic per-turn
structural/`router` compression)? The current worker
(`src/compression/headroom-worker.py`) runs `read_lifecycle` at every mode and
`CompressConfig` exposes no obvious switch for it. If it can be disabled, the
"both" design (cache-safe structural compression on Anthropic + a prefix guard)
becomes buildable; if not, semantic stays non-caching-upstream-only. Needs a
live-doc/source check per CLAUDE.md before R2 work.

## Open questions (plan §6 leftovers — owners assigned in workstream briefs)

| Question | Owner | Notes |
|---|---|---|
| ~~Python-native CCR retrieve API~~ | — | Superseded by Decision 18: EOL builds its own CCR store in TS (P0); sidecar CCR interop is a P2 question |
| `headroom learn` default guidance target (CLAUDE.md vs CLAUDE.local.md) | WS-B (B2) | Only relevant when the optional sidecar is present; verify then |
| `--code-graph` internals (codebase-memory-mcp) suitability | WS-C (C2 memo) | No first-party docs; source inspection in P1 |
| Windows GPU detection reliability (WMI vs nvidia-smi) | WS-D (D1) | Not resolvable from docs; needs empirical work on hardware |
| Headroom sidecar version handshake (npm client 0.22.4 ↔ Python 0.28/0.29) | WS-A (P2 sidecar task) | No published compatibility matrix; pin both sides + handshake check |
| LanceDB vs sqlite-vec as embedded default (native-dep weight, Arrow peer dep) | WS-C (C1 memo) | @lancedb/lancedb 0.31.0 healthy but napi-native; decide with a spike |
| tree-sitter in TS: web-tree-sitter (WASM) vs native prebuilds | WS-C (C2) | Cross-platform prebuild coverage is the deciding constraint |

## §54 — R1.1: live net-of-cache billed-`usage` A/B, level 1 vs level 3 (2026-07-11)

**Deliverable per `docs/plan/R1_BATCH.md` R1.1:** capture the real upstream `usage`
block (not gross forwarded tokens — Decision 23/§30-37) from live Claude Code
traffic through this repo's own proxy, at slider level 1 and level 3, and
compare billed-cost-equivalent input tokens.

**Bug found and fixed first (blocked the whole measurement):** real Anthropic
responses proxied through Golem arrive `content-encoding: gzip` (`src/proxy/
headers.ts` forwards the client's `accept-encoding` transparently — confirmed
via a manual `curl -D-` against the live local proxy). The original
`UsageSniffer` (`src/proxy/usage-sniffer.ts`) sniffed raw bytes assuming
plaintext JSON/SSE, so it silently found zero `usage` events on all real
traffic despite every fixture-based unit/integration test passing (fixtures
were never gzip-encoded). Fixed by feeding sniffing a side `node:zlib`
decompression stream (gunzip/brotli/inflate keyed off `content-encoding`) while
the bytes forwarded to the client remain the original, untouched, possibly-
compressed chunk — preserving the CLAUDE.md byte-fidelity hard rule. Caught
only because R1_BATCH.md's Definition of Done requires driving the real flow,
not just green tests (5 new unit + 1 new integration test added for the
compressed-body path).

**Measurement (this session's own dogfooding traffic, `.golem/telemetry/events.jsonl`,
`aggregateUsageByLevel`/`usageReportRows` from `src/telemetry/usage-report.ts`):**

| Level | Requests | inputTokens | cacheCreationInputTokens | cacheReadInputTokens | outputTokens | effectiveInputTokens/request |
|---|---|---|---|---|---|---|
| 1 (all) | 23 | 26,762 | 72,720 | 2,576,281 | 35,014 | ~16,317 |
| 1 (excl. 1 compaction-reset outlier) | 22 | 3,717 | 52,918 | 2,537,463 | 34,805 | ~14,710 |
| 3 (all) | 9 | 585 | 15,136 | 792,154 | 2,777 | ~10,969 |

(`effectiveInputTokens = inputTokens + cacheCreationInputTokens×1.25 + cacheReadInputTokens×0.1`,
per §14's Anthropic cache-pricing multipliers.)

**Conclusion: the ~30% level-1-vs-level-3 gap above is NOT a slider effect —
it's noise, and this repo's dogfooding setup cannot currently produce a
meaningful level 1 vs 3 A/B at all.** Two independent lines of evidence:

1. **Code proof.** `src/interfaces/policy.ts`'s `LEVEL_TABLE` gives levels 1
   and 3 identical `redaction`/`losslessCompression` config; the only stage
   that differs (`semanticCompression`: `"off"` vs `"aggressive"`) is
   unconditionally gated off by `isCachingUpstream()` in
   `src/pipeline/pipeline.ts` whenever the upstream host contains
   `anthropic.com` (Decision 31) — which this repo's real traffic always
   does. So the request bytes actually forwarded to Anthropic are provably
   byte-identical between level 1 and level 3 here; there is no pipeline
   difference left to measure.
2. **Telemetry confirms it.** Per-turn `cacheCreationInputTokens` is nonzero
   and similarly-scaled (hundreds–low-thousands) in *both* the level-1 and
   level-3 windows — the ordinary cost of a growing conversation's new tail
   needing a fresh cache write each turn, present regardless of level. The
   one outsized event (a single request whose `cacheReadInputTokens` fell
   163,225 → 38,818 while writing 19,802 cache-creation tokens, immediately
   preceded by a `cacheCreationInputTokens` of 794 with no drop) lines up
   with this very conversation's own context-compaction/summarization event,
   not with any slider change — it happened several turns *before* the level
   1→3 switch. Excluding it barely moves the level-1 average (16,317 →
   14,710), and the remaining gap vs level 3's 10,969 is well within the
   per-request variance already visible in the raw data (single-request
   `outputTokens` alone ranges from 77 to 14,834 — output length dominates
   over anything level-driven).

**What this means for the roadmap:** Decision 31's caching-upstream gate
already eliminated the net-of-cache risk that motivated R1.1 — on Anthropic,
there is currently nothing for level 2/3 to cost *beyond* level 1, because
semantic compression never runs there. The real open question is the one
already flagged in §53: whether Headroom's `read_lifecycle` can be disabled to
build a cache-safe **structural** compression tier for levels ≥2 on Anthropic.
*That* comparison (structural-only vs pure-lossless, both cache-safe) is where
a future net-of-cache A/B would carry signal; level 1 vs 3 as currently wired
does not.

**Side discovery (not fixed here — logged for later):** while composing a bash
command referencing this session's scratchpad path (which embeds a UUID,
`<...>/fa06e9c0-.../scratchpad/...`), the UUID segment was replaced by Golem's
own redaction entropy sweep with a `[REDACTED:high-entropy:N]` placeholder in
the conversation history resent for this turn — so the assistant literally
recalled and re-issued the corrupted path, and the command failed. `T7`
(2026-07-10 debrief) already fixed the entropy sweep eating *repo* paths via
`isPathLikeToken`; this is a related but distinct false-positive on a bare UUID
path segment outside that fix's coverage. Filed as a candidate alongside the
existing credit-card/Luhn false positive (ROADMAP R1.3) — same class of
problem (entropy heuristic vs structured-but-random-looking tokens), not
reproduced/fixed as part of R1.1.

Full gate green: `tsc --noEmit`, lint, format:check, `npm test` (all suites)
clean after the gzip fix; rebuilt and restarted the live proxy to verify on
real traffic (verification-notes DoD, R1_BATCH.md §1).

## §55 — R1.3: credit-card false-positive fix — separator-format guard (2026-07-11)

Fixes §50. The bare Luhn gate accepted any 13-19 digit window regardless of
how it was grouped, so a space-separated ASCII byte dump (irregular 1-3-digit
groups) could pass Luhn by chance and get redacted as a card number.

**Fix** (`src/pipeline/redaction-rules.ts`): new `isCreditCardLike(target)`
validator, `luhnValid(target) && hasConsistentSeparatorChar(target) &&
hasUniformGrouping(target)`. `hasConsistentSeparatorChar` rejects mixed
space/dash separators; `hasUniformGrouping` splits on the separator and
requires every group to be the same digit length — this is the check that
actually defeats §50's repro, since a bare "single consistent character"
requirement (the plan's literal suggestion) would still accept an all-space,
irregularly-grouped byte dump. `luhnValid` itself is unchanged and still
exported as a standalone primitive. The `credit-card` rule's `validate` now
points at `isCreditCardLike`.

**Corpus additions** (`tests/unit/pipeline/redaction-audit.test.ts`, new
`describe("T-C3: credit-card separator-format guard (§50)")`): a negative
case reproducing §50 exactly (a 8-value decimal byte dump, group lengths
2,1,3,2,3,3,2,2, concatenated digits independently verified Luhn-valid via a
throwaway Node script, not by eye — see the note below); two positive
regression cases (a contiguous 16-digit Luhn-valid test card, and the same
card grouped 4-4-4-4 with consistent single-space separators) proving real
card shapes still redact. Full gate green: `tsc --noEmit`, lint,
format:check, `npm test` — 722 tests (719 + 3 new), including the
pre-existing `redaction.test.ts` and `redaction-audit.test.ts` credit-card
cases, all pass.

**Escape-hatch note (methodological, not a bug):** this repo's own Claude
Code session runs through Golem's own redacting proxy (CLAUDE.local.md
dogfooding), and Claude Code resends full history each turn — so secret- or
card-shaped literals I authored myself in this same conversation (test
fixture strings, an Edit tool call's `new_string`) rendered back to me on the
next turn as `[REDACTED:credit-card:N]`-style placeholders, even though nothing
was wrong with the actual file on disk. Confirmed the on-disk content was
correct two ways that don't depend on trusting the rendered text: (1) a
structural view with digits masked to `D` (`str.replace(/[0-9]/g, "D")`,
printed via a throwaway Node script) shows the real literal lengths and
grouping without printing sensitive-shaped digits themselves; (2) `npm test`
pass/fail is computed by the real vitest subprocess against real on-disk
bytes, unaffected by the chat-context redaction. Both confirmed the fix and
fixtures are correct; the placeholder text was purely an artifact of viewing
my own prior tool call through the proxy on resend, not a data-loss bug.
Reconfirms the handling approach already established in §49/R1.1: don't trust
visual inspection of secret-shaped content in this repo's own session,
verify via test execution or structure-preserving-but-content-hiding checks
instead.

## §56 — R1.4: provider-key redaction rule gaps closed (2026-07-11)

Closes the residual gap noted in §24 (repeated at §31's neighborhood): four
provider secret shapes had no dedicated rule and relied solely on the
entropy-sweep backstop, which can miss short or low-entropy instances.

**Fix** (`src/pipeline/redaction-rules.ts`), four new `REDACTION_RULES`
entries:

- `google-api-key` — `AIza` prefix + 35 base64url-ish chars (39 chars total,
  the fixed real-world shape), placed after `slack-token`.
- `stripe-key` — `sk_live_` prefix (underscore, not the `sk-` hyphen shape
  the pre-existing `openai-key` rule matches) + 24-99 alphanumeric chars,
  placed after `google-api-key`.
- `gcp-oauth-token` — `ya29.` prefix + 20-120 base64url chars; the shortest
  real tokens sit near the entropy net's 32-char floor once the 5-char
  prefix is counted, so relying on the backstop alone risked misses, placed
  after `stripe-key`.
- `azure-account-key` — contextual rule matching `AccountKey=<base64,
  20-100 chars, optional `=`/`==` padding>` up to the next `;` or end of
  string, `group: 1` so only the key value is redacted and
  `AccountName=`/`EndpointSuffix=` stay legible — mirrors the existing
  `connection-password` rule's pattern of preserving surrounding legible
  context. Placed after `connection-password` and before `credit-card`.

**Corpus additions** (`tests/unit/pipeline/redaction.test.ts`, `CASES`
array): one positive/negative pair per new rule, inserted between the
`slack-token` and `jwt` entries. Fixtures use deterministic
`.repeat()/.slice()` construction (matching the file's existing style, e.g.
the pre-existing `sk-${"A1b2".repeat(9)}` fixture) rather than hand-typed
literals, so correctness doesn't depend on visually counting
secret-shaped characters under the escape hatch described in §55. Full gate
green: `tsc --noEmit`, lint, format:check clean (one `biome format --write`
pass needed to reflow the `azure-account-key` negative fixture's long
line); `npm test` — 730 tests (722 + 8 new), including every pre-existing
negative case (repo paths, integrity hashes, ASCII byte dumps, git SHAs,
UUIDs) with no new false positives.

**Scope note:** this closes §24's specific list (Google, Stripe, GCP, Azure).
Other providers' key shapes remain on the entropy-sweep backstop only,
consistent with §24/§31's "add rules as needed" stance — not a claim of
exhaustive provider coverage.

## §57 — R1.7: cross-OS e2e smoke + Linux fs.watch reliability — already shipped (2026-07-11)

`R1_BATCH.md`'s R1.7 asked to build a GitHub Actions cross-OS matrix running
an e2e smoke (`golem init` → proxy up → byte-faithful level-1 round trip →
`golem stats` shows an event) plus a Linux recursive-`fs.watch` reliability
test, with a fallback to wire if Linux native recursive watch proves flaky.
Checked each piece against what already exists before building anything new:

- **Cross-OS matrix:** `.github/workflows/ci.yml` already runs
  `ubuntu-latest`/`macos-latest`/`windows-latest` × Node 22/24 on every push
  to `main` and every PR, running `npm run lint`, `npm run typecheck`,
  `npm test`, `npm run build` — already exactly the matrix R1.7 asked for.
- **e2e smoke:** `tests/e2e/golem-init-smoke.test.ts` (T-C2) already covers
  the exact scenario R1.7 describes — `golemInit` against a temp project dir,
  the real `buildProxyFromSettings` construction path, a level-1 round trip
  against a fake upstream asserting byte-faithful response + genuine
  before/after token savings, and a durable `telemetry.aggregate()` read
  confirming `requests: 1`. `vitest.config.ts`'s `include:
  ["tests/**/*.test.ts"]` picks this file up under the plain `npm test` the
  CI matrix already runs — no separate wiring needed.
- **Linux fs.watch reliability:** re-reading [[ADR-0001 File Watcher
  Backend]] and §51 closely — the "if Linux recursive watch proves flaky,
  wire the fallback" framing in `R1_BATCH.md` doesn't match what ADR-0001
  actually decided. The decision was **Option 2** (manual per-directory
  `TreeWatcher` on every platform outside `{win32, darwin}`), specifically
  *to avoid* depending on Linux's native recursive support at all
  (`NATIVE_RECURSIVE_PLATFORMS = new Set(["win32", "darwin"])`,
  `src/knowledge/file-watcher.ts`). There is no code path on Linux that ever
  attempts native recursive `fs.watch` — so there is nothing for "proves
  flaky" to trigger, and no fallback left to wire; the fallback *is* the
  unconditional Linux implementation, shipped with T6.
  `tests/integration/knowledge-watch.test.ts` (real `GolemKnowledgeBase`,
  live create/delete through the watcher) and
  `tests/unit/knowledge/file-watcher.test.ts` (a `platform`-gated
  `TreeWatcher` case forcing the Linux branch regardless of host OS) already
  exercise this path, and both already run in the existing cross-OS matrix.
- **Runner strategy for Ollama/uv (the required decision point):** already
  decided implicitly and consistently applied — every test that touches
  Ollama/inference fakes it. `tests/integration/cli-ollama.test.ts` states
  outright "no real Ollama, no real [network]"; `tests/unit/cli/distill.test.ts`
  and friends inject a fake `InferenceService`; `golem-init-smoke.test.ts`
  uses a fake `InitProbe` and never shells out to a real `claude` binary. The
  one real-install/real-pull path (`install-runner.ts`'s spawn/download,
  `/api/pull`) is deliberately **manual-only, never run in CI** (§36, §48) —
  same treatment as `headroom-adapter.ts`'s real spawn path. Recording this
  as the dated decision R1.7 asked for: **stub/fake Ollama and the `claude`
  CLI everywhere in the automated suite; the real install/pull path stays a
  manual-only per-OS checklist (§48), never a CI job.**

**What this means for R1.7:** no new workflow file, no new fallback wiring,
no new watcher test — the batch item is already satisfied by T-C2 (e2e
smoke) and T6 (watcher + ADR-0001's design choice), landed in a prior
session before this task was picked up from `R1_BATCH.md`. One honest
limitation: this session has no `gh` CLI and the GitHub API returned 404 for
`golem-run/golem`'s Actions runs (repo not reachable/public from here), so
actual multi-run CI history could not be inspected to look for real-world
flakiness beyond what a single local `npm test` run shows (77 files / 730
tests passing on Windows this session). ADR-0001's status is left as
`accepted` — no new finding changes it.

## §58 — R2.5: Headroom `read_lifecycle` CAN be disabled, but not through the
surface Golem uses — and the library's real cache-safe answer is
proxy-only (2026-07-11)

§53 left one open verification gating R2.6: can Headroom's `read_lifecycle`
be turned off, keeping only deterministic structural compression, so a
cache-safe tier becomes buildable on Anthropic? `CompressConfig`'s
introspected signature (§34) has no such field, but that only proves the
*public convenience wrapper* lacks the knob — not whether the underlying
library supports it. Resolved by reading the actual pinned package source
(`headroom-ai==0.30.0`, matching `src/compression/index.ts`'s
`HEADROOM_SIDECAR_PYPI_PIN`), not docs or introspection alone: `uvx` install
of the `[proxy]` extra failed here (Windows Defender quarantined a
transitively-pulled `ast-grep-cli` binary — unrelated to Golem, not worked
around), so the wheel was fetched with `pip download --no-deps` (no install,
no script execution) and read directly. It is a pure-Python wheel
(`cp310-abi3`, no compiled extension in the relevant modules) — full source
available.

**Finding, precisely:**

1. **`compress()`/`CompressConfig` (the surface Golem's worker calls) has no
   read_lifecycle switch, confirmed at the source**: `_get_pipeline()`
   (`headroom/compress.py`) builds a **module-level singleton**
   `TransformPipeline()` with bare defaults — `_build_default_transforms()`
   (`headroom/transforms/pipeline.py`) only ever appends an opt-in
   tool-result interceptor, `CacheAligner`, and `ContentRouter`; there is no
   config path from `compress(config=CompressConfig(...))` down to
   `ContentRouter`'s `read_lifecycle` field. §53's finding stands for this
   call path.
2. **But `read_lifecycle` (Mechanism A) IS a public, independently
   constructible toggle one layer down.** `ContentRouterConfig` (exported
   from `headroom.transforms`) has a `read_lifecycle: ReadLifecycleConfig`
   field (`content_router.py:995`), consulted at `content_router.py:2917`
   (`if self.config.read_lifecycle.enabled: ...`). Disabling it means
   bypassing `compress()` entirely and driving `TransformPipeline(transforms=
   [CacheAligner(...), ContentRouter(ContentRouterConfig(read_lifecycle=
   ReadLifecycleConfig(enabled=False)))]).apply(...)` ourselves — a real
   integration change to `headroom-worker.py`, not a config flag.
3. **Mechanism A already splits into two independently-gated behaviors, and
   Headroom's own authors already reasoned about cache safety here**
   (`headroom/config.py:261`, `ReadLifecycleConfig`):
   `compress_stale: bool = True` (replace reads of files *later edited* —
   content is factually wrong, on by default) vs. `compress_superseded: bool
   = False` (replace reads of files *later re-read unchanged* — redundant but
   NOT byte-different — **off by default, with the dataclass comment reading
   verbatim "Disabled: busts Anthropic prompt cache prefix"**). So the
   default `compress()` call Golem's worker already makes is not the naive
   "rewrite arbitrary mid-history content" the pipeline gate assumed in §53 —
   it's already restricted to the stale-only subset, and the redundant-reread
   pattern (§32's original pattern, and the one §34 attributed most of the
   measured 53 elisions to) is the part the library itself already keeps out
   for cache-prefix reasons.
4. **The library's actual cache-safe mechanism for the redundant-reread case
   is a separate, more sophisticated design (Mechanism B, "read maturation":
   `headroom/transforms/read_maturation.py`) — and it is wired ONLY into the
   stateful `headroom proxy` server**, not into `compress()`/`ContentRouter`
   (confirmed by grep: `ReadMaturation*` appears only in
   `headroom/proxy/*`, `headroom/cache/prefix_tracker.py`,
   `headroom/cli/proxy.py`, `headroom/audit/*` — never in
   `transforms/pipeline.py` or `transforms/content_router.py`). Its
   docstring: "No cached byte is ever mutated... the trailing cache
   breakpoint is relocated to just before [a fresh Read] while its file is
   active... [until it matures and] only that final, small form ever enters
   the cache." This requires **persistent per-session state** (which reads
   are held back, per-file quiesce-turn counters) that a stateless
   per-request `compress(messages)` call has no way to carry — it is
   fundamentally a proxy-topology feature, and verification-notes §34
   already established Golem does not chain a second Anthropic-facing proxy
   (`headroom proxy` conflicts with Golem's own `/v1/messages` route).

**What this settles for R2.6:** disabling `read_lifecycle` outright is
*possible* but is not obviously the right lever — the part of it that
actually risked the cache (`compress_superseded`) is already off by
default, and the library's own answer to doing better (Mechanism B) is
architecturally out of reach without replicating Headroom's own
session-state tracking inside Golem — a materially bigger build than "flip
a config flag," and arguably out of scope for a first cache-safe tier.
**Recommended R2.6 shape, not yet built:** re-enable exactly the current
default `compress()` behavior (stale-only Mechanism A + `CacheAligner` +
`ContentRouter`, i.e. today's slider-≥2 pipeline *as it already runs on
non-caching upstreams*) on Anthropic too, behind a new opt-in tier, and
prove it net-cache-safe with R1.1's already-built `UsageSniffer`/
`aggregateUsageByLevel` infra before flipping `isCachingUpstream()`'s gate
for it — turning R1.1's shelved infrastructure into the actual R2.6
measurement, rather than building new telemetry. Not implemented this
session; this is a design recommendation for whoever picks up R2.6, not a
completed build.

## §59 — R2.1: Decision 24 spike — no real telemetry exists yet for KB-answer
substitution; the one instrumented proxy signal (CCR retrieval rate) is
0 misses in 1051 real swaps (2026-07-11)

R2.1's deliverable (R2_BATCH.md): a dated measurement of how many upstream
prompt+completion tokens would plausibly have been avoidable if the proxy
could substitute a local KB/web-cache answer for part or all of a turn,
using real telemetry (`ccrRefsRetrieved`, search hit rates) plus a manual
session sample. Read this project's actual `.golem/telemetry/events.jsonl`
(5644 lines) and the MCP tool source directly rather than estimating.

**What the telemetry actually contains:**

1. **Pipeline events** (`kind` absent, 5319 lines): per-request
   `stageSavings`/`ccrRefsStored` — Golem's own tool-output CCR swap
   (`CLAUDE.local.md`'s digest mechanism), not Decision-24 KB substitution.
   Sum of `ccrRefsStored` across all of them: **1051**, spread over **847**
   requests that stored at least one ref.
2. **Retrieval events** (`kind:"retrieval"`, written by `recordRetrieval` in
   `src/telemetry/index.ts:62`, called from the `expand` MCP tool's handler
   at `src/cli/mcp-compression.ts:51` — confirmed this path is genuinely
   wired, not dead code): **0 lines match `"kind":"retrieval"` anywhere in
   the file.** `expand` has never been invoked in this repo's whole recorded
   telemetry history.
3. **Usage events** (`kind:"usage"`, R1.1's infra): 313 lines, unrelated to
   this question (net-of-cache billed-usage sampling, already covered by
   §54).
4. **No telemetry exists for `search`/`fetch`/`ingest`/`wiki_read` MCP tool
   invocations at all** — grepped every call site in `src/mcp/server.ts`
   (tool registrations at lines 506/584/662/770) for a `record`/`telemetry`
   call nearby: none. These tools are not instrumented, so there is no
   durable signal for "how often did a `search`/`fetch` call return
   something that could have short-circuited an upstream round-trip" — the
   literal question Decision 24 sub-mode 1/2 needs answered. This is a real
   gap, not a null result to read past.

**The one honest number available:** of the 1051 times Golem's existing CCR
mechanism swapped bulky tool output for a compact, `expand`-able reference,
the model asked for the original back **zero** times. That's an indirect
but real signal: when Golem substitutes a reference for content, in every
observed real case in this project the excerpt was sufficient and no
upstream re-fetch was needed to recover it. It is evidence *for* the shape
of Decision 24 sub-mode 1 (context substitution — replace a span with an
`expand`/`fetch`-able reference) being viable in principle, but it measures
a different mechanism (already-produced tool output, already local) than
Decision 24's actual target (KB/web-cache content substituting for what
would otherwise be sent to or asked of the *upstream model*).

**Manual session sample:** `.golem/knowledge` holds two non-trivial local
indices (`a4d74063ac10cc1f/chunks.jsonl` 2223 lines / 6.4M,
`b86b4aadb151fcd9/chunks.jsonl` 1743 lines / 5.1M) — a real, sizeable local
KB exists to substitute from. But `.golem/webcache` has only 10 entries
(248K total) — WebFetch re-fetch is rare in this project specifically, so
the URL-cache-hit angle is a small lever *here*, though that's a
repo-specific fact, not a general one.

**What this means for R2.1 / R2.2 / R2.3:** Decision 24 is correctly scoped
as "design memo only, not built" — there is no existing instrumentation to
produce the token-volume number the task asked for, because nothing
upstream of the model has ever substituted a KB answer. The closest real
signal (CCR retrieval rate) is encouraging but indirect, and supports
starting with **R2.2's conservative context-substitution sub-mode** (same
shape as the already-proven CCR pattern, just triggered by KB/wiki hits
instead of tool-output size) with its own new `avoidedUpstream` telemetry
bucket built in from the start — so R2.2, once shipped, becomes the actual
measurement instrument this spike couldn't be. **R2.3's aggressive
local-answer sub-mode has zero telemetry basis in this repo today** — no
data exists on how often a `search`/`fetch` hit was good enough to have
replaced a whole turn — which reinforces R2_BATCH's own sequencing
(R2.3 gated behind both R2.1 and R2.2, done last, own new frozen contract).
Not implemented this session; recommends instrumenting `search`/`fetch`
call sites with the same durable-telemetry pattern as `recordRetrieval` as
a prerequisite of R2.2, so the bucket isn't retrofitted later.

## §60 — R2.6: opt-in bypass + A/B measurement infra built; live real-traffic
A/B deferred (mechanism ships, deliverable is partial) (2026-07-11)

R2_BATCH.md's R2.6 asks to re-enable Headroom's already-conservative default
`compress()` behavior on Anthropic-style caching upstreams too, behind a new
opt-in gate, and prove it net-cache-safe via a real billed-usage A/B (§58's
reshaped finding: the risky part of `read_lifecycle`, `compress_superseded`,
is already off by default in the library itself — R2.6's actual job is
re-enabling the safe default there, not building something novel).

**What was built (mechanism, fully tested, `tsc`/lint/format/vitest all
green — 738 tests, 78 files):**

- `compression.force_semantic_on_caching` (new settings leaf, off by
  default, snake_case, `GOLEM_COMPRESSION_FORCE_SEMANTIC_ON_CACHING` env
  override auto-derived) — only has any effect when `headroom_sidecar` is
  also on and slider level ≥2.
- `GolemPipelineOptions.forceSemanticOnCaching` bypasses
  `isCachingUpstream()` for the semantic stage specifically
  (`src/pipeline/pipeline.ts`). **`isCachingUpstream()` itself is
  unchanged** — Decision 31's gate is bypassed opt-in, not weakened.
- A `semanticForced` tag on `kind:"usage"` telemetry events (static
  per-run, set from the settings flag at proxy-build time — not
  per-request; there is no correlation id linking `onResponseUsage` back to
  the pipeline's internal stage-3 decision, and building one would be a
  bigger change than this task's "medium — mostly a scoped flag" sizing) +
  `aggregateUsageBySemanticForced`/`semanticForcedReportRows`
  (`src/telemetry/{types,jsonl-store,usage-report,index}.ts`), reusing
  R1.1's exact `effectiveInputTokens` formula (§54) so a gate-on vs
  gate-off comparison is judged on the same honest metric, not a new one.
  Neither function is wired into a CLI command yet — same precedent R1.1's
  `usageReportRows`/`aggregateUsageByLevel` set (verified unused by any CLI
  command before following it) — they're tested library functions, ready
  for whoever runs the A/B to call.

**What was NOT done — the live A/B itself.** R2_BATCH.md's own task
description asks to *prove* net-cache-safety via real billed-usage
comparison. Running that for real means flipping
`force_semantic_on_caching` on and restarting the golem proxy that this
very session's own Claude Code traffic is dogfooding through — a live
operational change to shared infrastructure this session depends on, mid-
session, unilaterally. That's a real risk (a broken pipeline mid-session
degrades this conversation's own proxying), not a hypothetical one, so it
was deliberately not done without flagging it first — the same treatment
R1.6 gave an Ollama-verification block: document the gap honestly rather
than fabricate a result or silently claim the task complete.

**Honest status: R2.6 ships the mechanism + measurement infrastructure,
not the net-cache-safety proof.** The live A/B is a manual follow-up:
enable `force_semantic_on_caching` for a real session, let normal traffic
run a while at slider ≥2 against `api.anthropic.com`, then compare
`semanticForcedReportRows(await store.aggregateUsageBySemanticForced())`
gate-on vs gate-off. Per R2_BATCH.md's own contingency language ("if
net-negative or inconclusive: document why and leave Decision 31's gate
as-is — a negative result here is still the deliverable"), adapted here to
"mechanism built, live A/B deferred" — the gate defaults to OFF
(`isCachingUpstream()` still blocks semantic-on-Anthropic by default) until
that follow-up produces a real number.

## §61 — R2.4: expand↔Headroom-CCR gap closed via hash backfill (2026-07-11)

Closes the caveat §38 flagged ("if Headroom *does* elide something into its
own CCR, `expand` cannot retrieve it — Golem's expand is wired to the TS CCR
store, not Headroom's").

**Root cause, confirmed from the pinned `headroom-ai==0.30.0` source (not
guessed):** every Headroom transform that elides content (`read_lifecycle`,
`log_compressor`, `search_compressor`, `diff_compressor`, SmartCrusher's Rust
path) computes a **reproducible truncated digest of the pre-elision content**
as the marker's `hash=<hex>` — SHA-256[:24] by default
(`cache/compression_store.py`'s `store()`), SHA-256[:12] for SmartCrusher's
Rust row-drop path, MD5[:24] for `log_compressor`'s own `explicit_hash`. The
hash is a key into Headroom's own in-process Python store, which Golem's TS
`CcrStore`/`expand` never receives — hence `expand <hash>` throwing
`UnknownRefError`. For **Anthropic-format** messages, elision replaces the
`content` string of the matched `tool_result` **block** in place (array
length/order preserved); for **OpenAI-format** `role:"tool"` messages, the
message's own `content` string is replaced directly.

Also confirmed: Golem's own `CCR_MARKER_RE`
(`src/compression/native-lossless.ts`) is exported but never consumed
programmatically anywhere — the real `expand` MCP tool's `ref_id` is an
unconstrained `z.string().min(1)`, and `CcrStore.putIfAbsent` takes an
arbitrary string key. So a shorter/differently-computed Headroom hash flows
through the existing `expand` path with zero changes to marker-parsing code,
once Golem's own store has an entry under that exact key.

**Fix — `backfillHeadroomCcrRefs`
(`src/compression/headroom-ccr-bridge.ts`):** diffs the semantic stage's
pre/post message arrays; for each `tool_result` block (or OpenAI-format tool
message) whose content changed and whose new content contains a
`hash=<hex>` marker, verifies the hash is a prefix of SHA-256 **or** MD5 of
the OLD content (covering every hash convention observed above) and, if
verified, backfills the OLD content into Golem's own `CcrStore` under that
exact hash via `putIfAbsent` — no marker-text rewriting. Fails open (a
store-write failure is swallowed, mirroring Headroom's own
storage-failure-must-not-break-the-request philosophy). Wired as a new,
non-frozen `GolemPipelineOptions.headroomCcrStore` option
(`src/pipeline/pipeline.ts`) rather than a change to the frozen
`CompressionService` contract, since the option lives outside
`src/interfaces/`. `src/cli/proxy-runtime.ts` constructs the bridge store
pointed at the **same** `.golem/ccr` directory
`NativeLosslessCompression.forProjectDir(dir)` and the MCP server's `expand`
already share, only when `headroom_sidecar` is configured — so a backfilled
ref is visible to a later `expand` call with no further plumbing.

**Verified:** `tsc --noEmit` clean; `biome check .` clean (repo-wide, zero
warnings); full `npx vitest run` — **79 files, 748 tests, all green**
(18 of them new/extended for this fix: 8 in
`tests/unit/compression/headroom-ccr-bridge.test.ts` covering all four
hash-length/algorithm conventions + non-derived-hash rejection +
idempotency + fail-open, and 2 new cases in
`tests/unit/pipeline/semantic-stage.test.ts` proving the pipeline-level
wiring — with `headroomCcrStore` configured, `expand`'s own `getEnvelope()`
recovers the pre-elision content and the marker text is unchanged; without
it, `ccrRefsStored` stays 0, the documented pre-fix gap unchanged as the
default). Also fixed 2 pre-existing unrelated Biome
`noNonNullAssertion` warnings in `tests/unit/telemetry/usage-report.test.ts`
(lines 41/44, left over from R2.6) while closing out this task's full-repo
gate.

## §62 — R2.2: context-substitution sub-mode shipped (2026-07-11)

Decision 24 sub-mode 1 ("context substitution": elide a request span already
known from the KB/web-cache, replace with an `expand`-able reference).

**Old-scale → new-scale gate translation.** Decision 24 was written
(2026-07-06) against the OLD 0-5 slider scale and says the sub-mode applies at
"slider ≥3". Decision 30 (2026-07-09) collapsed the scale to 0-3; the old→new
mapping is old 1+2 → new `lossless`(1), old 3 → new `balanced`(2), old 4+5 →
new `aggressive`(3). So "old ≥3" = old {3,4,5} = new **levels 2 and 3** —
exactly `stages.semanticCompression !== "off"` per `LEVEL_TABLE`
(`src/interfaces/policy.ts`). This let R2.2 reuse that existing frozen-table
field as its gate slot with **no change to `src/interfaces/policy.ts`** —
avoiding the contract-tests-first + cross-workstream-flagging hard rule a
`StageConfig` change would trigger.

**Caching-upstream gate, reusing the Decision-31/R2.6 precedent.** Golem has
no machinery that parses Anthropic's actual `cache_control` breakpoints
(confirmed: `grep "cache_control" src/` — zero matches). Rather than build
that, this stage is gated off entirely on caching (Anthropic-style) upstreams,
identical to how the semantic stage is gated
(`isCachingUpstream()` in `src/pipeline/pipeline.ts`). Rationale, spelled out
in `context-substitution.ts`'s module doc: `native-lossless.ts`'s dedup stage
is safe unconditionally because it's a PURE function of the current request's
own prefix (rebuilds its `seen` set fresh every call); the web-cache lookup
this stage consults is NOT — it grows across requests, so the same prefix
could substitute differently on a later call, changing bytes inside what was
previously a stable cached prefix (§14). On a non-caching upstream there's no
stable prefix to break, so any substitution there is unconditionally
cache-safe by construction.

**Scope: webcache only, v1.** Covers `src/knowledge/web-cache.ts`'s
exact-URL cache (pages fetched via WebFetch), not the full vector KB's
chunks — a deliberate narrowing (no hypothetical future requirements built
in); full KB-chunk substitution is a documented follow-up, not built now.

**What was built:**
- `WebCache.list()` + `contentHashIndex()` (`src/knowledge/web-cache.ts`):
  rebuilds a `sha256(content) -> url` map fresh on every call (no incremental
  index — the cache grows across requests, so a stale index would be wrong,
  and rebuilding is cheap at realistic project webcache sizes).
- `src/compression/context-substitution.ts` (new): `substituteKnownContent`
  walks user-role messages and `tool_result` blocks (mirroring
  `native-lossless.ts`'s exact scope for proxy-fidelity), replaces any span
  ≥512 chars (`DEFAULT_MIN_SUBSTITUTION_CHARS`) whose hash the lookup
  recognizes with a compact marker, and persists the original into the CCR
  store (fail-open) under that hash — the same `expand`-recovers-it
  reversibility precedent R2.4 established for Headroom's markers.
- Pipeline Stage 4 (`src/pipeline/pipeline.ts`), gated as above, wired via a
  new non-frozen `GolemPipelineOptions.contextSubstitution` option (not a
  `src/interfaces/` change).
- A new `avoidedUpstream` telemetry event kind
  (`src/telemetry/types.ts`/`jsonl-store.ts`/`index.ts`): `recordAvoidedUpstream`
  + `TelemetryStore.aggregateAvoidedUpstream()`, following the exact
  `recordRetrieval`/`recordUsageEvent` template — added only to the
  non-frozen `TelemetryStore` interface (same precedent as R2.6's
  `aggregateUsageBySemanticForced`), NOT to the frozen `CompressionStats`.
- Composition-root wiring in `src/cli/proxy-runtime.ts`: a `WebCache` rooted
  at the project dir, re-hashed via a thunk on every request (so newly
  fetched pages are recognized without a restart), sharing the same
  `.golem/ccr` `CcrStore` the Headroom backfill uses.

**Verified:** `tsc --noEmit` clean; `biome check .` / `format:check` clean
(repo-wide); full `npx vitest run` — **82 files, 780 tests, all green** (32
new for this task: 7 in `tests/unit/knowledge/web-cache.test.ts`, 13 in
`tests/unit/compression/context-substitution.test.ts`, 6 in
`tests/unit/pipeline/context-substitution-stage.test.ts`, 5 in
`tests/unit/telemetry/jsonl-store.test.ts`'s new `recordAvoidedUpstream`
block, and 1 end-to-end wiring test in `tests/unit/cli/proxy-runtime.test.ts`
that puts a known page in the webcache and asserts substitution + a durable
`avoidedUpstream` telemetry record through the real composition root).

## §63 — R4.7: drafter model re-verification (advisory catalog, Decision 6) (2026-07-16)

Re-verified the per-tier coder catalog (`src/inference/catalog.ts`) against
live sources, per Decision 6 ("models per tier — advisory, re-verify current
best at build time"). The catalog was last set around the qwen2.5-coder
generation.

**Sources (fetched 2026-07-16):**
- WebSearch "best small local coding LLM Ollama 2026 Qwen3 coder vs
  Qwen2.5-coder benchmarks" — consensus of several 2026 ranking pages
  (localaimaster, morphllm, insiderllm, runlocalmodel, promptquorum).
- https://ollama.com/library/qwen3-coder — the authoritative tag list.

**Findings:**
- Qwen3 is the current successor generation; **Qwen3-Coder** is the 2026
  default recommendation for agentic/multi-file coding (MoE, 256K context).
- BUT for **single-function / single-file** code quality — which is exactly
  the `drafter` role's job (cheap first draft, then Claude refines) —
  Qwen2.5-Coder still narrowly *leads* (e.g. HumanEval 92.7% at 32B; noted
  "cleanest, most idiomatic single-file code of any local model tested").
- Decisive constraint: **`qwen3-coder` on Ollama only ships in `30b` and
  `480b`** — there are NO small tags (no 7b/3b/1.5b). Golem's small tiers
  (P_CPU 1.5b, P_MIN 3b, P_MID 7b) have no drop-in qwen3-coder replacement.

**Decision: no catalog change.** qwen2.5-coder (1.5b/3b/7b/14b) remains the
current best fit for the drafter's narrow single-draft role at Golem's tiers,
and there is no small qwen3-coder to switch to anyway. Optional future note:
P_MAX (24GB+ hardware) could offer `qwen3-coder:30b` as an opt-in upgrade for
larger-context/agentic drafting, and the non-coder roles (summarizer/judge)
could move to the qwen3 dense line (qwen3:4b/8b/14b/32b) — but neither is
changed now: unmeasured model swaps mid-batch are exactly what Decision 23's
evidence-first rule warns against, and the drafter is the role this batch
measured.

**Draft-quality baseline (ungrounded, n=5).** Ran representative repo tasks
through `coder` (the running MCP server predates R4.2 grounding / R4.4
refinement, so these are the *ungrounded, one-shot* baseline R4.3 telemetry
will track over time):

| # | task | verdict |
|---|---|---|
| 1 | `/golem/plan` SKILL.md (R4.1) | revise — hallucinated "open browser" steps, mangled frontmatter, wrong CLI subcommand (`note --list` vs `note list`) |
| 2 | `gatherGrounding` helper (R4.2) | revise — `console.error`, unguarded `startLine`, broke loop instead of truncating to budget |
| 3 | `coder-refine.ts` module (R4.4) | revise — conflated JSON Schema with a zod schema, `console.error` |
| 4 | `clampSliderLevel` pure fn | accept — correct logic; only trim demo `console.log`s |
| 5 | `union` vitest suite | accept — correct cases; only fix the placeholder import path |

**Baseline: 2/5 accept, 3/5 revise, 0/5 reject.** Clear pattern — coder drafts
are **accept-quality for small self-contained functions/tests** but
**revise-quality for anything touching project conventions/APIs** (invents
plausible-but-wrong integration details). This is exactly why R4.2 grounding +
R4.4 refinement exist, and why CLAUDE.local.md says skip `coder` for trivial
edits and treat every draft as a starting point. Grounded/refined accept-rate
awaits an MCP reconnect (the session's `golem mcp serve` must respawn to pick
up the R4.2/R4.4 build) — tracked as follow-up, measurable via R4.3's
`tool_usage` drafted-locally bucket.

**R1.6 cross-OS checklist:** still blocked — no macOS/Linux hardware this
session (Windows only). `questions/r1.6-ollama-verification-blocked.md` stands.

## §64 — Decision 33 human review: one real served answer, examined (2026-07-16)

The ROADMAP loose end "flip Decision 33 (local-answer sub-mode) PROPOSED→ACCEPTED
after a human reviews a real served answer" was actioned this session. A real
served answer was produced and reviewed by the user. **Verdict: keep PROPOSED,
re-review later** — the flip is now gated on a *fair* re-review (see below),
not just any manual session.

**Method.** Exercised the production path — `openKnowledgeBase` +
`KnowledgeLocalAnswerService.tryAnswer` over the live project KB — at the
default `knowledge.local_answer_min_confidence: 0.6`. Queried with the **hashing
(lexical) embedder** because the on-disk index is 512-dim (`meta.json`
`dim:512`, `hashing-embedder.js` `DEFAULT_HASH_DIM`) — i.e. it was built
lexically, not semantically. 13 self-contained conceptual questions
("What is Golem?", "What does slider level 0 mean?", the 7 MCP tools, etc.).

**Results.** 12 of 13 **declined** (correctly fell through to upstream — the
extractive contract's conservatism working as designed). The **1 served answer
was wrong**: for "What does slider level 0 mean?" it served a raw code constant
from `src/mcp/slider-store.ts` (`export const LEGACY_SLIDER_LEVEL_KEY = …`), not
the passthrough/redaction-off explanation (which lives in the spec/CLAUDE.md and
scored 0.47–0.58, *below* the floor). This is exactly the §354-point-5 residual
risk: a confident-but-wrong answer to a question that only *looks*
self-contained.

**Two structural findings.**
1. **The deployed proxy can't run the feature as designed.** Only
   `qwen2.5-coder:7b` is pulled in Ollama; `nomic-embed-text` (the catalog
   text embedder) is absent. `proxy-runtime.ts` builds the semantic embedder
   whenever Ollama probes up, so a live single-turn request with
   `local_answer_enabled` would embed via a missing model → throw or
   dimension-mismatch against the 512-dim lexical index. The local-answer stage
   at `pipeline.ts:~242` is **not** wrapped in try/catch, so this would error a
   real request rather than fail-open. (Contrast: R4.2 grounding degrades
   gracefully on search failure — local-answer should adopt the same fail-open.)
2. **Lexical ranking favors code over prose.** Dense-token source chunks
   (repeating the query's words) outrank explanatory wiki/spec prose, so at the
   0.6 floor the *only* content that clears the bar is the wrong kind.

**Gate for the ACCEPTED flip (was "a manual session", now specific):** a fair
re-review requires (a) `nomic-embed-text` pulled + the project index rebuilt
semantically, then (b) re-running the sample to see whether a *good* served
answer ever appears above the floor. Until then there is no example of a
correct served answer to justify ACCEPTED. Independent of the flip, the
`pipeline.ts` local-answer-stage fail-open gap is a real robustness bug worth
fixing regardless (candidate BACKLOG item).

**Update (2026-07-17):** both halves of structural finding #1 are now fixed.
The fail-open try/catch landed in R5 (`pipeline.ts` local-answer stage). The
*underlying* bug — a semantic query against a lexically-built index silently
scoring every chunk 0 (which the try/catch only masked, never fixed) — is fixed
in **§67**: cross-embedder-space queries now throw loudly, and the proxy picks
its query embedder to match the persisted index. Finding #2 (lexical ranking
favours code over prose) and the ACCEPTED-flip gate remain open.

**Update (2026-07-17, cont.):** the fair semantic re-review the gate asked for is
now done — see **§69b**. It required first fixing three embed-path bugs that made
the semantic index unbuildable/uncleanable (**§69**). Outcome: finding #2 persists
even semantically (test/code still outranks prose for definitional queries; slider
level 0/1 still serve a wrong test constant), so Decision 33 **stays PROPOSED**,
now gated on a specific fix (exclude/down-weight `*.test.ts`+code from local-answer
sources, prefer prose), not a vague re-review.

## §65 — R5.1 spike: Claude Code headless resume mechanism (verified 2026-07-16)

Resolves the R5.1 memo's hardest open question — *"interactive-session resume
has no clean Claude Code TUI API — likely needs headless/SDK mode or a PTY
wrapper"*. Verified against the live CLI reference
(https://code.claude.com/docs/en/cli-reference, redirected from
docs.claude.com; fetched 2026-07-16).

**Finding: headless print mode + `--resume` is the mechanism. No PTY needed.**
Exact flags (quoted):
- `--print`, `-p` — "Print response without interactive mode" (non-interactive;
  runs a query and exits). `claude -p "query"`.
- `--resume`, `-r` — "Resume a specific session by ID or name" (passing a
  session ID searches the current project dir + its git worktrees; background
  sessions appear in the picker marked `bg` as of v2.1.144). `claude -r "<id>"`.
- `--continue`, `-c` — "Load the most recent conversation in the current
  directory."
- `--session-id` — "Use a specific session ID for the conversation (must be a
  valid UUID)." Lets Golem *assign* the id up front so it can resume
  deterministically later.
- `--output-format text|json|stream-json` (print mode) — machine-readable
  resume output for status parsing.
- `--permission-mode default|acceptEdits|plan|auto|dontAsk|bypassPermissions|manual`
  and `--dangerously-skip-permissions` — relevant to R5.4's autonomy levels
  (the enforcement hook can pair with a launch mode).

**Resume recipe Golem uses:** spawn (argument-array, cross-platform, no shell,
no PTY) `claude --resume <session-id> -p "<continue-prompt>" [--output-format
json]`, or `claude -c -p "<prompt>"` for most-recent. Golem persists the
`--session-id` UUID on the task at launch so relaunch is deterministic.

**Implication for the build:** the durable `TaskStore` records the session id +
the relaunch prompt + a resume argv; `golem task resume` builds that argv and
spawns it. Because `-p` is a plain non-interactive process, capacity-gated
auto-resume is just "spawn when due" — no terminal emulation, no fragile TUI
scripting. The memo's PTY fallback is therefore **not** needed for the headless
path (an interactive hand-back to a live TUI remains out of scope / manual).

## §66 — Local inference timeout was too tight, mis-scoped, and misreported (fixed 2026-07-17)

**Symptom.** A `coder` MCP call failed with *"Golem has no local model available
for this task at the current hardware tier … Last attempt failed: could not reach
inference endpoint: Headers Timeout Error."* Ollama was in fact up and
`qwen2.5-coder:7b` pulled — so the message was wrong on its face.

**Root cause (three compounding bugs).**
1. **Mis-scoped timeout.** `OllamaClient` chat is non-streaming (`stream:false`),
   so Ollama computes the *entire* completion before sending any response — which
   means undici's `headersTimeout` bounds the WHOLE generation, not just
   time-to-first-byte. The default was 120 000 ms.
2. **Too tight for this hardware.** Measured on this box: a cold, small-prompt
   400-token generation is ~40–53 s (~5–10 tok/s). A real *grounded* `coder`
   draft (multi-KB injected context → slower prompt-eval + longer output) crosses
   120 s and trips the headers timeout. Verified: a cold grounded-size drafter
   request completed in ~53 s for only 269 tokens, i.e. 120 s left almost no
   margin for a heavier request.
3. **Misreported.** `service.ts` treats any `InferenceEndpointError` as terminal
   and rethrows it as `CapabilityUnavailableError`, whose canned text says "no
   local model at this tier" — indistinguishable from a genuinely-missing model.
   (The class's own doc already flagged this ambiguity.) This is what sent the
   first investigation down the wrong path.

**Fix.**
- New `inference.request_timeout_ms` config leaf (default **600 000 ms**), env
  override `GOLEM_INFERENCE_REQUEST_TIMEOUT_MS`, wired through **every**
  `new OllamaClient(...)` site (previously the 120 s constructor default was
  unconfigurable). Connection-level failures still fail fast, so a generous cap
  only ever extends waiting on a genuinely-slow-but-alive endpoint.
- New `InferenceTimeoutError extends InferenceEndpointError`: undici
  headers/body timeouts are detected (`UND_ERR_HEADERS_TIMEOUT` /
  `UND_ERR_BODY_TIMEOUT`) and surfaced with an actionable message ("model may be
  cold-loading or the hardware is slow; raise `inference.request_timeout_ms`").
- The MCP error formatter renders a timeout distinctly ("NOT a missing model")
  whether it arrives directly or wrapped in `CapabilityUnavailableError`.

**Tests.** `ollama-client` timeout→`InferenceTimeoutError` (fake slow server);
`config-env` `GOLEM_INFERENCE_REQUEST_TIMEOUT_MS` override. Full suite green.

## §67 — KB search: cross-embedder-space queries silently returned garbage (fixed 2026-07-17)

Closes §64 structural finding #1's underlying cause (the R5 try/catch only
masked it).

**Root cause.** The embedding space of the on-disk index and the space the query
is embedded in were chosen independently. `golem mcp serve` reconciles them
(`ensureProjectIndexed` rebuilds on `manifest.json` signature drift), but the
`golem proxy` local-answer path chose its embedder from a live "is Ollama up?"
probe (`inference !== undefined`), never consulting what built the index. When
the two diverged (semantic query vs a lexically-built 512-dim index),
`cosineSimilarity` hit its `a.length !== b.length → return 0` branch and scored
*every* chunk 0 — ranked garbage, no error thrown, so the local-answer try/catch
never fired. This is the confident-but-wrong served answer §64 observed.

**Fix.**
- **Loud, not silent (backstop):** `FileVectorDriver.search` and
  `InMemoryVectorDriver.search` now throw `EmbedderMismatchError` on a
  query/index dimension mismatch instead of scoring 0. Any residual divergence is
  now a clear, actionable error everywhere (CLI/MCP surface "rebuild with
  `golem index`"; the proxy fails open for a real, logged reason).
- **Consistency:** new `resolvePersistedEmbedMode` reads the index's persisted
  manifest signature; the proxy picks its local-answer embedder to MATCH it —
  lexical index → hashing (works with no Ollama), semantic + model present →
  semantic, semantic + model gone → declines cleanly with a startup warning.

**Verified end-to-end:** built a real 512-dim lexical index, queried it with a
768-dim semantic embedder → threw `EmbedderMismatchError` (previously: silent
garbage). Unit + contract tests added; full suite green.

## §68 — CI red on a Windows/macOS file-watcher libuv abort (fix 2026-07-17)

**Symptom.** CI (`.github/workflows/ci.yml`) went red at run #4 (2026-07-15) and
stayed red (#5, #6). The failing step is `Tests`, but ONLY on macOS (node 22+24)
and Windows/node-24 — Ubuntu (both) and Windows/node-22 pass. The crash is a
hard libuv `abort()`, not a test assertion:
`Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c,
line 72`, followed by `ERR_IPC_CHANNEL_CLOSED` (the vitest tinypool worker died).

**Two dead ends, then the real root cause (from libuv source).**
- *Attempt 1 — canonicalize the watched path* (`realpathSync.native`, emit under
  the original root). Pushed on PR #2 → CI aborted identically (macOS 22/24,
  Windows 24). So it is NOT the root-path form.
- *Attempt 2 — drop `{recursive:true}`, use a per-directory NON-recursive
  `fs.watch` tree walk.* Pushed → CI aborted identically again.
- *Ruled out — node drift.* Resolved node is identical green (#3) vs red — win/mac
  node-24 `v24.18.0`, mac node-22 `v22.23.1`. Pinning wouldn't help.

Reading `libuv/src/win/fs-event.c` (v1.51.0) settled it. The abort is in
`uv__relative_path`: `assert(!_wcsnicmp(filename, dir, dirlen))`, where `dir` is
`handle->dirw` (the watched dir's long path from `GetLongPathNameW` at start) and
`filename` is `GetLongPathNameW(dir + "\\" + eventName)` at event time. It fires
when those two long-path resolutions don't share the `dir` prefix — a
runner/junction/mapped-drive/8.3 quirk. Crucially it is reached for **every
directory watch, recursive or not** (the recursive flag only sets
`ReadDirectoryChangesW`'s subtree bit at fs-event.c:46), and `realpath` can't
prevent it (Node's `realpath` ≠ Windows `GetLongPathNameW` semantics). So **no
`fs.watch`-on-a-directory variant is safe** — and it's an `abort()`, uncatchable
by any `error` handler, that can also crash a real Windows user on an unlucky path.

**Fix (guaranteed): stop using `fs.watch`; poll instead.** `watchPath` now scans
the tree (`scanFiles` — SKIP_DIRS-pruned, chunkable-only) on an interval
(`pollMs`, default 1000) and diffs mtime/size against the previous snapshot,
feeding the existing debounce + re-stat batching layer. No `fs.watch` → the libuv
fs-event path is never entered → the abort is impossible, on every OS. Bonus: one
backend everywhere means Linux CI now exercises exactly what Windows/macOS run
(previously they ran different code). Cost: change latency ≤ `pollMs` and a
periodic pruned stat-scan — fine for opt-in KB freshness. Supersedes ADR-0001.

**Verification honesty.** The abort itself remains not locally reproducible
(runner-environment-specific), but the fix removes the entire crashing mechanism
rather than trying to dodge its trigger, so its correctness doesn't depend on
reproducing it: with no `fs.watch` call, `uv__relative_path` cannot run. Local
proof is behavioral (watcher + full suite green on the polling backend);
cross-platform green is confirmed by CI on PR #2 after this change.

## §69 — Semantic KB path was unbuildable/uncleanable; three embed-path bugs fixed (2026-07-17)

Found while executing PRE_R6_BATCH **LE1** (the Decision 33 semantic re-review):
the semantic KB had **never built end-to-end on this repo**. The default lexical
hashing embedder (no token limit, fixed 512-dim) masked all three bugs. Root
cause was three compounding defects, all now fixed with tests (full suite green,
1032; `tsc` + `biome` clean):

1. **Oversized single input (LE5a).** `chunker.ts` `MAX_CHUNK_CHARS = 2_000` is a
   *soft* cap (splits on paragraph boundaries only). A dense unsplittable block (a
   wide markdown table in this file, a long `golem-spec.md` section) becomes a
   ~4096-token chunk. `OllamaClient.embed` forwarded inputs unbounded; stock
   `bge-m3` has physical batch 2048 < its 4096 context, so any input > 2048 tokens
   errored `input … too large to process` and, under load, crashed the runner.
   Ollama-side `num_batch` tuning did NOT fix it (2048 → clean error; 4096/8192 →
   runner crash). **Fix:** `MAX_EMBED_INPUT_CHARS = 6000`, each input truncated
   before send (stored chunk text unchanged; only the vector uses the head).
2. **Whole corpus in one request (LE5b).** `knowledge-base.ts` `#embedAndStore`
   embeds *all* chunks of a kind in a single `embed()` call → one `/v1/embeddings`
   request over thousands of inputs. Ollama opens a localhost connection to its
   runner per input; after ~1 min of rapid connections the dial is refused
   (**Windows ephemeral-port/TIME_WAIT exhaustion** — NOT a crash or CUDA-OOM: the
   server log showed 7 GB VRAM free throughout and a *different* ephemeral port in
   each `dial tcp 127.0.0.1:<port>/tokenize` failure), 400ing the whole request and
   losing all progress. **Fix:** `EMBED_BATCH_SIZE = 64` — sequential bounded
   batches; connections drain between them. Both fixes in `OllamaClient.embed`,
   +2 unit tests. Verified: stock (freshly-pulled) `bge-m3` builds the full 2550-
   chunk index end-to-end in ~6 min, no model tuning.
3. **Reindex never clears on embedder change (LE5c).** With 1+2 fixed the build
   completes, but `golem index` (`main.ts` → `knowledge.ingest`) upserts into the
   *pre-existing* collection. `FileVectorDriver.openCollection` loads the old
   `dim` from `meta.json` and `upsert` only set `dim` when 0, so a lexical→semantic
   reindex wrote 1024-dim vectors into a `dim:512`-labelled collection, kept the
   stale lexical chunks, and produced a mixed-dim collection §67's
   `assertEmbedderSpaceMatch` (correctly) refuses to query. `fullIndex` in
   `auto-index.ts` had the same gap (comment claims "clear + full rebuild"; code
   didn't clear). This is the real user path: *index lexically → `ollama pull
   bge-m3` → reindex* → unqueryable. **Fix:** `FileVectorDriver.upsert` detects an
   incoming-vector dimension that differs from a non-zero `col.dim`, clears the
   collection (+ its `#chunkIndex` entries) and resets `dim` before storing;
   +2 unit tests (resets on dim change; does NOT reset on same-dim incremental).

**Follow-ups (optional, logged, not blocking):** a *hard* char cap in the chunker
so oversized chunks never form; a retry around each embed batch; clearing stale
chunks on a same-dim rebuild of deleted files (mcp-serve already covers this via
`ensureProjectIndexed` incremental delete). None needed for correctness now.

## §69b — Decision 33 local-answer: fair semantic re-review (2026-07-17)

The §64 gate ("re-review on a semantically-built index, flip only if a *good*
served answer clears the 0.6 floor and no *wrong* one does") was actioned once
§69's fixes made a clean 1024-dim `semantic:bge-m3` index buildable. Method:
`KnowledgeLocalAnswerService.tryAnswer` (`knowledge` scope, default 0.6 floor,
k=5) over 13 self-contained conceptual questions; recorded top-5 hits + verdict.

**Results — 11 served / 2 declined:**

| Q | verdict | top source | correct? |
|---|---|---|---|
| What is Golem? | DECLINED (0.589) | CLAUDE.md (right prose) | good answer sat just under the floor |
| slider level 0 | SERVED 0.694 | `native-lossless.test.ts` `const LEVEL_0 = …` | **WRONG** (§64's canonical failure persists) |
| search tool | SERVED 0.612 | wiki *Wiki-First Knowledge* | ✅ correct |
| fetch tool | SERVED 0.603 | `autonomy/classify.ts` READ_TOOLS set | **WRONG** |
| expand tool | SERVED 0.640 | `skills.ts` expand skill | ✅ ok |
| stats tool | SERVED 0.635 | `skills.ts` stats skill | ✅ ok |
| level tool | SERVED 0.609 | `mcp/index.ts` tool-names comment | ~ weak |
| ingest tool | DECLINED (0.594) | `classify.ts` | correct decline |
| coder tool | SERVED 0.655 | R4.2 debrief | ✅ ok |
| redaction stage | SERVED 0.636 | wiki *Redaction Stage* | ✅ correct |
| compression saves tokens | SERVED 0.612 | vscode README | ~ weak (misses Decision 23 nuance) |
| wiki-first pattern | SERVED 0.677 | wiki *Wiki-First Knowledge* | ✅ correct |
| slider level 1 | SERVED 0.677 | `cli-stats.test.ts` `const LEVEL_1 = …` | **WRONG** |

**Read.** Semantic ranking is a clear improvement over lexical (§64 served 1/1
wrong; here wiki/spec prose now genuinely wins several — search, redaction,
wiki-first). BUT the §64 failure mode **persists**: dense-token code/**test**
chunks still outrank explanatory prose for definitional queries, and the two
canonical questions (slider level 0/1) still serve a confidently-wrong test
constant *above* the floor while the correct prose ("What is Golem?", 0.589) is
declined *below* it. Serving wrong > declining, so this still fails the bar.

**Verdict: Decision 33 stays PROPOSED — do NOT flip, do NOT retire.** Now
gated on a concrete, evidence-backed fix, not a vague re-review: address §64
finding #2 for the local-answer path — a source-type weighting that prefers
wiki/spec/doc prose and **excludes or down-weights `*.test.ts` (and likely all
code) from the local-answer source set** (mirror `boostWikiHits`), and/or raise
the floor / require the top source to be prose for definitional queries. Then
re-run this sample; flip only when no wrong answer is served. Test files are the
worst offenders (they repeat query terms: `LEVEL_0`, `LEVEL_1`) and are the
cheapest, highest-impact thing to exclude. This becomes PRE_R6_BATCH LE1's
follow-on task.

## §69c — Decision 33 finding #2 fixed: local-answer restricted to prose sources (2026-07-17)

Implemented §69b's gate. `KnowledgeLocalAnswerService.tryAnswer` now fetches a
wider candidate set (`max(k*4, 12)`) so prose isn't crowded out of the top-k by
dense-token code, then keeps only **prose** sources (`isProseSource`:
`.md/.markdown/.mdx/.txt/.rst`) before applying the confidence floor. Rationale:
the path is extractive (quotes a chunk verbatim), and a raw code/test chunk is
almost never a good answer to a definitional question. If no prose hit clears the
floor it declines and falls through to upstream (serving wrong > serving nothing).
+4 unit tests; full suite green (1036); `tsc`/`biome` clean.

**Re-run of the §69b sample after the fix — 6 served / 7 declined, ZERO wrong
served answers:**

| Q | before (§69b) | after |
|---|---|---|
| slider level 0 | SERVED wrong (`test.ts` `LEVEL_0`) | SERVED `IMPLEMENTATION_PLAN.md` §2.4 SliderPolicy (on-topic prose) |
| slider level 1 | SERVED wrong (`test.ts` `LEVEL_1`) | **DECLINED** |
| fetch tool | SERVED wrong (`classify.ts`) | **DECLINED** |
| expand / stats / level (code sources) | SERVED from `skills.ts`/`mcp` code | expand/level **DECLINE**; stats serves R4.3 debrief (prose) |
| search / redaction / wiki-first / coder | correct (wiki/debrief) | unchanged — still correct |
| What is Golem? / ingest | declined (prose under floor) | still declined |

**Net:** the confident-WRONG answers are eliminated — every previously-wrong
served answer now either declines or serves on-topic prose. Two remaining served
answers are on-topic but thin: "slider level 0" serves the SliderPolicy spec
table rather than the passthrough/redaction-OFF safety warning (Decision 30), and
"compression saves tokens" serves the VS Code panel README rather than the
situational-savings nuance (Decision 23). Neither is *wrong*, but neither is the
best possible answer — an inherent limit of extractive top-chunk serving (Decision
33 deliberately forbids generative phrasing to avoid fabrication).

**Bar check for the ACCEPTED flip:** §69b's gate was "no wrong answer served" —
now met. The remaining judgment (is on-topic-but-thin good enough, given the
"verify independently" label + opt-in/off-by-default posture?) is a **human call**
per Decision 33's PROPOSED convention; not flipped unilaterally.

**Tightening (2026-07-17, cont.):** applied the "prefer durable prose" step —
`isProseSource` now also excludes working/planning docs (`docs/plan/`:
IMPLEMENTATION_PLAN, ROADMAP, batch briefs, verification-notes, BACKLOG), so an
answer comes from the durable knowledge store (wiki + spec + root docs), not an
ephemeral plan table. Post-tightening sample: **6 served / 7 declined, still zero
wrong** — and now **5 of 6 served answers come from the wiki** (concepts +
debriefs). The two previously-thin answers resolve into a clean wiki-first signal:
- "slider level 0/1" now **DECLINE** (the spurious `IMPLEMENTATION_PLAN.md`
  SliderPolicy-table hit is excluded; the authoritative passthrough/redaction-OFF
  prose scores < 0.6). Safe, but it *should* serve a good answer.
- "compression saves tokens" still serves the VS Code README (thin) — the only
  non-wiki served answer left.

**Root cause of both = a wiki COVERAGE gap, not a ranking bug:** there is no wiki
concept page for the slider/levels or for compression (only `Redaction Stage.md`
exists among the pipeline concepts). Local-answer quality is now bounded by wiki
coverage — exactly the wiki-first design (Decision 28). **Fix at the source: add
the missing concept pages** (proposed: `Slider Levels` incl. level-0
passthrough/redaction-OFF per Decision 30; `Compression` incl. situational savings
per Decision 23), which then rank as authoritative prose and let local-answer
serve them. Tracked in PRE_R6_BATCH LE1 + the wiki work.

**Update (2026-07-17): wiki pages written, loop closed.** Added
`docs/wiki/concepts/Slider Levels.md` and `Compression.md`; after reindex the
three problem questions all serve the correct authoritative wiki prose:
"slider level 0" → `Slider Levels.md` (0.620, the passthrough/redaction-OFF
answer), "slider level 1" → `Slider Levels.md` (0.628), "compression" →
`Compression.md` (0.700, top hit). Final sample: 8 served / 5 declined, every
served answer now correct/authoritative wiki prose; the 5 declines fall through
safely (no wiki page defines those yet — more coverage opportunities, not bugs).
The wiki-first loop end to end: write the durable page → local-answer serves it.

## §69d — `golem index` made incremental (2026-07-17)

Prompted by "a 6-minute reindex is a long process." Incremental reindex already
existed — `ensureProjectIndexed` (`src/cli/auto-index.ts`, used by `golem mcp
serve` startup) diffs each file's mtime+size against the manifest and re-embeds
only changed/new files (drops deleted, or skips entirely) unless the embedder
signature changed. But the explicit `golem index` command called
`knowledge.ingest` directly — a **full** re-embed every run — and wrote its
manifest WITHOUT per-file states (no `files` arg), so even the auto-index couldn't
sync against a `golem index`-written manifest.

**Fix (`src/cli/main.ts`):** a whole-project `golem index` (no path arg, no
`--watch`) now routes through `ensureProjectIndexed` — incremental, and it writes
a proper file-state manifest. An explicit `golem index <path>` or `--watch` keeps
the targeted full ingest. Also closes LE5c at the command level
(`ensureProjectIndexed` does the correct `rm`+rebuild on embedder change).
Verified on this repo: the first run after the old empty-manifest is a one-time
catch-up (all files look "changed"); then a no-op run is **1.4 s** (was ~6–7 min)
and a single-file edit syncs in **3.7 s** (3 chunks). Full suite green (1036);
core incremental logic already covered by `tests/unit/cli/auto-index.test.ts` +
`tests/integration/knowledge-incremental.test.ts`.

## §70 — Distribution, versioning & self-update facts (2026-07-22, for Decision 41)

Verified ahead of building the one-line installer, standalone binary, and
self-update (Decision 41). Local toolchain at time of writing: Node **v24.13.1**,
npm **11.12.1**, Bun **not installed** on this Windows dev box, OS
MINGW64_NT-10.0-26200.

**1. npm publish status.** `npm view golem-run` and `npm view golem-vscode` both
return **E404 — not found** (2026-07-22). Neither the CLI package nor the VS Code
extension has ever been published. So the `curl … | sh` / `irm … | iex` one-liner
has nothing to install until the first `npm publish`; the installer must fail
gracefully (clear "not yet published" message) until then, and the self-update
registry check must tolerate a 404 as "no releases yet," not error.

**2. User-Agent strings for the nginx content-negotiation `map`.** Confirmed
behaviour (Microsoft docs + curl/wget defaults):
- `curl` sends `curl/<ver>` (e.g. `curl/8.x`); `wget` sends `Wget/<ver>`.
- PowerShell `Invoke-RestMethod`/`Invoke-WebRequest` (what `irm` is) sends a UA
  that **always contains the substring "PowerShell"**: Windows PowerShell 5.1 →
  `Mozilla/5.0 (Windows NT …) WindowsPowerShell/5.1.<build>`; PowerShell 7+
  (pwsh) → `Mozilla/5.0 (Windows NT …) PowerShell/7.<x>`. Both include
  `Mozilla/5.0`, so the map MUST test for `powershell` **before** any generic
  `Mozilla` browser rule.
- Browsers send `Mozilla/5.0 … AppleWebKit/… Chrome/… Safari/…` with **no**
  "PowerShell"/"curl"/"wget" token → fall through to the HTML landing page.
- Design: case-insensitive `map $http_user_agent`: `~*powershell → install.ps1`,
  `~*(curl|wget|libcurl|fetch|httpie) → install.sh`, `default → landing`. Explicit
  `/install.ps1` and `/install.sh` paths remain as an unambiguous fallback.

**3. Bun `bun build --compile` (https://bun.com/docs/bundler/executables,
fetched 2026-07-22).** Cross-compile targets we care about:
`bun-windows-x64`, `bun-windows-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`,
`bun-linux-x64`, `bun-linux-arm64` (plus `-baseline`/`-modern`/`-musl` variants).
Notes that shape our build:
- `--define VERSION='"x.y.z"'` inlines a build-time constant → the binary can
  report its version without reading package.json (which `--compile` does NOT
  autoload at runtime by default).
- The Bun runtime is always baked in; `--target=node` is unsupported. So the
  binary carries Bun, not Node — behaviour parity with our Node build must be
  covered by the e2e smoke, not assumed.
- `.wasm` and `.node` embed only via explicit `with { type: "file" }` import
  attributes. Our only WASM path is the **optional** `web-tree-sitter`
  syntax-aware chunker (devDep, off by default) — it will NOT be embedded, so the
  standalone binary silently lacks syntax-aware chunking (degrades to the default
  chunker, acceptable). Flag if syntax-aware chunking ever becomes default.
- Windows metadata flags (`--windows-icon`, version props) can't be used when
  **cross**-compiling — set those only on a native Windows build runner.
- **NOT YET RUN:** no Bun on this box and no macOS/Linux hardware in-session, so
  the actual compiled binaries are produced + smoke-tested only in CI (release
  workflow). Treat the standalone channel as build-wired-but-unverified-locally
  until a release run is green (precedent: the non-Windows Ollama rows, §
  r1.6-ollama-verification-blocked).

**4. Single source of truth for version.** `VERSION` is hardcoded in
`src/index.ts` (`"0.1.0"`), duplicated in `package.json` and
`vscode-extension/package.json`. Plan: `package.json` is canonical; a build-time
`scripts/sync-version.mjs` generates `src/version.ts` from it (re-exported by
`src/index.ts`); a `scripts/release.mjs` bumps both package.json files in lockstep.

**5. VS Code extension self-update.** VS Code auto-updates Marketplace-installed
extensions; there is no supported API for an extension to update *itself*. The
extension's job (Decision 41) is therefore to surface the **CLI** update state it
already has cheap access to (it shells `golem … --json` every poll): call
`golem update --check --json`, and on `updateAvailable` show a status-bar badge +
a `golem.update` command that runs the upgrade in an integrated terminal. The
extension binary keeps updating via the Marketplace as normal.

## §71 — WebFetch returns a prompt-specific answer, not the raw page (2026-07-23, for Decision 42)

Confirmed the premise behind the WebFetch raw-caching fix (Decision 42), building
on the hooks facts already recorded in §41:

- **Claude Code's WebFetch `tool_response` is the fetched page run through a
  summarization model against the call's `prompt`** — an *answer*, not the raw
  markdown. `tool_input` carries `{url, prompt}` (§41). Caching that answer keyed
  by URL alone (what the pre-Decision-42 PostToolUse hook did) serves it back to a
  later fetch of the same URL with a *different* prompt.
- **The PostToolUse hook only ever receives the answer** — there is no field
  carrying the raw page. So caching the raw page requires Golem to fetch the URL
  **itself** (global `fetch`, already used by `defaultRevalidate`), then extract
  text with the existing `extractHtmlText` / `extractPdfText` (§ R3.2).
- **Two distinct WebFetch interception points, easily conflated:**
  1. the **hook path** — `PreToolUse`/`PostToolUse(WebFetch)` around the tool
     (cache serve + capture); Decision 42 operates here.
  2. the **proxy path** — Claude Code's WebFetch makes an *internal
     summarization model call*, and that LLM request transits Golem's proxy,
     where local-answer can hijack it. The `MAX_LOCAL_ANSWER_QUERY_CHARS = 1000`
     length-gate guards this path.
- **Decision 42 shipped as Option A (PreToolUse replace):** the pre-hook fetches
  the raw page itself on a miss and serves it via `deny`, so the tool — and its
  internal summarization call — **never runs on the happy path**. That does NOT
  fully retire the length-gate: when Golem's own fetch fails the hook falls open,
  the tool runs, and its internal call transits the proxy after all. So the gate
  stays as the safety net for the fail-open case (pages Golem can't fetch itself);
  Option A only narrows how often the proxy-path hijack window is reachable.
- **The self-fetch is on the tool's critical (blocking) path** under Option A, so
  `fetchRawPage` bounds the request with `AbortSignal.timeout` (default 15 s) — a
  hang would otherwise stall the WebFetch tool. A timeout throws → fail-open.

## §72 — Claude Code cost doc re-verified for R6.4 (2026-07-23, for Decision 21f)

Re-fetched https://code.claude.com/docs/en/costs (2026-07-23) — Decision 21f
originally cited it on 2026-07-04. The doc has moved on; the R6.4 benchmark must
build against these current figures, not the 2026-07-04 memory.

- **Baselines (updated).** "Across enterprise deployments, the average cost is
  around **\$13 per developer per active day and \$150-250 per developer per
  month**, with costs **remaining below \$30 per active day for 90% of users**."
  The ~\$13/day figure Decision 21f cited persists; the \$150-250/month and
  "<\$30/day for 90%" bounds are new and worth carrying as reference constants.
  Guidance: "start with a small pilot group and use the tracking tools … to
  establish a baseline before wider rollout" — i.e. the doc itself frames these
  as *starting points*, not a delta to claim against (matches the memo's
  honest-attribution caveat).
- **Agent-team multiplier now qualified.** "Agent teams use approximately **7x
  more tokens** than standard sessions **when teammates run in plan mode**,
  because each teammate maintains its own context window." The 7× is unchanged
  but now scoped to plan-mode teammates; Golem does not spawn agent teams, so
  this is a reference number, not something Golem measures.
- **Metrics the doc tracks (goal ii).** `/usage` Session block: total cost,
  API/wall duration, code changes, and per-model input/output/**cache
  read/cache write** token counts. On paid plans it "attributes recent usage to
  **skills, subagents, plugins, and individual MCP servers**, with each shown as
  a percentage of the total," **flags behaviors** (long context, cache misses)
  when one "accounts for **10% or more** of recent usage," and toggles **last
  24 hours vs last 7 days** (`d`/`w`; VS Code Day/Week). Figures are
  "computed from **local session history on this machine**" — other devices /
  claude.ai excluded.
  - **Honest gap for R6.4:** Golem's telemetry attributes *Golem's own* MCP
    tools (R4.3 `aggregateToolUsage`) and pipeline savings — it does **not** see
    Claude Code's per-subagent/skill/plugin split (that lives in `/usage`, from
    local session history Golem never parses). The benchmark surfaces Golem's
    contribution against the doc's baselines; it is **not** a replacement for
    `/usage` per-user billing and must say so.
- **Reduction techniques Golem already automates (goal i).** The doc's own
  headline example — "**Offload processing to hooks** … a hook can grep for
  `ERROR` and return only matching lines, reducing context from tens of
  thousands of tokens to hundreds" (a PreToolUse test-output filter) — is
  exactly Golem's CCR oversized-output swap (B2). Others that map: "choose the
  right model / delegate verbose operations to subagents" → Golem `coder` local
  drafting; "prompt caching" (auto) → Golem's byte-faithful cache-stable path;
  "usage tracking via `/usage`" → Golem A4 telemetry + `golem stats`; "reduce
  MCP server overhead / prefer CLI tools" → Golem's deferred-tool + CLI-first
  posture; "**keep CLAUDE.md under 200 lines**" → a cheap, checkable leanness
  metric the benchmark can compute directly.
- **Cost-safety.** All savings the benchmark reports must stay net-of-cache
  (§30/§54, Decision 23/31): on Anthropic, lossless compression is ~0%; the real
  levers Golem can honestly count are CCR offload, local drafting, and
  `avoidedUpstream` — not gross-token compression. Reuse `effectiveInputTokens`
  (cache write 1.25×, read 0.1×) for any input-cost figure.

## §73 — R6.1 gateway protocols: which speak Anthropic-native vs OpenAI (2026-07-23, for Decision 22/R6.1)

Verified for the R6.1 "provider adapters" case (a)-vs-(b) split (the memo,
`proposals/r6-multi-provider-remote-memos.md`). Checked the live OpenRouter API
reference (fetched 2026-07-23, served from Golem's own raw-fetch cache) and a web
search of Microsoft Learn + MS Community Hub on Azure Foundry.

- **Azure AI Foundry (Claude models) = Anthropic-native (case a).** Foundry's
  Claude deployments respond ONLY to the native Anthropic Messages API, served at
  **`https://<resource>.services.ai.azure.com/anthropic/v1/messages`**. An
  OpenAI-style `/v1/chat/completions` request returns **404**. Auth: **`api-key`**
  (or `x-api-key`) header, or Microsoft Entra ID **`Authorization: Bearer <token>`**.
  Keep the Anthropic headers (`anthropic-version: 2023-06-01`, …). **Gotcha:** the
  `model` field must equal the *Foundry deployment name* (e.g. `claude-opus-4-5`),
  not Anthropic's dated model id. **Feature parity:** some Anthropic features
  return 400 on Azure-hosted deployments; Claude Code already detects "Hosted on
  Azure" and adapts. Sources: Microsoft Learn Q&A 5663566; techcommunity Azure AI
  Foundry blog 4525212; litellm azure_anthropic docs.
- **OpenRouter = OpenAI-schema primary, but ALSO exposes an Anthropic Messages
  endpoint.** The overview documents the normalized **OpenAI Chat Completions**
  body at `https://openrouter.ai/api/v1/chat/completions` (auth
  `Authorization: Bearer <OPENROUTER_API_KEY>`), but the API-reference nav lists a
  dedicated **"Anthropic Messages"** endpoint — so an Anthropic-native path is
  available too (verify its exact base path + tool-use fidelity before relying on
  it). Reaching non-Claude models / the normalized surface is OpenAI-schema =
  **case (b)**.
- **Implication for the build.** **Case (a) is small and byte-faithful-safe:**
  the wire protocol is unchanged (Anthropic Messages), so SSE / tool-use blocks
  pass through exactly as today — the only real work is (i) a per-provider
  **upstream base URL** (Azure appends `/anthropic`, so the proxy's existing
  "append request target to `upstreamBaseUrl` verbatim" gives
  `…/anthropic/v1/messages` for a `/v1/messages` request — no path rewriting), and
  (ii) **auth-header mapping** (Anthropic `x-api-key`; Azure `api-key` or Bearer;
  OpenRouter Bearer). `isCachingUpstream` should conservatively treat these as
  caching (Azure Foundry Claude prompt-cache behaviour unverified → assume caching
  per Decision 31; semantic stage stays off). **Case (b)** (OpenAI translation +
  the response-transform seam) remains the large, separate build the memo scopes.
- **Cross-check needed at build time:** does Azure Foundry Claude honour Anthropic
  prompt-cache `cache_control` blocks the same way? Unverified here — treat as
  caching until measured (fail-safe: no semantic rewrite, byte-faithful).

## §74 — R6.1 case (b) b1: OpenAI-schema translation LIVE-verified against Ollama (2026-07-23)

Unlike case (a), the OpenAI-schema translation is live-testable with no cloud
credential — Ollama's OpenAI-compatible endpoint runs locally. Ran a real
`GolemProxy` (translating provider wiring) against `http://localhost:11434/v1`
with `qwen2.5-coder:7b`:

- **Request:** `POST /v1/messages` with an Anthropic body (`model:
  claude-sonnet-4-5`, `max_tokens:64`, one user message). The proxy translated it
  to an OpenAI Chat Completions body (`stream:false`, model overridden to
  `qwen2.5-coder:7b`) and POSTed to `/v1/chat/completions`.
- **Response:** HTTP 200, a well-formed **Anthropic Messages** object —
  `{type:"message", role:"assistant", model:"qwen2.5-coder:7b",
  content:[{type:"text", text:"PONG"}], stop_reason:"end_turn",
  usage:{input_tokens:37, output_tokens:3}}`. The model id is the **real serving
  model**, never a `claude-*` name (honesty rail).
- **Confirms:** the response-transform seam (buffer → translate → write Anthropic
  JSON) works end-to-end on a real backend; the non-streaming path is sound.
  Ollama returns real `usage`, so token accounting survives translation.
- **b1 scope limits (by design, next slices):** NON-STREAMING only — `stream` is
  forced off, so a real Claude Code client (which sends `stream:true`) is not yet
  served; that is **b2** (Anthropic SSE ↔ OpenAI deltas). Text content only;
  tool-use mapping is **b3**. OpenAI/Gemini cloud providers are later slices
  (Gemini has its own schema; OpenAI reuses this exact translator + a `bearer`
  key via `GOLEM_UPSTREAM_API_KEY`).
- **Model override is required** for translating providers: Claude Code sends a
  `claude-*` model Ollama lacks, so `proxy.upstream_model` (e.g. `qwen2.5-coder:7b`)
  overrides it; the proxy warns at startup if it is unset.

## §75 — R6.1 case (b) b2: streaming translation LIVE-verified against Ollama (2026-07-23)

b2 adds SSE streaming translation (OpenAI deltas → Anthropic event stream) — the
slice that makes real Claude Code traffic (`stream:true`) work against an
OpenAI-schema upstream. Live-tested the same way as b1, streaming:

- **Request:** `POST /v1/messages` with `stream:true`. The translator now HONORS
  the client's stream flag (b1 forced it off) and adds
  `stream_options:{include_usage:true}`; the proxy detects the streaming request
  and pipes the upstream OpenAI SSE through `OpenAIChatSSETranslator` to the
  client live (never buffered).
- **Response:** HTTP 200 `text/event-stream`, a well-formed Anthropic event
  sequence — `message_start` → `content_block_start` → `content_block_delta`×N →
  `content_block_stop` → `message_delta` (`stop_reason:end_turn`,
  `usage:{input_tokens:37, output_tokens:3}`) → `message_stop`. Streamed text
  reassembled to `PONG`.
- **Protocol mapping confirmed:** OpenAI `choices[].delta.content` →
  `content_block_delta{text_delta}`; `finish_reason` → Anthropic `stop_reason`
  (via `mapStopReason`); the final OpenAI `usage` chunk (requested via
  `stream_options`, and emitted by Ollama) → `message_delta.usage`. `[DONE]` and
  partial-line chunk boundaries handled (the Transform buffers an incomplete tail
  and re-parses).
- **Known accounting caveat:** Anthropic puts `input_tokens` in `message_start`,
  but OpenAI streaming reports usage only at the END — so `message_start.usage`
  carries `input_tokens:0` and the real counts land in `message_delta.usage`.
  Some clients under-count input tokens as a result; acceptable for a local
  Ollama run and documented. (A fix would buffer the head, defeating streaming.)
- **b2 scope:** single text content block. Streaming tool-use (OpenAI
  `delta.tool_calls` → Anthropic `input_json_delta`) is **b3**.

## §76 — R6.1 case (b) b3: tool-use translation (2026-07-23)

b3 maps tools both ways: request `tools`/`tool_choice` + `tool_use`↔`tool_calls`
+ `tool_result`↔`role:"tool"`, and response `tool_calls`→`tool_use` (non-stream
and streaming `input_json_delta`). Mapping details confirmed against the OpenAI
Chat Completions + Anthropic Messages schemas:

- **Request:** Anthropic `tools:[{name,description,input_schema}]` → OpenAI
  `tools:[{type:"function",function:{name,description,parameters:input_schema}}]`.
  `tool_choice`: `auto`→`"auto"`, `any`→`"required"`, `none`→`"none"`,
  `{type:"tool",name}`→`{type:"function",function:{name}}`. An assistant turn's
  `tool_use` blocks → an assistant message with `tool_calls`
  (`function.arguments` = `JSON.stringify(input)`); a user turn's `tool_result`
  blocks → one `role:"tool"` message each (emitted BEFORE any user text, since
  they answer the prior assistant's calls) with `tool_call_id = tool_use_id`.
- **Response (non-streaming):** `message.tool_calls` → Anthropic `tool_use`
  content blocks (`input = JSON.parse(arguments)`, `{}` on invalid JSON), after
  any leading text block; `finish_reason:"tool_calls"` → `stop_reason:"tool_use"`.
- **Response (streaming):** Anthropic content blocks are STRICTLY SEQUENTIAL, so
  the translator keeps one block open and closes it before the next: text →
  `text` block; each OpenAI `delta.tool_calls[i]` → a `tool_use` block whose
  `arguments` fragments become `input_json_delta.partial_json` (concatenate to
  the full JSON). `id`/`name` captured from the first fragment.
- **LIVE (best-effort) against Ollama `qwen2.5-coder:7b`:** a request WITH tools
  was accepted (HTTP 200) and the response translated, but the model returned the
  call as **text** (a JSON blob) rather than a native OpenAI `tool_calls` —
  `stop_reason:end_turn`, no `tool_use` block. So the `tool_calls`→`tool_use`
  path is **unit-verified, not live-verified** against this model: whether native
  tool-calls appear depends on the backend model/server, not on Golem's mapping.
  (Ollama tool-call support is model- and version-dependent.)
- **b3 scope:** images still dropped; parallel tool calls handled (multiple
  OpenAI `tool_calls` indices → sequential Anthropic tool_use blocks), assuming
  each call's argument fragments arrive contiguously (OpenAI's actual behaviour).

## §77 — R6.1 case (b): OpenAI functional; Gemini API verified (2026-07-23)

**OpenAI is already functional via the b1–b3 translator — no new code.** The
`openai` provider is a translating provider (`isTranslatingProvider`), auth
`bearer` (key via `GOLEM_UPSTREAM_API_KEY`), non-caching; set
`proxy.upstream_base_url=https://api.openai.com/v1` + `proxy.upstream_model`
(e.g. `gpt-5.2`). Same for a cloud OpenRouter OpenAI endpoint. Not live-tested
here (no OpenAI key in-session) — but OpenAI DOES emit native `tool_calls`, so it
is the backend that will live-verify the b3 tool path. Ollama (local/LAN) is the
already-live-verified translating provider (§74/§75).

**Gemini — verified against https://ai.google.dev/api/generate-content (fetched
2026-07-23). It is a full SECOND translator, materially larger than one b-slice,
and needs a proxy-seam extension:**
- **Endpoint/auth differ from OpenAI:** `POST
  https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
  (streaming: `:streamGenerateContent?alt=sse`). Auth is an **API key as a query
  param** (`?key=…`), not a header — so the current `mapUpstreamHeaders` seam
  cannot carry it, and the path embeds the model + method + `alt=sse`. The
  `UpstreamTranslator` (today a fixed `path` + header auth) needs extending to a
  **dynamic path (per stream/model) + query-param auth**.
- **Request schema:** `contents[{role:"user"|"model", parts:[{text}|{functionCall}|
  {functionResponse}]}]`; `systemInstruction` (text only); `generationConfig`
  {`maxOutputTokens`,`temperature`,`topP`,`stopSequences`}; `tools[{function_declarations:
  [{name,description,parameters}]}]`; `toolConfig.function_calling_config.mode`
  (`auto`/`ANY`). Note `role:"model"` (not `assistant`) and `functionResponse`
  (not a separate tool role).
- **Response:** `candidates[{content.parts:[{text}|{functionCall{name,args}}],
  finishReason}]`; `usageMetadata{promptTokenCount, candidatesTokenCount}`.
- **Streaming:** SSE (`alt=sse`), each event a full `GenerateContentResponse`
  chunk — so the Anthropic-event state machine (b2/b3) applies, but reading
  Gemini's `candidates[].content.parts` deltas, not OpenAI deltas.
- **Not live-verifiable here** (no Gemini key). Scoped as slice **b4-gemini** —
  its own translator + the seam extension above; recommend a checkpoint before
  building (size + seam change + no live test).
- **UPDATE — b4-gemini BUILT 2026-07-23 (user go-ahead).** Shipped
  `src/providers/gemini-translate.ts` (+ `gemini-stream.ts`): request
  (`contents`/`role:model`/`parts`, `systemInstruction`, `generationConfig`,
  `tools[{functionDeclarations}]`, `toolConfig.functionCallingConfig`;
  `tool_use`→`functionCall`, `tool_result`→`functionResponse` with the name
  recovered from the request's tool_use blocks), non-streaming + streaming
  response (`candidates[].content.parts` → text / `tool_use`), `geminiPath`
  (model+method+`alt=sse`+`?key=`). Seam extended: `UpstreamTranslator.
  translateRequest` may return a per-request `path` (Gemini overrides it;
  OpenAI leaves it). Provider `gemini` wired (query-param key via
  `GOLEM_UPSTREAM_API_KEY`, non-caching, no header auth). **Unit- + proxy-
  integration-verified** (the per-request path override incl. `?key=` and
  Gemini↔Anthropic round-trip through the real proxy); **NOT live-tested** —
  no Gemini key in-session (a user-side end-to-end check remains). Base URL:
  `https://generativelanguage.googleapis.com/v1beta`.

## §78 — R6.2 v1 account switching, live-verified (2026-07-23, ADR-0003 accepted)

ADR-0003 accepted with the USER's ToS scope decision: **legitimate
account/provider switching only** (automated quota-evasion OUT). Built R6.2 v1:

- **Config:** `proxy.accounts` (non-secret registry: id, provider, base_url,
  model?, auth_scheme?) + `proxy.active_account` selector. Secrets are **never a
  setting** — an account's credential is env `GOLEM_UPSTREAM_API_KEY__<ID>`
  (uppercased/sanitized), the legacy single account keeps `GOLEM_UPSTREAM_API_KEY`.
- **Resolver** (`resolveActiveUpstream`, pure): active unset → legacy top-level
  config; active found → that account (provider/base/model/auth + its env key);
  active set-but-unknown → **legacy + a loud warning, never a silent switch to a
  different registry account** (ADR-0003 fail-closed). A missing per-account key
  is surfaced (the request 401s / warns), never swapped for another key.
- **CLI:** `golem account list` (shows registry, active marker, and whether each
  key env var is SET — never the value) and `golem account use <id>|none`
  (fail-closed: rejects an unknown id; appends a switch entry to
  `.golem/state/account-log.jsonl` — the ADR audit log). No MCP/tool surface
  reads or sets accounts (config/CLI only).
- **Proxy wiring:** `buildProxyFromSettings` resolves the active account up front
  and feeds its provider/base/model/auth/key into the existing R6.1 auth-mapping
  + translation seams — one active account per proxy run (no per-request routing;
  21e stays future).
- **LIVE-verified:** built a proxy from settings with `active_account:"local"`
  (an Ollama account) and hit it — HTTP 200, served by `qwen2.5-coder:7b`. So the
  full path (registry → resolver → provider selection → translation → upstream)
  works end-to-end, not just in unit tests.
- **Explicitly NOT built (ToS):** automated rotation to evade rate limits;
  route-on-exhaustion. A 429 from the active account surfaces to the client as
  today — no hidden retry on another account.
- **Follow-on (same day): status surfaces now reflect the active upstream.**
  `collectGolemState` (statusline/status/session-report) resolved only
  `proxy.upstream_base_url` — so with an active account it showed the *legacy*
  upstream, and the URL-derived label was cryptic for the new providers
  (`localhost:11434`). Now it runs `resolveActiveUpstream` (env-less; the label
  needs no key) and labels via `providerUpstreamLabel`: the **account id** when
  one is active, else the provider name for `openai`/`ollama`/`gemini`, else the
  URL label (anthropic/foundry/openrouter/host). So `⬢ Golem →local` /
  `→ollama` / `→gemini` honestly shows what the proxy fronts (the Decision-30
  "always-on upstream status" extended to the R6 multi-provider reality).

## §79 — Kimi K3 upstream + reasoning/vision translator enhancements (2026-07-24)

Investigated integrating **Kimi K3** (Moonshot AI) as an upstream, verified
against https://platform.kimi.ai/docs/guide/kimi-k3-quickstart (fetched
2026-07-24, served from Golem's raw-fetch cache) + a corroborating web search.

- **Kimi K3 is OpenAI-Chat-Completions compatible** → it already works via
  Golem's `openai` translating provider, **no new provider code**. Base URL
  `https://api.moonshot.ai/v1`, model id `kimi-k3`, auth
  `Authorization: Bearer $MOONSHOT_API_KEY` (bearer — Golem's `openai` default);
  streaming SSE + OpenAI tool-call schema. Config: `upstream_provider=openai`,
  `upstream_base_url=https://api.moonshot.ai/v1`, `upstream_model=kimi-k3`,
  `GOLEM_UPSTREAM_API_KEY=<key>` (or an account). **$1 min top-up** before a key
  works. Not live-tested here (no Moonshot key).
- **K3 is a reasoning + vision model**, so three translator gaps were closed so
  it (and any reasoning/vision OpenAI-schema backend) is first-class:
  1. **`reasoning_content` ↔ Anthropic `thinking`.** Non-streaming: a leading
     `{type:"thinking",thinking}` block; streaming: a `thinking` content block
     (`thinking_delta`) before the text block, sequential-block-safe. **No
     `signature` is emitted** — the block is synthesized from a non-Anthropic
     model (display-only); our request-side translator drops `thinking` blocks,
     so it never needs replaying upstream. Gated by `proxy.map_reasoning_to_thinking`
     (default on) in case a client mishandles unrequested thinking blocks.
  2. **`reasoning_effort` passthrough** — `proxy.upstream_reasoning_effort`
     (`low`/`high`/`max`) → OpenAI top-level `reasoning_effort`; omitted when
     unset (some non-reasoning backends reject it). K3's server default is `max`
     (priciest — reasoning billed as output at \$15/M).
  3. **Vision passthrough** — Anthropic `image` blocks → OpenAI `image_url`
     parts (base64 → `data:` URI, `url` → url). Anthropic Files-API `file`
     sources have no OpenAI equivalent and are dropped. Message content becomes
     an array only when images are present (text-only stays a string).
- **Verification:** unit + regression only — my local Ollama model
  (`qwen2.5-coder:7b`) is neither a reasoning nor a vision model, so the new
  paths can't be live-exercised here; the existing Ollama text/stream path was
  re-smoked and is unaffected (no `reasoning_content` → no spurious thinking
  block). A live check needs a reasoning/vision backend (Kimi K3 with a key).
- **Multi-turn caveat:** the K3 doc says feed the full assistant message
  (incl. reasoning) back each turn; Golem rebuilds each request from Anthropic
  history and drops `thinking` on the way out, so the trace is not preserved
  across turns (K3 recomputes). Acceptable; noted.

## §80 — Translator bug: mid-conversation `system` messages rejected (fixed 2026-07-24)

**Found in the field** (first real Kimi K3 traffic): switching to Kimi failed
with `Invalid enum value. Expected 'user' | 'assistant', received 'system'` at
`messages[991].role`, `[1002].role`, … — Golem's OWN request zod (not Kimi's).
Root cause: `anthropicMessage.role` in `openai-translate.ts` (and
`gemini-translate.ts`) was `z.enum(["user","assistant"])`, but **Anthropic
supports mid-conversation `system` messages** (a `role:"system"` entry inside the
`messages` array, distinct from the top-level `system` field — see the "Context
management → Mid-conversation system messages" doc) and **Claude Code emits
them** in long sessions. The byte-faithful Anthropic path never parses messages
so it was unaffected; only the translating path (openai/ollama/gemini) hit it,
which is why it only surfaced when a user first switched to a translated
provider.

**Fix:** accept `role:"system"` in both translators' message schema.
- OpenAI/Ollama: a `system` message → an OpenAI `{role:"system", content}` (text
  extracted); OpenAI-schema accepts multiple system messages anywhere.
- Gemini: `contents` has no system role, so it folds into a `user` turn (the
  existing non-assistant→`user` mapping), preserving position.
+2 regression tests. **Lesson:** the translating path must accept every role/
  block Claude Code can emit, even ones the *old* Anthropic API didn't — the
  passthrough hid this class of gap. Worth an audit of other Anthropic features
  (e.g. `document`/PDF blocks, `redacted_thinking`) the translator silently
  drops or would reject.

## §81 — Kimi K3 LIVE-verified + gzip-decompression fix (2026-07-24)

First real Kimi K3 traffic through the user's account (Moonshot key, topped up;
`golem account use kimi`). Two field findings:

1. **gzip:** the non-streaming translate path 502'd with "could not translate
   the upstream response (Unexpected token \x1f…)" — Moonshot gzips responses,
   and undici does **not** auto-decompress, so `translateResponse` received
   gzipped bytes instead of JSON. **Fix** (`server.ts`): decompress
   `content-encoding: gzip` before parsing in the translating branch. The
   Anthropic passthrough relays bytes verbatim so it was unaffected; the
   streaming translate path parsed the streamed SSE fine (not gzipped).
2. **LIVE VERIFIED (closes the §79 live gap):** with the fix, both paths work
   against real Kimi K3 —
   - **non-streaming:** HTTP 200, `model:"kimi-k3"`, content `[{type:"thinking",
     thinking:"…one word as requested."},{type:"text",text:"PONG"}]`,
     `stop_reason:"end_turn"`, `usage:{input:93,output:57}` — the
     **`reasoning_content` → Anthropic `thinking` block mapping works against
     the real model** (the response honestly reports `kimi-k3`, not a Claude
     name).
   - **streaming:** HTTP 200 `text/event-stream`, correct Anthropic sequence —
     `message_start` → thinking block (streaming `thinking_delta` run) → text
     block (`PONG`) → `content_block_stop` → `message_delta` → `message_stop`.
   So account resolution → bearer auth → request translation → Moonshot → gzip
   decode → response translation (thinking + text) all verified end-to-end.
   Claude Code (which streams) is the working path.

## §82 — OS credential store per platform: what is actually readable (2026-07-26)

The verification ADR-0003 invariant 2 required before any OS-keychain backend
("a light, cross-platform mechanism … confirmed"). Prompted by a real failure:
switching to a Kimi account left the proxy reporting "key missing" in every new
terminal, because the per-account env var only ever lived in one shell. Findings
are **per-platform**; all commands tested live on this machine (Windows 11,
pwsh 7.6.3, Node 24) unless noted.

- **Windows Credential Manager (`cmdkey`) is WRITE-ONLY from a CLI.**
  `cmdkey /generic:T /user:U /pass:P` stores, but `cmdkey /list:T` returns only
  Target + User — **never the password**. Verified. So Credential Manager cannot
  be used as a read-back store without the WinRT/COM API.
- **WinRT `PasswordVault` does not load in PowerShell 7.**
  `[Windows.Security.Credentials.PasswordVault,…]` → "Unable to find type".
  Verified. So that API route is also out for a script-only mechanism.
- **DPAPI *does* round-trip** via `ConvertTo-SecureString … | ConvertFrom-SecureString`
  (encrypt) and `ConvertTo-SecureString $blob` → `SecureStringToBSTR` →
  `PtrToStringAuto` (decrypt), with the secret passed on **stdin** (never argv).
  The blob is CurrentUser-scoped (bound to the user + machine), hex, ~524 chars
  for a 24-char secret. **But the PowerShell host matters and is
  machine-dependent:**
  - Spawned from **Node** (`child_process.spawn`), the inbox
    **`powershell.exe` (Windows PowerShell 5.1, both 64- and 32-bit) could NOT
    load `ConvertTo-SecureString`** on this machine: `CommandNotFoundException …
    the module could not be loaded`; an explicit
    `Import-Module Microsoft.PowerShell.Security` then failed on TypeData
    duplication (`The member AuditToString is already present`). This is a local
    module-autoload breakage, not a DPAPI limitation.
  - **`pwsh.exe` (PowerShell 7) round-trips correctly from the same Node spawn**
    (blob_len=524). It is an optional install, not inbox.
  - **Consequence:** DPAPI is reachable from Node **only through a PowerShell
    host, and which host works varies by machine.** The backend therefore
    DETECTS a working host at runtime (a real encrypt→decrypt self-test,
    preferring `pwsh` then `powershell.exe`) instead of assuming
    `powershell.exe` is safe, and throws a *remediable* error (install PS7 /
    export the env var / opt into `--store file`) when none works — never a raw
    PowerShell diagnostic, never silent plaintext.
  - **No direct-API route without a native dep:** Node Krypton
    (`process.binding('crypto')`) is blocked ("No such module"); `keytar@7.9.0`
    is a native module, barred from the default install by CLAUDE.md. A
    keytar-style opt-in **extra** remains a possible later enhancement for users
    who want the real Credential Manager.
- **macOS:** `security find-generic-password -s <svc> -a <acct> -w` prints the
  secret to stdout (exit 44 = not found); `add-generic-password -U -w` reads the
  password from stdin when `-w` has no value. ACL prompts are possible for a
  process that is not the item's creator — fine for the interactive CLI, a
  liability for a detached daemon (see below). (Command shapes from the
  `security(1)` man page; not executed here — no macOS device.)
- **Linux:** `secret-tool lookup service golem account <id>` (prints the secret,
  no trailing newline; not-found = exit 1 with empty stderr);
  `secret-tool store --label=… service golem account <id>` reads the secret from
  stdin. Requires libsecret-tools **and** a live Secret Service on D-Bus — both
  commonly absent in headless/SSH/WSL. (From `secret-tool(1)`; not executed here.)
- **The daemon must not touch the store.** Every OS mechanism above is weakest
  for exactly the process that needs the key: a detached, session-less daemon
  (macOS ACL prompts, Linux D-Bus absence, Windows host flakiness). So the
  **interactive CLI owns the credential**: it resolves (env → OS store) and
  injects the secret into the daemon's environment at spawn. The daemon keeps
  reading `process.env` and never touches a keychain. This also removes the
  original bug class: the daemon is spawned from a minimal allowlist env
  (`buildSpawnEnv`) rather than inheriting whichever shell happened to launch
  it, so a key set in one terminal — or stored via `golem account login` —
  reaches the proxy deterministically.

Decision 46 (CLI-managed credential chain) is built on exactly these findings.

## §83 — Settings layers REPLACE arrays; account state must write to the local scope (2026-07-26)

Found while adding `golem account add`. The config loader
(`applyObjectLayer` in src/config/loader.ts) merges layers per leaf with
`section[key] = parsed.data` — so a `proxy.accounts` **array** in any
higher-precedence layer **wholesale-replaces** (does not merge with) the array
from a lower layer. Consequence: this repo carries `proxy.accounts` in
`.golem/settings.local.json` (top file layer), so an `account add` / `account
use` that wrote to the committable `.golem/settings.json` was **silently
invisible** to the merged config the proxy actually reads (the new account
appeared in the file but not in `account list` / `account use`). **Rule:**
account state (`proxy.accounts`, `proxy.active_account`) is machine-specific and
must be written to the **local** scope — both so it wins the merge and so it
stays out of the committable project settings file. Verified: `account add` →
`list` shows it immediately, `use` then fails closed on the missing credential,
`remove` deletes it; a unit test asserts the local-scope write.

## §84 — OpenRouter free models were unreachable: case (a) misclassification (2026-07-29, corrects §73)

Found by dogfooding, live-verified against `openrouter.ai` and a local echo
upstream. An account added exactly as the docs suggest —
`golem account add openrouter-laguna --provider openrouter --base-url
https://openrouter.ai/api/v1 --model poolside/laguna-s-2.1:free --auth-scheme
bearer`, key stored with `golem account login` — could not serve **one** request.
Four independent defects stacked, each of which hid the next. Fixed under
Decision 48.

**1. `openrouter` was case (a) (byte-faithful), so the configured model never
reached the wire.** Byte-faithful means the body is never parsed or rewritten, so
Claude Code's own `claude-opus-5[1m]` was forwarded and `model=poolside/...` was
inert. OpenRouter's Anthropic-Messages endpoint serves only *Claude* models, so
every non-Claude model — the whole free tier — was unreachable by construction.
§73 already concluded "reaching non-Claude models / the normalized surface is
OpenAI-schema = **case (b)**"; the R6.1 implementation classified it as (a)
anyway, on the strength of §73's *other* observation that an Anthropic endpoint
also exists. **§73's "case (a)" recommendation for OpenRouter is superseded** —
the Anthropic endpoint is real but only useful for Claude models, so it is now
reached deliberately via `--provider custom --base-url https://openrouter.ai/api`.

**2. Path composition doubled the version segment.** The proxy appends the
client's request target to the base URL's path prefix
(`GolemProxy.basePath + forward.url`), so `https://openrouter.ai/api/v1` +
`/v1/messages` = `/api/v1/v1/messages`. Probed live:

| URL | Status |
| --- | --- |
| `POST https://openrouter.ai/api/v1/v1/messages` | **404** (HTML error page, not JSON) |
| `POST https://openrouter.ai/api/v1/messages` | 401 (endpoint exists — Anthropic-native) |
| `POST https://openrouter.ai/api/v1/chat/completions` | 401 (endpoint exists — OpenAI-schema) |

**3. `golem account login` reported success anyway.** The Decision 46 probe GETs
a model-list URL composed by its *own* rule (`/\/v\d+$/` → append `/models`), so
it hit the real `https://openrouter.ai/api/v1/models` and returned `accepted`.
The key was always valid; the probe simply does not test the route traffic uses.
**Rule:** a pre-flight probe must report the request URL it is NOT testing.

**4. `stripVendorPrefix` mangled the model id — the subtle one.** Even with
provider `openai` (the working workaround), the translating boundary stripped the
vendor segment, so a configured `poolside/laguna-s-2.1:free` went upstream as
`laguna-s-2.1:free`. Captured on the wire against a local echo server:
`{"path":"/api/v1/chat/completions","model":"laguna-s-2.1:free"}`. The helper was
added for single-vendor upstreams (`moonshotai/kimi-k3` → `kimi-k3`, §79), but
OpenRouter is multi-vendor and `vendor/model` IS its canonical id — the segment
disambiguates models several vendors publish under one name. OpenRouter happened
to resolve the bare slug in testing, which is precisely why this would have
surfaced later as a wrong-model-served bug rather than an error.

**Also found:** the proxy startup banner printed
`settings.proxy.upstream_base_url`, so two test proxies genuinely serving
OpenRouter both announced `-> https://api.anthropic.com`. Any account switch
looked inert from the banner alone.

**Live verification after the fix** (throwaway proxies on spare ports, pinned via
`GOLEM_PROXY_ACTIVE_ACCOUNT` so the session's own routing was untouched):

- `openai/gpt-oss-20b:free` — 200 non-streaming; SSE streaming emits proper
  `message_start` / `content_block_delta` / `message_stop`.
- `poolside/laguna-s-2.1:free` — 200 non-streaming and streaming, text deltas
  confirmed, model echoed with its vendor prefix intact.

**Two operational caveats (not Golem defects).** (i) OpenRouter's free pool
429s intermittently: 1 in 4 calls returned
`limit_source: upstream_provider_shared_pool`. (ii) `poolside/laguna-s-2.1:free`
is a reasoning model — at `max_tokens: 200` it spent the entire budget on
reasoning and emitted **zero** content blocks (`stop_reason: max_tokens`,
`output_tokens: 200`). Give it generous `max_tokens`. Note `map_reasoning_to_thinking`
is on yet no thinking deltas arrived, suggesting OpenRouter needs an explicit
`reasoning: {...}` request field to stream the trace — **UNVERIFIED, open
question** (Golem currently sends only `reasoning_effort`).

---

## §85 — ink 7 / React 19 for the `golem ui` panel (2026-07-30)

Checked against the npm registry on **2026-07-30**, before adding them
(Decision 50 chose ink over a hand-rolled TUI).

| Package | Version | Notes |
|---|---|---|
| `ink` | **7.1.1** | `engines.node >= 22` — matches this repo's floor. |
| `react` | **19.2.8** | ink 7 peers `react >= 19.2.0`. |
| `@types/react` | 19.x | Listed as an **optional** peer (`peerDependenciesMeta`). |
| `react-devtools-core` | — | Also an **optional** peer; deliberately not installed. |
| `ink-testing-library` | 4.0.0 | Last published 2024-05-22 against `ink ^5`. |

**All pure JS — no native or GPU components**, so CLAUDE.md's
"no heavyweight native deps in the default install" rule is not engaged. It is
still a real install-weight change: `npm install ink react` added **38 packages**,
taking `golem-run` from 6 runtime dependencies to ~34 transitively.
`yoga-layout` (ink's flexbox engine) is WASM-backed but ships no native build.

`npm audit` afterwards reported the same 3 pre-existing production advisories
(`@hono/node-server` via `@modelcontextprotocol/sdk`, `fast-uri`) — **none
introduced by ink or React**.

### `ink-testing-library@4` DOES work with ink 7 — VERIFIED

Its published `devDependencies` pin `ink ^5` / `react ^18`, so this was flagged as
a risk before starting. It was tested directly: `tests/integration/tui-render.test.tsx`
mounts the real `<App>` and asserts on `lastFrame()`, and passes on ink 7.1.1 +
React 19.2.8. No fallback to a hand-rolled fake-stdout harness was needed.

### TSX under this repo's toolchain

- `tsc` honours `tsconfig.json`'s `"jsx": "react-jsx"` and emits
  `import { jsx as _jsx } from "react/jsx-runtime"` — verified in `dist/tui/app.js`.
- `vitest` (esbuild) picks the same setting up from tsconfig; `*.test.tsx` had to
  be added to `vitest.config.ts`'s `include`.
- **`tsx` (the CLI runner) does NOT read tsconfig's `jsx` setting** and fails with
  `ReferenceError: React is not defined`; an inline
  `/** @jsxImportSource react */` pragma did not fix it either. Run ad-hoc panel
  scripts against `dist/` instead of through `tsx`.
- Under `exactOptionalPropertyTypes`, ink's `<Text color>` **rejects an explicit
  `undefined`**. Two consequences: the `ui.color: "never"` policy is applied by
  setting `FORCE_COLOR=0` before ink is imported (chalk decides its level at
  import time) so every theme field stays a real string; and genuinely-optional
  colours are spread in via a `col()` helper rather than passed as `undefined`.
- Enabling `jsx` in tsconfig makes **Biome apply React rules repo-wide**, so
  pre-existing `useAccount(...)` calls in plain `.ts` tripped
  `lint/correctness/useHookAtTopLevel`. Scoped that rule off for `**/*.ts` in
  `biome.json` `overrides`, leaving it active for the real React files in
  `src/tui/**`. (Biome's config is strict JSON — a `"//"` comment key is a hard
  config error, so the rationale lives in the commit and
  `docs/wiki/concepts/Configuration Surfaces.md`, not the file.)

### OPEN QUESTION — does `bun build --compile` bundle yoga-layout's WASM?

**UNVERIFIED.** The standalone-binary tier (Decision 41d,
`scripts/build-binary.mjs`) bundles with Bun, and Bun is not installed on this dev
box, so `golem ui` inside a compiled binary is untested. If Bun does not embed
`yoga-layout`'s WASM asset, the panel will fail at runtime **in binary builds
only** — the npm install path is verified working. Test this in the CI release
workflow before advertising `golem ui` for the no-Node install tier, and if it
fails, have `runTui` detect it and print "use the npm install for the panel"
rather than crashing.

### U+25A0 in the pet is Ambiguous-width

The pet's first glyph (`■`, U+25A0 BLACK SQUARE) is East Asian Width
**Ambiguous** — single-width in most terminals, double-width in a CJK-configured
one. The other seven glyphs are Block Elements (U+2580–U+259F), unambiguously
narrow. `string-width` (which ink measures with) treats Ambiguous as 1. Mitigated
rather than solved: the pet renders inside a fixed-width `<Box>`, so a double-wide
draw can shift that one glyph but cannot push the header text out of alignment.
`ui.pet false` / `golem ui --no-pet` is the escape hatch — and the same switch
covers legacy Windows consoles (codepage 437/850) that cannot draw block elements
at all.

---

## §86 — `golem` startup latency: measured, and what actually fixed it (2026-07-30)

The `golem ui` panel took "a number of seconds" to appear (user report). Measured
before guessing. Method: one **fresh node process per measurement**, best of 3–4,
on this Windows dev box (node v24.13.1). Fresh processes matter — measuring several
imports in one process makes whichever loads first pay for the shared
sub-dependencies, which inflated an earlier reading of `src/config` from ~130ms to
~620ms and would have sent the fix in the wrong direction.

**node baseline (`node -e ""`): ~55–85ms.** Subtract that from everything below.

### The three findings

**1. A regression I had just introduced.** Exporting `./control-surface.js` from
`src/config/index.ts` took that barrel from **~130ms → ~530ms**, because the
control surface reaches into `src/cli` (status → init → the hooks barrel, proxy,
update) and `src/hooks`. `src/hooks/pre-tool-use.ts` imports that barrel, and
Claude Code runs `golem hook pre-tool-use` on **every tool call**. Fixed by not
re-exporting it; consumers import `../config/control-surface.js` directly.
Guarded by `tests/unit/tui-lazy-import.test.ts`.

**2. The CLI's module graph was paid before anything could happen.**
`dist/cli/program.js` (commander plus every command's imports) is **~790ms**, and
ESM hoists imports — so a bare `golem` paid it, then paid ink on top, with nothing
on screen. `src/cli/main.ts` is now a **dependency-free shim** that reads argv and
dynamically imports exactly one of `../tui/index.js` or `./program.js`. `bin` still
points at `dist/cli/main.js`, so installed shims and `detectInstallMethod`'s
argv[1] matching are unaffected.

**3. What the panel's first paint actually needed.** Measured members of the old
critical path:

| Module | Cold import |
|---|---|
| `ink` (+react-reconciler, yoga, chalk, …) | **~940ms** |
| `cli/init.js` (via `cli/status.js`) | ~529ms |
| `cli/statusline.js` | ~473ms |
| `hooks/index.js` (barrel) | ~446ms |
| `cli/slider.js` (imports init.js for the WRITE path) | ~426ms |
| `cli/status.js` | ~414ms |
| `proxy/index.js` | ~315ms |
| `hooks/guidance.js` (direct, not the barrel) | ~117ms |
| `cli/proxy-daemon.js` | ~75ms |

Three of those were on the path only to *display* something:
- `cli/status.js` → now imported **lazily** by `collectHeader`, and
  `ControlSurface.header` is nullable. The panel paints its controls first and the
  header slots in after mount.
- `cli/slider.js` → the read half moved to **`cli/slider-read.ts`** (config lookup
  only, ~130ms); `slider.ts` re-exports it, so no caller changed. `setSliderLevel`
  is imported lazily at the point of writing.
- `hooks/index.js` → replaced with a direct `hooks/guidance.js` import.

### Result

| Moment | Before | After |
|---|---|---|
| **Anything on screen** | nothing until the panel | **~80ms** (ANSI pre-paint of the pet) |
| Panel interactive | ~2.5–3s | **~1.15s** |
| Header values filled in | (same as panel) | ~1.45s |

The pre-paint writes the pet + version + cwd with raw SGR before ink exists — all
free data — then erases those lines with `ESC[nA ESC[0J` before ink renders.

### Two things that did NOT work

- **`module.enableCompileCache()`** (node 22+ on-disk V8 bytecode cache): measured
  **worse** — ink went 948ms → 1022ms warm, and 2516ms on the cache-writing run.
  Not adopted.
- **Concurrent dynamic imports**: loading ink + the panel + the config surface with
  `Promise.all` instead of sequentially saved only **~70ms of ~1800ms**. Module
  evaluation is single-threaded CPU work, so it does not overlap. Kept (it is free
  and it does help the I/O-bound reads) but it is not the lever — *not loading* is.

### ink is now the floor, and it is not one fat dependency

ink is **~890ms over baseline** — roughly 75% of what remains before first paint.
Its cost is spread across its dependency tree, not concentrated:
`es-toolkit` ~194ms, `cli-truncate` ~78ms, `react-reconciler` ~77ms, `ws` ~72ms,
`wrap-ansi` ~65ms, `string-width` ~64ms, `yoga-layout` ~57ms, `scheduler` ~31ms,
`chalk` ~23ms, and a dozen more at 5–20ms each. There is no single import to
defer or patch around. **Getting first paint materially below ~1s means replacing
ink with a hand-rolled renderer** (the option weighed and declined in Decision 50);
nothing else in the panel's path is big enough to matter now.

### Still slow, NOT addressed here (measured, for a later pass)

Both go through `program.js`, so they still pay its ~725ms:

- `golem hook pre-tool-use` — **~765ms**, on every Claude Code tool call.
- `golem statusline` — **~835ms**, on every prompt.

Making `../mcp/index.js` lazy in `program.ts` (it is ~700ms in isolation, but
mostly shared deps) moved statusline 985ms → 835ms and `--version` 787ms → 725ms.
The rest is the same "thousand cuts" spread. The shim in `main.ts` makes the real
fix straightforward whenever it is worth doing: route `hook` and `statusline` to
their own lightweight entries instead of through commander.

### §86b — the hot paths, fixed (2026-07-30, USER-requested follow-up)

The two paths §86 measured and deferred were fixed after all, plus a leaf
dependency finding that turned out to matter more than the routing.

**`undici` is the heaviest leaf in the CLI: ~270ms** (~215ms over baseline). It
arrives through `src/proxy/index.js` (server.ts) and `src/inference/index.js`
(ollama-client.ts). Several hot-path callers were importing those **barrels** for
functions that only read a JSON file, and paying for an HTTP stack they never used:

| Module | Before | After | Change |
|---|---|---|---|
| `hooks/pre-tool-use.js` | 352ms | **127ms** | `readLimitState` from `proxy/limit-prediction.js`, not the barrel |
| `cli/statusline.js` | 473ms | **142ms** | `servedModelFor` from `proxy/served-model.js`; `readSessionState` from `hooks/session-state.js`; `SLIDER_LEVEL_NAMES` from `cli/slider-read.js`; `VERSION` from `version.js` |
| `cli/local-model.js` | 388ms | **68ms** | `../inference/index.js` made lazy — only `resolveCoderModel` needs it, while the cache *readers* sit on the statusline path |
| `config/control-surface.js` | 431ms | **140ms** | (from §86: lazy status, slider-read, direct guidance) |

Lesson worth generalising: **a barrel import is a hot-path liability.** Prefer the
narrowest module, and check what its transitive graph drags in before putting it on
a path that runs per-tool-call or per-prompt.

**New `src/cli/fast-path.ts`** handles the four hook events whose handlers take no
CLI-injected dependencies (`pre-tool-use`, `post-tool-use`, `prompt-submit`,
`notification`) plus `statusline`, without loading commander at all. `main.ts`
routes to it; `fastPathFor` returns null for `--help`, unknown events, and any
unexpected flag, so commander stays authoritative for output and errors.
`web-fetch-pre`/`web-fetch-post` (which need `buildKnowledge`/`fetchRaw`/
`revalidate`) and `session-start` (which drives the proxy daemon) deliberately stay
on the commander path.

**Equivalence was verified, not assumed.** Nine payloads — including an empty one,
and `post-tool-use --max-inline-chars 4` forcing a real CCR-ref swap (whose output
embeds a content hash) — were run through both the fast path and `runCli` directly,
diffing stdout and exit code. All nine byte-identical. `tests/unit/cli-fast-path.test.ts`
guards the routing and asserts `program.ts` never starts injecting a
`PostToolUseOptions` field (`redact` / `maxInlineChars` / `projectDir`), which is the
one assumption that makes `post-tool-use` safe to fast-path.

### Final numbers (best of 5, this box)

| Command | Before | After |
|---|---|---|
| `golem hook post-tool-use` (every tool call) | ~765ms | **129ms** — 5.9× |
| `golem hook pre-tool-use` (every tool call) | ~765ms | **137ms** — 5.6× |
| `golem statusline` (every prompt) | ~985ms | **301ms** — 3.3× |
| `golem` panel — pet on screen | (nothing) | **~85ms** |
| `golem` panel — interactive | ~2.5–3s | **~1.15s** |
| `golem --version` (commander path, unchanged by design) | ~810ms | ~811ms |

The commander path is untouched on purpose: it serves user-typed commands where
~800ms is not the bottleneck, and leaving it alone keeps `--help`, error messages,
and flag parsing in exactly one place.

### §86c — ink removed; the panel now paints in ~170ms (2026-07-30)

§86 concluded that ink was the floor and that going below ~1s meant replacing it.
Measured, decided, done.

**The case, in one line:** everything the panel needs *except* ink cost **150ms**
(including node boot); with ink it was **1091ms**. ink alone was **892ms** — ~85% of
the panel's load — and it was spread across its dependency tree
(`es-toolkit` ~194ms, `cli-truncate` ~78ms, `react-reconciler` ~77ms, `ws` ~72ms,
`wrap-ansi` ~65ms, `string-width` ~64ms, `yoga-layout` ~57ms, and a dozen at 5–20ms),
so there was nothing to defer or patch around.

### What ink was actually providing, and what replaced it

Inventoried from real usage, not from ink's feature list: **8 layout props**
(`flexDirection`, `marginTop`, `marginRight`, `paddingX`, `width`, `flexGrow`,
`flexShrink`, `justifyContent`), **3 text props** (`color`, `wrap`, `bold`), and
**3 hooks** (`useInput`, `useStdout`, `useApp`). The layouts were a vertical stack,
one two-column row, and one space-between row.

| ink provided | replaced by | lines |
|---|---|---|
| flexbox layout (yoga) | `src/tui/render.ts` — computes the 3 layouts directly | ~230 |
| diffed repaint, cursor, resize | `src/tui/screen.ts` — rewrites only changed lines | ~100 |
| `useInput` key decoding | `src/tui/keys.ts` — raw-mode decoder → the same `KeyPress` | ~175 |
| chalk colour degradation | `src/tui/ansi.ts` — hex → 24-bit/256/16/none | ~150 |
| `string-width` / `cli-truncate` | `src/tui/width.ts` — ANSI- and wide-char-aware | ~110 |
| React state→view | the reducer in `state.ts`, which already existed | 0 |

**Functionality is unchanged.** Same layout, same keys, same colours, same pet. The
frame was diffed against the ink version's output and matches. Two things are now
*ours* to get right rather than a dependency's — colour capability detection and
display-width arithmetic — so both are directly tested (17 assertions in
`tests/unit/tui-render.test.ts`), including the terminal matrix
(`NO_COLOR`/`FORCE_COLOR`/`COLORTERM`/`TERM`/`WT_SESSION`) and CJK/emoji widths.

**The reducer split paid for itself exactly as intended:** `tests/unit/tui-state.test.ts`
(32 tests covering every interaction rule) passed **unchanged** through the whole
rewrite, because `KeyPress` was always an ink-agnostic shape. Only the view files
changed. The new view is *easier* to test than before — `renderPanel` is
`state → string[]`, so no mount and no `ink-testing-library`.

**One more find along the way:** `src/tui/header.ts` imported `renderUpstream` from
`cli/status.js` — a string formatter behind a ~430ms module graph, sitting on the
render path. Both display helpers moved to the dependency-free
`src/cli/upstream-display.ts` (status.ts and statusline.ts re-export them), taking
`tui/header.js` from 260ms → **83ms**.

### Final numbers (best of 5–6, this box)

| | before this whole effort | now |
|---|---|---|
| `golem` panel — first frame, real data | ~2.5–3s (blank until then) | **~170ms** |
| `golem hook post-tool-use` (every tool call) | ~765ms | **126ms** |
| `golem hook pre-tool-use` (every tool call) | ~765ms | **135ms** |
| `golem statusline` (every prompt) | ~985ms | **275ms** |
| runtime dependencies | 6 → 34 (with ink) | **back to 6** |

The ANSI pre-paint splash from §86 was **removed**: at ~170ms to a fully-populated
frame there is nothing to cover, and a placeholder that flashes is worse than none.

**node boot (~52ms) is the remaining floor** for the hooks — Claude Code spawns a
process per call, so that cannot be avoided from inside Golem.

### The proxy was never the problem — measured

Worth stating plainly, because it was a stated worry. Against a canned local
Anthropic-shaped upstream (so the number is Golem, not the network), 40 requests with
a 9.7 KiB body, p50:

| | p50 | added |
|---|---|---|
| direct to upstream | 1.0ms | — |
| via Golem, slider 1 (default) | 5.4ms | **+4.4ms** |
| via Golem, slider 0 (full bypass) | 4.9ms | +3.9ms |

**+4.4ms per request** on the default level, against upstream LLM calls that take
1000s of ms — i.e. well under 1% overhead, and level 0 is barely cheaper, so the
pipeline itself is not where time goes. No proxy work was warranted and none was done.

### Also fixed: a pre-existing test flake this surfaced

Tests failed intermittently — first `cli-init.test.ts` (3 of ~6 full-suite runs), then
`e2e/golem-init-smoke.test.ts` — and on a *different* test each time, which is the
classic shape of something being waved through. Diagnosed rather than retried:
`Error: Test timed out in 5000ms`. Three test files run a real
`golemInit`/`golemUninit` (~20 file writes to a temp dir each), and on Windows under
parallel suite load plus a virus scanner they regularly exceed vitest's 5s default.
(Not the VS Code extension copy — the fake probe doesn't supply
`vscodeExtensionsDir`, so that path never runs.)

Fixed **globally** rather than per file, after a per-file timeout in `cli-init` merely
moved the failure to the next-unluckiest file: `testTimeout: 20_000` in
`vitest.config.ts`, with the reasoning recorded there. This suite is genuinely
I/O-heavy — real inits, spawned proxy daemons, port waits — so 5s was the wrong
default for it, and one mechanism beats sprinkling local overrides. A hung test still
fails, 20s later, which is a fine trade in a ~30s suite. **Three consecutive
full-suite runs green afterwards** (144 files / 1595 tests).

### §86d — one entry point for the panel; `golem status` kept (2026-07-30, USER decisions)

Two surface-area questions, both settled with measurements rather than taste.

**`golem ui` was the slow way in — so it's gone.** With bare `golem` already opening
the panel, the named command was redundant *and* slower: it went through commander
and paid its ~810ms graph, versus ~170ms for the bare command, which skips commander
entirely. Rather than fast-path a second entry point, the user chose to remove
`golem ui` / `golem settings` and move their flags onto the bare command.

`parsePanelArgs` (`src/cli/panel-args.ts`) now accepts `--dir <path>` (also
`--dir=<path>`), `--no-pet`, and `--advanced`, in any order. The reject side is the
part worth pinning, and it is (11 assertions in `tests/unit/cli-panel-args.test.ts`):

| argv | goes to |
|---|---|
| `golem`, `golem --no-pet`, `golem --dir <p> --advanced` | the panel |
| `golem --help` / `-h` / `--version` / `-V` | commander |
| any named command, with or without panel flags | commander |
| **any unrecognised flag** (`--pet`, `--dirr`, `--json`, `-x`) | commander |
| `--dir` with no value, or followed by another flag | commander |

That last-but-one row is the point: a typo must be reported by the code that owns
flag parsing, not silently open a UI. Verified end to end afterwards, including exit
codes: `golem ui` → migration message, exit **2** (not "unknown command"); panel
flags outside a TTY → "needs an interactive terminal", exit **1**; bare `golem |
cat` → help, unchanged; `golem --dirr x` → `error: unknown option '--dirr'`;
`golem bogus` → `error: unknown command 'bogus'`, exit 1; `golem --version` → exit 0.

Two implementation notes:
- `parsePanelArgs` lives in its own module, not in `main.ts`, because **main.ts
  self-executes on import** (it is the `bin` entry) — a test importing it would run
  the CLI against vitest's own argv. main.ts reaches it via `await import()`, which
  costs nothing for a module that only does string handling, and the "no static
  imports in main.ts" guard still holds.
- The panel has no subcommand to hang its options off, so `golem --help` documents it
  in an `addHelpText("after", …)` block. A test parses that block and asserts every
  flag it advertises is one `parsePanelArgs` accepts — otherwise the two would drift
  silently.

**`golem status` was considered for removal and deliberately KEPT.** Checked what
actually depends on it before answering: the VS Code extension polls
`golem status --json` every few seconds (`extension.js`), the `snooze-hold` guidance
rule tells agents to run it, two skills in `src/cli/skills.ts` reference it, and it is
the scriptable/CI path. The panel is the *human* surface; `status --json` is the
*machine* surface, and it costs nothing when not invoked (commander path, on demand
only). Removing it would have meant reworking the extension's polling and editing the
rule plus two skills — trading a working machine surface for a shorter command list.

## §87 — Caveman is output-side and prompt-delivered, not a compression library (2026-07-30)

Checked before designing against it, per the verify-don't-assume rule. Source:
`github.com/JuliusBrussee/caveman` README (repo page + raw `main/README.md`),
fetched 2026-07-30. MIT licence, no telemetry, no backend, Node ≥18 for the
installer. Recorded because a design proposal (`proposals/golem-brevity.md`,
spec Decision 52 PROPOSED) rests on these facts.

**It is not a payload transformer.** Install "drops a skill file into your agent",
and that file "tells agent: drop filler, keep substance, use fragments — but never
touch code, commands, or errors." Privacy section: "the skill is a prompt, the
hooks are local scripts." Nothing intercepts or rewrites the request; the
instruction enters the model's context and the model complies at generation time.

**It saves output tokens only, and it costs input tokens.** The README's own chart
puts **"input tokens saved" at 0%**, and it volunteers that the skill "adds ~1–1.5k
input tokens per turn," so on terse workloads savings "can go net-negative."
Headline claim is "65% fewer output tokens"; stats are "local estimates" computed
by `/caveman-stats` from the local session log. Treat all three numbers as
unverified vendor claims — including "technical accuracy 100%", which is an
assertion about how well a *prompt* is followed, with no enforcement mechanism.

**Levels:** `lite` / `full` (default) / `ultra` / `wenyan` (renders the answer in
classical Chinese). The README says "six levels" but enumerates only these four
plus the normal-agent baseline — two are never named, so the page is
self-inconsistent; do not assume a fifth/sixth exists. Switching is `/caveman
<level>`, sticky until changed or session end. It "compresses the *style*, never
translates" and preserves the input language — `wenyan` is the deliberate exception.

**Auto-on uses a local side channel:** on Claude Code "a hook writes a tiny flag
file each session" so caveman speech starts without typing `/caveman`. Relevant
because it means an installed Caveman can be active *invisibly* — any Golem-side
injection must detect and not double it.

**Two adjacent components are NOT the speech skill** and were initially conflated:

- `/caveman-compress <file>` rewrites a memory file (e.g. `CLAUDE.md`) into
  caveman-speak — genuinely **input**-side, claimed "~46% input tokens every
  session after", "code, URLs, paths byte-preserved". One-off, not per-request.
- **`caveman-shrink`** — "MCP middleware. Wraps any MCP server, compresses its tool
  descriptions." Input-side, per-request, npm package. **Its install and config
  steps are not documented on the README** — the page only links to npm, with no
  wrapper syntax, config schema, or MCP server-block example. Anything beyond "it
  wraps an MCP server and shrinks tool descriptions" would be invention; fetch the
  npm page before implementing against it.

**Consequence for Golem.** Depending on the package is the wrong shape: its
installer targets specific agents' skill directories and hooks, whereas Golem is
the proxy and can inject in-flight for every client with zero deps. The substance
is a prompt, and the licence is MIT, so vendoring the directive text with
attribution is both sufficient and cleaner. See `proposals/golem-brevity.md`.

**Pricing check that motivates the dial** (`claude-api` skill, cached 2026-06-24,
re-read 2026-07-30): Opus 5 is $5/MTok input, $25/MTok output → output is **5×
uncached input**; cache reads are ~0.1× input → output is **~50× cache-read
input**, and output is never cached. So Decision 23's "compression pays ~0% on
cached traffic" is an input-side finding that does **not** transfer to an
output-side dial. That is the whole argument for the proposal, and it is a
hypothesis to measure, not a claim to ship on.

## §88 — The tools block is ~900 tokens of Golem's own descriptions; why the shrinker is not shipped (2026-07-30)

Measured while scoping Workstream B of Decision 52 (in-flight compression of the
`tools` array — the `caveman-shrink` equivalent; BACKLOG row 2026-07-24).

**Census.** Golem's own MCP tool descriptions, as sent on every request that
carries the server's tool list (chars → ≈tokens at 4 chars/token):

| tool | ≈tokens | | tool | ≈tokens |
|---|--:|---|---|--:|
| `level` | 114 | | `wiki_read` | 53 |
| `coder` | 159 | | `stats` | 49 |
| `wiki_upsert` | 141 | | `ingest` | 48 |
| `snooze` | 134 | | `devices` | 42 |
| `expand` | 73 | | `fetch` | 30 |
| `search` | 64 | | **total** | **~902** |

So the headroom is real — ~900 tokens before any *other* MCP server or Claude
Code's own built-ins are counted, on every request, forever. It sits in the
cached prefix, so it bills at ~0.1× after the first turn; the saving is smaller
than the raw count suggests, which is exactly why it needs measuring rather than
assuming.

**Self-inflicted finding, recorded because it is the whole point.** Adding the
Decision-52 dial explanation to the `level` description took it from ~78 → 191
tokens. Trimmed back to 114: still +36 versus baseline, spent on two facts worth
having (the stale "level 3 adds local drafts" text was wrong post-Decision 31,
and the dials needed naming). A workstream about shrinking the tools block began
by growing it — worth remembering that every description edit is a token
decision.

**Why no shrinker shipped in this batch.** Every candidate transform is one of:

1. **Whitespace / punctuation normalisation** — genuinely lossless, and worth
   almost nothing (these strings are already prose, not formatted text).
2. **Rewriting the prose shorter** — real gains, but a tool description is
   *instructions the model reads to decide whether to call the tool*. Shortening
   it can change tool-selection behaviour. That is a **correctness** question,
   not a token question, and there is no harness here that measures
   tool-selection accuracy. Shipping it on the assumption that "shorter means
   the same" is precisely the move this project's honest-observability rule
   exists to prevent.
3. **Native `defer_loading` + tool-search passthrough** — lossless in the sense
   that no description is rewritten, but it changes *when* tools are visible to
   the model, which is a behavioural change of a different kind, and it needs the
   tool-search tool declared upstream. Also newer than these notes: verify
   against live docs before building (the BACKLOG row already flags this).

**Cache interactions that must be settled before any of the three.** `tools`
renders FIRST in the prefix (`tools` → `system` → `messages`), so an unstable
transform invalidates the entire cached prefix on every request — strictly worse
than doing nothing. And shrinking can push a prompt *below* the minimum cacheable
prefix (512 tokens on Opus 5, 1024 on Opus 4.8, 2048–4096 on older models —
checked 2026-07-30), converting a token saving into a total cache loss with no
error to warn you.

**Conclusion.** Next step is a tool-selection-accuracy harness, not a transform.
Until it exists, the honest position is that the tools block is a known ~900-token
target with no safe edit available.

---

## §89 — Tool search verified GA; the shrinker measured and REJECTED (2026-07-30)

Closes the §88 blocker. Two separate findings: what Anthropic's native mechanism
actually does (live-doc check), and what the now-built harness says about
rewriting descriptions ourselves (measurement).

### (a) Native tool search — live-doc check

Source: https://docs.claude.com/en/docs/agents-and-tools/tool-use/tool-search-tool
(fetched 2026-07-30 — served by Golem's own raw-page cache, Decision 42).
**Generally available**, not beta; no beta header. Two variants:
`tool_search_tool_regex_20251119` (Claude writes Python `re.search` patterns, ≤200
chars) and `tool_search_tool_bm25_20251119` (natural language, ≤500 chars).
Supported on Opus 5 / Opus 4.6–4.8 / Sonnet 4.5–4.6 / Haiku 4.5; Opus 4.1 and
earlier do not support it.

The facts that matter for a proxy, and that corrected our assumptions:

1. **`defer_loading` does not shrink the request.** "You still send every tool's
   full definition in the `tools` array on every request, including the deferred
   ones" — the API needs them server-side to run the search and expand
   references. It controls what enters the *context window*, not what the client
   transmits. So this is not a bytes-on-the-wire saving Golem could measure by
   diffing request sizes; the saving is in billed input tokens.
2. **Prompt caching is preserved by design.** The API excludes deferred tools
   from the system-prompt prefix and appends discovered ones as `tool_reference`
   blocks *inline in the conversation*, leaving the prefix untouched. This is the
   opposite of the §88 worry that lazy loading must bust the cache — Anthropic's
   implementation sidesteps it, ours could not have.
3. **A deferred tool may not carry `cache_control`** (400). The breakpoint has to
   ride a non-deferred tool. At least one tool must stay non-deferred (all-deferred
   is also a 400), and it should never be the search tool that is deferred.
4. Limits: ≤10,000 deferred tools; ≤5 matches returned per search; not metered as
   a separate server tool — discovered definitions just bill as input tokens.
5. **Anthropic's own "when to use" thresholds:** worth it at ≥10 tools or >10k
   tokens of definitions; standard calling is the better fit under 10 tools or
   <100 tokens total. Golem alone sits right on the boundary (11 tools, ~902
   description tokens / ~3847 full definitions) — the aggregate with Claude Code's
   built-ins and other MCP servers is what actually crosses it.
6. MCP-connector tools set `defer_loading` once on the `mcp_toolset`
   `default_config`, not per definition.

**Consequence — the real Workstream B risk was never the shrinker.** `golem init`
already writes `ENABLE_TOOL_SEARCH=true`, and behind a non-first-party base URL
Claude Code re-enables tool search *only if the proxy relays these blocks
correctly* (§12). Nothing asserted that. `tests/integration/proxy-tool-search.test.ts`
now does: byte-faithful forwarding of a tool-search request at levels 0/1,
preservation of `defer_loading` / the search-tool `type` / `tools` order /
`cache_control` placement at every level, and unchanged relay of a
`server_tool_use` + `tool_search_tool_result` + `tool_reference` response.
**Result: fidelity already held** — no bug found, but the invariant is now guarded
instead of assumed.

### (b) The shrinker, measured — REGRESSED, not shipped

`golem bench tools` (new, `src/tools/`) lists the catalog from the live MCP server
and A/Bs a candidate transform against 27 hand-labelled selection cases.
Chooser: `qwen2.5-coder:7b` at temperature 0 (see the caveat below).

| transform | tokens | accuracy | false positives | abstentions | verdict |
|---|---|---|---|---|---|
| `whitespace` (control) | 902 → 902 (**0 saved**) | 88.9% → 88.9% (0.0%) | 2 → 2 | 2 → 2 | NO-MATERIAL-CHANGE |
| `first-sentence` | 902 → 397 (**505 saved, 56%**) | 88.9% → **81.5%** (−7.4pp) | 2 → **6** | 2 → 0 | **REGRESSED** |

(false positives/abstentions are counts at 2 repeats; the 4-repeat run reproduces
the accuracy figures exactly and scales the counts linearly — 4 → 12 false
positives — because temperature 0 makes the chooser deterministic.)

**The control is the important row.** Whitespace normalisation saves *exactly
zero* tokens — not "almost nothing" as §88 estimated, but nothing at all, because
these descriptions are built from concatenated string literals with single spaces
and contain no redundant whitespace to collapse. That kills transform class 1
outright.

**The aggressive row shows the predicted failure mode, and it is the dangerous
one:** trimming to the first sentence triples false positives (2 → 6) while
driving abstentions to zero. The model does not get confused about *which* tool —
it starts calling a tool when none applies, because the trimmed text loses the
"use it when…" qualifiers that tell it when to stay out. A shrinker judged only on
"did it still pick the right tool from the right prompt" would have missed this
entirely.

**New census fact §88 did not have:** full definitions are **~3847 tokens**, 4.3×
the ~902 of descriptions alone. The input schemas, not the prose, are most of the
tools block — so prose-shortening was attacking the smaller half all along.

**Caveats, stated because the harness exists to prevent self-deception.** The
chooser is a *local* model, not the one that reads these descriptions in
production, and the 27 expected answers are hand-labelled by us, not observed
traffic. That makes a REGRESSED verdict credible (a small model tripping over
vagueness is evidence the text got worse) and a clean verdict weak (it would not
prove Claude behaves the same). Also: **the tier-2 `classifier` model
(`qwen2.5:7b`) is not pulled on this machine** — only `qwen2.5-coder:7b` is — so
the run used `--role drafter`. That is the same class of gap as the 2026-07-17
judge bug (BACKLOG): `golem devices` lists the tier's *catalog*, which is not the
same as what Ollama has actually downloaded.

**Conclusion. The tools-block shrinker is not shipped, and now that is a measured
decision rather than a deferred one.** Class 1 (whitespace) is worth zero; class 2
(prose rewriting) costs selection precision at the one saving worth having; class 3
(native `defer_loading`) is Anthropic's to run and Golem's job is only to relay it
faithfully, which is now tested. If this is revisited, the target is the input
schemas (~2900 tokens) and the harness is already the gate.

## §90 — RTK: an Apache-2.0 Bash-output compactor, complementary not competing (2026-07-30)

Checked before recommending an integration shape, per verify-don't-assume.
Source: `github.com/rtk-ai/rtk` README (repo page, fetched 2026-07-30, cached in
the webcache). Apache-2.0, Rust, single binary, "100+ supported commands,
<10ms overhead", version string in the README's own verify step is `rtk 0.28.2`
with a native-Windows hook noted from v0.37.2.

**What it is.** A `PreToolUse` hook that **rewrites Bash commands** to filtered
equivalents (`git status` → `rtk git status`) plus a large filter library: test
runners (jest/vitest/pytest/go/cargo/rspec/sbt), linters (eslint/biome/tsc/ruff/
clippy/golangci/rubocop), git/gh, docker/kubectl/oc, aws, pulumi, and file
primitives (`rtk read -l aggressive` = signatures only). Also `rtk gain` savings
analytics and `rtk discover` for missed opportunities. 15 agent integrations,
Claude Code's being the native-binary `PreToolUse` hook.

**It is honest about its own numbers, which is worth noting.** The README states
plainly that "cuts up to 90% of the bash output your agent reads… is not the same
as cutting your bill by 90%", and that token counts are **estimated as
`bytes / 4`** because it ships no tokenizer. So the percentages are directional
and the absolute token figures are approximate — the opposite of a claim Golem
would have to correct, and a fair basis for comparison against Golem's real
billed-`usage` telemetry (R1.1).

**Its documented blind spot is exactly Golem's surface.** Quoted: "the hook only
runs on Bash tool calls. Claude Code built-in tools like Read, Grep, and Glob do
not pass through the Bash hook, so they are not auto-rewritten." Golem's
`POST_TOOL_USE_MATCHER` is already `Bash|Read|Grep|Glob|WebFetch`
(`src/hooks/settings-writer.ts:26`) and the proxy sees the whole `messages` array.
So the two are complements: RTK compacts shell output, Golem compacts
built-in-tool output, deduplicates across the session, and prices the bill.

**Consequence for Golem (Decision 53).** Tier-3a peer: detect and coordinate,
never vendor. Vendoring would break invariant 4 (ship no third-party bytes),
inherit a `bytes/4` savings estimate into a project whose differentiator is real
`usage`, and add an opt-in telemetry path (device hash, command names, estimated
USD) to a local-first tool. R8.3 is descoped accordingly — do **not** rebuild 100+
Bash filters; build only the surfaces a command wrapper cannot reach.

**Open, deliberately not run:** a formal A/B was judged unnecessary by the user.
The cheap version stands — install it, and record what Golem's real usage
telemetry shows against RTK's estimates.

## §91 — Claude Code hook precedence between a rewriting hook and a denying hook is UNDOCUMENTED (2026-07-30)

Checked because Golem and RTK would both own `PreToolUse` on the same Bash call.
Source: `code.claude.com/docs/en/hooks` (301 from
`docs.claude.com/en/docs/claude-code/hooks`), fetched 2026-07-30.

**Verified.**
- `permissionDecision` takes `allow` / `deny` / `ask` / **`defer`**, under
  `hookSpecificOutput`. Exit 0 with no output is *not* approval — the call
  continues through the normal permission flow.
- **`updatedInput` sits directly under `hookSpecificOutput` on `PreToolUse` and
  "replaces a tool's arguments before it runs"** — distinct from
  `PermissionRequest`, where `updatedInput` nests inside a `decision` object.
  This is the mechanism RTK uses.
- All matching hooks for an event run **in parallel**; entries **merge** across
  settings levels (user/project/local/managed/plugin) rather than replacing each
  other; identical handlers are deduplicated by command string + `args`.
- `continue: false` outranks every event-specific decision field.
- Two-stage narrowing exists: `matcher` on `tool_name`, then a per-handler `if`
  using permission-rule syntax — but `if` is **best-effort and fails open**, so
  the docs explicitly say to use the permission system, not a hook, for a hard
  allow/deny.

**NOT documented, and it matters.** The precedence when parallel hooks return
*conflicting* `permissionDecision` values — specifically a hook returning
`updatedInput` (RTK's rewrite) racing a hook returning `deny` (Golem's snooze /
coder-first / autonomy gates). The `#pretooluse-decision-control` section was
truncated in the fetched page; `hooks-reference#pretooluse-decision-control` is
the place to look next.

**Why this is live rather than theoretical.** Golem's `PreToolUse` hook is
registered with **no matcher** (`src/cli/init.ts:704`), so it fires on every tool
call including Bash. Any user who installs both is exercising this interaction.
**Action (R8.12):** assert it in an integration test rather than trusting it —
Golem's `deny` paths must still win. Until that test exists, treat coexistence as
unverified.

> **CLOSED by §105 (2026-07-31).** The docs have since gained the precedence sentence
> (`deny > defer > ask > allow`), and the case they still omit — a hook returning only
> `updatedInput` racing a `deny` — is now pinned by a live test against Claude Code
> 2.1.220. The deny wins; the rewrite is discarded.

## §92 — Dependency-tier audit: two documented-as-optional things that were not (2026-07-30)

Found while writing Decision 53's ladder, by checking each claim rather than
reading the comments.

- **`unpdf` was mandatory.** `src/knowledge/extractors.ts` called it "the
  optional `unpdf` package" and the R3.2 debrief agreed, but it was a **static**
  `import` listed in `dependencies` — installed for every `golem-run` user, and a
  module-load crash on an install without it. Pure JS, so no hard rule was
  broken; the *contract* was wrong. Fixed: cached dynamic `import()` +
  `optionalDependencies` + a typed `PdfExtractionUnavailableError` that the two
  existing call sites already handle (`planIngest` → `filesSkipped`;
  `fetchRawPage` → falls open).
- **No `LICENSE` file.** `package.json` declared `Apache-2.0`; the tree had no
  licence text. Added verbatim (Apache-2.0, copyright Golem / golem.run) ahead of
  the R7.5 first publish.

**Verified-correct by contrast** (no action needed): `web-tree-sitter` was already
a genuine tier-2 — dynamic `import()` with a `null` degrade, grammars as
devDependencies only. That file is the pattern the `unpdf` fix follows.

**Live-machine state recorded, because it is the fact that prompted all of this:**
in this repo `compression.headroom_sidecar = true` and `uv` is present, yet **no
Headroom process has ever run** — the lossy semantic stage is its only caller and
that stage is gated off on caching upstreams (Decision 31) unless
`force_semantic_on_caching` is set. Caveman is **not installed** at all. One idle
spawn target and one absent program: exactly what tiers 2 and 3 are supposed to
look like, and the reason `golem ext` reports a `gate` note instead of claiming
"running".

## §93 — This project's real prompt-cache hit rate is 98.4%, which redirects R8 (2026-07-30)

Measured with R8.1's own rollup (`golem stats --cache`) against this repo's
durable telemetry the moment it shipped — 7,874 recorded responses, all-time:

| bucket | tokens | rate |
|---|--:|---|
| cache **read** | 2,042,812,070 | ~0.1× |
| cache **write** (prefill) | 32,750,061 | ~1.25× |
| **uncached** input | 1,215,854 | 1× |
| hit rate | **98.4%** | |

**What this says.** The prompt cache on this project's traffic is already working
close to optimally. Uncached input is **0.06%** of billed input. So the failure
mode R8.1's bust detector exists to catch — a broken prefix forcing a re-prefill —
is **not** where this project's money goes.

**Where it actually goes.** Weighting by rate, cache reads are ~204M full-rate
equivalents against ~41M for prefill and ~1.2M uncached: **~83% of input cost is
re-reading an already-cached context**, turn after turn. Cheap per token, on an
enormous base.

**Consequence — an honest demotion of work I had just argued for.** The R8 memo
ranked cache-bust detection first on the theory that busts were an invisible,
recoverable cost. On this evidence that theory is wrong *here*: there is almost
nothing to recover. The instrument was still worth building (it is what produced
this table, and it is the only way to know a bust rate rather than assume one),
but its *bust* half should be treated as a guard rail, not a savings lever.

The levers this table actually supports, in order:

1. **R8.2 suffix-only tool-result dedup** — smaller context ⇒ fewer cache-read
   tokens on *every* subsequent turn. Directly attacks the 83%.
2. **R8.5 repo map + oversized-`Read` swap** — same mechanism, upstream of it:
   never put the 20k-token file in the context to begin with.
3. **R8.4 context ledger** — tells a human *which* content is being re-read, so
   the pruning is aimed rather than guessed.

**Caveat on the number.** This is all-time telemetry for one project (this repo,
dogfooded daily at slider 3 with brevity pinned to `full`), on Anthropic with
Claude Code as the client — a client that is unusually good at cache discipline.
A project with a churning `tools` block, an injected timestamp, or frequent
compaction would look nothing like this. Do not generalise 98.4% into a claim
about Golem's users; it is a measurement of *this* setup, and the whole point of
shipping the rollup is that anyone can now measure their own.

**Coverage note.** At the moment of measurement the *verdict* half read "none
recorded" over 14,776 pipeline events, correctly — the running proxy predated the
build. That is the disclosure working as designed rather than a bug: an
unobserved request is reported as unobserved, never as a hit.

## §94 — R8.2 was already built in 2026 (A2 / Decision 18); the memo proposed existing work (2026-07-30)

Checked the code before building R8.2 ("suffix-only tool-result dedup"), which the
R8 memo had described as novel and ranked as its highest-confidence lever. It is
not novel. `src/compression/native-lossless.ts` has shipped it since task A2:

> "exact repeats of large content within one conversation are replaced by CCR
> reference markers; **the first occurrence is always kept in place**"

and it achieves the cache-safety property the memo claimed as the new idea — not
by special-casing the suffix, but by **purity**: the transform of `messages[i]`
depends only on the original bytes of `messages[0..i]`, the dedup seen-set is
rebuilt from the input on every call, and the marker text is a pure function of
(refId, tokenEstimate). Extending a conversation therefore *cannot* change the
compressed form of earlier messages, from any process. That is a stronger
guarantee than "only rewrite the newest block", and it was designed for exactly
the reason the memo re-derived (§14 prefix byte-stability).

**Measured on this repo's real traffic** (`golem stats --window all`, 14,791
requests):

| stage | before | after | saved |
|---|--:|--:|--:|
| dedup | 4,763,725 | 314,022 | **4,449,703** |

A 93% reduction on the content it touches, with 4,878 CCR refs stored and **2**
retrieved — i.e. the elision marker is almost never insufficient, which is the
same signal R2.1 recorded (0 misses in 1,051 swaps) and further evidence the
technique is safe.

**Correction to the memo.** R8.2 is struck as a build task. The lesson is the
repo's own standing rule, which the memo skipped: check the KB and the code before
proposing. Writing the proposal from the *shape* of the external projects (Aider,
RTK) rather than from this codebase produced a confident recommendation to build
something that already existed and was already measured.

**What is genuinely NOT covered**, for anyone tempted to reopen this:

- **Near-identical** content (the same file re-read with one line changed) is not
  deduped — only byte-exact repeats above `DEFAULT_MIN_DEDUP_CHARS` (256). A
  fuzzy matcher would be lossy and would break the purity guarantee above, so it
  is not a small change.
- **Large content that appears only once** is untouched by definition. Given §93
  (~83% of input cost is re-reading an already-cached context), *this* is the real
  remaining target — which is R8.5's repo map and oversized-`Read` swap, not dedup.
- `DEFAULT_MIN_DEDUP_CHARS = 256` looks right rather than tuned: the marker itself
  is ~150 chars, so below ~256 the swap stops paying. Changing it invalidates live
  cache prefixes (the file says so), so it needs a measurement, not a guess.

## §95 — First real context ledger: tool definitions are 18.8k tokens, and Bash output is the biggest tool (2026-07-30)

R8.4's first capture, taken from the live proxy during the session that built it
(550 messages, ~312k tokens in the request). Every number below is re-sent and
re-read on **every subsequent turn** of that conversation, which is what §93
established as ~83% of input cost.

| bucket | tokens | share |
|---|--:|--:|
| assistant text + tool calls | 102,868 | 33.5% |
| tool results | 95,463 | 31.1% |
| thinking blocks | 54,074 | 17.6% |
| user text | 32,199 | 10.5% |
| **tool definitions** | **18,827** | 6.1% |
| system prompt | 3,365 | 1.1% |

Tool results by producing tool:

| tool | tokens | results |
|---|--:|--:|
| **Bash** | **36,968** | 132 |
| Read | 27,056 | 18 |
| WebFetch | 17,015 | 10 |
| `mcp__golem__expand` | 6,356 | **1** |
| Edit | 4,836 | 68 |
| Write | 1,615 | 26 |
| others (search/TodoWrite/ToolSearch/snooze) | <1,700 | 12 |

**Three findings that change priorities.**

1. **The `tools` block is ~5× bigger than §88 measured — 18,827 tokens, and the
   single largest individual block in the request.** §88 measured *Golem's own 11
   MCP tool descriptions* at ~902 tokens (~3,847 with schemas); a real session adds
   Claude Code's built-ins plus every other MCP server, and the total is 18.8k
   re-read every turn. That materially strengthens **R8.S1 (tool-schema
   shrinking)**, which §89 had already identified as the remaining headroom, and it
   raises the ceiling from "~3.8k" to "~18.8k". It does *not* revive the rejected
   prose shrinker — the accuracy verdict there stands (§89) — but it justifies
   re-running `golem bench tools` against schemas specifically.

2. **Bash output is the biggest single tool consumer: 36,968 tokens across 132
   results.** This is precisely what RTK compacts (§90), and it is the first
   quantified case for the tier-3a recommendation: ~37k tokens of shell output,
   re-read every turn, on one session. It also confirms **R8.3's descoping was
   right** — do not rebuild Bash filters, install the tool that has 100+ of them.

3. **One `expand` call cost 6,356 tokens** — the fourth-largest tool consumer, from
   a single result. The `golem-ccr-refs` guidance rule already warns that expanding
   "costs the tokens the swap saved"; this is the measured version, and it argues
   for the rule being stated as strongly as it is.

**Also notable, not yet actionable:** thinking blocks are 54,074 tokens (17.6%) —
a bucket nothing in Golem currently touches, and one that cannot be touched at
levels ≤1 (proxy fidelity: thinking blocks pass through byte-faithful). Worth
knowing before anyone proposes a "just drop old thinking" transform: it would be a
fidelity-rule change, not a tuning knob.

**Caveats.** One capture, one conversation, this repo, an unusually tool-heavy
session (it installed MCP servers and ran a 1,800-test suite repeatedly). The
buckets are estimates from `estimateTokens`, not a tokenizer. The ledger is
latest-only by design, so this is a snapshot rather than a distribution — anyone
wanting a distribution should sample `golem stats --context --json` over time.

## §96 — Installing RTK silently degraded Golem's autonomy gate (found and fixed) (2026-07-30)

R8.12's real finding, and not the one §91 predicted. §91 flagged the *undocumented*
question — precedence between a rewriting hook and a denying one — which remains
open because it is Claude Code's behaviour, not Golem's. Looking for what Golem's
half could get wrong turned up something concrete and testable instead.

**The asymmetry.** `src/autonomy/classify.ts` anchors its two danger lists on word
boundaries (`/\bgit\s+push\b/i`, `/\brm\s+-[a-z]*[rf]/i`) but anchors its
safe-list on the **start of the string** (`/^(npx\s+)?(tsc|vitest|biome)(\s|$)/`).
RTK rewrites `vitest` into `rtk vitest`. So:

| command | before | after |
|---|---|---|
| `rtk git push` | `outward` ✅ | `outward` ✅ |
| `rtk rm -rf build` | `destructive` ✅ | `destructive` ✅ |
| `rtk vitest` | **`unknown`** → prompt | `read` → auto-approvable |

**Nothing was unsafe** — the gate is fail-closed, so the failure mode was a prompt,
not an approval. But it means a user who installs RTK finds previously
auto-approved commands suddenly asking, with no indication why, and the natural
response to that is to loosen the autonomy level. A safety mechanism that gets
disabled out of irritation is a safety problem.

**Fix.** `stripOutputWrapper` retries **only the safe-list** against the command
with a known wrapper token removed. The danger checks still run first, on the
original string, so unwrapping cannot downgrade a classification — it can only
turn `unknown` into `read` for a command that would already be safe unwrapped.
Deliberately shallow: one level, exact `rtk ` prefix (so `rtkfoo` is untouched),
and RTK's own command-taking subcommands (`rtk proxy <cmd>`, `rtk err <cmd>`,
`rtk test <cmd>`, `rtk summary <cmd>`) are left to fall through to `unknown`
because unwrapping them yields a meaningless bare subcommand name. 13 tests,
including the composition cases (`rtk vitest; rm -rf /` → `destructive`,
`rtk vitest | tee out` → `unknown`).

**Second fix in the same pass — don't destroy another compactor's escape hatch.**
RTK tees full unfiltered output to a file and points at it inline
(`[full output: ~/.local/share/rtk/tee/….log]`). Golem's PostToolUse swap replaces
oversized output with a head/tail excerpt, which can drop that pointer into the
elided middle — a compaction *of a compaction* losing the other tool's only route
back. `buildDigest` now carries the pointer through in its own section when it
would otherwise be lost, matched loosely (`[full output: …]`) because the wording
belongs to another project. 4 tests.

**Still open (unchanged):** §91's precedence question. Golem never emits
`updatedInput`, so it cannot itself conflict; what happens when RTK's rewrite races
Golem's `deny` is Claude Code's to define, and the docs do not. Anyone running both
should treat it as unverified until `hooks-reference#pretooluse-decision-control`
is read.

**Generalisation worth keeping:** the bug class is "a peer rewrites the input your
classifier reads". Any future tier-3a peer that mutates tool arguments needs the
same audit — check whether every pattern that matters is anchored in a way that
survives the rewrite. Start-anchored allow-lists are the fragile ones; the
word-boundary deny-lists survived by luck, not design.

## §97 — R8.3 rescoped again by its own evidence: Grep/Glob distillation has no measured demand (2026-07-30)

R8.3 was already descoped once (§90: do not rebuild RTK's 100+ Bash filters; build
only the surfaces a command wrapper cannot reach). Checking §95's ledger before
building the remainder showed the *rest* of the plan was also speculative.

**The plan said** structure-aware distillers for `Read` / `Grep` / `Glob` / MCP
results. **The ledger says** where the tokens actually are:

| tool | tokens | results |
|---|--:|--:|
| Bash | 36,968 | 132 |
| **Read** | **27,056** | 18 |
| WebFetch | 17,015 | 10 |
| `expand` | 6,356 | 1 |
| Edit | 4,836 | 68 |
| Write | 1,615 | 26 |
| **Grep / Glob** | **absent** | 0 |

Grep and Glob do not appear at all — in this session the equivalent work went
through `Bash` (`grep`/`ls` via the shell), which is RTK's territory. Building
Grep/Glob distillers would have been polish on a surface with no measured traffic,
which is exactly what §94 caught the memo doing for R8.2.

**What shipped instead** is the evidence-supported piece: `Read` is the second
biggest consumer *and* the one an external Bash compactor cannot touch, and one
`expand` cost 6,356 tokens. So the digest became **line-aware** — it names the line
ranges it shows, names the elided range, and recommends a narrow re-read *before*
offering `expand`:

```
--- head: lines 1-42 of 1200 ---
--- tail: lines 1181-1200 of 1200 ---
--- 1138 line(s) elided (lines 43-1180). PREFER a narrower re-read of just what you
    need (e.g. Read with offset/limit, or grep the file) — expanding re-enters the
    FULL original and costs back the tokens this swap saved. ---
```

Same token budget, strictly more useful: the previous char-window excerpt was
positionless, so `expand` was the *only* way to see more. This makes the digest
support `.claude/rules/golem-ccr-refs.md`'s advice instead of quietly working
against it.

**A bug the existing tests caught.** The first draft aligned to lines without
keeping a char cap, so a single enormous line (a minified bundle, a JSON blob — one
line, 30k chars) was classified "complete" and passed through **whole**, defeating
the swap entirely. Two pre-existing tests failed immediately. The fix requires
*both* line coverage and no char-level truncation before declaring an output
complete, and marks a char-clamped range `partial`. Recorded because the failure
mode was silent bloat, not an error.

**Also removed:** `headExcerpt`/`tailExcerpt` are gone rather than left beside their
replacements — biome's unused-variable rule flagged them, which is the intended
outcome for superseded code.

**Still not built, deliberately:** MCP-result distillers. Golem's own tool results
are 1,018 (`search`) + 40 (`snooze`) + 366 (`TodoWrite`) + 193 (`ToolSearch`)
tokens in §95's capture — under 0.6% of context. Nothing to win yet; revisit if a
ledger sample ever shows otherwise.

## §98 — `min-release-age` IS implemented in npm 11: it resolves to a rolling `before` (2026-07-30)

Checked before shipping R8.10's `.npmrc`, because Pi's README cites
`min-release-age=2` and the key is not in npm's public config documentation I could
find. Verified locally against **npm 11.12.1** rather than assumed.

**What the probes showed.**

1. `npm config ls -l` lists `min-release-age = null` — so the key is *recognised*,
   not silently discarded.
2. `npm config get min-release-age` returns `null` even with
   `min-release-age=2` in the project `.npmrc` — which initially looked like the key
   being inert, and would have been the wrong conclusion.
3. `npm config list` reveals what actually happens: the project config renders as

   ```
   ; "project" config from D:\…\golem\.npmrc
   before = "2026-07-28T05:52:22.076Z"
   ```

   i.e. npm **translates `min-release-age=<days>` into a rolling `before`
   timestamp** at config-read time. It is an alias, which is why `get` on the alias
   reports null while the effect is real.

**Consequence — it works, and it is worth setting.** `min-release-age=2` refuses to
resolve anything published in the last two days, which is the window in which a
compromised release is usually caught and yanked.

**Two caveats to know before relying on it.**

- It has **no effect on `npm ci`**, which installs from the lockfile. Its value is
  at `npm install <pkg>` time, i.e. when a human adds or bumps a dependency.
- Because it becomes `before`, it silently changes *all* resolution — a
  just-published version simply appears not to exist. Expect a confusing "no
  matching version" when deliberately installing something released today; the fix
  is `npm install --before ""` or a temporary override, not removing the setting.

**Also settled in the same pass:** npm **ignores `package-lock.json` inside a
published tarball**, so a consumer of `golem-run` would have resolved transitive
dependencies fresh and inherited none of this repo's pinning.
`npm-shrinkwrap.json` is the lockfile npm honours when published, so
`scripts/make-shrinkwrap.mjs` generates it at release time from the lockfile. It is
**gitignored on purpose** — `package-lock.json` stays the single ground truth, and
committing both would guarantee drift. Documented in RELEASING.md.

**Enforcement, because a posture in a dotfile is not a guarantee.** `save-exact`
governs only *future* installs and cannot stop a hand-edit reintroducing a range,
so `scripts/verify-deps.mjs` (wired into `npm run check`) asserts: exact pins on
every direct dependency incl. optional, the `.npmrc` posture still present, pins
agreeing with what the lockfile resolved, and the runtime dependency count still
≤ 5. 12 tests drive it against synthetic trees — a gate that silently passes would
be worse than none.

## §99 — R8.1's verdict half is UNRELIABLE as shipped: 142 busts / 3 firsts / 0 appends against a billed 98.4% hit rate (2026-07-30)

Found within minutes of deploying R8.1 to the live proxy, and it is two separate
problems stacked.

### Problem 1 — the verdict never reached the report (fixed)

The proxy wrote verdicts to the JSONL correctly (`grep -o '"cachePrefix":"[a-z]*"'`
→ 142 `bust`, 3 `first`), yet `golem stats --cache` said **"Prefix verdicts: none
recorded"** over 14,919 events.

Cause: `parseEvent` in `jsonl-store.ts` reconstructs a `TelemetryEvent`
**field-by-field** — it is an allow-list, so a new field is invisible on read until
a line is added for it. The R8.1 unit tests passed because they fed
`TelemetryEvent` objects straight into `aggregateCacheStats`, never through the
store.

Fixed, plus `tests/integration/cache-verdict-roundtrip.test.ts` which writes
through the real store, reads through the real reader, and aggregates. **Standing
rule for this repo: a new `TelemetryEvent` field needs a `parseEvent` line AND a
round-trip test; an aggregator unit test cannot catch this class of bug.**

### Problem 2 — the classifier over-reports busts, badly (NOT fixed)

With the read path fixed, the real distribution is **142 `bust` / 3 `first` /
0 `append`** — i.e. ~98% of classified requests are called cache busts, while the
**billed** numbers over the same period say a **98.4% hit rate** with cache-write
at 1.5% of input. Both cannot be true. The billed number is ground truth, so the
verdict is wrong ~98% of the time.

**Most likely cause: the conversation key.** `cachePrefixFingerprint` groups
requests by a hash of `messages[0]`, and a real client multiplexes *many* short
conversations through one proxy — subagent runs, title/topic generation, WebFetch
summarisation, quota probes — a large share of which open with an identical or
near-identical first message. Those all collide onto one key and therefore read as
each other's busts.

**The documented caveat was wrong about severity.** `cache-prefix.ts` says a
collision "costs at most one misattributed verdict, and never a wrong bill". The
first clause is false: collisions are the *dominant* case, not the marginal one.
The second clause holds — nothing about billing or request bytes is affected — which
is the only reason this is a bad metric rather than an incident.

**What this vindicates.** Keeping the billed and predicted signals separate and
refusing to blend them into a "cache health score" (R8.1's central design call) is
what made the contradiction visible in the first place. A blended number would have
averaged a correct measurement with a 98%-wrong prediction and looked plausible.

**Not fixed here, deliberately.** A better design is a real change, not a tweak,
and it deserves the data now in hand:

- **Candidate A — prefix-chain identity.** Keep a bounded set of seen
  `messages[0..k]` hashes and classify a request as `append` when *any* prefix of
  it was seen before, regardless of which "conversation" it belongs to. Removes
  the notion of a conversation key entirely.
- **Candidate B — require growth.** Only report `bust` when the message count is
  ≥ the previous request's; a shorter or equal-length divergent request is more
  likely a different conversation than an edit. Cheap, partial.
- **Candidate C — use a client-supplied id if one exists.** Worth re-checking
  whether Claude Code sends anything stable (a `metadata.user_id`, a header) that
  the proxy could key on instead of guessing.

**Until then, treat `golem stats --cache`'s verdict section as diagnostic noise and
the billed section as the answer.** The renderer already labels verdicts a
prediction and names the heuristic; that wording is now load-bearing rather than
cautious boilerplate.

## §100 — R8.S1 answered: 93.9% of the tools block is not Golem's, and the "schemas are the headroom" finding was an artifact (2026-07-30)

R8.S1 (tool-schema shrinking) was the roadmap's "next by evidence", promoted twice:
§89 closed with "the target is the input schemas (~2900 tokens)" and §95 raised the
ceiling from ~3.8k to **18,827 tokens** by measuring a real request. Both numbers
were right about their own subject and wrong about the conclusion drawn from them.
The ledger now decomposes the `tools` block per definition, and the first capture
ends the workstream.

### The measurement

`golem stats --context`, live capture on this repo, 188 messages, ~139,327 tokens:

| owner | tokens | share | tools |
|---|--:|--:|--:|
| **client built-ins** | **17,473** | **93.9%** | 18 |
| **Golem MCP tools** | **1,130** | **6.1%** | 6 |

Within the block: **descriptions ~12,146 · input schemas ~5,947 · everything else
~510**.

Biggest single definitions, all of them the client's:

| tool | tokens | desc | schema |
|---|--:|--:|--:|
| `Workflow` | 5,264 | 4,753 | 444 |
| `Artifact` | 2,621 | 1,591 | 1,001 |
| `PowerShell` | 2,141 | 1,929 | 172 |
| `AskUserQuestion` | 1,225 | 447 | 756 |
| `ScheduleWakeup` | 953 | 672 | 261 |

### Four findings

1. **Golem's own tool definitions are 1,130 tokens — 6.1% of the block and 0.8% of
   the request.** That is the entire budget R8.S1 could ever have worked with. The
   18.8k of §95 was a *ceiling*, and a ceiling is not a lever: 93.9% of it belongs
   to Claude Code, and rewriting a client's own tool definitions from the proxy
   would be a fidelity change, not a dial. One built-in (`Workflow`, 5,264 tokens)
   is **4.7× Golem's entire contribution**.
2. **§89's "the schemas are the real headroom (~2900 of ~3847)" was an artifact of
   measuring the wrong surface.** It subtracted descriptions from the *`listTools`*
   definition total and attributed the remainder to input schemas. Golem's actual
   input schemas are **~1,128 tokens**; the missing ~1,800 is `outputSchema`
   (~1,522), plus `title`/`annotations`/`execution`/`_meta`. On the real wire,
   `other keys` averages **~21 tokens per tool** — just `name` and `type` — so
   **Claude Code forwards none of that MCP metadata to the API.** It costs nothing
   and there was never anything to reclaim there. On the wire, prose outweighs
   schemas **2:1** (12,146 vs 5,947), inverting the §89 conclusion entirely.
3. **The three schema transforms measured, and the honest verdict is REJECTED — but
   for a new reason.** `golem bench tools` was extended to render schemas to the
   chooser (a schema transform scored against a description-only prompt shows a zero
   delta *by construction*) and to score **argument construction** against the
   ORIGINAL schemas — the failure mode a selection gate structurally cannot see.
   Chooser `qwen2.5-coder:7b`, temperature 0, `--role drafter` (the tier's
   `classifier` model is still not pulled — the same gap §89 flagged, unchanged):

   | transform | schema tokens | selection acc | args valid | fields correct |
   |---|--:|--:|--:|--:|
   | `schema-meta` (drop `$schema`) | 1128 → 998 (−130) | 92.0% → 88.5% | 92.9% → 92.9% | 92.9% → 92.9% |
   | `schema-validation` (+bounds, `additionalProperties`) | 1128 → 854 (−274) | 92.0% → 92.3% | 92.9% → 92.9% | 92.9% → 92.9% |
   | `schema-descriptions` (+every property description) | 1128 → **357 (−771, 68%)** | 92.0% → 92.3% | 92.9% → 92.9% | 92.9% → 92.9% |

   **Read the argument columns as an instrument failure, not a clean pass.** They
   are byte-identical in every mode, and the single failing case is the same one in
   both arms: `arg-search-2` passes `k: 100` when `maximum: 50` is **present in the
   schema it was shown**. A 7B coder model at temperature 0 is answering from the
   prompt text and the tool name, not from schema annotations — so removing all of
   them changes nothing it does. That makes "no delta" evidence about the chooser,
   not about the transform. The production reader is Claude, and §89's caveat
   applies with more force here: a null result from this harness is weak evidence of
   safety, never proof.
4. **Claude Code's deferral appears to be client-side and genuinely shrinks the
   wire — which the API docs' description does not cover.** The forwarded array has
   24 entries, 8 flagged `defer_loading: true`, and includes an entry literally
   named **`DeferredToolPlaceholder` (51 tokens)** alongside a client tool
   `ToolSearch` (360 tokens). There is **no** `tool_search_tool_regex_20251119` /
   `_bm25_20251119` server-tool entry. Of Golem's 11 tools only **6** are present,
   and they are the 6 this session had already used. §89(1) recorded, correctly from
   the docs, that the *API feature* still transmits every deferred definition;
   Claude Code's own MCP deferral evidently does not — it sends a placeholder plus
   the definitions discovered so far. **Stated as an observation, not a documented
   contract:** it is undocumented, it is the client's internal behaviour, and it
   could change. But it means an unused Golem tool costs approximately nothing, and
   the 1,130 is the bill for tools actually in play.

### Consequence

**R8.S1 is closed as REJECTED, and the whole tools-block line of work is
de-prioritised.** Even the one transform that is provably invisible to the model —
`schema-meta`, which drops a JSON-Schema dialect URI — is worth **~72 tokens on the
wire** across Golem's 6 forwarded tools: 0.05% of this request, in exchange for
mutating a cached prefix. That is not a trade worth making, and saying so with a
number is the deliverable.

What ships instead is the instrument: the ledger's per-definition decomposition
(owner, description/schema/other split, deferred count), so nobody promotes this
workstream a third time on an aggregate. The two gates built here
(`--render full`, `ARGUMENT_CASES` + `validateAgainstSchema`) stay in the tree —
they are the right shape for judging *any* future schema change, and they carry the
recorded caveat that the local chooser cannot currently exercise them.

**Standing gap, now twice-observed.** The tier-2 `classifier` model
(`qwen2.5:7b`) has never been pulled on this machine, so both §89 and this run used
`--role drafter`. `golem devices` lists the tier's *catalog*, not what Ollama has
downloaded — the same class of gap as the 2026-07-17 judge bug. Worth a real check
rather than a third caveat.

---

## §101 — R8.5 measured: the repo map wins the retrieval question by +21.4 points, for 57 tokens (2026-07-30)

R8.5's gate was "does the map let the model find the right file **without** the
read? Report saving and accuracy together." Built as `golem bench map`, on 22
hand-labelled retrieval cases against this repo. Unlike the last three
context-economy items, the instrument said **yes**.

### The A/B

Both arms are shown to the same chooser, on the same cases, in the same run. The
baseline is deliberately not "no context" — it is the **plain file list**, which
the model can already get for almost nothing (`Glob`, `ls`), capped to the same
token budget. Chooser `qwen2.5-coder:7b`, temperature 0, `--role drafter`
(the tier's `classifier` model is *still* not pulled — third occurrence, see
§100's standing gap and the `local-models` task).

| arm | context | mean tokens/call | correct/scored | accuracy |
|---|---|--:|--:|--:|
| baseline | plain path list (386 paths) | ~1,329 | 18/63 | **28.6%** |
| candidate | repo map, re-ranked per question | ~1,386 | 33/66 | **50.0%** |

**Delta +21.4 points for +57 tokens per call**, at 22 cases × 3 repeats.
Resolution is 4.5% (one case), so the delta is 4.7× what the set can resolve, and
it reproduced *exactly* across 1 and 3 repeats. Verdict **MAP-HELPS**.

Cases the map won and the path list lost: `autonomy-classify`, `hardware-tier`,
`model-catalog-roles`, `openai-translation`, `settings-precedence`, `statusline`.
One case went the other way (`brevity-dial`) — recorded, not hidden.

### What it costs, stated beside what it buys

- **The map:** ~1,390 tokens at the default 1.4k budget — 386 files with symbols,
  2,712 symbols extracted, 12 files / ~70 symbols shown.
- **What it displaces:** a whole-file read of a labelled file averages **~2,238
  tokens**, so the map costs **~0.6× one read**. It pays if it avoids one.
- **The tool definition** (permanent, every request): `golem bench tools` before
  11 tools / ~902 desc / ~1,128 schema; after 12 / ~1,003 / ~1,289. `code` is
  **~101 description + ~161 schema = ~262 forwarded tokens** (§100: MCP metadata
  and `outputSchema` are not forwarded, and an unused tool costs ~nothing until
  first use).

### Three things the measurement changed in the implementation

1. **Only exported symbols may be graph targets.** Counting every top-level
   definition as an edge target let file-local names (`body`, `url`, `draft`)
   attract inbound reference weight from the whole repo, which floated
   `tests/unit/proxy/cache-prefix.test.ts` above `src/interfaces/`. Restricting
   targets to exported, non-member definitions fixed the ranking outright.
2. **A queried map needs more than a personalized teleport vector.** With damping
   0.85 the hubs still won: `src/cli/init.ts` ranked first for "where is the
   oversized tool output digest built". A queried map now also lowers damping to
   0.5 and scales the final rank by the file's own query affinity.
3. **Word-part matching, not substring matching, and IDF weights.** `the` is a
   substring of `pathExists` and `and` of `expand`; with raw substring matching
   those function words out-scored `digest` (2 files). Splitting identifiers into
   word parts (`runPostToolUseHook` → run, post, tool, use, hook) and weighting
   each token by rarity put `src/hooks/post-tool-use.ts` first for that question.

### Honest limits

- The chooser is a **local 7B model**, not the frontier model that reads a map in
  production. A positive result here is evidence the *map* carries the signal, not
  a claim about how Opus would use it.
- 22 cases resolve ~4.5% at best, and the labels are hand-written against this
  repo. The harness reports labelled paths that no longer resolve rather than
  scoring them wrong, so the set fails loudly when it rots.
- **This does not answer memo open question 3.** It measures whether the map
  *names* the right file, not whether the model then skips reading it.
  Displacement needs live traffic, and remains open.
- The verdict rule was tightened while running this: a blanket "any excluded
  chooser error ⇒ inconclusive" let one reproducible unusable reply erase a delta
  4.7× the resolution. It now scores excluded errors the worst possible way and
  asks whether the sign survives (here: +18.2%, so it cannot flip).

## §102 — Ollama's OpenAI-compat `/v1/embeddings` silently discards `keep_alive`; native `/api/embed` honours it (2026-07-30)

Checked because a visible GPU spike prompted the question of whether Golem should
refresh the embedding model's keep-alive on each knowledge-path use. Probed live
against **ollama 0.32.5** on the dev box (RTX 3070, `nomic-embed-text:latest`,
323 MB, 100% GPU) rather than reasoned about, because both halves of the answer
turned out to be counter-intuitive.

**What the probes showed.**

| probe | `ollama ps` → `UNTIL` | reading |
|---|---|---|
| plain `POST /v1/embeddings` | 56 min → **59 min** | idle timer **is** refreshed by an ordinary request |
| `POST /v1/embeddings` + `"keep_alive":"10m"` | **stays 59 min** | param accepted, **silently ignored**, HTTP 200 |
| `POST /api/embed` + `"keep_alive":"10m"` | → **9 min** | native endpoint honours it |

**Consequence 1 — the nudge already happens, so there is nothing to add.** Every
embed request resets the unload timer, including through the compat path. The
knowledge path *is* the keep-alive nudge; an extra refresh call would be redundant
work. No code change was made.

**Consequence 2 — the silent-failure trap.** `src/inference/ollama-client.ts` posts
to `/v1/embeddings` (chosen so the "point it at any OpenAI-compat server" story of
Decision 12 holds). Had we added `keep_alive` there, it would have returned 200,
passed review, shipped, and done **nothing** — no error, no warning, no log line.
Setting the duration requires Ollama-native `/api/embed`, which costs the
endpoint-portability property that endpoint choice exists to preserve. Recorded as
a deliberate non-change: bad trade for a ~3 s cold load a few times a day.

**Where the observed 1h window actually came from.** The machine's **User** env
`OLLAMA_KEEP_ALIVE=1h`, not this repo — `grep -rE 'keep_alive|keepAlive|KEEP_ALIVE'`
over the tree has **zero hits**. So keep-alive behaviour here is *machine state*, and
a contributor without that variable gets Ollama's own default instead. That default
is documented as 5 minutes but was **not verified in this pass** — if anything ever
depends on it, probe it.

**Method caveat worth keeping.** These probes mutate shared local state: the 10 min
arm left the live model on a 10 min timer, which was explicitly restored to 1h with
a follow-up `/api/embed` call. A keep-alive probe is not read-only — restore it, or
the next person's cold-start measurement is measuring your leftover.

**Unrelated but observed while measuring:** the GPU sat at **89 °C while drawing
36 W of 115 W** at near-idle. That is a thermal/fan condition on the box, not
anything Ollama or Golem is doing, and it is noted here only so a future latency
measurement on this hardware is not read as a software regression.

## §103 — Headroom's net effect on CACHING traffic MEASURED: 8.7×–11.3× WORSE than not compressing (2026-07-30, answers §34 conclusion 3)

§34 measured Headroom's gross saving and closed with an explicit refusal to claim a
net number: *"No net savings may be claimed until this is measured live."* That
question stayed open for 25 days. It is now measured, offline, on two real
transcripts from this repo. **The gate in Decision 31 is correct, and the margin is
not close.**

### The gross number is real — and larger than §34 recorded

`scripts/measure_headroom.py`, `headroom-ai==0.30.0` (the shipped pin), no torch:

| transcript | messages | tokens before | gross saved |
|---|--:|--:|--:|
| `9d45e10b…` (2026-07-30) | 1,404 | 445,116 | **7.08%** |
| `fa06e9c0…` (2026-07-15) | 4,631 | 2,010,745 | **21.69%** |
| §34's session (2026-07-05) | 2,008 | 787,169 | 5.48% |

**Savings scale with session length**, which §34's single sample could not show —
1,433 transforms fired on the 4,631-message history. `read_lifecycle` earns more the
longer an agent works, because more files get re-read and superseded. Still flat
across `target_ratio` / `savings_profile` / `compress_user_messages` (confirming
§34/§35: those knobs drive the absent ML stage, and §35 already showed ML is
irrelevant on code traffic regardless).

### The net number, and the structural reason it is bad

New: `scripts/measure_headroom_cache.py`. The insight that makes this cheap to
measure — **you do not need live billing to answer it.** Find the first index where
the compressed history stops matching the original; everything from there on is a
changed prefix, so it cannot be a cache hit. That index is the whole ballgame.

| | `fa06e9c0…` | `9d45e10b…` |
|---|--:|--:|
| first divergence | message **6** of 4,631 | message **21** of 1,404 |
| untouched prefix still cache-readable | **0.01%** of history | **1.00%** |
| A: no compression (0.1× on all) | 126,814 units | 30,426 units |
| B: compressed (0.1× prefix + 1.25× suffix) | 1,107,999 units | 342,388 units |
| **verdict** | **NET LOSS 8.74×** | **NET LOSS 11.25×** |

**Why divergence is always early, and why that is not fixable by tuning.**
`read_lifecycle` saves tokens by dropping the *earliest superseded* copy of a
re-read file. The transform's value and its cache damage are the *same act*: the
stalest copy is by construction near the start of the history. A transform that
paid off later in the history would be a different, weaker transform. So this is
not a bad default to be tuned around — it is inherent to how the saving is earned.

Against a **98.4% billed hit rate** (§93), 0.1× on everything beats 1.25× on 70% of
it by an order of magnitude. Trading a 21.7% gross reduction for near-total prefix
loss is the §31 artifact trap in its purest form: the gross number looks like a win
and the bill goes up ~9×.

### On a non-caching upstream it is a clean win

Same runs, priced without a cache: **9.06%** and **30.09%** saved. This is exactly
Decision 23's "compression is situational" claim, now measured on *both* sides
rather than asserted on one. The sidecar is worth keeping for the case (a)
non-caching providers; it must never engage on Anthropic.

### Consequences

1. **`force_semantic_on_caching` must stay `false`.** Its doc comment said the risk
   was unproven ("until proven net-safe by a real `aggregateUsageBySemanticForced`
   comparison"). It is now proven *un*safe. The live-A/B path remains available for
   research, but nobody should flip this expecting savings.
2. **The R2.6 live A/B is no longer worth spending real tokens on.** It was scoped
   to answer this question against live billing. An 8.7×–11.3× predicted loss does
   not need confirming at cost; if it is ever run, run it to validate the *model*,
   not to look for a win.
3. **Every surface that named the level was lying by omission.** `golem status`
   reported `Slider: level 3 (aggressive)` while the two stages that distinguish
   levels 2–3 from level 1 were gated off, so the observed behaviour was level 1.
   Fixed in the same batch, and the fix took two passes worth recording: the first
   added a *warning line beneath* the headline, which is not enough — a footnote
   under a headline that still reads "aggressive" leaves the headline wrong. The
   **label itself** now carries the effective level, at every surface that prints
   one: `golem status` (headline, dial line, reason), `golem statusline` (leads with
   the running level, badges the inert one — the per-prompt surface, so the
   most-read version of the misreport), the `golem` TUI header, `golem slider <n>`
   at set time, and the `level` MCP tool (whose reply otherwise teaches the *model*
   a false belief about its own context budget).
4. **The script is the reusable gate.** Any future compressor (Caveman-class,
   context substitution, a new Headroom release) gets held to the same bar: report
   first-divergence index, not just gross tokens. A compressor that only touches the
   *tail* of history could pass this gate where Headroom fails it — that is the shape
   worth looking for.

### Honest limits

- The flattening tokenizer in the cache script counts 1,268,139 where Headroom's own
  counts 2,010,745 (it does not descend every block shape). **Absolute cost-units are
  understated; the A/B ratio is not affected** — both arms use the same counter. The
  first-divergence index, which drives the verdict, is tokenizer-independent.
- This prices one steady-state turn against a warm cache, not a full session replay
  with Claude Code's real ≤4 cache breakpoints. A breakpoint-accurate simulation would
  change the multiple, not the sign: with divergence at message 6, no breakpoint
  placement rescues the prefix.
- Measured on this repo's own agent traffic (heavy Read/Edit, long sessions). A
  workload with a different re-read profile would show a different gross number; the
  net argument depends only on divergence being early, which follows from the
  transform's design rather than from this workload.

---

## §104 — R8.13 closed: §99's 98%-wrong verdict was a `cache_control` marker counted as content, not a colliding conversation key (2026-07-31)

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md (re-read
2026-07-31), plus a live trace on this repo's own traffic through the running proxy.

§99 recorded 142 `bust` / 3 `first` / **0 `append`** against a billed 98.4% hit rate and
named three candidate causes, leading with a colliding conversation key. **The leading
candidate was wrong.** The fix was one line of hashing.

### The diagnosis, measured not reasoned

`cacheBustMessageIndex` and `cacheMessageCount` were added to the pipeline event first,
because the discriminator §99 needed had never been recorded: a bust said *that* an
earlier byte changed, never *how far back*. One proxy restart and three turns settled it:

| request | verdict | component | bust index | messages | billed read | billed write |
|---|---|---|--:|--:|--:|--:|
| n | `first` | — | — | 41 | 77,240 | 313 |
| n+1 | `bust` | messages | **40** | 43 | 77,553 | 483 |
| n+2 | `bust` | messages | **42** | 45 | 78,036 | 235 |

The bust index is always `prevCount - 1` — **the previous request's final message**,
every single turn, while the bill shows a ~99% cache read. That rules the conversation
key out (one `first`, a coherent chain, no interleaving) and points at the last message.

**The cause: Claude Code moves its `cache_control` breakpoint to the newest block each
turn.** The previously-final block therefore *loses* a key it used to carry, its JSON
hash changes, and `classifyPrefixChange` called it an edit to already-sent history.

### What the docs say (the part that decides it)

- **`cache_control` is a breakpoint marker, not cached content.** The cache key is "a
  hash of the prefix ending at that block" — of *content*. Breakpoint placement is not
  on the documented invalidation list (that list is tool definitions, web-search and
  citations toggles, speed setting, `tool_choice`, images, thinking parameters, effort,
  non-tool results with thinking).
- Verbatim on exactly our case: *"blocks that were previously marked with a
  `cache_control` block are later not marked with this, but they will still be considered
  a cache hit (and also a cache refresh!) if they are hit within 5 minutes."*
- **Reads walk backward.** "If none exists, it walks backward one block at a time" —
  which is why a moved breakpoint still finds the earlier write.
- **The lookback window is 20 blocks**, the breakpoint counting as the first. A turn that
  appends 20+ blocks past the last write misses a prefix that is still byte-identical and
  still live. A second breakpoint opens a second window that recovers it.

### The fix

- Hashes exclude `cache_control` at any depth, via a `JSON.stringify` replacer rather
  than a deep clone (no copy allocated on the request path).
- `blockCounts` and `breakpoints` added to the fingerprint, and a fourth bust component
  **`lookback`** models the 20-block window — a bust where *nothing changed* and the fix
  is an extra breakpoint, not fewer edits. Suppressed when the request carries ≥2
  breakpoints, since a second window would find the write.
- `cache_report` gained a `lookback` bucket and a **deepest history bust** line
  (`message 40 of 43 — 3 message(s) (7.0% of history) re-prefilled`).

### The gate: the distribution is now explicable

Live, post-deploy, same repo and workload:

| | before (§99) | after |
|---|--:|--:|
| append | 0 | **8** |
| bust (all `messages`, all tail) | 142 | 3 |
| append share | **0%** | **73%** |
| billed hit rate | 98.4% | 99.0% |

And the surviving busts are **real**, not residue — they predict a billed difference,
which is the whole point of a predictor:

- mean billed cache **write on bust turns: 2,951 tokens** (n=3)
- mean billed cache **write on append turns: 892 tokens** (n=11)

**3.3×.** Before the fix the verdict predicted nothing at all, because every turn was a
bust. The remaining busts are genuine tail rewrites (an already-sent last message whose
content really did change between turns — ephemeral `<system-reminder>` blocks are the
obvious candidate; not chased, because the verdict is now correct either way).

### Two lessons worth keeping

1. **§99's own leading hypothesis cost nothing to disprove and would have cost a
   redesign to implement.** Candidate A (prefix-chain identity) would have removed the
   conversation key — machinery, in exchange for nothing, since the key was never the
   problem. What settled it was recording *one more number* (the bust index) and reading
   three requests. Instrument before redesigning.
2. **"A bust" was never one thing.** A change at index 2 of 180 re-prefills everything;
   one at index 179 of 180 costs the tail. Reporting them under one counter is what let a
   98%-bust report coexist with a 98.4% hit rate for a day. Even across the *whole*
   pre-fix history the deepest bust re-prefilled only 7.0% of the history — visible at a
   glance now, invisible before.

## §105 — §91 closed on both halves: the docs now state PreToolUse precedence, and a live run proves `deny` beats a rewrite (2026-07-31)

Task `hook-precedence`. Source: `code.claude.com/docs/en/hooks` (re-read 2026-07-31,
served from Golem's own webcache), plus a live run against **Claude Code 2.1.220**.

**Half one — the docs no longer withhold it.** §91 recorded the precedence question as
undocumented and pointed at `#pretooluse-decision-control` as the place to look next.
That section now contains the sentence verbatim:

> When multiple PreToolUse hooks return different decisions, precedence is
> deny > defer > ask > allow.

and, on `permissionDecision`:

> Deny and ask rules are still evaluated regardless of what the hook returns

So the *conflicting-decisions* case is settled by the vendor: `deny` outranks everything.

**Half two — the case the docs still do not cover, asserted.** The RTK shape is not a
conflicting decision: it returns **no `permissionDecision` at all**, only
`hookSpecificOutput.updatedInput`, which "replaces a tool's arguments before it runs".
Nothing in the reference says what happens to that rewrite when a *different* hook on the
same call denies. §91's instruction was "assert it; do not trust it", so
`tests/e2e/hook-precedence.live.test.ts` does:

- a temp project with **two** project-scope `PreToolUse` hooks, both `matcher: "Bash"` —
  one returning only `updatedInput` (rewriting the command to one that creates a marker
  file), one returning `deny`;
- a real `claude -p` turn asked to run `cat note.txt` through Bash;
- ground truth is the **marker file**: if it exists, the rewritten command executed and
  the deny lost.

**Observed: both hooks fired on the same call, and the marker was never created.** The
deny won; the rewrite was discarded rather than executed. The test also refuses to pass
vacuously — it fails if neither hook fired, which would mean Bash was never attempted.

**What this licenses.** Golem's `deny` paths — snooze enforcement (Decision 45),
coder-first (Decision 39), the autonomy gate (ADR-0002) — are safe to rely on alongside a
peer that rewrites Bash input. §96's finding stands as the *other* asymmetry: a peer's
rewrite can still change what Golem's classifier *reads* (fixed by `stripOutputWrapper`),
and that is a matching problem, not a precedence one.

**Cost of the check, and why it is opt-in.** The test spends one model turn, so it is
gated behind `GOLEM_LIVE_CLAUDE=1` and never runs in the default suite:

```
GOLEM_LIVE_CLAUDE=1 npx vitest run tests/e2e/hook-precedence.live.test.ts
```

Re-run it after any Claude Code upgrade that touches hooks — this is a vendor behaviour
pinned by observation, not by contract, and the docs were silent on it three days ago.

## §106 — R8.8: models.dev's JSON API is usable, its web table is not, and Anthropic's own prices stay the authority (2026-07-31)

Checked before wiring R8.8's catalog, because the whole feature turns tokens into
**money** and a wrong price is worse than no price.

**The web page renders several Anthropic models at $0.00.** `https://models.dev/`
(fetched 2026-07-31) lists `anthropic/claude-opus-5`, `claude-sonnet-5`,
`claude-fable-5` and `claude-opus-4-8` in its Price column as **`$0.00 / $0.00`**.
Had the catalog been built by scraping that surface, Golem's cost report would have
priced this project's entire Opus traffic at zero.

**The JSON API is correct.** `https://models.dev/api.json` (HTTP 200,
`application/json`, 3,325,795 bytes) is a provider map, and the Anthropic entries
carry real numbers:

```
{ "anthropic": { "id", "env", "npm", "doc",
    "models": { "claude-opus-5": {
      "limit": { "context": 1000000, "output": 128000 },
      "cost":  { "input": 5, "output": 25, "cache_read": 0.5, "cache_write": 6.25 } } } } }
```

Shape as of this date: **175 providers, 5,900 models**; every model carries
`limit.context`, 404 of the 5,900 carry **no** `cost` block. Trimmed to the fields
Golem reports the whole set is **723 KB**, which is why the cache stores a
normalised derivation rather than the upstream document.

Spot-checks against Anthropic's published pricing (per MTok, input/output):
`claude-opus-5` 5/25 ✓, `claude-haiku-4-5` 1/5 ✓, `claude-sonnet-5` **2/10** —
the introductory price in force through 2026-08-31, not the 3/15 list price.

**Design consequence (shipped).** Two layers with the built-in winning:
Golem's own dated table (`BUILTIN_MODEL_CATALOG`, sourced from
`platform.claude.com/docs/en/pricing`, `asOf: 2026-07-31`) is authoritative for the
7 Claude ids this project runs on; the fetched catalog only **fills gaps** and can
never overwrite a built-in entry (`mergeCatalogs`). Nothing fetches implicitly —
`golem models refresh` is the only network path, so a cost report can never depend
on a third party's uptime or a third party's mistake. `claude-sonnet-5` carries a
`note` naming the introductory window, because a price with an expiry date that
prints without one is a trap for whoever reads the report in September.

**Live numbers after wiring (this repo, 24h window, 20 attributed samples):**
`in 40 / write 12,359 / read 9,627,462 / out 4,738` → **$5.01**, i.e. ~96% of the
bill is cache *reads* at 0.1×. The remaining 1,501 samples in the same window are
reported as **unattributed** rather than priced, because they were recorded before
the proxy tagged the model — the honest degradation the task's gate asked for.

**Third time for the same defect class.** `parseEvent` in
`src/telemetry/jsonl-store.ts` is a field-by-field allow-list, so the proxy wrote
`model`/`modelProvider` on every sample while `golem bench cost` reported *every*
sample as unattributed — exactly §99/R8.13's failure, and before that R8.1's. Only
running the real command against real telemetry caught it; the unit tests were
green throughout. The round-trip test in
`tests/integration/cache-verdict-roundtrip.test.ts` now covers the model fields
too. **Any new `TelemetryEvent` field needs a line in `parseEvent` AND a case in
that file.**

## §107 — P3b answered: caveman-shrink saves 53 of 1,089 description tokens (4.9%) with no accuracy change — a reproducible negative (2026-07-31)

The last open Caveman-adoption row. §87 flagged that `caveman-shrink`'s install and
config were **undocumented on the README**, so this starts with what the package
actually is, then runs Golem's existing gate against *their* implementation rather
than rebuilding it (P3b's whole point).

**What the package is** (`caveman-shrink@0.1.0`, MIT, published 2026-05-01, 4 files,
11,674 bytes unpacked; `main: compress.js`, `bin: index.js`; repo
`JuliusBrussee/caveman`, directory `mcp-servers/caveman-shrink`). The npm *web* page
403s to a plain fetch; `npm view caveman-shrink --json` and `npm pack` both work, and
the tarball's own README documents the surface §87 could not find:

- **Install/wrap:** `npx caveman-shrink <upstream-command> [...args]` — a **stdio MCP
  proxy** that spawns the upstream server as a subprocess and rewrites `description`
  fields in `tools/list` / `prompts/list` / `resources/list` responses.
- **Config (env only):** `CAVEMAN_SHRINK_FIELDS` (default `description`) and
  `CAVEMAN_SHRINK_DEBUG=1`.
- **Deliberately not touched in v1:** request payloads to the upstream, and
  `tools/call` response content.
- **Transform** (`compress.js`): drop articles / fillers / pleasantries / hedges /
  leading "I'll|you can|let me", collapse whitespace, re-capitalise sentences —
  with fenced code, inline code, URLs, paths, CONST_CASE, dotted.calls and version
  numbers protected by sentinel substitution.

**How it was measured.** New mode `--shrink ext-caveman-shrink` on `golem bench
tools`, resolving `compress.js` from the **user's own install** (`src/tools/ext-shrink.ts`;
`--shrink-path` / `GOLEM_CAVEMAN_SHRINK` / `caveman-shrink/compress.js` / package
root, in that order). Golem ships none of its bytes, and an unresolvable package is a
hard refusal — measuring an identity transform would publish a fake 0% under their
name. Run: 27 selection cases × 3 repeats, chooser `qwen2.5-coder:7b` (`--role
drafter`; the tier's `classifier` model is still not pulled — the `local-models`
warning now says so up front rather than after the fact).

**The number.**

| | baseline | caveman-shrink |
|---|--:|--:|
| description tokens (Golem's 12 tools) | ~1,089 | **~1,036** |
| accuracy (27×3) | 88.9% | 91.4% |
| false positives | 3 | 3 |
| abstentions | 3 | 0 |

**~53 tokens saved — 4.9% of the descriptions.** Accuracy nominally +2.5 points, which
the harness itself flags as within ~1 case of the baseline on 27×3: `NO-MATERIAL-CHANGE`.
Per-string savings are 1.3%–11.6% of characters on Golem's own prose (probe against
their `compress()`), because these descriptions are already terse — the transform's
own protections (code/paths/identifiers) cover much of what is left.

**Verdict: reproducible negative, and the same one §100 reached from the other side.**
53 tokens is **0.04% of a 139k request**, it sits in the cached prefix at 0.1×
(≈5 full-price-input-token equivalents per request), and collecting it would mean the
proxy rewriting tool descriptions in flight — including other servers' and the
client's built-ins, which §100 established are 93.9% of the block and not Golem's to
rewrite. There is no accuracy objection to their transform; the objection is that the
prize does not exist. **Not adopted, not vendored, not wrapped.** The mode stays in
the harness so anyone whose catalog is more verbose than Golem's can rerun the gate
on their own descriptions in one command.

**Note the shape of the finding:** the accuracy risk was never the binding constraint
here either (§100's lesson, restated) — *ownership* and *magnitude* were.

## §108 — R8.S2 answered: system-prompt slimming is 0.92% of the request and is DECLINED (2026-07-31)

The spike expected a no; the deliverable was the arithmetic. Third independent
capture of the system prompt on this project's own traffic (§95: 3,350; §100: 3,365;
here **3,347** tokens) — remarkably stable, and **0.92% of a 362,283-token request**.

**Live per-request cost basis** (`golem bench cost`, 24h, the 20 samples R8.8 now
attributes): `in 40 / cache-write 12,359 / cache-read 9,627,462 / out 4,738` across
20 requests → **~48,912 full-price-input-token equivalents per request** (write 1.25×,
read 0.1×), and ~237 output tokens per request. So ~96% of the input bill is cache
*reads*, and the system prompt is inside that cached prefix.

**What a trim would collect** (cut × 0.1× cache-read, then Opus 5 at $5/MTok input,
at this repo's ~1,500 requests/day):

| trim of `system` | tokens | equivalents/request | share of request's input cost | per month |
|---|--:|--:|--:|--:|
| 10% | 335 | 33.5 | 0.068% | **$7.54** |
| 30% | 1,004 | 100.4 | 0.205% | **$22.59** |
| 50% | 1,674 | 167.4 | 0.342% | **$37.66** |

**What it risks.** An unstable rewrite — one whose bytes move between turns — busts
the tools+system prefix on every request: the whole 362k prefix reprices from 0.1× to
1×, **+326,055 equivalents ≈ 6.7× a normal request**, i.e. **3,247× the per-request
saving a 30% trim would collect**. Golem has already measured the shape of that
mistake once (§103: Headroom on caching traffic, 8.7×–11.3× worse than doing nothing).
Byte-stability is achievable — Decision 52's marker-fenced append proves it — so the
risk is manageable rather than inevitable, but the asymmetry is the whole story.

**Why it is declined even at $22/month.**

1. **The bytes are not Golem's.** `system` is where the *client* puts the instructions
   that make the harness work. Trimming them is a fidelity change, and CLAUDE.md's
   hard rule is byte-faithful passthrough at level ≤1 — so this could only ever be a
   level-2/3 behaviour, where Decision 23 already says the input axis is ~0% on
   caching traffic. Same ownership argument that closed §100 (93.9% of the tools block
   is the client's) and §107 (caveman-shrink's 53 tokens).
2. **Nothing in it is provably inert.** The one transform this project ever proved
   invisible — dropping `$schema` (§100) — was worth 72 tokens (0.05%) and was still
   rejected for mutating a cached prefix. There is no equivalent "provably ignorable"
   region of a system prompt; every candidate cut is a behaviour bet.
3. **The prize is 0.2% for a behaviour bet on the highest-consequence bytes in the
   request.** A 30% cut of the client's own operating instructions to save one fifth
   of one percent is not a trade this project should offer its users.

**Verdict: DECLINED, not deferred.** No code shipped; `system` keeps its only
sanctioned mutation, Decision 52's byte-stable marker-fenced append. Reopen only with
a *provably inert* region and a byte-stability proof, and even then measure against
this table first. Fourth consecutive input-side idea to die on the same two questions:
**whose bytes are they, and how big is the prize actually** (§100, §103, §107, §108).

## §109 — R8.6 shipped: four LSP questions as `code` modes cost +333 definition tokens *when enabled*, and 0 when not (2026-07-31)

R8.6's gate was cross-OS spawn/lifecycle plus "server absent → no-op, never an error
path". Both are met. The number the R8b discipline demands is the definition cost, and
it has an unusual shape here: **it is zero in the shipped default.**

**Measured** (`golem bench tools`, this repo, 12 tools):

| | `code` desc | `code` schema | `code` full | block full |
|---|--:|--:|--:|--:|
| before R8.6 | ~101 | ~161 | ~437 | ~4,562 |
| after, LSP **off** (default) | ~101 | ~161 | ~437 | **~4,540** |
| after, LSP **on** (`--lsp`) | ~159 | ~301 | ~770 | ~4,895 |

Two readings:

1. **Off costs nothing — it costs 22 tokens less.** The LSP mode enum, the `file` /
   `line` / `character` / `symbol` parameters and the extra prose are only added to the
   schema when a bridge is injected (`knowledge.lsp_enabled`, default **false**). The
   −22 is incidental: making the map-only output fields `.optional()` — an LSP mode
   answers a position, not a tree, and reporting `files_scanned: 0` for it would be a
   claim about a scan that never happened — shortened the serialised `required` list.
2. **On costs +333 full-definition tokens, and modes are ~3× cheaper than tools.**
   Every tool pays a fixed envelope: `devices`, with a 9-token schema, still costs ~318
   full. Four separate `diagnostics`/`definition`/`references`/`hover` tools would each
   pay that envelope — ≈1,000–1,300 tokens on the same census — against the +333
   measured for one tool with four extra modes. §100's "a tool definition is a permanent
   per-request bill" is what made this the design, and the census now shows the size of
   the avoided bill rather than asserting it.

`--lsp` is a new flag on `golem bench tools` precisely so the on-state is measurable
rather than assumed; the default census keeps reporting the state users actually ship,
which is the §99/§104 lesson about metrics that describe a configuration nobody is in.

**What is verified, and what is not.** 17 integration tests spawn a real child process
(`tests/fixtures/fake-lsp-server.mjs`, this repo's own node binary) and cover the
handshake, byte-at-a-time framing, all four modes, and every degrade path: binary not on
`PATH`, unclaimed file extension, handshake timeout, request timeout, mid-session crash
(with a pool re-spawn on the next call), protocol desync, unreadable file, missing
position. Every one resolves to `available: false` plus a reason — none throws.

**Not verified: a real language server.** `typescript-language-server` is not installed
on this machine and Golem must not depend on it (Decision 53 criterion 4), so what is
proven is the protocol and the lifecycle, not tsserver's own behaviour — notably how long
a cold project load actually takes against `knowledge.lsp_timeout_ms` (15s default), and
whether `DIAGNOSTICS_SETTLE_MS` (400ms) is enough for its two-phase publish. That is a
live-traffic question, like R8.5's displacement question, and it wants the same answer:
measure it on real use, do not guess it now.

**Also unmeasured — the same open question R8.5 left.** Whether an agent given
`definition`/`references` actually *stops* grepping and reading whole files. The
displacement claim is the whole justification for both features and neither has evidence
yet; §101's +21.4 accuracy points for the map is the closest thing, and it measures
retrieval, not avoided reads.

## §110 — R8.7: the local editor SHIPS, but only in the format the harness approved — whole-file, 91.7% semantic, and the two diff formats fail at 33.3% (2026-07-31)

R8.7's gate was "harness before code, non-negotiable", with the format as a measured
independent variable the way Aider treats it. `golem bench edit` was built first, its bar
(`EDIT_BAR` in `src/tools/edit-bench.ts`) was fixed **before the first run**, and the
result is the second R8 item an instrument *approved* rather than redirected — but it
approved exactly one of the three candidate designs, and it was not the one the task
document assumed.

**Measured** (this repo, `qwen2.5-coder:7b` at the `drafter` role, 12 hand-labelled edit
cases, `temperature: 0`, definition-loss guard active — the shipped configuration):

| format | in-format | apply | exact | **semantic** | local reply tok |
|---|--:|--:|--:|--:|--:|
| `search-replace` | 6/12 (50.0%) | 50.0% | 16.7% | **33.3%** | ~69 |
| `udiff` | 12/12 (100%) | 50.0% | 33.3% | **33.3%** | ~75 |
| **`whole`** | 12/12 (100%) | **100%** | 41.7% | **91.7%** | ~58 |

Pre-registered bar: ship at semantic ≥ 80% **and** apply ≥ 70%; advisory-only at
semantic ≥ 50%; otherwise reject. `whole` clears it; the other two are rejected by it.

**Why the two diff formats fail, and they fail differently.** The task document assumed
search/replace, because that is what Aider's leaderboard rewards on frontier models. A
7B-class local model cannot hold up either half of that bargain:

1. **`search-replace` — half the replies were not in the format at all** (6/12
   `unparsed`). Asked for `<<<<<<< SEARCH` blocks, the model returns the whole rewritten
   file instead. That is a *compliance* failure, so the harness counts it separately from
   an editing failure — an aggregated "50% apply" would have hidden which of the two was
   broken, which is §100's lesson restated.
2. **`udiff` — perfect compliance, and half the hunks still do not apply** (6/12
   `no-match`). Every reply was a well-formed diff; the model simply does not reproduce
   existing lines byte for byte, and *both* diff formats require exactly that. The
   trailing-whitespace leniency (`exact-then-trimmed`) rescued **zero** of them, so this
   is not a whitespace problem: the model paraphrases code it was told to copy.

Golem's validator turns that into a refusal rather than corruption, which is the point:
`no-match` and `ambiguous` are the two failures a search/replace applier must never
resolve by guessing.

**Whole-file wins for a reason that is also its risk.** There is nothing to copy — the
model emits the file it wants, so there is no byte-for-byte requirement to fail. That
removes the failure mode the diff formats died of and introduces one a parse check cannot
see: a rewrite that parses perfectly and has quietly *dropped* an unrelated function
("// ...rest of the file unchanged"). So validation gained a **definition-loss guard**
(`symbolCheck` in `src/tools/edit-apply.ts`): the tree-sitter definition list before and
after must not lose a name, and losing one is `symbols-lost`, a rejection. On the 12
measured cases the guard rejected **nothing** — it costs nothing here; its value is
entirely on the large files this case set does not contain, and it is pinned by unit and
integration tests that deliberately drop a definition.

**The cost, reported beside the accuracy (Decision 52's rule).**

| | tokens |
|---|--:|
| the instruction a frontier model writes | ~21 output |
| the same edit written by hand | ~51 output |
| the whole fixture re-emitted | ~44 output |
| `coder` definition, editor mode **off** (default) | 614 — **byte-identical to R8.6** |
| `coder` definition, editor mode **on** | 927 (**+313**) |

**This arithmetic does not close on the measured fixtures, and that is why the mode is
off by default.** ~30 output tokens saved per edit against +313 input tokens on *every*
request is the shape §100 rejected R8.S1 for. Two things make it shippable anyway: the
cost is **opt-in and provably zero when off** (`inference.local_editor_enabled`, default
false — `golem bench tools --editor` exists so the on-state is measurable, the `--lsp`
precedent from §109), and the fixtures are ~10–40 lines, which is the *worst* case for
the ratio. The saving scales with edit size while the schema cost is fixed, so the
honest claim is a **conditional** one: this pays on files big enough to matter and is a
loss on files this small. What is NOT measured is where the crossover sits — that needs
larger labelled cases, and until they exist `MAX_EDIT_LINES = 200` is a *guard*, not a
measured bound.

**Two instrument findings, both worth more than the verdict.**

- **`--repeats` cannot sharpen this harness.** At `temperature: 0` all three arms
  reproduced identical per-case outcomes across 2 and 3 passes (36 attempts per arm, same
  rates as 12). The report now says so: repeats buy reproducibility, not statistical
  power, and only more cases move the ±8.3-point resolution. Any future "raise repeats"
  advice on a deterministic local model is noise.
- **The compliance/apply split is the finding.** Had the harness reported one number, the
  conclusion would have been "diff formats apply about half the time" — true, and useless.
  The split says search/replace fails because the model *ignores the format* while udiff
  fails because it *cannot copy*, and only the second is a property of the model rather
  than of the prompt.

**What is verified, and what is not.** 50 unit tests over the parsers, the validator, the
diff renderer and the harness's own verdict logic (including the adverse-error guard and
the §100 insensitivity check), plus 9 MCP integration tests over the shipped mode: propose
by default, write only on `apply: true`, refuse a definition-dropping rewrite, refuse a
path outside the project root, refuse a file above the cap, and the schema's absence when
the flag is off. **Not verified:** any file over ~40 lines, any language without a
tree-sitter grammar (those can be *proposed* but never written — an unvalidated whole-file
overwrite is the corruption path R8.7 forbids), and — as with R8.5 and R8.6 — whether an
agent given this mode actually *stops* writing edits itself. That is the same live-traffic
displacement question, and it is still open.

## §111 — R8.9 shipped: a change ledger on shadow refs; the live smoke test caught what 11 green tests could not (2026-07-31)

**What was built.** `golem checkpoint create|list|show|restore|drop|prune` snapshots the
worktree into `refs/golem/ledger/<id>` — a `commit-tree` object parented on `HEAD` that no
branch points at — and can put it back. The task's rule was the repo's own: **commit only
when asked**. So: no branch, no commit on `HEAD`, and no index write, because every staging
step runs against a throwaway `GIT_INDEX_FILE` at `<gitDir>/golem-index-<pid>-<n>` and the
restore is `read-tree` + `checkout-index -f -z --stdin` against that same temp index. Two
consequences worth recording: git's default fetch/push refspecs do not carry
`refs/golem/*`, so a checkpoint cannot leave the machine by accident; and since a snapshot
is an ordinary commit, `git diff refs/golem/ledger/<id>` works with no Golem command
involved.

**The gate split, and why.** `restore|undo|drop|prune` are classified `destructive` in
`src/autonomy/classify.ts`, which puts them in ADR-0002's never-auto set — no autonomy
level approves them, and `ask` overrides an allow-list (this repo allow-lists
`Bash(golem:*)`, so that override is the operative half). `create`/`list` were deliberately
left unescalated: gate the *snapshot* and the model stops taking snapshots, at which point
the feature saves nothing. A restore also takes its own `pre-restore` checkpoint first and
prints the command that reverses it, which is what makes a preview-plus-prompt sufficient
consent for a destructive act.

**No MCP tool, on purpose.** §88/§100 measured what a tool definition costs on every
request (~250–320 tokens of envelope before any content). The model reaches this through
`Bash` for free, so the guidance ships as a lazy `/golem/checkpoint` skill plus one
paragraph in `/golem/develop`. First R8 feature where that trade was made explicitly rather
than by default.

**Finding 1 — the smoke test found the bug, 11 green tests did not.** In a scratch repo
with **no `.gitignore`**, the first live restore reported "2 deleted" against a plan of 1.
The extra path was Golem's own `.golem/` state — telemetry, tasks, CCR blobs — written
*after* the checkpoint by the very command under test. A restore that deletes it is
rewinding Golem, not the user's attempt. Fixed by putting the exclusion in the pathspec
(`git add --all -- . :(exclude).golem`) so the snapshot and the plan agree it is out of
scope; a filter on the delete list alone would have left it inside the tree and inside
every diff. Why no test caught it: every realistic project gitignores `.golem/`, so
`.gitignore` was silently doing the job. The regression test now creates `.golem/` state
**untracked and un-ignored** and asserts the plan is empty of it. Generalisable: a
Golem feature that walks the worktree must exclude Golem's own state *explicitly*, never
by relying on the user's ignore file.

**Finding 2 — restored files carry git's line endings, not the disk's.** `checkout-index`
runs the smudge filter, so with `core.autocrlf=true` (this machine, and many Windows
installs) an LF-only working copy comes back CRLF; three tests failed on `\r\n` before this
was understood. Not a defect — it is exactly what `git checkout` does, and matching git is
the contract — so it is documented in `src/checkpoint/ledger.ts` and on the concept page,
and the test repos pin `core.autocrlf=false` so the suite tests the ledger rather than the
developer's git config.

**Degrade paths, all asserted.** No git on `PATH`, not a repo, a **detached HEAD**, and a
**dirty index** each produce a no-op naming the reason — never a partial restore. The
dirty-index refusal is not squeamishness: a restore writes worktree files, so staged
content would afterwards describe a state that no longer exists on disk. An **unborn HEAD**
(a repo with no commits) is supported rather than refused — the snapshot is simply
parentless — which also drove the choice of `status --porcelain` over `diff --cached` for
the staged-change probe, since the latter errors with no HEAD to compare against.

**Also of note (dogfooding).** Golem's redaction stage rewrites e-mail literals on the way
*back* to the model, so the committer address written into `ledger.ts` reads as
`[REDACTED:email:N]` when the model greps for it afterwards. The bytes on disk are correct
— it is a display effect — but an agent cannot `Edit`-match such a line and must anchor
elsewhere. Worth knowing before someone "fixes" a redacted-looking literal in source.

**What is not measured.** The saving is structural: no one has yet counted a repair cycle
against a discard on real traffic. The mechanism costs ~0 tokens when unused (no
definition, no hook), so the downside is bounded, but "discarding is cheaper than
repairing" rests on §93's re-reading share, not an A/B. And the displacement question R8.5
and R8.6 both left open applies again: whether an agent actually reaches for a checkpoint
before a risky attempt is a dogfooding observation nobody has made yet.

## §112 — `proxy stop` leaves Claude Code wired to a dead port, and `settings.json` `env` is NOT hot-reloaded (2026-08-06)

Found by dogfooding: the user stopped the proxy from the VS Code UI and observed that
the Anthropic base URL was not removed. Traced and confirmed; the finding has two halves,
and the second is what makes the obvious fix insufficient.

**(a) Nothing in the stop path touches the wiring.** `setProxy(false)` in
`vscode-extension/extension.js` runs `golem proxy stop --dir <cwd>` and nothing else. The
`stop` action in `src/cli/commands/proxy.ts` does exactly two things —
`writeProxyDesired(dir, "stopped", …)` and `stopProxy(dir)` (kill the pid). No surface in
that path reads or writes `.claude/settings.json`. So `ANTHROPIC_BASE_URL` keeps pointing
at `http://localhost:<port>` after the listener is gone, and every subsequent Claude Code
request fails with connection-refused. Not a regression — the behaviour was never designed.
§46 added the VS Code toggle and only ever specified the process lifecycle.

**(b) Unwiring alone cannot rescue the running session.** `ANTHROPIC_BASE_URL` reaches
Claude Code through `.claude/settings.json` → `"env"`. §13 (settings hierarchy, live docs
2026-07-03) enumerates what hot-reloads: `permissions`, `hooks`, `apiKeyHelper`. `env` is
**not** in that set, and `model`/`outputStyle` are explicitly called out as needing a
restart. Golem's own `docs/wiki/concepts/Dogfooding Golem.md` escape hatch independently
says to remove the var *"and reopen the editor"*. Both point the same way: deleting the key
on `stop` fixes the **next** session and leaves the current one broken. Any design that
stops at "delete the key" therefore does not solve the reported symptom.

**(c) The naive shim would breach a hard rule.** The seamless fix is to keep the port
served by a forward-only listener. The tempting implementation is the existing pure-
passthrough path (`BYPASS_HEADER` = `x-golem-bypass`, `src/proxy/types.ts`, or slider
level 0), and it is wrong: that path forwards untouched, which means **redaction off**.
CLAUDE.md permits level 0 as the single redaction-off exception precisely on the condition
that it is never the default and always surfaced loudly, and `src/cli/skills.ts` already
tells agents to "prefer level 1 (redaction on, byte-faithful) unless a true full bypass is
intended". A Stop button that silently routed unredacted prompts upstream would make the
redaction-off path reachable from a click that says nothing about redaction. The shim must
serve at level-1 semantics.

**(d) The unwire guard already exists — reuse it.** `src/cli/init.ts` deletes
`ANTHROPIC_BASE_URL` only when it equals Golem's own computed base URL (the
`env[ENV_BASE_URL] === baseUrl` test, used at both the Foundry-switch and `uninit` sites),
and `init` refuses outright when a *foreign* base URL is present. That ownership check is
exactly what a `proxy unwire` needs, and re-deriving it would be how a third-party
gateway's wiring eventually gets clobbered.

Recorded as spec Decision 56 and task R8.31.

## §113 — SessionStart has five sources, not two; the auto-start matcher missed three (2026-08-08)

Source: https://code.claude.com/docs/en/hooks.md (fetched 2026-08-08).

Found by dogfooding: after a PC restart the user opened VS Code with the Claude Code
panel visible and the proxy was not running. Corrects the matcher recorded in §47.

**(a) The documented `source` set is wider than the matcher.** The live matcher table
gives `SessionStart` five values — `startup`, `resume`, `clear`, `compact`, `fork`. §47
wired `startup|resume`, which was the known set at the time; `fork` postdates it. So a
session begun by `/clear`, by a compaction, or with `--fork-session` did not run
`golem hook session-start`, and a proxy left down stayed down through it. Widened to
`startup|resume|clear|compact|fork` in `SESSION_START_MATCHER`
(`src/hooks/settings-writer.ts`) and in this project's `.claude/settings.json`. No test
pinned the old literal.

**(b) Auto-start is session-scoped, and that is not the same as project-open.** The hook
itself is healthy — invoked directly with a `{cwd, source}` payload it exits 0 in ~2.7s,
far inside its 15s timeout, and `startDetached` unrefs a detached child that would
survive the timeout anyway. Desired state was `running`, so the `desired=stopped` no-op
path was not taken either. The evidence is a 15-minute hole: boot 19:13:01, proxy pid up
19:28:11, telemetry resuming 19:28:59. The docs say hooks fire in IDE extensions the same
as anywhere ("sessions in the terminal, IDE extensions, the Desktop app, and Claude Code
on the web all fire the same hook events") but do **not** specify whether an IDE panel
creates a session at panel-open or at first message. Opening the panel does not by itself
start a CLI process, so the leading explanation is that no session existed to fire the
hook. Unproven from outside — the hook's no-op path is fail-safe and silent, so it leaves
no trace to distinguish "did not fire" from "fired and returned early".

**(c) Golem installs no OS-level autostart, by design.** No Task Scheduler entry, no Run
key, no Startup-folder shortcut, no service anywhere in the repo. The proxy is a detached
`node` process and a reboot kills it; §47's recovery is on project open, not on logon.
User decision 2026-08-08: leave that as-is. The practical consequence, worth stating
because it is not obvious from §47, is that after a reboot the proxy returns on the first
*message*, not when the editor or panel opens. `golem proxy start --detach` or the VS Code
status-bar toggle closes the gap manually.

---

## §114 — Claude Code passes ANY model string through behind a custom `ANTHROPIC_BASE_URL` — virtual model ids are viable (2026-08-08)

**Why this was checked.** `docs/plan/proposals/multi-target-routing.md` makes a
*virtual model id* (`model: "golem/coder"`) the primary way to select a routing
target — level 1 of its precedence chain, and the mechanism that lets a sub-agent
branch onto its own model with zero new Golem machinery. The whole UX rested on
an unverified assumption: that Claude Code forwards an arbitrary, non-`claude-*`
model string instead of rejecting or normalizing it. Task 21e's Phase 1 was
gated on this answer.

**Doc host moved.** `docs.claude.com/en/docs/claude-code/*` now 301s to
`code.claude.com/docs/en/*`. CLAUDE.md's "Verify, don't assume" section still
names the old host; it redirects, so nothing is broken, but new fetches should
go straight to `code.claude.com/docs/en/`. The full page index is at
`code.claude.com/docs/llms.txt`.

### The finding — verification PASSES

From **Model configuration** (`/docs/en/model-config`), verbatim:

> Claude Code rejects an unrecognized string with `Model "<name>" is not a
> recognized model id.` and the session keeps its current model, instead of
> saving the string and failing on the next request.
>
> **The check runs only on the Anthropic API. On Amazon Bedrock, Google Cloud's
> Agent Platform, Microsoft Foundry, Claude Platform on AWS, and behind an LLM
> gateway or a custom `ANTHROPIC_BASE_URL`, your provider or gateway defines the
> model names, so Claude Code passes any string through without checking it.**
> The check also doesn't cover the `--model` flag, the `ANTHROPIC_MODEL`
> environment variable, or the `model` setting […]

Golem **is** a custom `ANTHROPIC_BASE_URL`, so the recognition check is disabled
by construction. This is the same base-URL-conditional behaviour class as §12
(tool search disabled on a non-first-party base URL) — Claude Code repeatedly
keys behaviour off whether it is talking to the first-party API.

Corroborating, from the same page: a "model name" is explicitly
provider-defined — *"Amazon Bedrock: an inference profile ARN; Microsoft
Foundry: a deployment name; Google Cloud's Agent Platform: a version name"*.
Claude Code already forwards opaque strings it cannot validate against any
Claude allowlist, so a `golem/*` id is not a special case.

**Sub-agent frontmatter accepts full ids.** From **Create custom subagents**
(`/docs/en/sub-agents`), the frontmatter table:

> `model` — Model to use: `sonnet`, `opus`, `haiku`, `fable`, a full model ID
> (for example, `claude-opus-5`), or `inherit`. Defaults to `inherit`

So `model: golem/coder` in a sub-agent definition is a documented shape (a full
model ID), and the recognition check that might have rejected it does not run
behind our base URL.

**Already empirically true in-repo.** `sniffRequestModel`
(`src/providers/model-display.ts`) reads the client's model id back out of the
request body for R8.8 cost attribution, and R6.1's byte-faithful path forwards
it. The model field demonstrably arrives at the proxy today.

### Caveats that must be carried into the design

1. **Anthropic does not support this.** From **Other LLM gateways**
   (`/docs/en/llm-gateway`), verbatim: *"Anthropic doesn't endorse, maintain, or
   audit third-party gateway products, and doesn't support routing Claude Code
   to non-Claude models through any gateway."* Unsupported, not prohibited —
   and Golem already sits here (R6.1 case (b) translates to OpenRouter / Ollama /
   Gemini). Worth stating plainly in user-facing docs rather than implying
   blessing.
2. **Retirement warnings still fire on sub-agent frontmatter.** The
   retirement/remap warning *"also covers a `model` set in subagent
   frontmatter"* — a separate check from the recognition check. A `golem/*` id
   should not trip it (it matches no retirement schedule), but a startup notice
   naming an unknown model would be confusing; worth an empirical check.
3. **`availableModels` can restrict selection.** An org allowlist could exclude
   virtual ids. Only relevant to managed/enterprise settings, but it is a
   documented way for this mechanism to be switched off outside Golem's control.
4. **`--model` / `ANTHROPIC_MODEL` / the `model` setting are unchecked even on
   the Anthropic API**, but a bad value there surfaces as *"There's an issue
   with the selected model"* on the first request rather than at set time. Golem
   must therefore produce a clear proxy error for an unknown `golem/*` target,
   because Claude Code will not catch it.
5. **Slash in the id is unverified.** `golem/coder` contains `/`. Nothing in the
   docs forbids it and OpenRouter ids (`vendor/model`) prove slashes survive the
   wire, but Claude Code's own handling of a slashed id was not empirically
   tested. **Residual check before shipping:** run one real request with
   `model: golem/coder` and confirm the string reaches `sniffRequestModel`
   intact. If it does not, fall back to a flat id (`golem-coder`).

### Consequence

21e Phase 1's gate is **cleared on the documentation**, subject to caveat 5's
one-request empirical confirmation. The virtual-model-id UX stands, and the
fallback (hook-injected `x-golem-target` header) is not needed.

## §115 — the cache-serve red dot is Claude Code reporting a *denied* tool call, and PreToolUse still has no output substitution (2026-08-09)

Reported by the user: *"a webfetch which is serviced by golem works, but shows a red
dot in claude code."*

**Not a bug in the hook — it is the mechanism.** `runWebFetchPre` serves a cached (or
self-fetched raw) page by returning `permissionDecision: "deny"` with the content in
`permissionDecisionReason`. Claude Code renders a denied tool call as an error, so the
call goes red even though the content was delivered and the fetch was correctly skipped.
Reproduced live in this session: the WebFetch of the hooks doc returned inside an
`<error>` wrapper, prefixed `✓ Golem served this URL from the knowledge base`.

**Re-verified the PreToolUse output contract against live docs** (`code.claude.com/docs/en/hooks.md`,
fetched 2026-08-09) because §44's "no output-substitution field" finding predates several
hook changes. It still holds. PreToolUse decision control has exactly four fields:

| field | meaning (verbatim, abridged) |
|---|---|
| `permissionDecision` | `allow` / `deny` / `ask` / `defer` |
| `permissionDecisionReason` | for `"deny"`, **shown to Claude**; for `allow`/`ask`, shown to the user but not Claude; for `defer`, ignored |
| `updatedInput` | modifies the tool's **input** before execution; replaces the entire input object |
| `additionalContext` | string added to Claude's context **alongside the tool result** |

There is still **no** `updatedToolOutput` (that is PostToolUse only), no `toolResult`, no
synthetic-result field. So "return content without running the tool" has exactly one
expression: `deny` + reason. The red dot is the price.

The event list has grown since §8 — `PermissionRequest`, `PermissionDenied`,
`PostToolUseFailure`, `PostToolBatch`, `UserPromptExpansion`, `MessageDisplay`,
`InstructionsLoaded`, `TaskCreated`/`TaskCompleted`, `TeammateIdle` now exist. None of
them substitutes a PreToolUse result; `PermissionDenied` fires on *auto-mode classifier*
denials, not hook denials, so it is not a relabelling hook.

**The one untested escape** is `updatedInput` + `allow`: rewrite `tool_input.url` to a
loopback URL Golem serves the cached page from, so WebFetch succeeds normally and renders
green. It is documented and legal, but it re-introduces exactly what Decision 42 Option A
removed — WebFetch would run, including its **internal summarization model call** (which
transits the proxy, see §the Decision 42 note). That is a real cost traded for a UI
colour, so it needs measuring rather than assuming. Written up as **R9.7**.

## §116 — R9.8: `lossless_only` is unreachable by ANY config, and the daemon was discarding every warning (2026-08-09)

Measured directly against the pinned package (`uv run --python 3.13 --with
headroom-ai==0.30.0`), not from docs. Four findings, three of them contradicting
what R9.8 was written to assume.

**1. `CompressConfig` is eight flat fields, and that is the whole reachable surface.**
Confirmed by introspection: `compress_user_messages` (False), `compress_system_messages`
(True), `protect_recent` (4), `protect_analysis_context` (True), `target_ratio` (None),
`min_tokens_to_compress` (250), `kompress_model` (None), `savings_profile` (None).
`headroom.compress()` forwards seven of them to `pipeline.apply()`; `savings_profile` is
applied earlier via `apply_agent_savings_profile`. There is no `smart_crusher`,
`lossless_only` or `read_lifecycle` field anywhere on it.

**2. The nested config R9.8 proposed to reach does not work — and it is not a passthrough
problem.** `HeadroomConfig` *does* carry `smart_crusher: SmartCrusherConfig`, and
`SmartCrusherConfig.lossless_only` *does* exist (default False). But Headroom's default
pipeline builds the router with **no config at all** — `transforms/pipeline.py`:

```python
transforms.append(ContentRouter())      # ← no config argument
```

so `HeadroomConfig.smart_crusher` is held by the pipeline and never handed to anything.
Measured on a 400-row tool result, `mode="aggressive"`:

| route | tokens saved | `<<ccr:…>>` markers |
|---|---|---|
| stock pipeline | 19,181 | **37** |
| `HeadroomConfig(smart_crusher=SmartCrusherConfig(lossless_only=True))` | 19,181 | **37** |
| `ContentRouter(ContentRouterConfig(lossless=True))` | 15,740 | **0** |

`HEADROOM_LOSSLESS_ONLY` exists but is read only in `proxy/server.py` — Headroom's own
proxy, which Golem does not run. **The reach point is the transform instance, not a
config object.** Golem therefore swaps the ContentRouter inside a real default pipeline
rather than rebuilding the transform list, so an upstream release that adds a transform
keeps it; if no ContentRouter is found the option is reported, never silently dropped.

`ContentRouterConfig.lossless` is the right switch rather than
`smart_crusher_lossless_only`: it *also* sets `ccr_inject_marker = False`, so the
marker-free promise holds on every path, not just the crusher's.

**3. Headroom already protects Read/Glob/Grep/Write/Edit — when the tool name resolves.**
`DEFAULT_EXCLUDE_TOOLS` covers exactly those five. The same payload routed
`router:excluded:lossless_json` (0 markers) under tool name `Read` and
`router:tool_result:smart_crusher` (37 markers) under `Bash`. Golem forwards the whole
message array including the assistant `tool_use` blocks, so the exclusion does apply —
the marker exposure is **Bash, WebFetch and MCP tool output**, not Read.

**4. `compress_user_messages` is INERT on the shipped install.** R9.8 flagged Golem's
level-3 preset setting it True against Headroom's "skip them for coding agents" default.
Measured both ways on identical input: same 7,984 tokens saved, user prose byte-identical
(8,160B), tool_result byte-identical (37,979B). The prose-compressing Kompress stage
needs `[ml]`/torch, which the default install deliberately omits (§35), and tool_result
blocks are routed by ContentRouter regardless of the flag. **The preset is not the lever
it appeared to be** — the router is. Left as-is, documented rather than flipped.

**5. The daemon was throwing away every proxy diagnostic.** `startDetached` spawned with
`stdio: "ignore"` (`src/cli/proxy-daemon.ts`), so in the mode people actually run the
proxy in, the adapter's "this Headroom ignored …" warning — and the target-misconfig and
missing-credential warnings beside it — reached nobody. This repo's own
`.golem/settings.local.json` carries `headroom_config.plugins`, which was filtered out
and never applied; the warning existed and was invisible. The daemon now appends
stdout/stderr to `.golem/proxy.log` (front-truncated at 1 MB, falling back to `"ignore"`
if it cannot be opened), and `golem status` reports the path. A diagnostic nobody can
find is the same as no diagnostic.

**Decision taken (2026-08-09):** marker-free is Golem's **default** wherever the semantic
stage runs — 82% of the saving kept, zero markers — overridable per-request with
`headroom_config: {"lossless_only": false}`. The flagship client is a coding agent doing
exact-match edits, and a marker in a tool result is precisely what makes the model's view
of a file differ from its bytes on disk.

## §117 — R9.6: the migration shim only ever existed for one rename, and the account layer was claiming target ids (2026-08-09)

Building the declarative migration table surfaced two things the task brief did not
predict.

**1. Retiring the leaf is what makes the mechanism real.** A migration table whose
`from` key is still a live leaf is a fiction: both names remain writable, the loader
never consults the table, and nothing changes. `assertLeafRename` therefore refuses
that combination, and its test is the guard — registering a rename while leaving the
old key in `SETTINGS_LEAVES` fails the suite rather than quietly doing nothing. This
is the "example is the test" the brief asked for, inverted into an invariant.

**2. `proxy.active_account` and `proxy.default_target` had drifted apart in meaning.**
R9.1 renamed the selector and unified routing on `default_target`, but the *account*
layer (`resolveActiveUpstream`, via proxy-runtime and every display surface) went on
reading `active_account`. Retiring the leaf collapsed them — and exposed that the
unified selector may legitimately name a **target** that is not an account
(`sonnet-5`, say). The old code would have warned `active_account "sonnet-5" is not
in proxy.accounts` on every proxy start.

Fixed by giving `resolveActiveUpstream` the known target ids: a selector that names a
target is not a misconfiguration, so the account layer stands aside silently and
routing serves it. Fail-closed is not weakened — a selector in *neither* registry
still warns, and `proxy-runtime` independently fail-closes against both registries at
startup, so the unknown-id case is covered twice.

**Where the warning goes.** Config warnings surfaced only in `golem status`, the TUI
and the control surface — none of which anyone runs after an upgrade that appears to
work. They now also print at proxy startup, which is the process that actually
consumes the settings. That is only useful because R9.8 stopped the detached daemon
spawning with `stdio: "ignore"`: before that commit the line would have gone to the
same nowhere. The two tasks compose — a diagnostic and a place to read it.

**Verified live** (built CLI, temp project whose `settings.json` names only the old
key): `config get proxy.active_account` and `config get proxy.default_target` both
report `proxy.default_target = "openrouter-qwen3" — project (…/settings.json)`;
`golem status` prints the rename warning naming the file and the key to edit; and
`config set proxy.active_account …` writes `default_target` and says so. `writeSetting`
resolves retired keys too, so no write path can put a renamed key back into a file.

## §118 — R9.5: the two managed-file bugs were one missing question (2026-08-09)

Skills were overwritten on any difference; guidance was never rewritten at all.
They read as opposite bugs and are the same one: both surfaces asked *does this
file differ from what Golem ships?* — which cannot separate "Golem's text moved
on" from "the user edited it". Each picked an answer and was therefore wrong half
the time. Recording the hash of what Golem last wrote adds the missing question,
and both behaviours fall out of it: **stale** (matches what Golem wrote, so
refreshing loses nothing) vs **owned** (does not, so it is the user's).

**No record means owned — the deliberate direction.** A project initialized
before this mechanism has no hashes, so its drifted files classify as owned and
are kept with a note rather than refreshed. The alternative (refresh when
unsure) is the original data-loss bug wearing a new mechanism: Golem cannot prove
it wrote that content, so it must not discard it. The record self-heals, since
every write from here on records a hash. A corrupt or unreadable record degrades
the same way — to *keep the user's file*, never to overwrite it.

**The sentinel kept its real job.** `.golem/state/guidance.json` `{seeded:true}`
existed so `golem guidance disable` survives a re-init, and that is still exactly
what it does — but "don't undo the user's choice" and "never refresh the text"
had been the same mechanism, and only the first was ever intended. Seeding now
asks per rule: still present → refresh it if unmodified; absent → leave it absent
and say "disabled — not re-seeded". A refresh that resurrected a disabled rule
would be a worse bug than the one being fixed, so that case has its own test.

**`conflict` is a new ActionKind, not a `modify` variant.** The brief's
requirement — "'refreshing stale text' and 'replacing your edit' cannot both
render as `modify`" — is a vocabulary problem, not a message problem: any shared
kind loses the distinction wherever actions are rendered generically (the two
`padEnd` renderers, the VS Code panel, `--dry-run`). The detail text carries the
instruction, because a refusal with no way forward is just an unexplained stop.

**Verified live** (built CLI, temp project): `golem init`, append a line to
`.claude/skills/golem/ship/SKILL.md`, `golem init` again → reports
`conflict .claude/skills/golem/ship/SKILL.md — … kept your version …` and the
edit is still on disk. Before this change the same sequence silently destroyed
it, reporting only `modify`.

## §119 — R9.10: the rename was the easy half; `config set` was leaving a dead key behind (2026-08-09)

`inference.local_coder_enabled` → `inference.coder_enabled`, registered in R9.6's
migration table. The rename itself was mechanical. Two things were not.

**1. `golem config set` on a retired key left the file holding BOTH names.**
R9.6 made `set` write the live key and report the redirect, which is right — but
`writeSetting` only ever adds. So a user following the deprecation notice ended up
with `local_coder_enabled` *and* `coder_enabled` in one file, the loader's
shadowed-key warning firing on every load, and no way out but a hand edit. Found
by running the migration on this repo's own `.golem/settings.json`. `setConfig`
now deletes the retired key from **the same scope's file** after writing the live
one, via a `deleteRetiredKey` helper that deliberately bypasses migration
resolution — `writeSetting` resolves retired names, so using it to delete one
would have deleted the replacement instead. Other scopes are untouched: cleaning
up a file the command did not write would be overreach.

**2. `local_model.workers` had to move, not just be renamed.** The gate says
`golem status --json` must never report a non-local model under a `local_model`
key. With `coder` pointed at a vendor target this repo was emitting exactly that
— `local_model.workers[0].model = "claude-sonnet-5"` beside
`local_model.coder_model = "qwen2.5-coder:7b"`. Workers are now top-level with a
`local` boolean per row; `local_model` keeps only what is genuinely the local
backend. The VS Code renderer reads the new key and falls back to the old one, so
a stale extension degrades rather than breaks.

`golem local status` gained a line naming any worker that does NOT run on that
backend, because "Local model: ACTIVE" above a worker table pointing at
api.anthropic.com is a true sentence arranged to mislead.

**Verified live on this repo, which was the honest test case**: `.golem/settings.json`
still held `local_coder_enabled` after the rename, and `golem status` reported
`coder_enabled: true` (migration carried it) with a warning naming the file and
the key to edit; `golem local status` printed
``note: `coder` runs on target "sonnet-5", NOT on this backend``; `local_model`
no longer contained `claude-sonnet-5`; and `config set` on the old name left the
file holding only `coder_enabled`, after which the warning was gone.

**Sequencing paid off exactly as predicted.** R9.6 supplied the migration, so no
existing config broke. R9.5 supplied managed-file refresh, so the rewritten
`local-coder` guidance rationale — which previously said "leaves the paid model's
tokens", the inverse of the truth once `coder` points at a vendor model — actually
reaches projects that already ran `golem init`. Doing R9.10 first would have
demonstrated both bugs instead of fixing them.

## §120 — R9.7: the loopback escape is CLOSED by WebFetch's forced HTTPS; the red dot is accepted in writing (2026-08-09)

Closes R9.7. §115 left exactly one untested escape from the cache-serve red dot:
`updatedInput` + `permissionDecision: "allow"`, rewriting `tool_input.url` to a loopback
URL Golem serves the page from, so WebFetch runs normally and renders green. Tested it
live rather than reasoning about it. **Half of it works; the half that matters does not.**

### What was measured (all live, this session)

**1. `updatedInput` url-rewriting IS honoured — CONFIRMED.** A temporary probe branch in
`runWebFetchPre` (reverted; never committed) answered a marked URL with
`permissionDecision: "allow"` + `updatedInput: {url: <other>, prompt}`. `WebFetch("https://example.com/?r97-probe")`
returned **RFC 2606** ("Reserved Top Level DNS Names"), not example.com — and rendered as
a **normal, non-error tool call**. So the rewrite mechanism and the green render are both real.
Note `updatedInput` replaces the *entire* input object: `prompt` must be carried through.

**2. Every URL a local endpoint could plausibly use is rejected.** This is what kills it:

| rewritten to | result |
|---|---|
| `http://127.0.0.1:<port>/…` | **`SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER`** — WebFetch upgraded http→https and spoke TLS at the plain-HTTP server. Nothing reached the HTTP layer. Matches the tool's own doc: *"HTTP is upgraded to HTTPS."* |
| `https://127.0.0.1:<port>/…`, self-signed cert | **`self signed certificate`** — the cert is validated. (It *did* connect: there is no loopback/private-IP blocklist, the cert is the only objection.) |
| `file:///…` | **`Invalid URL`** |
| `data:text/html,…` | **`Invalid URL`** |

So a loopback endpoint is reachable **only** over HTTPS with a certificate Claude Code's
Node process already trusts. That means shipping a Golem-generated CA and installing it via
`NODE_EXTRA_CA_CERTS` in Claude Code's env.

**3. The summarizer call does transit the proxy, and it is uncached.** Controlled fetch of
`https://example.org/` (~1.2 KB) with raw mode off, watched in `.golem/telemetry/events.jsonl`:
a `cachePrefix: "first"`, `cacheMessageCount: 1` request of **362 tokens**, billed
**551 input / 9 output, `cacheCreation` 0 and `cacheRead` 0**. (551 ≈ 362 + the 203-token
brevity directive, which is being injected into the summarizer call too.) It is a single-turn
tool-free request, exactly as §71 described — confirming part (b) of the R9.7 design was
*possible*.

### The decision: DECLINED — keep `deny` + serve, and say so in the text

Three independent reasons, any one sufficient:

1. **Cost of admission is a CA in Claude Code's trust store.** `NODE_EXTRA_CA_CERTS` is
   process-wide: it would make Claude Code trust a locally-stored Golem CA for *all* TLS,
   `api.anthropic.com` included. Anything on the machine that can read that key can MITM
   the session. Golem is the component in this stack whose entire job is to be trustworthy;
   spending that on a UI colour is a bad trade. (The published-key alternatives — a
   third-party wildcard cert for a name resolving to 127.0.0.1, `traefik.me`-style — mean
   shipping someone else's private key and needing DNS, so they are worse, not cheaper.)
   Secondary costs: cert generation with no `openssl` dependency needs a new pure-JS dep,
   and settings.json `env` is not hot-reloaded (§112), so it needs a restart to take effect.
2. **Part (a) alone re-bills the summarizer on every fetch.** Measured above: uncached,
   input scaling with page size. The hooks doc from §115 is 248,890 chars ≈ **62k input
   tokens per fetch, every fetch, at 0% cache hit** — against a session whose real hit rate
   is 98.4% (§93). Decision 42 Option A removed exactly this.
3. **Part (b) would fix the tokens by breaking the context economy.** Short-circuiting the
   summarization at the proxy means the *raw page* enters context whole instead of a summary.
   `MAX_SERVED_CHARS` (8,000) exists precisely to stop a 249k-char page landing in one tool
   result. Trading a red dot for a 62k-token context blow-up is a strictly worse bug.

Reasons 2 and 3 stand **even if** the CA problem were solved, so this is not "blocked pending
a cert" — it is declined on the merits. The sentinel-nonce and endpoint-auth designs in the
R9.7 brief are moot and were not built.

### What shipped instead

The half-measure the brief allowed: **wording that reads correctly inside an error box.**
The old intro opened `✓ Golem served this URL…` — a tick inside an `<error>` wrapper, which
is what got it reported as broken. Both serve paths now open `NOT AN ERROR —` and close with
an explicit sentence that Claude Code renders hook-served content as a *denied* tool call, so
red is expected and the fetch did not fail. Pinned by a test so it cannot silently regress,
and recorded in the module docstring so the next reader does not re-derive §115 → §120.

**If Claude Code ever gains a PreToolUse output-substitution field, this becomes a one-line
change and should be revisited.** Until then the red dot is the documented price of skipping
both a network fetch and an LLM call.

## §121 — CORRECTION to §120: the loopback cert needs no CA, and the real blockers are scope holes, not trust (2026-08-09)

§120 declined the loopback design partly on *"it needs a Golem CA in Claude Code's
process-wide trust, covering `api.anthropic.com`"*. **That reason is wrong and is
withdrawn.** Prompted by the user asking whether the cert could be handled at install
time. Measured, not reasoned:

### What was measured

**1. A self-signed `CA:FALSE` LEAF works as a trust anchor.** First attempt proved
nothing — `openssl req -x509` emits `CA:TRUE` by default, so the "self-signed cert"
tested in §120 was a CA. Regenerated with `basicConstraints=critical,CA:FALSE`
(+`keyUsage`, `extendedKeyUsage=serverAuth`, SAN `DNS:localhost,IP:127.0.0.1`):

| client env | result |
|---|---|
| none (control) | `FAIL DEPTH_ZERO_SELF_SIGNED_CERT` |
| `NODE_EXTRA_CA_CERTS=<the leaf itself>` | **`OK`** — TLS validated |
| same env, fetching `https://example.com` | **`OK 200`** — the public store still works |

So `NODE_EXTRA_CA_CERTS` **appends to** the default store rather than replacing it, and
the anchor can be the leaf itself. **There is no CA to install and therefore no signing
capability to steal**: a `CA:FALSE` cert cannot mint a cert for any other host, so the
"could MITM api.anthropic.com" blast radius does not exist. Residual risk is only that
someone who can read the key can impersonate `127.0.0.1:<port>` to Claude Code — and
anyone with that access can already write the web cache and the KB, which are served
into context anyway. Incremental risk over the status quo: small.

**2. Claude Code documents the variable** (`code.claude.com/docs/en/network-config.md`,
fetched 2026-08-09): `NODE_EXTRA_CA_CERTS` under "Custom CA certificates", *"All
environment variables shown on this page can also be configured in `settings.json`"*,
read **once at startup** (so a restart is required — consistent with §112), and
verifiable: `claude --debug` logs `CA certs: Appended extra certificates from
NODE_EXTRA_CA_CERTS (<path>)`, and `/status` shows an **Additional CA cert(s)** row.

### The blockers that actually remain

**A. Settings-scope holes make the wiring unreliable exactly where Golem writes it.**
Same doc: in **cloud sessions** Claude Code *ignores* `NODE_EXTRA_CA_CERTS` from a
settings `env` block outright; and in **Claude Desktop app-managed sessions** it reads
it only from managed settings and `~/.claude/settings.json`, explicitly **ignoring a
repository's own settings files** — which is precisely where `golem init` writes its
wiring. So a project-scope install silently does nothing in those sessions.

**B. A failed rewrite is worse than a red dot.** Today's failure mode is "works, looks
red". If the hook rewrites to loopback in a session where the cert is not trusted, the
fetch **actually fails**. Any build must therefore keep deny-and-serve as the fallback
and only rewrite once it has positive evidence the endpoint was reachable (e.g. a latch
recording that a real WebFetch arrived at the endpoint), rather than assuming.

**C. `NODE_EXTRA_CA_CERTS` is a single path, and someone else may own it.** A user
behind a corporate TLS-inspection proxy already has it set. Golem must not clobber it;
concatenating their bundle with ours creates a copy that goes stale when theirs rotates.
Safest posture: set it only when unset, otherwise print instructions.

**D. §120 reasons 2 and 3 are untouched.** The summarizer still runs per fetch
(measured: 551 in / 9 out for 1.2 KB, uncached), and it can only be bounded by serving a
*capped* page from the endpoint — at which point the model receives WebFetch's
**prompt-specific summary of a truncated page** instead of today's prompt-independent
raw text. That is Decision 42's thesis in reverse, and it is a fidelity regression paid
for with tokens, to buy a colour.

### Verdict

Install-time cert handling is **feasible and much cheaper than §120 claimed** — a leaf,
a settings `env` line and a restart. It is **not** suitable as a default, because of A
(silently inert in two session types), B (converts a cosmetic problem into a real
failure) and D (tokens + fidelity). It is a reasonable **opt-in** for users who want the
green dot and mostly fetch small pages. Filed as R9.12 rather than built, because the
default stays as shipped in R9.7.

## §122 — CORRECTION to §121: `additionalContext` reaches the model on an `allow`, and it SURVIVES a failed tool call — R9.12 needs no opt-in (2026-08-09)

§115 listed `additionalContext` in the PreToolUse contract (*"added to Claude's context
alongside the tool result"*) but never exercised it, and §120/§121 both reasoned as if the
loopback **endpoint's response body** had to carry the served page. It does not. Prompted
by the user asking whether R9.12 could ship on by default instead of behind a flag.

Measured live in one session with a temporary probe branch in `runWebFetchPre`, keyed off
a `golem_probe=<n>` marker in the URL. The global `golem` is a directory junction to the
repo, so `npm run build` takes effect on the **next hook invocation** — no Claude Code
restart is needed to iterate on hook behaviour (unlike settings `env`, §112).

### What was measured

| probe | hook output | tool outcome | did the payload reach the model? |
|---|---|---|---|
| 1 | `allow` + `additionalContext`, no rewrite | **green**, real fetch ran, returned `"Example Domain"` | **YES** — arrived as `<system-reminder>` prefixed `PreToolUse:WebFetch hook additional context:` |
| 2 | `allow` + `additionalContext` + `updatedInput.url` → `https://127.0.0.1:1/` | **failed**, `<error>connect ECONNREFUSED 127.0.0.1:1</error>` | **YES — unchanged.** Delivery is independent of tool success |
| 3 | as probe 2, `additionalContext` ≈ 20 224 chars | failed as above | **partly** — Claude Code emitted `<persisted-output>`: *"Output too large (19.7KB). Full output saved to: …\tool-results\<id>.txt"* plus a 2 KB preview |

### What this changes

**Blocker B is FALSIFIED.** §121 said *"a failed rewrite is worse than a red dot"* because
the fetch would actually fail. Probe 2 shows the content still arrives in full when the
rewritten call fails. The worst case of a wrong rewrite is therefore *red dot + content
delivered* — substantively what R9.7 already ships — not a lost fetch. The latch is now a
**cosmetic** optimisation, not a safety mechanism.

**Blocker D is mostly dissolved.** The endpoint no longer has to serve the page; it serves
a **stub**, and the raw cached text rides in on `additionalContext` — prompt-independent,
never passed through WebFetch's summarizer, so Decision 42's thesis is preserved rather
than inverted. The residual cost is one summarizer call over a few hundred bytes of stub
per served fetch. That is a real but small and *fixed* cost, not a per-page one.

**Blockers A and C become harmless rather than blocking.** A cloud session, a
Desktop-app-managed session, or a machine where `NODE_EXTRA_CA_CERTS` is already owned by
a TLS-inspection proxy simply never gets a trusted endpoint — so the hook keeps using
today's deny-and-serve. Silently inert now means *silently identical to what shipped*.

**The 8 000-char serve cap stays.** Probe 3 shows oversized `additionalContext` is not
truncated destructively, but it is moved out of context into a `tool-results/*.txt` file
behind a 2 KB preview. That is strictly worse than the current cap + CCR ref, which puts
8 000 chars in context *and* leaves a one-step `expand` for the rest.

### Consequence for R9.12

The only remaining reason for an opt-in was the tokens/fidelity trade (D), and the
stub-plus-`additionalContext` shape removes the fidelity half and shrinks the token half.
R9.12 is therefore rewritten as a **default-on, self-configuring** feature: green when the
endpoint is provably trusted in the running session, byte-identical to R9.7's
deny-and-serve otherwise. No flag to tick, and no session where the user is worse off than
today. `NODE_EXTRA_CA_CERTS` is still only ever set when unset (§121 C stands).

### Caveat that must be designed for

A failed rewrite renders an opaque `connect ECONNREFUSED …` / TLS error in the transcript,
whereas today's deny renders Golem's own `NOT AN ERROR —` framing. Any path that can fail
visibly must therefore either (a) keep `deny` as the fallback so the framing survives, or
(b) carry an explicit "this error is expected, the content is below, do not retry" line in
`additionalContext`. (a) is preferred — it is the known-good path.

## §123 — CORRECTION to §121/§122: Claude Code is Bun/BoringSSL and REJECTS a `CA:FALSE` leaf anchor — the green path needs a real CA, which R9.12 forbids (2026-08-09)

§121 measured the `CA:FALSE` leaf trick against **Node/OpenSSL** and concluded "ship a
leaf, never a CA". §122 built on it. Both were measured against the wrong TLS stack.
The `claude` on this machine is a **`PE32+ executable`** — a compiled **Bun** binary — and
its TLS errors read `error:10000009:SSL routines:OPENSSL_internal:...`, i.e. **BoringSSL**.

### What was measured

Claude Code *does* read the variable — pointing it at a garbage file yields
`warn: ignoring extra certs from <path>, load failed: error:10000009:SSL routines:OPENSSL_internal:PEM routines`.
So the env plumbing works; the anchor is what fails. Each row below is a real headless
`claude -p … --allowedTools WebFetch` run against a local HTTPS server on `127.0.0.1`,
with `NODE_EXTRA_CA_CERTS` pointing at that server's own certificate:

| trust anchor | WebFetch result |
|---|---|
| Golem's hand-rolled `CA:FALSE` leaf (`src/proxy/loopback-cert.ts`) | **FAIL** — `unable to verify the first certificate` |
| **`openssl`-generated** `CA:FALSE` leaf (the §121 recipe, as a control) | **FAIL** — `unable to verify the first certificate` |
| `openssl`-generated **`CA:TRUE`** self-signed | **OK**, `is_error=false`, body returned verbatim |

The openssl control matters: it rules out a defect in the hand-rolled DER. Both leaves
fail identically, and only the CA succeeds. **BoringSSL requires a trust anchor to be a
CA**, where OpenSSL will accept a self-signed leaf as its own anchor. That is the whole
difference, and §121's central correction does not survive it.

### Consequence

The green path is reachable **only** by installing a `CA:TRUE` certificate into Claude
Code's process-wide trust. That reinstates §120's original objection verbatim: a CA in
that store can sign for **any** host, `api.anthropic.com` included, so anyone who can read
the key can MITM Claude Code's traffic. R9.12's own "Out of scope" says *"Any form of CA.
If a design needs signing power, it is the wrong design."* By the task's own gate, the
honest answer is **REGRESSED**: the green path does not ship.

### What survives

- **§122's three `additionalContext` measurements stand** — they were measured against
  Claude Code itself, not against Node, and the live run re-confirmed the important one:
  when the rewritten call failed with `unable to verify the first certificate`, the page
  **still reached the model**, which answered from it and correctly reported the fetch as
  having failed. Content delivery really is decoupled from tool success.
- **The floor is untouched.** With `NODE_EXTRA_CA_CERTS` unset (every session today) the
  hook takes R9.7's deny path, byte-for-byte; the full suite passes unchanged.
- The hand-rolled X.509 generator works and adds no dependency, should a future design
  need a loopback certificate for something that is not Claude Code's WebFetch.

### The one shape not yet measured

A **publicly-trusted certificate for a hostname that resolves to `127.0.0.1`** (the
`localtest.me` / `traefik.me` pattern) would give a green fetch with **no** trust-store
change, no CA, and no restart — the anchor is already in the public store. Costs: a
dependency on a third-party domain and its published key, and a DNS lookup per fetch (so
it fails closed to the deny floor when offline). Not measured, and not obviously
acceptable for a local-first project — recorded so the option is not lost.

## §124 — the green WebFetch IS reachable: a DNS-name-constrained CA that provably cannot issue a cert for api.anthropic.com (2026-08-09)

§123 closed R9.12 on the grounds that green needs a CA and "any CA" was forbidden because
it could sign for `api.anthropic.com`. That premise assumed an **unconstrained** CA. X.509
`nameConstraints` removes the assumption, and BoringSSL turns out to enforce them. Prompted
by the user asking whether WebFetch could be used without HTTPS; it cannot, but the
question reopened the trust question and this is the way through.

### Plain HTTP is definitively closed (asked and answered first)

A plain-HTTP server on loopback, fetched from a cwd with no Golem hooks, logged:

```
PORT=52358
CLIENT-ERROR HPE_INVALID_METHOD          <- TLS ClientHello bytes hitting an HTTP parser
CLIENT-ERROR ERR_HTTP_REQUEST_TIMEOUT
```

No request ever reached the HTTP layer, for either `http://127.0.0.1:<port>` or
`http://localhost:<port>`. Server-side confirmation of §120's client-side
`WRONG_VERSION_NUMBER`. There is no loopback exemption from the `http`→`https` upgrade.

### New fact: `localhost` is not a usable hostname for WebFetch

`https://localhost:<port>/…` returns **`Invalid URL`** — the same rejection `file://` and
`data:` get (§120). Only the IP literal `127.0.0.1` is accepted. This matters structurally:
the rewrite target must be an IP, so the leaf must be validated by an **iPAddress** SAN.

### The certificate matrix, all measured with live `claude -p … --allowedTools WebFetch`

| trust anchor (`NODE_EXTRA_CA_CERTS`) | server leaf | result |
|---|---|---|
| hand-rolled `CA:FALSE` leaf | itself | FAIL — `unable to verify the first certificate` |
| `openssl` `CA:FALSE` leaf (§121 recipe, control) | itself | FAIL — `unable to verify the first certificate` |
| unconstrained `CA:TRUE` | itself | OK — but this is the forbidden shape |
| CA + `nameConstraints` including `permitted;IP:127.0.0.1/…` | `IP:127.0.0.1` | FAIL — **`unsupported name constraint type`** |
| CA + `nameConstraints=critical,permitted;DNS:golem.invalid` | `IP:127.0.0.1` | **OK — GREEN** |
| the same DNS-constrained CA | `IP:127.0.0.1` **+ `DNS:api.anthropic.com`** | FAIL — **`permitted subtree violation`** |

The last two rows together are the finding. BoringSSL **cannot parse** `iPAddress` name
constraints (it rejects the whole anchor rather than ignoring the extension — it fails
closed, which is the safe direction), but it **does parse and enforce** `dNSName`
constraints. So a CA restricted to `permitted;DNS:golem.invalid` is accepted as an anchor,
validates an IP-SAN leaf for `127.0.0.1`, and is *provably* unable to issue anything
bearing `api.anthropic.com` — the exact certificate §120 feared was refused with
`permitted subtree violation`, by the client, in a live run.

### Residual risk, stated plainly

The `iPAddress` name form stays **unconstrained**, because constraining it makes BoringSSL
reject the anchor outright. So whoever can read the CA key can mint a certificate for any
**IP literal** that a Claude Code started with this env would trust. It cannot mint one for
any **hostname** outside `*.golem.invalid`, and Claude Code reaches `api.anthropic.com` by
hostname, so the MITM path §120 named is closed. `pathlen:0` also prevents sub-CAs.

This is materially different from shipping an unconstrained CA, and it is not zero. The
key would live in `.golem/loopback/` at `0600`, beside a KB and web cache that are already
fed into context.

### Status

Not built. R9.12's "Out of scope" still says *"Any form of CA"*, written when a CA meant
unlimited signing power. That boundary is now the only thing between this and a green
WebFetch, and moving it is the user's call, not an agent's.

## §125 — the loopback CA takes effect WITHOUT restarting Claude Code, and tool children see settings `env` immediately (2026-08-10)

Found while deploying R9.12 to this repo. Two related facts, both measured in the session
that was already running when `golem init` wrote the wiring:

**1. Settings `env` reaches child processes immediately.** Straight after `golem init`, a
Bash tool call printed
`NODE_EXTRA_CA_CERTS=D:\…\.golem\loopback\ca.pem` — no restart, no reload. So a hook's own
environment reflects the *settings file*, not necessarily what Claude Code's TLS stack was
started with. That made the hook's env check look like a possible false positive.

**2. It is not a false positive — Claude Code's own TLS picked it up too.** A WebFetch of
a cached URL in that same pre-existing session returned **`is_error=false`**, served from
the loopback stub, with the page arriving via `additionalContext`. The TLS handshake
against the newly-created CA succeeded in a process that started before the CA existed.

This is **better than the documentation implies**. `network-config.md` says these
variables are "read once at startup", and §112 recorded the same for settings `env`
generally — true for `ANTHROPIC_BASE_URL`, but the CA store is evidently re-read when
settings change (the same doc already says mTLS cert/key are "re-read each time it applies
settings, including when settings change during a session"; the CA appears to behave the
same way). `golem init`'s notice was written to promise a restart was required; it now
says a restart is only needed *if* the green path does not appear.

### The residual mismatch this does NOT rule out

In **cloud** and **Desktop-app-managed** sessions the doc says `NODE_EXTRA_CA_CERTS` from a
repository's settings `env` is ignored for TLS (§121-A). If such a session nonetheless
injects it into child environments, the hook would see the variable, believe the endpoint
is trusted, rewrite, and the fetch would fail. Thanks to §122 the page still reaches the
model, so nothing is lost — but the transcript shows an opaque TLS error instead of the
clean `NOT AN ERROR —` deny.

Closing that needs the reachability **latch** that R9.12's design described and the shipped
code does not implement: rewrite optimistically once, have the endpoint record that a real
WebFetch arrived, and fall back to the deny floor for the rest of the session when no hit
was recorded. Filed as R9.19. Not reproducible from a terminal session, which is why it was
filed rather than guessed at.

## §126 — models.dev exposes `modalities.input`, which is the image-capability signal Golem needed (2026-08-14)

Checked live at `https://models.dev/api.json` while building R10.14.

Every model entry carries a `modalities` block alongside `limit` and `cost`:

```json
"modalities": { "input": ["text"], "output": ["text"] }
```

`deepseek/deepseek-v4-flash` reports `input: ["text"]` — no vision. A vision
model reports `input: ["text","image"]`. There is also a sibling `attachment:
false` boolean, which appears to track the same fact; `modalities.input` was
chosen because it is explicit about WHICH modalities rather than a single flag,
and it is the field OpenRouter's own catalogue mirrors
(`architecture.input_modalities`).

This matters because R8.8 already fetches and caches this exact document, so the
capability is **Golem's own cached data, not a runtime dependency** — the hard
rule the models command was built around.

Coverage is good at the id level: the refreshed catalog holds
`openrouter | deepseek/deepseek-v4-flash-0731 | ["text"]` as an exact entry, so
`lookupModel` with `preferProvider: "openrouter"` resolves it without falling
back to the dated-snapshot rule (`-0731` is not `-YYYYMMDD`, so that fallback
would NOT have matched — the exact entry is what makes this work).

Caveat worth carrying: 6,320 entries came back, many ids repeated across dozens
of providers with the same modalities. Disambiguation by provider is therefore
load-bearing, not cosmetic.

## §127 — Decision 56's bypass shim was removed by R9.23, not R10.1 (2026-08-14)

R10.12's brief attributed the loss of `src/cli/proxy-state.ts` and the bypass
shim to R10.1, the first-pancake rewrite, and asked for that to be confirmed
from history rather than assumed. Confirmed, and it was wrong:

```
git log --diff-filter=D -- src/cli/proxy-state.ts
1992445  R9.23: rename ext to pkg, fix Caveman detection, add pkg install   (2026-08-11)
```

R10.1 landed as 13a8f19 on 2026-08-13 — two days LATER. The same R9.23 commit
rewrote `src/cli/commands/proxy.ts` by 365 lines, deleted the `stop` command
entirely (not just the shim), and left the comment that records the reasoning:

```ts
// R9.23: if the URL is in settings, the daemon should be alive.
// If it's not, restart it — no separate state file needed.
```

Worth carrying: the regression was NOT caused by the rewrite everyone would
suspect. It came from a rename-and-simplify batch, where deleting a state file
looks like tidying rather than reversing a decision. When attributing a
regression, run `--diff-filter=D` before naming a culprit — the plausible
candidate here was innocent, and the innocent one is still in the tree.

Second finding from the same restore: the recovered guidance strings referenced
`golem proxy start --detach`, a flag R9.23 had also removed. It is now
`golem proxy restart`. A recovered message can be stale in ways a compiler
cannot see — the strings were valid TypeScript naming a command that errors.

---

## §128 — OpenRouter's streaming reasoning fields and its mid-stream error frame (2026-08-19, answers §84's open question)

Captured live against the user's own OpenRouter account (`deepseek/deepseek-v4-flash`,
`qwen/qwen3.7-flash`), raw SSE dumped before any translation.

**Reasoning is `reasoning`, never `reasoning_content`.** Every chunk of a real
deepseek stream carried both `delta.reasoning` (plaintext) and
`delta.reasoning_details` (structured, same text), and `reasoning_content` never
appeared once:

```json
{"id":"…","model":"deepseek/deepseek-v4-flash","provider":"StreamLake",
 "choices":[{"index":0,"delta":{"content":"","role":"assistant","reasoning":"We",
 "reasoning_details":[{"type":"reasoning.text","text":"We","format":"unknown","index":0}]},
 "finish_reason":null,"native_finish_reason":null}]}
```

OpenRouter's own docs confirm the direction of the alias: *"You can also use
`reasoning_content` as an alias — it functions identically to `reasoning`"* is
about the **request**. Responses use `message.reasoning` /
`choices[].delta.reasoning_details`. Golem read only `reasoning_content`, so
**every** reasoning trace from **every** OpenRouter model was silently dropped —
which is §84's *"map_reasoning_to_thinking is on yet no thinking deltas arrived,
suggesting OpenRouter needs an explicit `reasoning: {...}` request field —
UNVERIFIED"*. **That inference was wrong**: no request field is needed to
*receive* the trace, Golem was reading the wrong field name. Fixed in R10.23.
Both fields are read now, plaintext first, because reading both duplicates the
whole trace.

**A mid-stream failure is a `data:` frame with a top-level `error`.** Once tokens
are flowing the status is already 200, so OpenRouter reports the failure in-band:
`"error":{"code":"server_error","message":"Provider disconnected unexpectedly"}`
at the top level, alongside
`"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]`, and the
stream ends. Golem's translator dropped every frame carrying no `delta`, so the
cause was discarded and R10.18's generic "empty completion" notice went out in
its place — with `stop_reason: end_turn`, because `mapStopReason` maps an
unrecognised `finish_reason` (including `"error"`) to `end_turn`. A dropped cause
plus a normal-looking stop is what produced the user's *"I would get no further
updates"*.

**The Anthropic side has a first-class shape for this**, verified the same day at
platform.claude.com/docs/en/build-with-claude/streaming: *"The API may
occasionally send errors in the event stream"*, as

```sse
event: error
data: {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}
```

and it may arrive at any point, including after `message_start` and content
deltas. So R10.18's premise — *"the headers have already gone out, so an HTTP
error is no longer available"* — was true about the STATUS and wrong about the
options: the protocol carries the failure in-band as an error, not as prose. It
matters because in-band prose is a COMPLETED turn.

**Two operational facts.** (i) `qwen/qwen3.7-flash` streams a reasoning trace
too, so the reported "deepseek fails, qwen does not" asymmetry is not about which
model reasons — it is how much of `max_tokens` the trace eats and which provider
OpenRouter routes to. At `max_tokens: 400` qwen spent the whole budget on
reasoning and emitted **zero** content; deepseek at 200 answered. (ii) Repeated
agentic-shaped probes (tools, `max_tokens: 2000`) succeeded on both models —
`finish_reason: tool_calls`, 5–7 tool calls, no content, no error. Empty
completions here are **intermittent**, which is why R10.23 makes them a retryable
`error` event rather than a completed turn.

**Still unverified, deliberately:** whether `proxy.upstream_reasoning_effort` (sent
as OpenAI's top-level `reasoning_effort`) does anything at OpenRouter. Their docs
describe a nested `reasoning: {effort|max_tokens|exclude|enabled}` object and do
not mention `reasoning_effort`; a probe with `reasoning_effort: "high"` returned a
normal answer, which neither confirms nor denies that it was honoured. If it is
inert, it is the "config that cannot take effect" trap §84 named — it needs its
own task, because changing what Golem SENDS changes cost.

---

## §129 — Golem's own pipeline can hold a live request, and used to do it silently (2026-08-19)

From the user's second report: one occurrence of Claude Code sitting on "waiting
for API" against the default Anthropic upstream. The Anthropic path is a raw byte
pipe with no retry, so the proxy cannot stall a response — but the REQUEST side
awaits four stages before forwarding: redaction, local answer (Decision 33),
lossless compression, semantic compression + context substitution.

Stage 1.5 is the one that can block for seconds: `tryAnswer` awaits a vector
search, which awaits an embedder, which on a cold local model is a multi-second
first call. It is gated to single-turn requests — i.e. exactly the requests that
OPEN a session — so the FIRST turn of a session was the one that paid, and only
that turn, which matches "one occurrence" better than any upstream explanation.
Nothing bounded the wait and nothing logged it, so it was indistinguishable from
upstream latency: the API wore a delay Golem caused.

R10.23 bounds it at 2s (fail-open, the same verdict the stage already reached on
error) and logs `golem proxy: pipeline held this request Nms before forwarding
(…) — <stage>=Nms` past 750ms. The threshold exists so the line is rare enough to
mean something: under it, the pipeline is invisible against normal upstream
latency.

Rule worth keeping, since this is the third time it has come up (§84's banner,
R10.19's `headroom_config`, now this): **if Golem spends a user's time, Golem has
to be the one to say so.** An honest-observability tool that lets the upstream
wear its own latency is lying by omission.

---

## §130 — two status surfaces, no shared contract: what drifted and what now pins it (2026-08-20)

Found by the user reading both lines in one VS Code window. `golem statusline`
(TypeScript, `src/cli/statusline.ts`) and the VS Code status bar (plain CommonJS,
`vscode-extension/render.js`) render the same facts and share **no module** — by
design, since the extension must not import the CLI's graph. What they also
shared was no contract, and they had drifted apart in four ways at once:

| | CLI | status bar |
| --- | --- | --- |
| dial position | after the destination | BETWEEN brand and arrow |
| role order | workers first, chat last | workers first, chat last |
| destination label | gateway (`openrouter`) | model's vendor (`deepseek`) |
| model precedence | last-served, else configured | configured, else last-served |
| proxy states | 4 (running/unwired/bypass/off) | 2, and `in_path` unread |
| bypass glyph | filled ⬢ (green) | hollow ⬡ |

`role-marks-parity.test.ts` (R9.4) already pinned the GLYPHS the two use, and
that test is why the marks agreed while everything around them diverged — a
narrow pin gives real, and misleading, confidence. The new
`statusline-parity.test.ts` renders equivalent state through both implementations
and asserts ONE identical string; it found the bypass-glyph disagreement
immediately, which nobody had reported.

**Rule worth keeping: when two implementations of one surface cannot share code,
the test is the only place the contract can live — so pin the OUTPUT, not the
constants.** Pinning constants proves they agree about symbols while they
disagree about meaning.

**Second finding, from the same read: a dial shown in a state where it cannot
act is a misreport, not a detail.** Both surfaces printed the configured
compression and brevity while the proxy was stopped, unwired, or serving the
redaction-only bypass shim. R8.32 established this for the GLYPH (a running
daemon nothing points at must not look active) and Decision 56 for the bypass
label, but neither reached the dials — so the most confident-looking part of the
line kept advertising transforms no stage was running. The dials are now
suppressed in all three states and the state is NAMED, in one vocabulary, because
colour and glyph fill are not readable under NO_COLOR, in a screenshot, or by
anyone who has not memorised ⬢ vs ⬡.

Note the R8.32 test whose name was `does not claim a compression level when Golem
is not in the path` and whose body asserted `expect(line).toContain("aggressive")`
— it pinned the very claim its name forbade. A test can be green, precise, and
pointed at the wrong behaviour; read the name against the assertion.

---

## §131 — `inference.default_target` could not be set to a target (2026-08-20)

The VS Code "switch upstream" picker offered gateways, and `golem gateway use`
rejected anything that was not a gateway id. So a gateway fronting several models
— `openrouter` with a qwen entry and a deepseek entry — could only be selected as
a whole, and selecting it served `models[0]`. The other model was unreachable from
every UI, and from the CLI, despite:

- R9.1 resolving TARGETS (`<gateway>:<model>`) in the registry,
- R9.2 routing per target (virtual `golem/<id>` model ids, `x-golem-target`,
  conversation bindings),
- R10.8 making `inference.default_target` the chat fall-through,
- and the leaf being *named* `default_target`.

Every mechanism existed except a verb to set it. Fixed by teaching `useGateway`
to accept a target id (preflighting the credential of the gateway BEHIND the
target, not the target id, which resolves to nothing) and adding
`golem target use`. `collectGateways` now reports `active_target` — the selection
verbatim — while `active` stays the backing GATEWAY id so no existing consumer
changes meaning.

**Rule: a setting named after a concept must accept that concept.** The registry
and the router spoke targets; the only writer spoke gateways; nothing failed
loudly, the picker just quietly offered one of the two models the user had
configured.

Also fixed here: `collectGateways` reported each gateway's model as `models[0]`
unconditionally, so even after switching, every surface named the first model.

**Test-isolation note (same batch):** `tests/integration/cli-status.test.ts`'s
"no warnings for an uninitialized project" case read the MACHINE's installed VS
Code extension via R9.16's staleness check, so it went red on any working tree
that had edited the extension and not yet redeployed — a fact about the machine,
not the project. It now passes `vscodeExtensionsDir: null`, as
`tests/contract/vscode-status-fields.contract.test.ts` already did.

---

## §132 — Retiring the slider: what the refactor found that the design did not (2026-08-20)

R11.1/ADR-0004 replaced a preset-over-two-dials with the two dials. Four findings
worth keeping, none of which were visible from the design.

**1. `golem on`/`golem off` forgets, so it could not be the bypass's home.** The
obvious place for old level 0 was the existing pipeline toggle. It is in-process
only (`#pipelineEnabled`, flipped by a POST to `/__golem/pipeline/<enabled>`), so
it resets to ON at every proxy restart — and the proxy restarts on project open
(the SessionStart hook) and on every `gateway use`. A durable bypass cannot live
in a flag that forgets, so `proxy.bypass_all` is a persisted setting and the
proxy applies it at construction. **That the toggle forgets is its own honesty
bug and is still open**: `golem off` reports success and silently reverts.

**2. The safety property moved from "defended" to "unrepresentable".** Before,
`LEVEL_TABLE[0]` had `redaction: false` and `MIN_ACTIVE_COMPRESSION_LEVEL`
existed solely to stop a *pinned* dial selecting that row. Deleting the row
deleted the clamp and the class of bug: no value of any dial can now express
redaction-off. The contract test that used to assert the clamp works now asserts
there is nothing to clamp — a strictly stronger statement.

**3. Live reload had to become opt-in, and a test caught why.** The retired
slider had a property the dials did not: a `SliderStore` re-read
settings.local.json per request so the `level` MCP tool could change the level
without a restart, while a *pinned* dial needed one. Losing that with the slider
would have made the replacement worse than the thing it replaced, so
`resolvePolicy` re-reads config (TTL 1s, full precedence, fail-safe to the
build-time policy). First implementation re-read **unconditionally**, which
silently discarded settings a caller had *built* rather than loaded — caught by
the R2.2 context-substitution test, which passes
`overrides: { compression: { level: "2" } }` and would have been served the
file's default. Hence `reloadDials`, opt-in, with the daemon (which did load from
disk) the caller that opts in.

**Rule: a live re-read must not silently outrank the values the caller handed
you.** "Refresh from source" is only equivalent to "keep what I was given" when
the caller's values came from that source.

**4. A retired ENUM VALUE is harder than a retired KEY.** R9.6's machinery
handles renamed keys, which load with a warning. `compression.level: "auto"` is a
live key with a dead value, so the whole settings file fails to load and *every*
`golem` command dies — found on this repo's own `settings.local.json`, which said
`auto` with no slider level (so the slider-transform branch never ran). The sweep
now resolves a lone `auto` against the default the slider used to supply.

**Also: the slider migration is the first migration that TRANSFORMS.** One
retired key becomes two or three live ones with computed values, which
`SettingMigration` (a `from`/`to` rename) cannot express — hence a separate
function and a third `action`, `resolved`. It reproduces the retired resolvers
exactly, so a real pin still wins, `"auto"` is replaced rather than treated as a
pin, and `slider.level: 0` becomes `proxy.bypass_all: true` with both dials off.
Live-verified on seven fixtures plus this repo's real file (backup at
`.golem/state/config-backups/local-0.24.0.json`).

**Numbers.** 379 slider references across 63 files at the start; `tsc` was the
worklist. Deleted: `src/cli/slider.ts`, `src/cli/slider-read.ts`,
`src/mcp/slider-store.ts`, the `level` MCP tool, `golem slider`,
`golem.setSlider`, the `slider` block in `status --json`, `SliderPolicy`,
`SliderLevel`, `Pinned`, `resolveBrevity`, `resolveCompressionLevel`,
`brevityPresetForLevel`, `MAX_SLIDER_LEVEL`, `MIN_ACTIVE_COMPRESSION_LEVEL`,
`migrateSliderLevel`, and the `auto` state on both dials. Suite: 2,763 green.

## §133 — `claude plugin` has a real remove/upgrade contract but no version pin, and `installed_plugins.json` (not the cache) is what "installed" means (2026-08-21)

Checked against the `claude` CLI on this machine while building R8.14's write half.
Both halves of this were assumptions in the old ad-hoc `pkgInstall`, and both were
wrong in a way that mattered.

**1. The subcommands exist, so `remove` and `upgrade` are real verbs.**
`claude plugin --help` lists `install|i`, `uninstall|remove`, `update`, `enable`,
`disable`, `list`, `marketplace`, `details`, `prune|autoremove`, `validate`,
`tag`, `init|new`, `eval`. `uninstall` and `update` both take `<plugin>` (the
`plugin@marketplace` form resolves a specific marketplace) and both take `-y,
--yes`, documented as **required when stdin or stdout is not a TTY**. So Golem's
own non-TTY refusal and the `--yes` it passes downstream line up with the
upstream's own discipline rather than fighting it.

**2. There is NO version selector on `claude plugin install`.** Its options are
`--config <key=value>`, `-s, --scope <scope>`, `-y, --yes` — no `@version`, no
`--version`. A plugin tracks whatever ref its marketplace points at. That is why
the Caveman row records `pinPolicy: "upstream-unpinned"` instead of inventing a
pin: the registry's job is to say *who governs the version*, and "the upstream
does, and offers us no say" is an honest answer where a fabricated pin would not
be. It is also why Caveman is the one row with explicit `upgrade` steps — there is
no pin there for an upgrade to move past, so `claude plugin update` is the whole
contract. Every *pinned* row instead declares `upgrade: "reinstall"`.

**3. `~/.claude/plugins/installed_plugins.json` is the authority; the cache
directory is a leftover.** Found by disagreement between two surfaces on this
machine: `golem pkg list` said `[found] caveman`, `claude plugin list` said "No
plugins installed." Both were reading real state:

```
~/.claude/plugins/installed_plugins.json   {"version":2,"plugins":{}}   <- authority
~/.claude/plugins/cache/caveman/caveman/11ddc0c9813c/                    <- leftover payload
~/.claude/plugins/marketplaces/caveman/                                  <- marketplace clone, also kept
```

`claude plugin uninstall` empties `plugins` in the registry and leaves the content
cache **and** the marketplace clone on disk. `pluginOnDisk` had been checking for
the cache directory, so it reported an uninstalled plugin as present — for ten
days, in this repo, on the surface whose entire selling point is not claiming a
state it is not in.

`installed_plugins.json` is now read first and treated as **authoritative in both
directions**: present in `plugins` → installed; file readable and absent from
`plugins` → *not* installed, cache notwithstanding. The cache check survives only
as a fallback for a Claude Code old enough to have no registry file, where a
leftover cache is the only signal there is. Ids are matched as `<name>` or
`<name>@<marketplace>` (the `plugins` map was empty here, so the exact key shape a
populated file uses is inferred from the CLI's own `plugin@marketplace` argument
form — the matcher accepts both and ignores a marketplace mismatch only when the
caller named one).

**The transferable rule.** A tool's *cache* is not its *inventory*. When detection
has to answer "is this installed", find the file the tool would have to update to
answer that question itself, and read that one — a directory that merely exists is
evidence someone once installed it, which is a different claim. And when a read-only
surface grows a `remove` verb, re-derive what its detector actually proves: the
verb is what makes a stale positive load-bearing.
## §134 — Node offers no in-process sandbox, so the plugin seam states it instead of implying one (2026-08-21)

Checked while writing ADR-0005 for R8.11, because the task brief said explicitly:
*"Sandboxing as a solved problem — if it needs a sandbox to be safe, say so in the
ADR rather than shipping."* It does need one, there isn't one, and every option
was examined before writing that down.

**1. `node:vm` is not a security boundary — upstream says so.** The module's own
documentation states it is not to be used as a security mechanism to run
untrusted code. Anything reachable from the context (`process`, a host object, a
`require` handed in) is an escape. It buys namespace separation, which is not the
property wanted here.

**2. `worker_threads` isolates STATE, not AUTHORITY.** A worker can
`require("node:fs")`, open sockets, and read the same environment. It would buy
crash isolation and cost the seam its purpose: a redaction rule has to run
synchronously *inside* the pass to be part of the pass, and a per-rule IPC round
trip on every string in every request body is not viable.

**3. The permission model (`--permission`) is process-wide and set at launch.** It
cannot be scoped to one loaded module, so it cannot express "this plugin may not
read the filesystem" while Golem itself still can.

**4. A separate OS process IS a real boundary — and Golem already has that
surface.** It is `golem pkg`, the tier-2 spawn-target shape. The conclusion that
matters for future work: **anything that can tolerate a process hop should be a
`pkg`, not a `plugin`.** The plugin seam is only for what genuinely must run
in-process.

So the honest statement, which is now in the ADR verbatim: *loading a Golem plugin
is exactly as dangerous as adding a dependency to your own `package.json` and
importing it. It is not less dangerous.* Every control in the design narrows what
a plugin is **asked** to do; none of them narrows what it **can** do.

**What the risk is actually weighed against.** Not zero. Before R8.11, extending
redaction meant editing Golem, and the realistic outcomes were: the org forks and
their fork drifts out of date — including out of date with fixes to the redaction
stage itself; or the org gives up and their private key format flows upstream
unredacted; or they do not adopt Golem. None of those is safe. The question was
never "is loading third-party code risky", it was "which risk, and is the user
told the truth about it".

**The design rule that fell out of it.** Since containment is unavailable, every
mitigation had to be *structural* — a property of the seam that holds without
anyone reading the plugin:

- Built-ins always run first and plugin rules are a suffix, so a plugin can only
  ever redact MORE. `REDACTION_RULES` is never handed out and there is no remove,
  replace or reorder function to call.
- A plugin pipeline stage runs after redaction **and redaction runs again over
  whatever it returns.** Redaction is idempotent (placeholders contain `[`, `]`
  and `:`, which no rule's charset matches), so the second pass cannot renumber
  anything — what it buys is that a stage cannot introduce unredacted content
  however it obtained it.
- Rule kinds are namespaced `<plugin>/<rule>`, so a plugin cannot impersonate a
  built-in placeholder kind in telemetry.
- Rules are registered once, before serving, and a second registration is
  REFUSED. This is a §14 prefix-stability requirement, not tidiness.

**The transferable rule.** When you cannot contain something, do not build a
control that looks like containment. State the residual risk in the words a user
would use, then make every mitigation a structural property they can check —
"every 'yes' in the threat-model table is a property of the seam, and every 'no'
is a property of the runtime". Two rows in that table are deliberately "No" with
no mitigation at all (a plugin exfiltrating what it sees; a pathological regex
hanging the proxy, since JS regex execution is synchronous and uninterruptible).
Writing them down is the feature.

## §135 — R12.6: Web Push is content-blind but metadata-loud, iOS has no Apple-free wake, and the relay must NOT originate the push (2026-08-21)

Spike for **R12.6**, reopened the same day by **ADR-0006 Revision 2** (spec Decision
59), which promoted "relay-originated push" to option 1. Every fact below was
checked against live sources on **2026-08-21**; URLs and document dates are inline.
None of it is from memory — the iOS story has moved three times (16.4, 18.4, 26.0)
and the Push API spec changed editors in September 2025.

**The question.** ADR-0006 ships a companion app that can unblock a waiting agent.
A companion app whose owner has to remember to open it is not one. So: how does a
phone learn a permission prompt is waiting, without adding a party that can read
what is being asked?

### 0. Option 1, answered first: the relay must NOT originate the push

Verdict: **no — and it buys nothing.** Three findings, in the order that matters.

**(a) Originating a push requires a signing key, and §3b says the relay holds
none.** Both push services Golem would target enforce VAPID *subscription
restriction* (RFC 8292 §4): the subscription is created carrying the application
server's public key, and "the request for push message delivery MUST include a JWT
signed by the private key that corresponds to the public key used when creating
the subscription". Apple states the same operationally — "The public key you
include must match the public key you provided to `PushManager.subscribe`." So a
relay that originates pushes holds a private signing key, and §3b's first bullet
("It holds no key and terminates no TLS") becomes false. That bullet is the whole
basis of the blind-relay claim; it is not negotiable for a convenience.

**(b) The weaker variant still hands the relay a wake credential.** The laptop
could pre-encrypt the body and pre-sign the JWT, leaving the relay a dumb
POST-forwarder holding no long-term key. Two live-source facts spoil it. RFC 8292
§5: "This authentication scheme is vulnerable to replay attacks if an attacker can
acquire a valid JWT" — and Apple's guidance is "Don't refresh your JWT more
frequently than once per hour", so a forwarded token is replayable for a usefully
long window. RFC 8030 §8.3 is explicit that the endpoint is a capability URL:
"Knowledge of a push URI implies authorization to send push messages." Together
the relay gains a durable address for that phone plus the ability to ring it. §3b
already concedes DoS, and nuisance notifications are inside that — but **durable
offline addressability is a new capability, not a metadata increment**: reaching a
paired device when no session is open at all is precisely the thing today's relay
provably cannot do. Note the Push API spec flags this exact hand-off as the
application server's discretion, which is why declining it has to be written down:
"The application server is able to share the details necessary to use a push
subscription with a third party at its own discretion."

**(c) It buys nothing, because the blocked machine is online by definition.** The
event being announced is "Claude Code is waiting for a decision *on this laptop*".
The laptop is therefore awake, running, and holding the prompt; it needs no help
making one outbound HTTPS POST. The only thing relay-origination would buy is
hiding the laptop's IP from Apple/Google — and in relayed mode the relay already
sees both endpoints' addresses, so the trade is a new capability for a partial
privacy gain against a different party. Declined.

**For the ADR:** push, if it ships, is originated by the machine that is blocked.
No subscription endpoint, no `p256dh`/`auth` pair, and no VAPID private key ever
reaches the relay. §3b survives unamended.

### 1. What Web Push leaks to the push service — the body is genuinely opaque; the metadata is not

**The body is opaque, and the push service is the named adversary.** RFC 8291
(Nov 2017) exists for this: "This document describes how messages sent using this
protocol can be secured against inspection, modification, and forgery by a push
service." Mechanism: ECDH on P-256 plus an authentication secret, where "A user
agent generates an ECDH key pair and authentication secret that it associates with
each subscription it creates" — the decryption keys are minted **on the phone** and
shared only with the application server. RFC 8030 §8.1 states the bare protocol's
weakness plainly ("The protection afforded by TLS does not protect content from
the push service. Without additional safeguards, a push service can inspect and
modify the message content") and then requires the safeguard, which the Push API
mandates. So an encrypted "something is waiting" **is** genuinely unreadable by
Google and Apple. That half of the brief's hypothesis is verified, not assumed.

**The metadata is exposed by design, and padding is the only mitigation.** Push
API, W3C Working Draft **01 December 2025**, §4: "The contents of a push message
are encrypted [RFC8291]. However, the push service is still exposed to the
metadata of messages sent by an application server to a user agent over a push
subscription. This includes the timing, frequency, and size of messages. Other
than changing push services, which user agents may disallow, the only known
mitigation is to increase the apparent message size by padding." RFC 8291 §7 says
the same from the protocol side: "The timing and length of communication cannot be
hidden from the push service. … the push service will see which application server
is talking to which user agent and the subscription that is used."

**The application server's identity is a deliberate, stable pseudonym.** That is
VAPID's stated purpose (RFC 8292 abstract): "The signature can be used by the push
service to attribute requests that are made by the same application server to a
single entity." With a restricted subscription the key is bound at subscribe time,
so it cannot be rotated per message without discarding the subscription. Contact
info is optional: RFC 8292 §2.1 — "If the application server wishes to provide
contact details, it MAY include a `sub` (Subject) claim … either a `mailto:` …
or an `https:` URI." SHOULD, not MUST, and a project URL satisfies it.

**What an endpoint reveals is spec-constrained, with one carve-out that matters.**
RFC 8030 §8.2 is unusually strong: push URIs "MUST NOT provide any basis to
correlate communications for a given user agent", "It MUST NOT be possible to
correlate any two push resource URIs based solely on their contents", and "User and
device information MUST NOT be exposed through a push or push message URI" — while
conceding "It is also possible that traffic analysis could be used to correlate
subscriptions." Push API §4 adds the carve-out: "The push endpoint MUST NOT expose
information about the user to be derived by actors **other than the push service**."
So an endpoint is opaque to us and to a relay, and *not* to Apple/Google. One
genuinely reassuring rule: "The push endpoint of a deactivated push subscription
MUST NOT be reused for a new push subscription. This prevents the creation of a
persistent identifier that the user cannot remove."

**Cleartext headers leak more than people expect.** RFC 8030 §8.1: "The Topic
header field exposes information that allows more granular correlation of push
messages on the same subject. This might be used to aid traffic analysis of push
messages by the push service." `TTL` and `Urgency` are likewise cleartext. Padding
headroom: RFC 8291 §4 requires a single record with an `rs` covering "the
plaintext, the padding delimiter (1 octet), any padding, and the authentication
tag", within a 4096-octet body / "at most, 3993 octets of plaintext". Enough to pad
a fixed-size doorbell to a constant.

**Net residue after doing everything right:** a stable pseudonym for this laptop,
this device's subscription, the timing and frequency of blocks, a padded constant
size, and the laptop's IP. That is a work-pattern signal about one developer — the
same *class* §3b already concedes to the relay, disclosed to a second party.

### 2. iOS does deliver Web Push to an installed web app — under four conditions

From Apple's live page "Sending web push notifications in web apps and browsers"
(fetched 2026-08-21) and WebKit's own posts:

- **Home Screen install, on iOS specifically.** "Add web push to Home Screen web
  apps in **iOS 16.4 or later** and Webpages in Safari 16 for macOS 13 or later."
  The asymmetry in that sentence is the condition: on iOS it is installed web apps,
  not Safari tabs.
- **No developer account.** "You don't need to join the Apple Developer Program to
  send web push notifications." No Website Push ID. WebKit (2023-02-16) concurs and
  names the transport: "Web Push on iOS and iPadOS uses the same Apple Push
  Notification service that powers native push on all Apple devices."
- **Permission from a gesture.** WebKit: a Home Screen web app "can request
  permission to receive push notifications as long as that request is in response
  to direct user interaction". Delivered notifications then behave like any app's —
  "They show on the Lock Screen, in Notification Center, and on a paired Apple
  Watch." Egress to allow: `https://*.push.apple.com`.
- **Every push must ring — silent push is impossible.** Apple: "Safari doesn't
  support invisible push notifications. Present push notifications to the user
  immediately after your service worker receives them. If you don't, Safari
  revokes the push notification permission for your site." WebKit gives the
  mechanism: `userVisibleOnly: true` is required. **Consequence for Golem, and it
  is a good one:** push cannot be used as a silent transport to wake a sync, so
  push count equals notification count and no covert side channel exists — not even
  one we could build by accident.

**Current OS state, checked rather than assumed.** Safari 26.0 (2025-09-15) made
installing *easier*: "By default, every website added to the Home Screen opens as
a web app", and "Giving users a web app experience simply no longer requires a
manifest file." Grepped the Safari 26.0 / 26.2 / 26.4 / 26.6 release notes for
push changes: none. 26.0's only push mention is Web Inspector auto-inspecting and
pausing service workers; 26.2's is `history.pushState`; 26.6 has none.

**Declarative Web Push is the right shape for a rarely-opened app.** Shipped
Safari 18.4 (iOS/iPadOS 18.4), macOS in 18.5, and is now standardised as §3.3 of
the December 2025 Push API draft — so it is not an Apple-only bet. It displays a
notification from a JSON body (`{"web_push": 8030, "notification": {…}}`) with no
service worker involved, inside the same aes128gcm envelope, so opacity is
unchanged. Why it matters here: WebKit says ITP "deletes all website data for
websites you haven't visited in a while. This includes service worker
registrations", and "ITP removing a service worker registration would render the
push subscription useless" — whereas with `window.pushManager`, "the removal of
that service worker registration will not affect the associated push subscription."
A companion app is *by construction* opened rarely. Classic Web Push is the wrong
shape for it; declarative is the right one.

**And WebKit anticipated our exact case**, in a section titled "What if I can't
send the notification description through the internet?": "maybe the app is for
secure communication and decryption keys for the notification payload only exist
within the app on the device." Their answer is the pattern to copy — the push
carries a generic fallback that is always displayable, an installed service worker
may *replace* it from local state, and "If the event handler fails to display a
replacement notification in time, the fallback is used."

### 3. The LAN-only alternatives, costed at the failure mode

Every row is judged on the case the feature exists for: **phone locked, off
Wi-Fi.** The happy paths are all fine and all irrelevant.

| option | wakes a locked phone that is off Wi-Fi? | what it actually costs |
|---|---|---|
| foregrounded PWA holding the session (R12.5's poll) | **No** — nor a locked phone *on* Wi-Fi | nothing new; this is already what R12.5 does |
| Background Sync / Periodic Background Sync to poll | **No — it does not exist on iOS** | MDN browser-compat-data `api.SyncManager` (fetched 2026-08-21): Safari `version_added: false` (open bug webkit.org/b/182565), `safari_ios` mirrors it, Firefox false, Chrome 49. MDN labels the API "Limited availability … not Baseline". A closed iOS web app cannot poll at all |
| self-hosted **ntfy**, iOS app | **Not instantly** | ntfy's own docs concede it: a self-hosted server has to "forward so called `poll_request` messages to the main ntfy.sh server", and the chain is ntfy.sh → Firebase → APNs. Without `upstream-base-url`, "delivery can take hours, depending on the state of the phone"; on an active phone "it shouldn't take more than 20-30 minutes". Their stated reason: "iOS heavily restricts background processing", making instant push impossible "without a central server" |
| self-hosted ntfy / **UnifiedPush**, Android app | **Yes** — the one genuinely Google-free wake | UnifiedPush's distributor list (fetched 2026-08-21) is **Android and Linux only; no iOS distributor exists**. Costs a second app the user installs and runs, plus a server that must be internet-reachable for the off-Wi-Fi case — i.e. the relay problem again, wearing a different hat |
| Matrix / XMPP the user already runs | same split | iOS clients reach the device through a push gateway into APNs; Android clients can use UnifiedPush. Inherits the two rows above and adds a whole second protocol |
| iOS **Local Push Connectivity** | **No, by design** | Apple: for when "access to the wider internet is unavailable". `NEAppPushManager` instances "indicate on which Wi-Fi networks the extension runs", and it runs "as long as the device joins the matching SSID". Needs a native app *and* an extension *and* `com.apple.developer.networking.networkextension` with the `app-push-provider` value, "Request this entitlement from the Entitlement Request Page". SSID-bound is the exact opposite of what we need; Apple's own advice is to fall back to APNs when there is no local connection |
| local-network wake (WoL and friends) | **No** | wakes machines, not phone apps — and off Wi-Fi there is no LAN to wake from |

**The honest summary: every LAN-only option fails in the same place, and it is the
place that motivates the feature.** A locked phone off Wi-Fi is reachable only via
the single persistent connection the OS itself maintains — APNs or FCM. On iOS
there is no third answer, and the people who maintain the leading self-hosted push
server say so in their own documentation. On Android there is one, and it costs a
native app plus an internet-reachable server.

**The Android/FCM half, for completeness.** Chrome/Android Web Push goes to
`fcm.googleapis.com` with Google as push service; VAPID replaced the old GCM
sender-id coupling, so **no Firebase project is needed to send** — web.dev's "The
Web Push Protocol": the `applicationServerKey` "is passed to the push service and
used to check that the application that subscribed the user is also the
application that is triggering push messages". Delivery to a dozing device turns
on one header: Firebase's priority docs say normal-priority delivery "may be
delayed" until a Doze maintenance window or the user wakes the device, while high
priority makes FCM attempt immediate delivery, "waking a sleeping device when
necessary". Android 13+ downgrades apps that send high priority *without* showing
a notification — which §2 forbids us from doing anyway, so the two platforms'
constraints agree rather than conflict.

### 4. What the user loses if the answer is "nothing reliable"

They lose **remote unblocking on a phone they are not looking at** — and only that.
They keep remote *observation* and remote *approval* whenever they open the app
(R12.5), and they keep the laptop, where Claude Code already prompts and always
will. ADR-0006 §5 makes this safe rather than merely tolerable: silence denies, so
a missed prompt costs a denial and a re-ask, never a wrong action.

What is actually lost is **latency**. For an agent that blocks a few times an hour,
"the app must be open" collapses the feature to "a dashboard I remember to check" —
worth having, and not what the phrase *companion app* promises. That is the trade,
stated plainly, so nobody has to rediscover it.

### The recommendation the ADR can absorb

**Push ships as a doorbell, not a channel** — eight constraints, each traceable to
a source above:

1. **Originated by the blocked machine, never the relay** (§0 above). No endpoint,
   key pair, or JWT leaves the laptop. ADR-0006 §3b needs no amendment.
2. **Opt-in, off by default, per paired device, revocable locally** — matching §3a's
   local-only enrolment and §6's revocation-works-while-the-phone-is-off rule.
3. **The payload is a constant.** Never the project, the command, the tool name, the
   argument, or the digest — the answer to "what may a push contain" is *"something
   is waiting"* and literally nothing else. Declarative shape, fixed strings, e.g.
   `{"web_push": 8030, "notification": {"title": "Golem", "body": "A decision is waiting."}}`,
   **padded to a fixed length** so the size channel carries nothing (Push API §4
   names padding as the only mitigation; RFC 8291 §4 gives the room).
   **No `Topic` header ever** (RFC 8030 §8.1). VAPID `sub` is a project URL, never
   the user's email (RFC 8292 §2.1 makes it optional).
4. **`Urgency: high`, and `TTL` no longer than the gate deadline.** A doorbell that
   rings after the decision expired is a lie: §4 binds a decision to a deadline and
   §5 makes silence deny, so a stale push must expire in the push service rather
   than arrive late.
5. **The notification is not a control.** No actions, no inline reply, nothing
   approvable from a lock-screen preview — R12.5 already requires this, and Apple's
   no-silent-push rule means the notification is guaranteed to be *seen*, which
   makes the discipline load-bearing rather than cosmetic.
6. **Enrichment, if any, is local.** A service worker may replace the fallback using
   the paired laptop over the existing mTLS session — WebKit's documented pattern
   for exactly our case. If the phone cannot reach the laptop, the generic fallback
   stands. Never enrich from the push body.
7. **Third parties that remain in the path, named:** **Apple** (APNs,
   `*.push.apple.com`) for iOS and Safari; **Google** (FCM, `fcm.googleapis.com`)
   for Chrome and Android; **Mozilla** (autopush) for Firefox. Each learns a stable
   VAPID pseudonym for this laptop, this device's subscription, the timing and
   frequency of blocks, a padded constant size, and the laptop's IP. None can learn
   what is being asked. **No Golem-operated push service** — R6.3's bar holds.
8. **This is a new concession, not a re-reading of §3b.** §3b concedes what the
   *relay* learns. This concedes a *second* observer that learns when this
   developer's agent needed a decision. It deserves its own sentence in the ADR,
   not a clause folded into an existing one.

### The precondition nobody has tested, and the two observations that settle it

Everything above is about the transport. There is a prior question the
documentation does not answer, and it decides whether push is reachable at all:
**a push subscription is bound to an origin, and the companion app's origin is the
laptop.**

Verified: the Push API abstract has push messages "delivered to a Service Worker
that runs in the origin of the web application", and §4 ties deactivation to "the
service worker registration associated with the push subscription". Change the
origin, lose the subscription. Under ADR-0006 §3a the app is served by the laptop
over mTLS with a Golem-issued certificate — so the origin is a LAN address, and two
things are open:

1. **Untested:** whether an iOS 26 Home Screen web app installed from an origin
   whose certificate chains to a *user-installed* Golem CA can register a service
   worker and obtain a push subscription. Nothing in Apple's or WebKit's docs
   forbids it; nothing confirms it. Do not build on either assumption — this is
   exactly the shape of §123, where a plausible TLS assumption turned out false on
   contact with a real client.
2. **Unresolved by design:** `https://192.168.1.20:41199` is not stable. A new DHCP
   lease, a different network, or the relayed transport yields a *different origin*,
   hence a different install and a different subscription. Web Push needs one
   origin for the life of the pairing, while §3b deliberately gives the app two
   transports. R12.5's "the UI must not know which transport it is on" therefore
   hardens into a requirement on the **origin**, and it lands on R12.8, not here.

**The reproducible test, in the manner of §100 and §108.** Pair one iPhone on iOS
26 against a laptop serving the R12.5 dashboard at a stable name with a Golem-CA
certificate. Add to Home Screen. Call `window.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`
and record whether an endpoint comes back. Then send one padded declarative push
from the laptop with the phone **locked and on cellular only**, and record whether
it arrives and how late. Two observations settle the whole question. Neither is
possible from this machine and neither is a code change, so it is a gate on
R12.5/R12.8 rather than work this spike could have done.

### Outcome

**Outcome 1 of the three, conditionally: a self-hosted-enough path exists** —
content-blind by construction, no Golem-operated service, the relay untouched and
its §3b properties intact — with every remaining third party named in
recommendation 7 and one device test outstanding.

Two clean negatives are recorded alongside it, and they are the durable half:
**there is no Apple-free way to wake a locked iPhone that is off Wi-Fi** (ntfy's
maintainers concede it in their own docs, Local Push Connectivity is SSID-bound and
entitlement-gated, Background Sync does not exist in Safari), and **no LAN-only
mechanism addresses the case the feature exists for.**

Until the device test passes, **R12.5 ships the degraded path**: it polls while
open and claims nothing more. The sentence for the screen is
**"Alerts are off — this screen only updates while it is open."**

**Sources, all fetched 2026-08-21:** RFC 8030 §§8.1–8.3
(`https://www.rfc-editor.org/rfc/rfc8030.txt`); RFC 8291 §§4, 7
(`https://www.rfc-editor.org/rfc/rfc8291.txt`); RFC 8292 §§2.1, 4, 5
(`https://www.rfc-editor.org/rfc/rfc8292.txt`); W3C Push API Working Draft
01 December 2025 §§3.3, 4 (`https://www.w3.org/TR/push-api/`); Apple, "Sending web
push notifications in web apps and browsers"
(`https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers`);
Apple, "Local push connectivity"
(`https://developer.apple.com/documentation/networkextension/local-push-connectivity`);
WebKit, "Web Push for Web Apps on iOS and iPadOS", 2023-02-16
(`https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/`); WebKit,
"Meet Declarative Web Push", 2025-03-27
(`https://webkit.org/blog/16535/meet-declarative-web-push/`); WebKit, "WebKit
Features in Safari 26.0", 2025-09-15
(`https://webkit.org/blog/17333/webkit-features-in-safari-26-0/`) plus the 26.2 /
26.4 / 26.6 notes; ntfy configuration docs, iOS section
(`https://docs.ntfy.sh/config/`); UnifiedPush distributors
(`https://unifiedpush.org/users/distributors/`); web.dev, "The Web Push Protocol"
(`https://web.dev/articles/push-notifications-web-push-protocol`); Firebase message
priority docs (`https://firebase.google.com/docs/cloud-messaging/android-message-priority`);
MDN browser-compat-data `api.SyncManager`
(`https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/SyncManager.json`).

## §136 — R12.7: the reverse channel Decision 37 said was impossible now EXISTS and is an MCP server — the "no continue button" outcome survives, its reason does not (2026-08-22)

R12.7's brief asked for a re-verification rather than a restatement of Decision 37
(2026-07-18) and of ADR-0006's capability-3 row ("Start work in an idle session —
Structurally unavailable"). The re-verification **falsifies the reason**. Recorded
in full, because a task written on the assumption that nothing had changed found
the one thing that did.

**Verified against Claude Code `2.1.235`** (`claude --version`, installed on this
machine, 2026-08-22) and the live docs fetched 2026-08-22.

### What Decision 37 claimed, and which half still holds

Decision 37 gave two reasons, and they have diverged:

1. **The architectural half — STILL TRUE, verbatim.** "The proxy sits *below*
   Claude Code as a request relay with no reverse channel into the interactive
   TUI, `/resume` is a client-side slash command the proxy never sees." Nothing in
   the current client changes this. No request-path mechanism was added; the proxy
   still sees `/v1/messages` and nothing else, and no amount of proxying creates a
   user turn.
2. **The product half — NO LONGER TRUE.** "There is no IPC into an already-running
   interactive session (only into headless/SDK processes a caller launches
   itself)", and "the only techniques that reach a live TUI are tmux `send-keys` /
   OS keystroke injection". Both statements are now false. Anthropic shipped three
   supported mechanisms, none of which is screen-scraping.

### The three supported mechanisms that now exist

**1. Channels — the one that matters, because it is an MCP server.**
`https://code.claude.com/docs/en/channels` and
`https://code.claude.com/docs/en/channels-reference`, both fetched 2026-08-22. The
page title is literally *"Push events into a running session with channels"*, and
the definition is quoted exactly:

> "A channel is an MCP server that pushes events into your running Claude Code
> session, so Claude can react to things that happen while you're not at the
> terminal."

The contract is small and entirely public:

- declare `capabilities: { experimental: { 'claude/channel': {} } }` — "Required.
  Always `{}`. Presence registers the notification listener."
- emit `notifications/claude/channel` with `params.content` (string) and optional
  `params.meta` (`Record<string,string>`);
- connect over **stdio**: "A channel is an MCP server that runs on the same machine
  as Claude Code. Claude Code spawns it as a subprocess and communicates over
  stdio."
- the event reaches the model as `<channel source="your-channel" …>content</channel>`.

The documented walkthrough is a webhook receiver listening on `127.0.0.1:8788` that
forwards every POST body into the session, and the fakechat quickstart's terminal
notice says messages "**inject directly in this session**". **Golem is already an
MCP server** (`src/mcp/`), so this seam is reachable in principle without a new
dependency — the MCP SDK is the only hard requirement and "Node, Bun and Deno all
work" (the pre-built plugins use Bun; a custom channel need not).

**Also first-party now: remote approve/deny.** A channel may declare
`capabilities.experimental['claude/channel/permission']`, and Claude Code then
sends `notifications/claude/channel/permission_request` carrying `request_id`,
`tool_name`, `description` and `input_preview`, holding the local dialog open in
parallel — "you can answer in the terminal or on your phone, and Claude Code
applies whichever answer arrives first and closes the other". That is ADR-0006
capability 2, built by Anthropic, with a design close to R12.3's own (short id,
local dialog stays authoritative, first answer wins). Flagged for the batch, not
re-litigated here.

**2. Remote Control.** `https://code.claude.com/docs/en/remote-control` (fetched
2026-08-22) plus `claude remote-control` in the CLI reference: "Continue a local
Claude Code session from your phone, tablet, or any browser… Claude keeps running
locally the entire time." `claude --remote-control` / `--rc` enables it on an
ordinary interactive session you can still type into locally. Steering, images from
the phone, and Anthropic's own push notifications when Claude "needs a decision".
A first-party product occupying most of ADR-0006's ground. It is not a Golem seam
(Anthropic's app, Anthropic's API, an Anthropic account) and it is the honest thing
to point a user at who wants what capability 3 promised.

**3. Cross-session messaging.**
`https://code.claude.com/docs/en/cross-session-messaging` (fetched 2026-08-22),
"requires Claude Code v2.1.224 or later and runs on macOS and Linux". `ListAgents`
+ `SendMessage`, and the sentence that settles the idle question outright: "The
receiving Claude reads the message between tool calls during an active turn… **When
the receiving session is idle, Claude Code starts a new turn with the message.**"
Model-driven (Claude calls the tools, not a third party), and **not available on
Windows**, which is this developer's platform.

### So why R12.5 still ships NO continue button

The capability exists; the button still does not, and the reasons are now different
— each one a quote rather than a preference:

1. **It is opt-in at launch, per session, by flag.** "Being in `.mcp.json` isn't
   enough: a server also has to be named in `--channels`." A session already
   running without the flag cannot be reached, and the phone cannot know how the
   laptop's session was started. A control that works on some sessions and silently
   does nothing on the rest is worse than an absent control.
2. **A custom channel is not on the allowlist.** "During the research preview,
   every channel must be on the approved allowlist to register… the approved
   allowlist is Anthropic-curated, so your channel stays on the development flag
   while you build and test" — i.e. `--dangerously-load-development-channels`.
   Golem does not ship a feature whose only path is a flag with `dangerously` in
   its name.
3. **There is no delivery acknowledgement.** "Claude Code doesn't acknowledge
   notifications. The `await` on `mcp.notification()` resolves when the message is
   written to the transport, not when Claude has processed it. If the session hasn't
   loaded your server as a channel, or the organization policy blocks it, **Claude
   Code drops the events silently and returns no error to your server**." A phone
   button that cannot learn whether its message landed can only lie. It is the same
   class of failure ADR-0006 §5 answers with "silence denies" — except silence on a
   *send* has no safe interpretation, because nothing was being held open to deny.
4. **The contract is explicitly unstable, and account-shaped.** "the `--channels`
   flag syntax and protocol contract may change based on feedback"; channels
   "require Anthropic authentication through claude.ai or a Console API key, and are
   not available on Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft
   Foundry" — which collides with Golem's multi-account/gateway routing (ADR-0003,
   R6.1) rather than composing with it.
5. **Authoring a turn is a strictly larger authority than answering one, and
   ADR-0006 was not accepted for it.** ADR-0002's class line constrains *tool calls
   the model proposes*; injected free text can propose anything, so it routes around
   the line rather than sitting behind it. The docs put the burden on the channel
   author in exactly these words: "Anyone who can reply through the channel can
   approve or deny tool use in your session, so only allowlist senders you trust
   with that authority." Extending a paired phone from "answer the question the hook
   is holding open" to "write a new instruction" is a **new user decision**, not a
   UI affordance R12.5's author may add.

### The honest substitute, and what it may never be called

Unchanged and still correct: **enqueue, do not inject.** R5.1's durable queue
(`golem task add|list|show|resume|cancel`, `notBefore`, `isResumable`, headless
`claude --resume <id> -p …` — §65) is the only path where a phone changes what
happens next without anyone pretending work has begun.

Decided here, for R12.5: **do not surface it in R12.5.** A phone that can enqueue a
prompt can enqueue *any* prompt, which the next headless resume then executes with
the local session's permissions — capability 2's blast radius without capability 2's
held-open hook. It needs its own opt-in and its own ADR paragraph (R12.10). If it is
ever surfaced, three rules hold:

- **never the word "continue"** (nor "resume", "send", "go"). The only honest label
  is **"Add a task for later"**, with the sub-line **"Nothing runs until your laptop
  picks it up."**
- **never in the same visual group as Approve/Deny** — one answers a question that
  already exists, the other creates work nothing has agreed to do.
- **no progress, no spinner, no state that implies execution.** The success
  confirmation is that a task was *written*, and nothing more.

### The sentence R12.5 puts where the button isn't

Matching §135's register ("Alerts are off — this screen only updates while it is
open."):

> **"There is no prompt box — this screen can answer what the agent is already
> asking, but nothing here can start a turn."**

Scoped to *here* on purpose. "No phone can steer a session" would now be false —
Remote Control does exactly that — so the sentence claims only what is true of
Golem's own surface, and gives a reason the reader can act on: the hook holds a
question open, and that is the only thing there is to answer.

### Consistency with §135 (R12.6), not a re-litigation

No conflict. §135's push must be laptop-originated because the blocked laptop is
awake by definition; the same fact is why an enqueued task has something local that
*could* pick it up later. But awake is not willing-to-begin-a-turn, and nothing in
the push path creates one. §135 stands as written.

### What this obliges someone to change

- **ADR-0006's capability-3 row** says "Structurally unavailable (Decision 37)". The
  *outcome* stands; the *reason* is superseded. A dated re-verification block is
  added to the ADR pointing here, rather than rewriting an accepted decision.
- **Spec Decision 59(g)** ("Capability 3 does not exist… there is no reverse channel
  into the interactive TUI") needs a **user** amendment: the accurate wording is
  that Golem *declines to build* capability 3, not that it cannot. A dated pointer
  is appended; the decision text is left to the user.
- **R12.10** is filed for the question this opens: whether a Golem channel is worth
  having once the research preview stabilises, plus the narrower
  phone-enqueues-a-task half.

### Observed in passing (two defects, not filed)

- **CCR expand returned "Unknown or expired CCR ref" for three WebFetch refs**
  minutes after they were issued (e.g.
  `e6479a89ad4304c04c3d4168486b6833033256ee2eb5f74f627bc6cd9ec14576`), while the
  swap marker promised "The full original is stored losslessly". The workaround was
  `curl` + `sed` against the same URL. A marker naming a retrieval path that then
  404s is worse than no marker.
- **The session scratchpad path is redacted out of shell commands.** Its UUID
  segment reads as high-entropy, so `curl -o <scratchpad>/f.md` became
  `-o C:[REDACTED:high-entropy:1].md` and the next `grep` failed on a path that
  does not exist. Redaction working as designed on a path that has to survive
  verbatim.

**Sources, all fetched 2026-08-22** (client `2.1.235`):
`https://code.claude.com/docs/en/channels.md`;
`https://code.claude.com/docs/en/channels-reference.md` (Overview; What you need;
Test during the research preview; Server options; Notification format; Relay
permission prompts); `https://code.claude.com/docs/en/cross-session-messaging.md`;
`https://code.claude.com/docs/en/remote-control.md`;
`https://code.claude.com/docs/en/cli-reference` (`claude remote-control`,
`claude attach`, `claude agents`, `claude respawn`, `claude daemon status`);
`https://code.claude.com/docs/en/changelog.md`; `https://code.claude.com/docs/llms.txt`.


## §137 — `subagent-park`: the park is a tool-call gate, so it can only ever be applied at the spawn (2026-08-22)

**The gap, restated from the evidence rather than from the design.** Three
subagents were dispatched on R12 work on 2026-08-22. Two terminated on
`Agent terminated early due to an API error: You've hit your session limit`,
their last recorded words "All green. Committing." and "Committing on a fresh
branch off main." The parent session, at ~96% utilization, was protected
correctly: its next tool call was denied with the enforcing park instruction.

So the park works and does not reach a child. The reason is structural, not a
bug: `PreToolUse` gates **tool calls**, and the limit is hit on a **model
request**. The child's turn fails upstream before it proposes a call, so there
is nothing to deny and no turn in which the child could write a note. Making the
gate stricter inside the child cannot help — the child never gets a turn to be
gated.

**What is actually reachable.** The one part of a subagent's lifetime the parent
issues as an ordinary tool call is the spawn. Gating there keeps every existing
rule intact: the gate stays a tool-call gate, the decision stays local, nothing
new touches the request path.

**Pricing a spawn.** The threshold is not the park threshold, because a spawn is
a span of burn rather than a call: a spawn at 60% that runs twenty minutes can
still die at 100%, and one at 85% that takes a minute will not. Measured from
this session, the three agents consumed **~171k, ~186k and ~186k subagent tokens
over 85–94 tool calls each** — roughly 15–20% of a session window apiece. Shipped
default `snooze.spawn_cost_fraction = 0.18`; a spawn is refused when
`utilization + fraction x (in-flight + 1) > 1`.

**The in-flight term is the part that would otherwise still lose agents.**
Utilization already contains what running children have spent, so charging them
again would double-count. What it does *not* contain is a sibling dispatched
since the reading was taken — precisely the three-at-once fan-out above, where
each spawn reads the same pre-batch number and each looks affordable alone.
Allowed spawns are therefore recorded (`.golem/state/spawn-gate.json`) and any
recorded after `observedAtIso` is charged at the estimate.

**Fail-closed, without a deadlock.** No reading, or a cold header feed, means the
gate cannot measure. Assuming headroom there is the failure mode the task named,
so it warns instead — **once per reading**, after which a re-issued spawn
proceeds. That keeps the honest half of ADR-0002 (never silently allow) without
recreating the R9.23 deadlock, where a hard deny made the only permitted action
unreachable.

**Ordering against the park.** The spawn gate runs *after* the park block. At or
above the park threshold a spawn is denied by the park like every other call, and
"park now" is the more useful instruction than "that spawn is too expensive". In
practice the spawn gate therefore bites in the band below the park threshold,
which is exactly where the lost agents were dispatched from.

**What could not be gated, and is guidance instead.** A long-running child can
still outlive its budget after a legitimate spawn. Two mitigations need no
reverse channel and are now in the seeded `subagent-headroom` rule: tell every
dispatched agent to **commit working increments on its own branch** (the two
survivors survived precisely because they had committed — note the tension with
"one workstream per PR": commit early, not merge early), and when a child does
die, **convert its task notification into a durable task** naming what it was
doing. The record survives even though the process does not; that is the honest
version of "resume", and it stays inside Decision 37's boundary — nothing injects
a turn into a dying child and nothing synthesises a reply in the proxy.

**Surfaces.** `snooze.spawn_gate` (default true) and `snooze.spawn_cost_fraction`
(default 0.18); env `GOLEM_SNOOZE_SPAWN_GATE` / `GOLEM_SNOOZE_SPAWN_COST_FRACTION`
via the generic mapping. `golem status`'s Limits line now ends
`park advisory|enforced · spawns allowed|REFUSED|ungated|warn-once ~18%/agent` —
`REFUSED` is computed against the live reading, so it claims the gate is *biting*,
not merely enabled.

**Demonstrated, not argued.** The refusal, the both-names match (`Task` and
`Agent`), the unchanged with-headroom path, the three-at-once fan-out, the
one-shot blind warning, the off switch, and the yields-to-the-park ordering are
all driven through the real hook with an injected utilization —
`tests/unit/hooks/pre-tool-use.test.ts`, plus the decision function in
`tests/unit/hooks/spawn-gate.test.ts`.
## §138 — ccr-ref-scope: `expand` misses across a git worktree because the CCR store is rooted per-directory, and "expired" was never real (2026-08-22)

Closes the defect §136 logged in passing: `expand` returned "Unknown or expired
CCR ref" for WebFetch refs minutes after they were issued. Task doc:
`docs/plan/tasks/ccr-ref-scope.md`.

### "Expired" disproved before anything else

Grepped `prune|evict|ttl|maxEntries|expiry|expire` across `src/compression/ccr-store.ts`
and `src/compression/local-blob-store.ts`: no hits except a docstring saying "or
was evicted" — aspirational, not implemented. Neither class prunes, ever. So
"expired" was always a guess dressed as a diagnosis, and the fix could not be a
retention policy (also explicitly out of scope per the task doc).

### The two-roots hypothesis, verified before being fixed

`tests/integration/ccr-worktree-scope.test.ts` (committed first, as `0f37604`,
*failing*) built a real main checkout, ran a real `git worktree add`, ran the
real `PostToolUseHook` with `cwd` = the worktree, then called
`NativeLosslessCompression.forProjectDir(mainRoot).retrieve(...)` for the ref the
hook had just issued. It failed exactly as predicted:

```
UnknownRefError: unknown CCR ref: 33346a47987f1e9200e4fbe85e8e2c161189b1e2b4ebd0417f89dcd20ca6f8ab
    at src/compression/ccr-store.ts:76
```

Confirms the task doc's hypothesis exactly: the hook resolves its CCR root from
`cwd` (the worktree), `expand` is served by whichever `NativeLosslessCompression`
the MCP server was built with (rooted at the main checkout) — same refId, two
different `.golem/ccr` directories.

### The identity decision: a worktree IS the same project (agrees with `canonicalProjectId`)

Per the task doc's default ("go there unless something in the redaction or
storage contract argues otherwise"): a git linked worktree is the SAME project as
its main checkout for CCR purposes. Resolved through git's own bookkeeping — a
worktree's `.git` is a FILE holding `gitdir: <main>/.git/worktrees/<name>`, and
that directory's `commondir` file holds the path back to the shared `.git` — read
directly with `node:fs`, no `git` subprocess (keeps `forProjectDir` synchronous,
matching its 4 existing call sites: `src/cli/mcp-compression.ts`,
`src/cli/proxy-runtime.ts`, `src/cli/stats.ts`, plus test/contract call sites).

New shared function: `src/shared/git-worktree.ts#resolveWorktreeRoot`. Both
identity decisions route through it — `NativeLosslessCompression.forProjectDir`
and `src/hooks/post-tool-use.ts`'s write side for CCR, `canonicalProjectId`
(`src/knowledge/file-driver.ts`) for the vector index — so the two answers cannot
independently drift, the exact requirement the task doc raised by pointing at
R11.2's precedent. Wiki page: `docs/wiki/concepts/CCR Ref Scope.md`.

### `UnknownRefError` now distinguishes its causes

`src/interfaces/compression.ts`'s `UnknownRefError` gained `location` and
`reason: "not-found" | "corrupt"` (backward compatible — `new
UnknownRefError(refId)` alone still works, defaulting both). `CcrStore.getEnvelope`
now throws with the store's own `#location` and the correct reason for each of
the three real causes (never stored / stored under a different root — both
"not-found", since a store cannot tell them apart from the outside; invalid JSON;
schema validation failure — both "corrupt", with `detail`). `src/mcp/server.ts`'s
`expand` tool and `src/mcp/in-memory-compression.ts`'s stub now surface
`error.message` directly instead of a fixed "Unknown or expired" string.

### End-to-end confirmation, before and after, against the real built artifacts

Rebuilt (`npm run build`) and ran a standalone script against `dist/` (not
source-via-vitest) reproducing the exact scenario: real `git worktree add`, the
built `dist/hooks/index.js` PostToolUse handler with `cwd` = worktree, then the
built `dist/compression/index.js` `NativeLosslessCompression.forProjectDir(mainRoot)`
— `expand`'s real code path. Result:

```
ref issued from worktree hook: 33346a47987f1e9200e4fbe85e8e2c161189b1e2b4ebd0417f89dcd20ca6f8ab
RESULT: expand from main retrieved 40000 bytes; byte-identical: true
RESULT: unsatisfiable-ref error message:
  no envelope for CCR ref "000...000" at <main>\.golem\ccr — either it was never stored, or it was stored under a different project root.
  reason: not-found location: <main>\.golem\ccr
```

Proxy rebuilt and restarted (`golem proxy restart`) against the new `dist/`.

### Verification run (2026-08-22, CI still billing-blocked per the suspended gate)

- `npx tsc --noEmit` — exit 0
- `npm run lint` (biome check) — exit 0 (after fixing import order/quote-style in
  the two new test files and a line-wrap in `ccr-store.ts` that biome's formatter
  wanted)
- `npm run format:check` — exit 0
- `npx vitest run` — **233 files passed, 1 skipped (234); 2998 tests passed, 2
  skipped (3000)** — exit 0
- `golem wiki check` — 171 pages + 1 doc, no issues — exit 0

New/extended tests: `tests/integration/ccr-worktree-scope.test.ts` (the
reproduction, at the seam that broke), `tests/unit/shared/git-worktree.test.ts`
(9 cases for `resolveWorktreeRoot`, including malformed-layout fallbacks),
`tests/unit/compression/ccr-store.test.ts` (7 cases for the split
`UnknownRefError`), plus a worktree case added to
`tests/unit/knowledge/file-driver.test.ts`'s `canonicalProjectId` suite proving
it agrees with the CCR store's answer.
## §139 — `docs-slider-drift-remainder`: the check reached the spec body, and the Decisions Log needed a heading-scoped exemption, not a weaker one (2026-08-22)

§132 (2026-08-20) retired the slider in code; the `golem wiki check` retired-
identifier scan (docs-slider-drift, 2026-08-21) covered the wiki and README.md.
Two surfaces were still stale: `docs/golem-spec.md` §1-8 (~30 live mentions
across §1-8, not counting §9) and `vscode-extension/README.md` (4 lines), plus
two leftover code strings. All four are now clean and `golem wiki check`
confirms it: 171 pages + 3 non-wiki docs, 0 issues.

**1. Whether the existing `RECORD_CITATION` rule already covered the
Decisions Log had to be verified, not assumed — it did not.** The brief
allowed adding exemption machinery only if the existing per-unit rule
genuinely failed there. Read all 44 slider-mentioning units in §9 individually:
the large majority cite a decision number or `verification-notes` **by name**,
not by the literal `.md`-suffixed path or `docs/decisions/`/`docs/plan/`
prefix `RECORD_CITATION`'s regex requires, and several name no record at all —
they're describing the slider's own retirement as history, which
`RETIREMENT_CONTEXT` almost catches but not reliably per-unit across a
44-unit section. Loosening either regex to pass §9 would have loosened them
project-wide, which is exactly the "weaken the rule" the brief forbade. Added
instead: `decisionsLogStartLine` (`src/cli/wiki.ts`), a heading-keyed,
whole-section exemption — any unit whose `startLine` is at or after a
`## ... Decisions Log` heading (case-insensitive, any level) is skipped before
the existing per-unit checks run. Scoped to one section of one document by
construction: a page with no such heading is unaffected, and this is not a
directory-based `RECORD_ZONES` rule, since a single mixed-content file can't
use one. Covered by three new cases in
`tests/unit/cli/wiki-retired-identifiers.test.ts` (unexempted mention under
the heading: not flagged; the same mention before the heading: still flagged;
heading match is case-insensitive with any prefix/level). `PROSE_FILES_OUTSIDE_WIKI`
widened from `["README.md"]` to add `docs/golem-spec.md` and
`vscode-extension/README.md` — still an explicit allowlist by design, not a
tree-walk.

**2. The spec rewrite found two staleness bugs beyond renaming.** (a) Two
spots (`slider ≥4`, `levels 3-4`) named a compression level that never existed
even on the pre-ADR-0004 0-3 scale — Decision 30 had already collapsed it, so
this wasn't ADR-0004 drift, it was uncaught leftover drift from an earlier
decision. (b) One spot ("Claude refines (slider-gated)") described an
auto-triggered local-draft feature that Decision 31 **removed outright**, not
renamed — the coder tool is invoked explicitly now, never auto-triggered by a
dial value — so that line needed a rewrite of its claim, not a substitution
of its noun. §9 (Decisions Log) is untouched, per the exemption above; the
ASCII architecture diagram's box width (a fenced code block, not stripped by
the checker) was preserved exactly when its label changed.

**3. The vscode README rewrite was grounded in the extension's actual current
model, not the brief's description of the old one.** Read `render.js` /
`extension.js` before touching prose: the panel already renders a
`compression.level` picker (`off`/`1`/`2`/`3`, named Off/Lossless/Balanced/
Aggressive), and the danger-confirmed control is `proxy.bypass_all`, rendered
by the Settings section with its own `danger` string — there is no "slider
level 0" anywhere in the running code, so the fix was letting the README catch
up to code that had already moved. Line 26 was the one that mattered most:
"slider level 0 disables redaction" is the exact claim ADR-0004 makes
false — a number cannot disable redaction now, only `proxy.bypass_all` can,
and it is never the default. While grounding the rewrite, found the
pre-existing text also conflated two states `levelLabel()` (Decision 56) keeps
separate: a **stopped** proxy reads `Passthrough`; a **running** proxy with
`proxy.bypass_all` on reads `Bypass` (it's still serving and redacting, so
grouping it with "stopped" would misdescribe it). Corrected in the same pass
since it sits in the paragraph being rewritten anyway.

**4. Two code strings, both drafted first via the local model (`coder` MCP
tool, `qwen/qwen3.7-flash` target) per standing preference, then hand-
finished.** `src/config/ui-model.ts`'s `brevity.level` summary offered
`"auto (follow the slider)"` — not a valid value since ADR-0004 — now lists
only the four real ones. Its `compression.level` detail string, found while
in the area, had a garbled leftover fragment from an earlier edit
("... until you set it back to auto. ... passthrough belongs to the slider,
where turning redaction off is surfaced loudly") — ungrammatical and wrong
twice over (no level offers passthrough now; bypass is a separate setting).
Rewritten. `src/tui/header.ts:42`'s local `HeaderSegment` variable was still
named `slider` though it renders the compression level (label `"Level"`) —
rename-only, output unchanged, confirmed both by reading the render call site
and by `golem status`'s live "Compression: 3 (aggressive) → effectively 1
(lossless)" / "Dials: brevity full" lines, which are built from the same
`StatusReport` `headerLines()` consumes.

**Known, deliberate hole: `src/dashboard/server.ts:246-247`'s `slider-level`/
`slider-name` DOM element ids are untouched.** Owned by workstream R12.6
(remote push); not touched here per the task brief. This is a real remaining
instance of the retired name, just not a user-visible string — the DOM ids
are an implementation detail, not label text — and the wiki checker does not
scan `.ts` source outside `PROSE_FILES_OUTSIDE_WIKI`, so it does not fire on
it. Left for R12.6 to rename when it next touches that file.

**Also observed, not fixed (out of the three defined surfaces): stale
comments in `vscode-extension/render.js`** (around `levelLabel()`'s doc
comment and the status-bar-item doc comment) still describe "slider level 0"
in prose form, even though the code beside them already reflects
`proxy.bypass_all`/`compression.level`. Code comments aren't the wiki
checker's domain and weren't one of the three named surfaces, so left as a
found-but-unfiled remainder — same defect class as this whole task, one layer
further down.

**Verification (exit codes, local gate per CLAUDE.md while CI stays
billing-blocked):** `npx tsc --noEmit` → 0. `npm run lint` → 0 (one biome
line-length wrap needed on `PROSE_FILES_OUTSIDE_WIKI` after widening it,
fixed in a follow-up commit). `npm run format:check` → 0. `npx vitest run` →
0, **230 files passed + 1 skipped (231), 2983 tests passed + 2 skipped
(2985)**. `golem wiki check` (built CLI, `dist/cli/main.js`) → 0, `171 page(s)
+ 3 doc(s), no issues`.
## §140 — redaction-path-uuid: a hex chunk now counts as clean in `isPathLikeToken` (2026-08-22)

Closes the false positive §136 hit incidentally (line above: `-o
C:[REDACTED:high-entropy:1].md`) and the task brief's own two sightings — the
session scratchpad path (`AppData/Local/Temp/claude/…/<uuid>/scratchpad`) and
`.claude/worktrees/agent-<id>/` both redact whole, because a UUID segment mixes
letters and digits and so is neither purely alphabetic nor purely numeric, the
two clean-chunk classes `isPathLikeToken` recognised until now.

**What changed, precisely.** `isPathLikeToken` (src/pipeline/redaction-rules.ts)
now accepts a third clean-chunk class: a chunk that is pure hex (dehyphenated
digits/`a-f`, either case). This is gated by `MIN_CHUNKS_FOR_HEX_ALLOWANCE = 3`
— a token needs at least 3 `/`-`_`-`-`-delimited chunks before a hex chunk is
allowed to count as clean, so a two-chunk `word-hexlike` pair (the shape a real
hyphenated secret most resembles) still fails the path-like check and reaches
the entropy sweep.

**Why this does not weaken redaction — the call-order argument, not just the
guard.** `isHighEntropyToken` already excludes a token that is *pure hex in its
entirety* (dehyphenated) before it ever calls `isPathLikeToken` — bare UUIDs
and git SHAs were non-secret before this task. So by the time a token reaches
`isPathLikeToken`, if a whole-token pure-hex exclusion did not already dispose
of it, at least one chunk is not hex-clean — either it is a genuine word, or it
mixes a digit with a letter outside `a-f`. This is a call-order invariant, not
an assumption: any token where a hex chunk allowance could accidentally admit a
real random secret would already have been caught earlier by the existing
whole-token check first, or the guard below.

The chunk-count guard is deliberate defense-in-depth on top of that invariant,
not the only thing carrying the argument: three-plus chunks matches every real
case in scope (a directory prefix plus a UUID/hash leaf) while giving a
hyphenated secret one fewer degree of freedom to hide in. Tests cover the floor
exactly (`tests/unit/pipeline/redaction-audit.test.ts`, "a hex chunk at exactly
the chunk-count floor (3) IS accepted as path-like") and one below it (the
2-chunk adversarial case, which still redacts).

**Left alone, on purpose (task's "Out of scope"):** the rule table, the
reversible-redaction map (R9.3), `ENTROPY_THRESHOLD_BITS`, the candidate
charset, and any allowlisting of scratchpad/worktree directories by path — an
allowlist only helps the two families already noticed and goes stale.

**The adversarial case that must still redact, verified in the suite:** a
4-chunk hyphenated token where every chunk mixes a digit with a letter drawn
from *outside* `a-f` (so no chunk is pure-alpha, pure-numeric, or pure-hex)
still redacts — the pre-existing "every chunk must be clean" rule rejects it
independent of the hex-chunk addition. Built at runtime from character codes
(`"g".charCodeAt(0)` through `"z"`), never a literal secret or a literal
`[REDACTED:…]` placeholder, per the standing fixture rule — see the live
finding below for why that rule is not academic.

**Live finding while drafting the tests, corroborating the bug from the other
side.** This dev environment's own tool traffic is routed through Golem's
proxy, so any Bash/Read output containing a 32–128-char run of the entropy
candidate charset gets redacted before it reaches the model — including this
agent's own diagnostic output, mid-task, more than once. Concretely: typing a
genuinely random 40-character mixed-case letter string (generated
programmatically, not a literal — via `charCodeAt` iteration, no copy-paste
involved) into a `console.log` and reading it back through the Bash tool
produced `[REDACTED:high-entropy:N]` instead of the string. This is not
data corruption from this task's change — re-verified after the fix, end to
end, below — it is the entropy sweep doing exactly what it is designed to do to
a token shaped like a real secret. It is useful corroborating evidence that the
mechanism described in the task brief is live and general, not a one-off.

**Copy-forward poisoning, reproduced on myself.** Mid-task, retyping a
scratchpad path that had appeared in earlier tool output (to reuse it in a new
command) produced a mangled/placeholder path at the moment of composing the
next tool call — the exact "Copy-forward is poisoned" mechanism the task
brief's Third-sighting section describes, caught here from the authoring side
rather than the reading side. Fix in the moment: stop reusing any path that has
already appeared in tool output; generate a fresh one (`mktemp -d`, or a fresh
`crypto.randomUUID()`) instead of retyping. See [[Redaction Path Placeholders]]
for the durable version of this advice.

**End-to-end verification, live, after `npm run build` + `golem proxy
restart`** (not just unit tests — an actual Bash round-trip through the
rebuilt pipeline): built fresh UUIDs at runtime (never copied from earlier
output), wrote them to disk inside path strings for both real path families,
measured ground truth on disk BEFORE looking at any tool-output view
(`wc -l`/`wc -c`, `grep -c REDACTED`, `md5sum`), then compared against the
`cat` view that comes back through the pipeline:

- POSIX scratchpad-shaped path + `.claude/worktrees/agent-<uuid>` path: ground
  truth 0 occurrences of `REDACTED` on disk (2 lines, 74/60 chars); the `cat`
  view matched byte-for-byte, no placeholders.
- The same UUID spelled both with `/` and with `\` in one file (per the Third
  sighting's requirement to test both separators and assert they agree):
  ground truth 2 lines, 74 chars each, checksum `631f41304fdef85be24e9c16f88e5236`
  on disk; the `cat` view showed both spellings intact and identical apart from
  the separator, confirming the fix (unlike before the fix, where only the `\`
  spelling would have survived, since `ENTROPY_CANDIDATE_RE` does not include
  `\`).
- Negative control, run through the same rebuilt pipeline: a genuine random
  40-character secret (built from `crypto.getRandomValues`, not a literal)
  still came back as `[REDACTED:high-entropy:N]` — redaction is not weakened
  for material that is not path-shaped.

**Verification commands, exit codes and totals (2026-08-22):**
`npx tsc --noEmit` → exit 0; `npm run lint` (`biome check .`) → exit 0, 561
files, no fixes; `npm run format:check` (`biome format .`) → exit 0, 561
files, no fixes; `npx vitest run` → exit 0, 230 test files passed / 1 skipped
(231), 2987 tests passed / 2 skipped (2989); `golem wiki check` → exit 0, 171
pages + 1 doc, no issues. `npx vitest run tests/unit/pipeline` alone → exit 0,
9 files / 140 tests, including the 28 tests (7 new) in
`redaction-audit.test.ts`.

See wiki [[Redaction Path Placeholders]] and
`docs/wiki/debriefs/2026-08-22-redaction-path-uuid-hex-chunk-allowance.md` for
the full writeup, and task `redaction-path-uuid`.

## §141 — R12.11: Golem can plausibly hold its class line against the channel relay, but only by moving enforcement one hook-event earlier than it currently sits — unconfirmed live for the interactive case (2026-08-22)

Task: `docs/plan/tasks/R12.11.md`. Evidence base going in: §136 (client `2.1.235`,
docs fetched 2026-08-22). Client version for everything new below: **`2.1.235`**,
same session. Every item is labelled **[DOCUMENTED]**, **[OBSERVED]**, or
**[UNESTABLISHED]** — never upgraded past what was actually run.

### The load-bearing discovery: Golem's real gate emits `ask`, never `deny`

**[OBSERVED — read from source, not a live run]** `src/autonomy/gate.ts:14,27-34`:
`GateEmission` is `"allow" | "ask" | null` — there is **no `deny` value in Golem's
own type**. For `destructive` and `outward`, `decideGate` returns
`{ emit: "ask", reason: gateReason(...) }` at **every** autonomy level. My own
throwaway test hook (`deny-hook.mjs`, now deleted) was modeled on the wrong shape —
its comment claimed to mirror "the same shape `src/hooks/pre-tool-use.ts` emits for
ADR-0002 destructive/outward," which is false. Golem never emits `deny`. It forces
a question (`ask`) and relies on `PreToolUse`'s `null`/`ask` both routing to
Claude Code's native permission flow — i.e. **the human**, per
`src/hooks/pre-tool-use.ts:273-276` ("anything that is not `allow` ends with the
human being asked"). This matters because `ask` does not *resolve* the request; it
only guarantees a question gets asked. Whoever answers that question is a separate
matter to establish — which is the whole spike.

### 1. Ordering — [DOCUMENTED, with one OBSERVED headless data point]

**[DOCUMENTED]** The hooks reference (`code.claude.com/docs/en/hooks`, re-fetched
fresh this session, content hash confirmed newer than the 2026-08-10 cache it
replaced) names an event Golem does not currently use: **`PermissionRequest`** —
"Runs when Claude Code is about to ask you for permission... if no hook returns a
decision, it denies the tool call" (this fires even in non-interactive sessions
that can't show a prompt). It is explicitly *distinct* from `PreToolUse`: "PreToolUse
hooks run before every tool call, whether or not it needs permission.
PermissionRequest hooks run only when Claude Code is about to [ask]." Its decision
shape is also distinct — `hookSpecificOutput.decision.behavior: "allow"|"deny"`,
not `permissionDecision`. Golem's hook wiring (`src/hooks/pre-tool-use.ts`)
registers `PreToolUse` only; it has never used `PermissionRequest`.

**[DOCUMENTED]** The same page, in the `Notification` event's `permission_prompt`
section: *"If you or a PermissionRequest hook answer sooner, Claude Code doesn't
run `permission_prompt`."* This is stated about one specific downstream notification
(the desktop-alert one, not the channel one), but it establishes the general
ordering claim precisely: a `PermissionRequest` hook decision resolves the request
**before** whatever fires next reacts to it. The channels-reference page describes
its own relay trigger the same way, independently: *"Claude Code calls it with the
four request fields **when a permission dialog opens**"* — i.e. the channel relay's
trigger condition is that a dialog exists at all. A `PermissionRequest` hook that
returns a decision means no dialog is ever shown (docs: "if no hook returns a
decision, it denies" — implying if one *does*, that decision stands in for the
dialog). Put together, this is a documented, textually-supported (not merely
API-shape-guessed) chain: `PreToolUse` (Golem, today: `ask`, i.e. defer) →
`PermissionRequest` (nobody, today: unhandled) → **dialog opens** → channel relay
fires. Golem's current `ask` sits at the first link and does not resolve anything;
the second link is the one that, per docs, can pre-empt the dialog (and by
construction, the relay) entirely — and Golem does not occupy it.

**[OBSERVED, headless `-p` only]** Four live `claude -p --dangerously-load-development-channels
server:testchan --verbose --output-format stream-json` runs against a throwaway
project (`.mcp.json` → a hand-written test channel declaring
`claude/channel` + `claude/channel/permission`; `.claude/settings.json` → a
throwaway `PreToolUse` hook on `Bash`), real first-party billing
(`apiKeySource:"none"`, `provider:"firstParty"`, ~$0.20/run):
- No hook, `permissionMode:"auto"`: Bash ran with zero prompt.
- `PreToolUse` hook forcing `permissionDecision:"deny"`: zero channel
  notifications (nothing to relay — the call never reached a decision point where
  a dialog could open).
- `PreToolUse` hook forcing `permissionDecision:"ask"`: the tool call resolved
  **synchronously to a denial** (`decision_reason_type:"hook"`,
  `non_execution_kind:"user-rejected"`), with **no dialog and no channel
  notification** logged in either case, despite the channel showing `"status":
  "connected"` in the same run's `mcp_servers` init block.

This headless result is now **explained, not just observed**: it is exactly the
documented `PermissionRequest` fallback — "in sessions that can't show a prompt...
if no hook returns a decision, it denies the tool call." `-p` mode can't show a
prompt; no `PermissionRequest` hook was registered; so it auto-denied before any
dialog (and therefore before any relay) existed. This is consistent with, and does
not contradict, the `PermissionRequest`-pre-empts-the-dialog theory above — it's
the same mechanism firing on its no-hook-registered branch instead of its
hook-returned-a-decision branch.

**[UNESTABLISHED]** Whether, in a genuine **interactive** session (not `-p`), a
`PermissionRequest` hook returning `behavior:"deny"` for `destructive`/`outward`
actually prevents the channel's `permission_request` notification from firing —
i.e. whether the channel relay's trigger and the `PermissionRequest` hook's
resolution point are the *same* event or merely adjacent ones. This is the one
test that would turn "documented, textually consistent" into "observed." It was
not run. Headless `-p` mode is structurally unable to open a dialog at all (see
above), so it cannot exercise this path regardless of which hook is registered;
running it needs a real interactive terminal session. This repo has no PTY-driving
test harness (`grep -rl "node-pty\|pty.spawn" tests/ src/ package.json` — no
hits; `grep -n "node-pty" package.json package-lock.json` — no hits), and building
one is a new, non-trivial capability (plus a native dependency CLAUDE.md's hard
rules already discourage for the default install) that this spike's budget does
not extend to. Filed as a follow-up rather than improvised: see task
`R12.12` below.

### 2. Whether a `deny`-shaped decision survives a remote `allow` — [UNESTABLISHED for the case that matters; near-vacuous for the one Golem currently ships]

The brief calls this "the whole spike in one test." Two different tests answer to
that name, and only the less important one was run:

- **Golem's shipped mechanism today (`ask` at `PreToolUse`) is not a decision at
  all** — it's a forced question with no answer attached, so there is nothing for
  a remote `allow` to race *against* until whatever answers the question (native
  dialog, or headless auto-deny) resolves it. **[OBSERVED, headless]**: `ask` in
  `-p` mode resolves to denial before any relay point exists — no race occurs
  because nothing is ever open to race over.
- **The test that actually matters** — a `PermissionRequest`-level `deny` (the
  fix §1 identifies as the candidate closure) racing a remote channel `allow` on
  a *genuinely open* interactive dialog — was not run, for the same
  structural/tooling reason as §1's `[UNESTABLISHED]` item. **[UNESTABLISHED]**.

One documented fact narrows this usefully: the channel's verdict schema
(`notifications/claude/channel/permission`, fields `request_id` + `behavior:
"allow"|"deny"`) only resolves a request Claude Code already has **open and
tracked by that `request_id`** — "Claude Code applies it only if the ID matches
an open request." If a `PermissionRequest` hook has already resolved the call
(no dialog, no `request_id` issued), there is nothing for a channel verdict to
attach to, full stop — not a race Golem wins, but a race that never starts. This
is the same "no dialog → nothing to relay" logic as §1, restated at the verdict
layer. **[DOCUMENTED]**.

### 3. Preview constraints, costed honestly — [DOCUMENTED, re-confirmed]

No change from §136's findings, re-confirmed against the fresh 2026-08-22 fetch:
research preview; Team/Enterprise organizations default to **blocked** until an
Owner explicitly enables `channelsEnabled` (Console-with-API-key defaults
**permitted**; Pro/Max individual, no org, **skips the check entirely**);
`--channels`/`--dangerously-load-development-channels` are launch-flag-only,
absent from `claude --help` while in preview, and being listed in `.mcp.json` is
not sufficient — a session without the flag never loads a channel regardless of
config; **no delivery acknowledgement** for a reply-tool message (only the
permission-relay verdict path has an explicit accept/reject shape); the whole
contract is stated as unstable research preview with version-gated behavior
changes already observed within it (the `v2.1.211`/`v2.1.233`/`v2.1.234` sanitization
and redaction changes named in channels-reference). **What would have to change
before a shipped Golem feature could depend on this:** (a) general availability
or at minimum an Enterprise-manageable stable flag, not a launch-argument opt-in
users must remember every session; (b) a documented commitment that the
protocol/notification shapes won't change out from under a shipped integration;
(c) ideally, a documented, class-aware way to mark a specific permission
request non-relayable (see §1/§2 — none exists today; a `PermissionRequest` hook
resolving the request first is a workaround, not that feature). **What a user
sees meanwhile:** nothing — Golem does not build against a channel today, so
there is no user-facing gap to explain; the gap is entirely between the paused
tasks and the point where these constraints would need to have changed.

### 4. What a channel route does NOT give — R12.5 disposition

**[DOCUMENTED]** ADR-0006 capability 1 (observe: a read-only status surface) is
architecturally untouched by any of this — channels are a notification/relay
path, not a read API, and R12.5's own design note already says the local panel
"deliberately does NOT surface permission prompts because Claude Code already
does." Once capability 2 (remote *answering* of `read`/`write`/`unknown`) is
something Anthropic's own channel does for free — for any user who enables it —
the part of R12.5 that would have been genuinely novel (a phone-shaped
approve/deny surface Golem built and operated) is subsumed by a first-party
feature Golem doesn't need to compete with. What's left for R12.5 is exactly
capability 1: a responsive, installable *view* of Golem's own dashboard
(project state, stats, pending-call visibility) with no approve/deny affordance
of its own — which is smaller than R12.5's current brief, not nothing.
**Recommendation: reduce R12.5 to the observe-only shape and drop its
approve/deny bullet; do not cancel it outright**, since a read-only phone
dashboard has value independent of any transport question.

### 5. The auth collision — [OBSERVED, and it complicates rather than resolves the question]

Re-confirmed from the prior session's live runs: this dev machine's shell
environment points `ANTHROPIC_BASE_URL` at Golem's own local proxy
(`http://localhost:4930`) and sets `ANTHROPIC_FOUNDRY_API_KEY` — which reads, on
its face, like exactly the gateway/custom-auth path the channels docs say is
unsupported ("not available on Amazon Bedrock, Google Cloud's Agent Platform, or
Microsoft Foundry"). **[OBSERVED]**: all four `claude -p` runs this session
nonetheless reported `"apiKeySource":"none"`, `"provider":"firstParty"`, and real
`total_cost_usd` charges — meaning these specific invocations authenticated via
claude.ai/Console OAuth, not through Golem's proxy, regardless of the env vars
present in the shell. **This is not evidence that Golem's account routing and
channels coexist in general** — it only shows that *this particular CLI
invocation shape*, in *this* environment, happened to bypass the proxy. Whether a
session actually routed through Golem's proxy (the configuration ADR-0003 /
Decision 47 describe) would satisfy or fail the channel's auth requirement
remains **[UNESTABLISHED]** — the live evidence gathered answers a different,
narrower question than the one asked. Filed as part of the same follow-up
(`R12.12`) rather than guessed at.

### Unexplained, flagged rather than resolved

**[OBSERVED, no root cause found]** Across four otherwise-identical
`--dangerously-load-development-channels server:testchan` runs, the test
channel's reported connection status was inconsistent: `"connected"` twice
(the `deny`-hook and `ask`-hook runs), `"failed"` twice (the no-hook runs), with
no code or config difference that plausibly explains hook-presence correlating
with channel-connection success. Ruled out: the channel script itself (a
hand-crafted stdio MCP `initialize` handshake, run standalone, worked correctly
every time); the specific documented `MCP_PROTOCOL_NEGOTIATION=auto` /
`2026-07-28` rejection mode (the installed `@modelcontextprotocol/sdk@1.29.0`
doesn't list that revision as supported *or* rejected — it's simply not in its
version table). Not chased further — a Windows spawn-timing race and a
leftover process from a prior run were both considered and neither confirmed.
Recorded so a future live run isn't surprised by it.

### Recommendation, and the one property that decided it

**Channel wins — conditionally**, in the sense the task brief defines it:
*Golem's remaining claim is not the transport, it is the class line* — and the
evidence above says that claim is defensible without building R12.3/R12.4/
R12.8/R12.9, **provided Golem finishes a piece of policy work it already half
owns**, rather than because the class line is safe today as currently shipped.

**The deciding property**: Golem's current enforcement of `destructive`/`outward`
(`gate.ts`: `emit: "ask"` at `PreToolUse`) is a forced *question*, not a
*decision* — it does not resolve the call, it only guarantees a dialog gets
asked, and documentation is consistent (though not live-confirmed for this exact
case) that a dialog, once opened, is exactly the event a connected
permission-relay channel is notified of, with no field anywhere in the hooks or
channels reference that lets a hook mark a specific call non-relayable after the
fact. That is a real gap **as shipped**. But the same documentation identifies an
event Golem does not yet use — `PermissionRequest` — whose decision resolves the
call *before* a dialog exists, and therefore, by the "no dialog → nothing to
relay" logic in §1/§2, plausibly before the channel relay has anything to act on.
Moving Golem's `destructive`/`outward` enforcement from `PreToolUse`'s `ask` to a
`PermissionRequest` hook returning a real `behavior:"deny"` is a small,
self-contained change to a hook Golem already owns — not a new transport — and
if it holds (still **[UNESTABLISHED]** for the live interactive case), it means
Golem does not need to build its own remote-approval pairing/relay/account stack
to keep the property ADR-0006 requires: Anthropic's relay can be left to do
capability 2 for the classes that are legitimately remotely-approvable, while
Golem's own hook — one event earlier — keeps the classes that are not off the
table before a dialog, and therefore a relay, ever exists.

**Disposition of the paused stack:**
- **R12.3, R12.4, R12.8, R12.9 — recommend cancelling.** Their purpose was
  carrying capability 2 end-to-end (pairing, relay, hosted account). Anthropic
  ships that. Nothing here found a reason Golem needs its own.
- **R12.5 — recommend reducing** to the observe-only (capability 1) shape per
  item 4 above, not cancelling.
- **A new small task, `R12.12`**, is filed for the actual closure: add a
  `PermissionRequest` hook to Golem's autonomy gate that emits
  `behavior:"deny"` for `destructive`/`outward` (replacing/supplementing the
  current `PreToolUse` `ask`), and — separately, as an `owner: user` task since
  it needs a real interactive terminal, a real enabled channel (Team/Enterprise
  admin action or a personal Pro/Max account), and possibly a `node-pty`-based
  harness that CLAUDE.md's "no heavyweight native deps in default install" rule
  says does not belong in the shipped product — live-confirm that a
  `PermissionRequest`-level `deny` actually pre-empts the channel relay before
  treating the class line as protected in production. Until that confirmation
  lands, ADR-0006's class-line guarantee should be treated as **at-risk, not
  safe**, for any user who has both Golem's current build and a permission-relay
  channel connected in the same interactive session — which is the honest
  "what the user loses/risks in the meantime" the brief's third outcome shape
  asks for, even though the overall recommendation here leans toward "channel
  wins" rather than "neither yet."

**Sources for §141, all fetched or re-confirmed 2026-08-22** (client `2.1.235`):
`https://code.claude.com/docs/en/hooks` (fresh fetch this session, superseding the
2026-08-10 cache — `PermissionRequest`, `PermissionRequest decision control`,
`Notification`/`permission_prompt` sections); `https://code.claude.com/docs/en/channels-reference`
(`How relay works`, `Permission request fields`, `Add relay to a chat bridge`);
`src/autonomy/gate.ts`, `src/autonomy/classify.ts`, `src/autonomy/policy.ts`,
`src/hooks/pre-tool-use.ts` (read from source); four live `claude -p
--dangerously-load-development-channels` runs against a throwaway local project and
throwaway local test channel (`.tmp-r12.11/`, deleted before commit), real
first-party billing (~$0.80 total across the session).


## §142 — R13.1: the `claude` CLI *can* be driven as a hosted, multi-turn session — stream-json input is the mechanism, with two real gaps (2026-08-22)

**Client version for every finding below: `2.1.235` (`claude --version`).**

**Verdict on ADR-0007 §3a's runner**: the `claude` CLI qualifies. `claude -p
--input-format stream-json --output-format stream-json` accepts a second user
message on stdin after the first turn's `result` event without the process
exiting, holds one stable `session_id` across both turns, emits assistant text/
tool calls/tool results as separable structured events, honours
`ANTHROPIC_BASE_URL` so Golem's proxy sees every request, and loads the
project's `.claude/settings.json` hooks exactly as an interactive session does.
The two real gaps: interrupting a running turn could not be made to work via
`child.kill("SIGINT")` on Windows (process-kill only — see item 3), and the
usage-limit park is architecturally Golem's own concept, not something a
spawned `claude` process participates in (item 8) — both are gaps in behaviour,
not in the viability of the runner itself. §3a is updated accordingly below.

### 1. Multi-turn input — **[OBSERVED]**

Flag spelling and envelope from live docs (`code.claude.com/docs/en/cli-reference`,
fetched with a cache-busting query to force a fresh copy past Golem's own
webcache): `--input-format stream-json` paired with `--output-format
stream-json`, each line of stdin one JSON object
`{"type":"user","message":{"role":"user","content":"…"},"parent_tool_use_id":null}`.

Ran a throwaway probe (`spawn("claude", ["-p","--input-format","stream-json",
"--output-format","stream-json","--verbose","--permission-mode","default"])`,
argument array, no shell) against a scratch project directory: wrote one
message, waited for a `result` event, wrote a second message on the same
still-open stdin, waited for a second `result`. Outcome: `resultCount: 2`,
`sessionIds: ["92e8ffef-7c32-45d7-9181-75b2e2f13d19"]` (one id, both turns),
`exitCode: 0` after `stdin.end()`, no timeout. One minor oddity: a *second*
`system/init` event fired ahead of the second turn's `assistant` event — cheap
to ignore, but a consumer parsing strictly on "first event is init" would need
to tolerate a repeat.

### 2. Streamed output, structured — **[OBSERVED]**

The same stream-json shape (confirmed again under item 6's hook probe) emits
tool calls and tool results as their own event objects, not folded into final
text: an `assistant`-type event whose `message.content` array contains a
`{"type":"tool_use","id":…,"name":"Bash","input":{...}}` item, followed later by
a `user`-type event whose `message.content` array contains a
`{"type":"tool_result","content":…,"is_error":…,"tool_use_id":…}` item
correlated by id. A `system/permission_denied` event also appeared as its own
distinct event type when the hook-driven denial fired (see item 6) — a cleaner
structured signal than plain `-p` gave in §141, which only reported the denial
inside the final result text. ADR-0007 §2's "visible tool calls" promise is
deliverable from this stream without inference over prose.

### 3. Interruption — **[OBSERVED, Windows — process-kill only]**

Documentation basis (`code.claude.com/docs/en/cli-reference`, cli-reference and
SDK docs) — **[DOCUMENTED]**: SIGINT (or the Agent SDK's `interrupt()`) is
described as ending the current turn cleanly "before you stop the process",
implying the process can survive an interrupted turn; SIGTERM kills
unconditionally and loses the turn.

Live test — **[OBSERVED]**: started a Bash `sleep 8` tool call under an
always-`allow` hook (so no permission gate interfered), waited for the CLI's own
`system/task_started` event to confirm the tool was actually mid-flight, then
sent `child.kill("SIGINT")` from Node on Windows. Result: no `result` event, no
`close` event, and no further stdout at all within a 20-second window; the
process did not respond to the interrupt request, and had to be finished off
with `SIGKILL` (confirmed gone afterward via a process listing — no orphan left
behind, but no graceful "turn ended, session survives" outcome either).

This reads as a Windows platform gap rather than a Claude Code one: Node
cannot deliver a true POSIX signal to a non-console-attached child process on
Windows, so `child.kill("SIGINT")` there is not equivalent to a developer
pressing Ctrl+C in a real terminal on Linux/macOS. **[UNESTABLISHED]** whether
SIGINT works as the docs describe on a POSIX host — no such host was available
to test in this session. Per the task brief: on Windows today, only
process-kill (SIGKILL) was demonstrated to end a turn, and ADR-0007 §2's
"interrupting a running turn" needs a platform caveat until a POSIX run
confirms the documented behaviour.

### 4. Resume and identity — **[OBSERVED, partial]** / **[UNESTABLISHED, reboot]**

Cross-*process* continuity — **[OBSERVED]**: took a `session_id` produced by an
earlier probe run in this session (`97ef2b72-…`, same scratch project
directory still on disk) and, in a brand-new `claude` process — not the
long-lived stream-json child, a completely separate invocation — ran `claude
--resume 97ef2b72-… -p "…what did you just attempt to run…" --output-format
json`. It returned the *same* `session_id` and correctly recalled the specific
prior turn's content (the exact echo command it had attempted and the exact
hook-denial message text), at a fraction of the token cost of a cold start
(19,084 cache-creation + 27,498 cache-read tokens vs. ~44k cache-creation on a
cold session) — strong evidence the resumed context, not just the id, survives
a process restart. Session storage is scoped to the project directory (cwd),
consistent with §65's original finding.

Machine-reboot survival — **[UNESTABLISHED]**: not tested; rebooting the host
was out of proportion for a spike and not available in this environment. The
resume test's behaviour (a brand-new process reading a completed prior
conversation, at a cost profile consistent with reading persisted data off
disk rather than a resident daemon) is circumstantial evidence session state is
file-backed, which would usually survive a reboot — but that is an inference,
not a run, and is not upgraded past UNESTABLISHED here.

### 5. Working directory and project scope — **[OBSERVED]**

A throwaway project directory with only a `.claude/settings.json` (no other
project scaffolding) got a `PreToolUse` hook on `Bash` to fire during a hosted
stream-json session: the hook process wrote a log line
(`{"timestamp":…,"tool_name":"Bash","tool_input":{"command":"echo
golem-r13-1-hook-probe",…}}`) that showed up on disk exactly once, matching the
one Bash call the model attempted. `cwd` alone was sufficient — no
`--add-dir`, no extra settings flags — for `.claude/` to load and its hook to
run, the same as an interactive session per the cli-reference docs
(**[DOCUMENTED]** for the "same as interactive" framing; **[OBSERVED]** for
"the hook actually fires"). This directly answers the invariant-2 precondition:
Golem's own hooks are reachable in a hosted session.

### 6. Permission behaviour — **[OBSERVED]**, extending §141

§141 established (plain `-p`, single-shot) that a hook emitting Golem's real
`ask` (never `deny` — `src/autonomy/gate.ts`) resolves to a synchronous denial
in headless mode because no dialog can ever open. This session repeated that
test in the *hosted, multi-turn stream-json* shape specifically, and it holds:
the always-`ask` hook fired once, and the assistant's own reply reported "The
command was blocked by a hook, not executed. Hook output: `golem-r13.1-spike-
always-ask`. Stopping here as instructed" — no dialog, no hang, a clean
synchronous refusal surfaced back into the conversation. The `result` event's
own `permission_denials` array also carried a structured record of the denied
call (`tool_name`, `tool_use_id`, `tool_input`) independent of the prose.

This is good news for ADR-0007 invariant 2 specifically: contrary to the ADR's
current §3a text, which frames "a refusal is a real deny" as something only
available if *Golem* owns the loop (the fallback), a *hosted* session running
the unmodified `claude` CLI already gets an effectively-hard refusal for
`ask`-classified calls, for free, purely because headless/hosted mode
structurally cannot open a dialog. Golem does not need to own tool execution to
hold the class line here; it needs its hook registered, which item 5 confirms
it can be.

### 7. Proxy interposition — **[OBSERVED]**

Spawned `claude -p "hi" --output-format json` with `ANTHROPIC_BASE_URL` pointed
at a local stub HTTP server (never a real upstream — zero API billing for this
one). The stub recorded 6 requests: one `/api/hello` and five retried
`/v1/messages?beta=true` calls (the CLI retrying against the stub's constant
HTTP 500, consistent with documented `system/api_retry` behaviour), every one
carrying real `authorization: Bearer …` and `anthropic-version: 2023-06-01`
headers — proof the spawned process's actual model traffic, headers included,
goes wherever `ANTHROPIC_BASE_URL` points. Golem's proxy sitting at that URL
would see, and could act on, every request. Satisfies ADR-0007 invariant 8 for
the "does the traffic even arrive" question; it does not by itself prove
Golem's redaction/telemetry code paths engage correctly against this traffic
shape, which is a proxy-side integration concern for R13.3, not this spike.

### 8. Cost and lifetime — **[OBSERVED, rough]** / **[DOCUMENTED + reasoned, park]**

Measured, not modelled, per real `result` events from this session's own
probes: turns with essentially no content (a one-word reply, or a single
short Bash call) cost **$0.21–$0.51 each** at Opus-5 pricing, with the spread
explained almost entirely by prompt-cache state — a cold project directory
pays ~44–46k `cache_creation_input_tokens` (system prompt + tool schemas, not
the message itself), a warm one drops to single-digit-thousands of
cache-creation plus tens of thousands of cheap `cache_read_input_tokens`. In
other words: an *idle* hosted session is not free to keep resident — every
turn it takes, however trivial, pays most of a full context-window's worth of
system-prompt tokens unless the cache is warm, and idle time itself (no turns
at all) costs nothing beyond the OS process. One further finding: interrupting
a turn (item 3) means the local `result` event — the only place the CLI
reports `total_cost_usd` — never arrives, so a host that kills a turn loses
its own cost accounting for that turn; Anthropic's own billing is presumably
unaffected, but Golem's local telemetry would need another source of truth for
cost incurred during an interrupted turn.

Usage-limit park — **[DOCUMENTED reasoning, not run]**: Golem's own park
(`snooze`, `.claude/rules/golem-snooze-hold.md`) is a tool-call gate inside
Golem's *own* orchestration layer; a spawned `claude` process is not a
participant in that gate, it is an independent API consumer. If the
account backing it hits Anthropic's usage limit, the expected surface (per the
retry behaviour already observed in item 7) is an API-level error event in the
same process, not Golem's park mechanism — the two are orthogonal, and
ADR-0007 should not assume a hosted session inherits Golem's park behaviour for
free. Running an account to its actual limit to confirm this was judged out of
proportion for a spike (destructive to quota needed for the rest of this task
and for sibling agents running concurrently); left **[UNESTABLISHED]** as a
live-confirmed fact, filed as a follow-up if §3a is built.

### The fallback, priced (per the task brief — not built)

**Claude Agent SDK** (TypeScript/Python): a new dependency, but not a
foreign-runtime one — Golem is already TypeScript, so the "five-dep runtime
pin" concern in CLAUDE.md is about weight and surface, not language boundary.
It gives structured streaming input/output and interrupt as first-class SDK
calls (`query()` async generator, `interrupt()`) rather than hand-rolled
stdin/stdout JSON framing, which would remove items 1–3's plumbing risk
entirely — including, plausibly, item 3's Windows gap, since the SDK's
`interrupt()` is documented as a distinct call, not a signal, so it may not
inherit Windows' POSIX-signal limitation (untested here — that would be its
own spike). Cost: one more package to pin and update, and it still shells out
to the same `claude` binary underneath for the actual model/tool work per its
own docs, so it does not remove the runner dependency, it wraps it.

**Golem's own agent loop via `src/providers/`**: no new dependency, and would
give Golem a real `deny` (not the `ask`-that-resolves-to-denial this spike
found) since Golem would own tool execution directly. Cost: Golem then owns
the entire tool-execution surface — every tool Claude Code ships today, kept in
sync, forever — which is a categorically larger maintenance and security
surface than spawning a product that already does this. Item 6's finding
weakens the case for this option specifically: a *hosted* session already gets
an effectively-hard refusal for `ask`-classified calls without Golem writing
its own loop, so the main reason to prefer this fallback (real `deny`) is
already available more cheaply via the CLI-spawn primary.

**Recommendation**: keep the `claude` CLI as §3a's runner. Neither fallback is
justified by anything found here — the primary works, with two documented gaps
(Windows interrupt, park semantics) rather than a viability failure.

**Sources for §142** (client `2.1.235`, fetched or re-confirmed 2026-08-22):
`https://code.claude.com/docs/en/cli-reference` (cache-busted fetch, past
Golem's own webcache, for `--input-format`/`--output-format stream-json`
flags); prior live-docs research this session on the background-session/
supervisor subsystem (`claude agents`/`attach`/`--bg`) and on `PermissionRequest`
vs `PreToolUse` (ruling out `--bg` as §3a's mechanism — no programmatic send
path, and `--bg` rejects `-p`); `docs/decisions/ADR-0007-remote-conversation-and-hosted-sessions.md`
§§2, 3a, 5; `src/tasks/resume.ts`, `src/tasks/types.ts`; verification-notes
§65 and §141 (precedent, extended not re-derived); five throwaway Node
probes against scratch project directories under `.tmp-r13.1/` (argument-array
spawn, no shell, no PTY — deleted before commit); real first-party billing,
measured per-turn as recorded above, roughly $2 total across the session's
live runs (the exact grand total is not fully reconstructable — one turn was
deliberately interrupted before its `result`/cost event could arrive, which is
itself the item-8 finding about cost-visibility on an interrupted turn).

---

### 143. — WITHDRAWN 2026-08-29 (was: a second R13.1 spike result contradicting §142)

A second, independently-run R13.1 spike was appended here on 2026-08-23 as
`### 143.` — inside §142's own section, which is also how it collided with the
real `## §143` (R13.2's conversation store) and why three wiki pages ended up
citing "§143" for an R13.1 finding.

It reported multi-turn stdin as `[UNESTABLISHED]` — "could NOT be reproduced
under standalone conditions despite claims in §142" — and recommended building
R13.3 as chained `-p` invocations rather than a long-lived process.

**Ruled superseded (USER decision, 2026-08-29): §142 stands.** §142 carries the
live probe with the numbers — `resultCount: 2`, `sessionIds` one id across both
turns, `exitCode: 0` after `stdin.end()`, no timeout — and the withdrawn record
offered no counter-measurement, only a failure to reproduce. A failure to
reproduce is not a refutation of a recorded observation, and the withdrawn
record's own citation pointed at another task's section. Its two wiki pages
(`R13.1-claude-cli-hosted-spike.md` and its debrief) were deleted with this
ruling; `concepts/Hosted-multi-turn-claude-CLI-spike.md` was kept because its
findings table always agreed with §142.

Kept as a tombstone rather than removed outright: this file is the dated record,
and "a claim was made, contradicted a measurement, and was withdrawn" belongs in
it. The one finding worth carrying forward is procedural, not technical — **two
agents closed the same task independently and neither noticed the other**, which
is what produced the collision. See the R13.1 note in `docs/plan/SHIPPED.md`.

## §143 — R13.2: the conversation store — what is retained, the bounds chosen, and a Commander.js option-collision worth recording for the sibling tasks that will add subcommands here (2026-08-22)

Task: `docs/plan/tasks/R13.2.md`. Decision base: ADR-0007 §5 invariant 5
(redaction before storage, local-only, bounded, one documented delete) and §6
Retention (the deliberate, narrowly-argued exception to `session-tree.ts`'s
*content hashes, no prompt content* rule — Revision 1 narrowed the
justification to scrollback + continuation, explicitly not an indefinite
archive, after branching was dropped).

### What is retained, and for how long

One JSON file per conversation under `<project-root>/.golem/conversations/<conversationId>.json`
(`src/session/conversation-store.ts`), written mode `0o600` (owner-only where
the platform honours file modes — a documented no-op on Windows, same caveat
`credentials/backends.ts` already carries for the same reason). Every turn's
`content` is passed through `redactRequestBody` (`src/pipeline/redaction.ts`)
**unconditionally, inside `appendTurn`** — there is no parameter, flag, or
branch that writes the raw value instead; the redacted result is the only
thing this class ever persists. Proven, not asserted: `tests/unit/session/conversation-store.test.ts`
builds a github-token-shaped secret **at runtime** (`` `ghp_${"a".repeat(36)}` ``,
per the standing fixture rule — a hardcoded literal gets swept up by the
entropy sweep before the test ever runs, and a hardcoded literal
`[REDACTED:...]` would pass without exercising anything), places it in a
turn's content, and asserts the stored bytes contain `[REDACTED:github-token:1]`
and do **not** contain the secret substring.

Bounds, both configurable (`ConversationStoreOptions`), honest defaults chosen
against ADR-0007 Revision 1's narrowed justification (scrollback +
continuation, not an archive):
- **Count** — `maxConversations`, default 32.
- **Age** — `maxAgeMs`, default 30 days.

Eviction runs after every `appendTurn` (age first, then count, oldest
`lastTurnAt` first) — same shape precedent as `web-cache.ts` (bounded local
store under `.golem/`) and `session-tree.ts` (count-based `MAX_CONVERSATIONS`).
Deletion: `golem session forget <id>` (one conversation) or
`golem session forget --all` (the whole store, then recreates an empty
directory so the next `appendTurn` doesn't need to special-case "never
existed" vs. "just emptied").

`.golem/conversations/` was added to `.gitignore` explicitly — this repo lists
every `.golem/` subdirectory individually rather than relying on a blanket
`.golem/` pattern, so the coverage was **verified, not assumed**, with a test
that shells out to `git check-ignore -q` against the real repo (exits 0 only
when ignored) and a second test asserting `git ls-files .golem/conversations`
returns nothing (a fresh clone carries no store).

Identity: `conversationIdFor` delegates entirely to `cachePrefixFingerprint`
(`src/proxy/cache-prefix.ts`, fixed by R8.13) — the exact function
`session-tree.ts` already uses for its own conversation key — so one
conversation has one id in both stores; this file does not derive a second
hash of its own. `conversationStoreDir` resolves `projectRoot` through
`resolveWorktreeRoot` (`src/shared/git-worktree.ts`, task `ccr-ref-scope`)
*first*, so a conversation recorded from inside a linked worktree checkout is
rooted at the same directory a main-checkout reader sees — verified with a
test that runs from inside this very worktree checkout and asserts the
collapse is actually applied, not merely that a bare non-repo temp dir passes
through unchanged (a distinct, separately-asserted case).

### A Commander.js option-collision, recorded because R13.3/R13.5/R13.8 will add more subcommands under `session`

**[OBSERVED, isolated in a minimal standalone repro outside this codebase]**
`src/cli/commands/session.ts` registers `session` (parent, its own `--dir`
option for the tree-view action) and `session forget [id]` (child, its own
separately-declared `--dir` option). When both a parent command and one of its
subcommands declare the **same option flag**, Commander's default
(non-positional) argument parsing does not reliably route a CLI-typed value to
the subcommand's own `opts()` — the value can be captured by whichever
command's parser reaches it first while scanning the full remaining argv, and
the child falls back to *its own* default rather than the parent's, discarding
what the user actually typed. Confirmed with three isolated single-file node
scripts (no vitest, no project code) varying only which command(s) declare
`--dir`:
- parent-only declares it → child's action sees the correct value via
  `command.parent.opts().dir`, in both `forget --dir <path> <id>` and
  `forget <id> --dir <path>` order.
- both declare it, distinct default strings → the CLI-typed value is lost
  entirely; the child's action reports **its own** default, not the parent's,
  regardless of argument order.
- `program.enablePositionalOptions()` (root only) also fixes it, but scoping
  that call to the child subcommand alone does **not** — it must sit on the
  command that owns the ambiguous scan, empirically the root in this shape.

Fix applied (kept both `--dir` declarations, for `--help` visibility on each
subcommand, per the code comment in `session.ts`): the `forget` action reads
`command.parent?.opts<{ dir: string }>().dir ?? opts.dir` instead of trusting
its own `opts.dir`. Verified for `forget --dir <path> <id>`,
`forget <id> --dir <path>`, and the no-flag default case, both in the minimal
repro and in `tests/unit/cli/session-forget.test.ts` against the real
`LocalConversationStore` (not mocked). **Flagging for R13.3/R13.5/R13.8**:
any new subcommand nested under `session` that re-declares `--dir` (or any
other flag `session` itself already owns) will hit the exact same bug — either
avoid redeclaring the parent's flag and read it via `command.parent.opts()`,
or declare it nowhere but the parent.

**Sources for §143**: `docs/decisions/ADR-0007-remote-conversation-and-hosted-sessions.md`
§5 invariant 5, §6; `src/session/session-tree.ts` header; `src/knowledge/web-cache.ts`;
`src/credentials/backends.ts` (the `0o600`-on-Windows caveat precedent); the
Commander.js collision was isolated empirically against the installed
`commander` package version in this repo (`node_modules/commander`), not
against upstream docs — no live-doc claim is made about Commander's documented
behavior, only what this installed version does.

## §144 — R13.11: `inherit` auth means two incompatible things, and step 4 of the R10.8 chain had never once worked (2026-08-27)

**Reported by the user, both symptoms reproduced live before any code changed.**

### The finding that matters

`upstream_auth_scheme = "inherit"` is answering **two different questions** in two
different places, and the answers are incompatible:

- **The proxy** asks "how do I forward this request?" and `inherit` correctly
  means *forward the client’s own credential headers unchanged*. That is why
  `defaultAuthScheme("anthropic")` returns `inherit`: Golem is a transparent
  passthrough and injects nothing.
- **`dispatch()`** asks "how do I authenticate a request I am making myself?" and
  there `inherit` can only mean *send nothing* — there is no client request whose
  headers could be forwarded.

For a keyless loopback server (`ollama`, `llamacpp`) "send nothing" is right. For
`api.anthropic.com` it is a guaranteed `401`. The guard before the request read

```ts
if (mapper === undefined && target.authScheme !== "inherit") throw …
```

so it **exempted the one case that could not work**, and every unrouted `coder`
call POSTed unauthenticated.

### Why the gate did not catch it

R10.8’s recorded gate was *"provable from the audit record and `golem status`,
without a local model installed at all"*. Both were correct throughout: `golem
status` truthfully said `coder: anthropic (target anthropic) — via the harness
default upstream; nothing routes coder`, and the audit line named the right
target and route. **Routing and reporting were right; the request failed.** The
gate never completed one.

Worse, a test asserted the defect as intent —
*"still dispatches with no credential when the scheme is inherit"* — expecting an
Anthropic request to go out with no `x-api-key` at all. It passed for the whole
time the feature was broken.

Lesson worth carrying: a gate phrased over *observability surfaces* can be fully
green while the behaviour those surfaces describe has never once succeeded. When
a step’s whole purpose is "reach a destination", the gate has to reach it.

### The second, latent defect found beside it

`makeAuthMapper("inherit", apiKey)` returns `undefined` **whatever key is
passed** — the scheme is checked before the key. So a credential the user had
genuinely stored with `golem gateway login anthropic` could never reach a
dispatch, and `golem target list` truthfully reporting "key set" told them
nothing about whether `coder` could use it. Same class as the R10.8-era finding
that the MCP server inherits no `GOLEM_UPSTREAM_API_KEY__*` env at all: the key
existed, the request went out bare.

### Live evidence for the "looping model"

`DispatchRequest` carried one `prompt` string; dispatch sent a single user turn.
Asked to retry, `openrouter:qwen/qwen3.7-flash` answered:

> "I'd be glad to fix it, but I don't have visibility into your previous attempt
> or the failing test."

The model was not looping. Each call was **turn one of a fresh conversation**, so
re-asking a near-identical question necessarily produced a near-identical answer.
Anything that reads as an LLM repeating itself across tool calls is worth
checking against the transport before the model.

### Redaction consequence, recorded because it is easy to get wrong

Once a dispatch carries several strings, they must share ONE `PlaceholderTable`.
Independent per-message tables give the same secret different numbers in
different turns, and a single `restore` map can then only put one of them back —
so the failure mode is **silent corruption of the reply**, not a leak. Hence
`redactReversibleTexts`, with `redactReversibleText` reimplemented in terms of it
so the two cannot drift. `redactRequestBody` already shared a table across a whole
request body for the same reason.

### Decisions taken (USER, 2026-08-26)

1. When nothing routes `coder` and the harness default cannot be authenticated,
   **decline** so the session’s own model does the work inline — not a fallback to
   the local Ollama model, and not merely a clearer error. R10.8’s "local is a
   destination, never a fallback" rule is preserved intact.
2. Fix the stateless-iteration defect as well as the transport quick wins.

### Deliberately not done

`golem status` does **not** read the credential store to predict the decline.
That would add a DPAPI-backed lookup to every statusline render (status feeds the
per-turn statusline). It states the dependency and points at `golem target list`
instead. Predicting either "it drafts here" or "it declines" without checking
would be the dishonest-signal class this project exists to close.

## §145 — R13.12: an MCP server cannot spawn a harness subagent, and two adjacent settings nearly resolved the same string differently (2026-08-28)

### The constraint that decided the design

The user's ask was: *"if I set the default_coder to claude-sonnet-5 the harness
should use an agent to complete the tasks with Sonnet 5."*

**That cannot be implemented inside the `coder` tool.** MCP servers expose tools
*to* a client; nothing in the surface Golem uses lets a server invoke the client's
own tools, so there is no call `coder` could make that starts a Task subagent. Any
design that assumes otherwise is assuming a callback that does not exist.

What IS available splits cleanly in two, and naming the split is the useful part:

| | can Golem do it? |
|---|---|
| run a subagent on a different model | **no** — only the harness can |
| generate the artifact that makes it native | **yes** — `golem init` already owns `.claude/` wiring |
| be honest at the point of use | **yes** — `coder` declines and names the subagent |

So R13.12 owns the wiring and the honesty, and never pretends to own the spawn.
Recorded because the same shape will recur for every future "can Golem make Claude
Code do X" question: **own the artifact, not the action.**

### Subagent frontmatter: plain model id, not the virtual one

§114 already quotes the frontmatter table (`model` accepts "a full model ID (for
example, `claude-opus-5`)"), so a plain id is documented. R9.2 shipped the proxy
half of `golem/<target>` too, but **§114 caveat 5 remains open** — the slash was
never confirmed Claude Code-side, and R9.2 closed with that check outstanding. The
generator therefore emits a plain id and a test asserts `not.toContain("golem/")`,
so this stays a decision rather than drifting into an assumption.

### The near-miss worth recording

`default_coder` accepts a target id or a model id, so it must decide which a bare
word is. The intended rule was "whatever the registry resolves", and the
convenient assumption was that `resolveTarget` handles a bare GATEWAY id the way
`default_target` does.

**It does not.** `resolveTarget` matches target ids only; the gateway-to-first-target
rule lives in `resolveDefaultTargetId`, one layer up, and only fires when
`settings.default_target` is set. So `default_coder = "openrouter"` would have been
read as a *model* called `openrouter` and produced an agent definition naming a
model that does not exist.

Caught by a test that asserted the intended behaviour and failed. Lesson: **when
two adjacent settings accept the same shape, verify they resolve it through the
same code, not through the same-sounding function.** A resolver named
`resolveTarget` not resolving everything the target syntax allows is exactly the
kind of thing a reader assumes rather than checks.

### Deliberately NOT verified here — gates R13.14

R13.12 proves the definition is written, its frontmatter matches the documented
shape, and `coder` declines and names it. It does **not** prove:

1. Claude Code honours a generated agent's `model:` (an unknown model surfaces
   only on the first request — §114 caveat 4);
2. the delegation is actually served by that model rather than the parent's;
3. the traffic goes through `ANTHROPIC_BASE_URL`, so Golem still sees it.

(3) is the load-bearing one: it is the entire difference between the subagent route
and the `claude-cli` spawn it supersedes, which scrubs `ANTHROPIC_*` precisely so
the child does NOT come back through Golem. No in-repo test can establish it — it
needs one real delegation in a live session.

That is why the `claude-cli` removal was split out to **R13.14** rather than
shipped alongside. Deleting a working mechanism on the strength of an unverified
replacement inverts the safe order, and the repo's own rule is verify, don't
assume.

### A trap for whoever does R13.14

The settings schema validates `proxy.gateways[].provider` against a Zod enum.
Dropping `claude-cli` from that enum makes an existing settings file containing one
fail to **parse** — which breaks `golem status` and every other command, not just
the coder. A targeted migration error is what is wanted, so the enum probably has
to keep the value as a deprecated-and-rejected case rather than lose the member.
Work that out before deleting anything.

## §146 — R13.4: passkeys cannot be the user factor on a LAN origin, and the reason is naming, not transport (2026-08-29)

R13.4's gate says **"what the user factor can actually be on this platform is
MEASURED, not assumed."** This is that measurement. It matters because a previous
attempt at this task shipped a code comment asserting the same conclusion from a
citation (`verification-notes §143`) that pointed at R13.2's conversation store —
the finding did not exist. The conclusion happens to be right; the reason given
for it was wrong, and the difference decides whether the blocker is fixable.

**Source**: `developer.mozilla.org/en-US/docs/Web/API/PublicKeyCredentialCreationOptions`,
fetched 2026-08-29 (raw page, not a summary). Cross-checked against
`w3.org/TR/webauthn-3/` — the spec page truncated before §4 Terminology, so the
normative RP-ID definition was NOT read first-hand and MDN is the source quoted
below. That is a real limit on this note and is stated rather than papered over.

### The reason that is usually given, and why it is not the blocker

WebAuthn is gated on a secure context — **[DOCUMENTED]**, MDN, verbatim:

> Secure context: This feature is available only in secure contexts (HTTPS), in
> some or all supporting browsers.

That one is **solvable, in principle**. Golem already runs its own CA
(`src/proxy/loopback-cert.ts`, §121→§124), and an `https://` origin whose chain
the device trusts is a secure context. It would need the CA installed and trusted
on the phone — awkward on iOS, which needs a profile plus a separate full-trust
toggle — but it is a configuration problem, not a wall.

So "no passkeys because no secure context" is the wrong reason. If it were the
only obstacle, the answer would be "install the CA", not "use a passcode".

### The actual blocker: the Relying Party ID must be a domain

**[DOCUMENTED]**, MDN, on `rp.id`, verbatim:

> The `id` cannot include a port or scheme like a standard origin, but the domain
> scheme must be https scheme. The `id` needs to equal the origin's effective
> domain, or a domain suffix thereof. So for example if the relying party's
> origin is `https://login.example.com:1337`, the following ids are valid:
> `login.example.com`, `example.com`. But not: `m.login.example.com`, `com`

and:

> If omitted, `id` defaults to the document origin — which would be
> `login.example.com` in the above example.

The companion app's origin is `https://192.168.0.20:4655` (R12.5 measured the
real LAN address live; R13.4's write surface sits beside it on 4655). Its
effective domain is an **IP literal**. An IP literal is not a domain, so:

- there is no valid `rp.id` to supply — an IP is not a domain and cannot be a
  domain suffix of one;
- omitting `rp.id` does not help, because the default is that same non-domain
  origin.

**No amount of CA trust changes this.** It is a naming rule, not a
transport-security rule, and the two are independent. A passkey would need a real
registrable domain, which a LAN-only design does not have and — per ADR-0007 §7,
which scopes phase 1 to the LAN — is not going to acquire before R13.10.

### Verdict

**The passcode is the MECHANISM, not the fallback**, for as long as the companion
app is reached by IP. Shipped as such in `src/security/user-factor.ts`: scrypt
verifier at rest, an absolute unlock window, an idle relock, and a separate
step-up freshness check for high-risk acts.

### What is still UNESTABLISHED

- **The device-side half.** Whether a phone that HAS trusted Golem's CA reports
  `window.isSecureContext === true` for an IP-literal `https://` origin was not
  run — no phone was involved in this measurement. It does not change the verdict
  (the RP-ID rule bites either way) but it would matter to any future feature
  needing a secure context for something other than WebAuthn — Web Crypto's
  `subtle`, service workers, clipboard. Worth measuring when R12.14's device pass
  happens.
- **The normative text.** MDN is a faithful secondary source and is what is quoted
  here; the W3C §4 Terminology definition of Relying Party Identifier was not read
  directly because the spec page truncated. If a future task depends on an edge of
  this rule rather than its centre, read the spec.
- **What changes at R13.10.** An internet relay with a real domain would remove
  the blocker entirely. That is the point at which the passkey question should be
  re-asked rather than assumed still closed.

## §147 — R13.3: the host enforces at `PreToolUse`, not `PermissionRequest` — and `--settings` is what makes the enforcement the host's own (2026-08-29)

**Client version for every finding below: `2.1.246` (`claude --version`).** §142
measured `2.1.235`; this re-confirms its central finding on a newer client and
adds three that changed R13.3's design.

Task: `docs/plan/tasks/R13.3.md`. Decision base: ADR-0007 §3a (the runner), §3c
(the rule that permits a hosted loop) and invariants 2, 3, 4, 8.

### 1. Multi-turn stdin still works — **[OBSERVED]**

One process, `-p --input-format stream-json --output-format stream-json
--verbose --permission-mode default`, two messages written to the same still-open
stdin. Outcome: `results: 2`, **one** `session_id`
(`be85d92c-57db-4b41-b33b-9abd0fa68ca7`) across both turns, `exitCode: 0` after
`stdin.end()`, no timeout. §142's verdict holds on `2.1.246`.

Event kinds seen across the run: `system/init`, `rate_limit_event`, `assistant`,
`user`, `result/success`, `system/thinking_tokens`, `system/permission_denied`.
Two are new since §142 and both are useful: `rate_limit_event` is a park signal
the host can surface (invariant 8), and `system/thinking_tokens` is noise the
normaliser must ignore rather than choke on.

### 2. `--settings <inline JSON>` wires hooks for a project that has none — **[OBSERVED]**

`claude --help` on `2.1.246`: *"--settings <file-or-json>  Path to a settings
JSON file or a JSON string"*. Passing a JSON string containing a `hooks` block
**does** install those hooks for the session, in a scratch project directory with
no `.claude/settings.json` at all.

This is the finding R13.3's enforcement rests on. §142 item 5 had established
that a hosted session picks up the *project's* hooks via cwd — but that makes the
host's enforcement conditional on guest wiring that `golem autonomy unwire` can
remove. With `--settings`, the host supplies the gate itself and does not care
what the project's settings say.

### 3. `PermissionRequest` is the WRONG enforcement point for a hosted session — **[OBSERVED]**

This one inverts R12.12's conclusion, for a reason that is specific and worth
stating.

A `PermissionRequest` hook returning `behavior:"deny"` was installed via
`--settings`, and the session was asked to run `echo golem-hook-probe` inside its
own cwd. **The command ran, and the hook never fired at all** — proven by having
the hook append to a file before deciding: the file was never created.

The docs already say why: `PermissionRequest` "Runs when Claude Code is about to
ask you for permission." In `--permission-mode default`, an ordinary in-cwd
command never asks. So enforcing there is enforcement that silently does nothing
for the common case.

R12.12 was still right for the *guest* path — its problem was a dialog opening
and a connected channel answering it, and dialogs are exactly what
`PermissionRequest` precedes. The two tasks need different events because they
are solving different problems, not because one of them is wrong.

### 4. `PreToolUse` + `permissionDecision: "deny"` DOES stop the call — **[OBSERVED]**

Same probe, same `--settings` mechanism, hook switched to `PreToolUse`:

- the hook fired (`{"event":"PreToolUse","tool":"Bash","input":{"command":"echo golem-hook-probe",…}}`);
- the call was refused;
- **the reason text reached the model as the tool result**: `is_error=true`,
  content `GOLEM-HOST-DENY: refused by the session host.`;
- the model reported it accurately: *"Command blocked — host refused it."*

Note the shapes are not interchangeable, and the wrong one is a silent no-op:
`PreToolUse` takes a FLAT `permissionDecision` + `permissionDecisionReason`;
`PermissionRequest` nests `decision.behavior` + `message`.

### 5. Claude Code's own guards are separate, and still run — **[OBSERVED]**

In run 1, `rm -rf /tmp/golem-r133-victim` (outside the session's cwd) was refused
by Claude Code itself: *"rm in '/tmp/golem-r133-victim' was blocked. For security,
Claude Code may only remove files from the allowed working directories for this
session."* It arrived as a `system/permission_denied` event — a different shape
from a hook denial, which surfaces as an errored `tool_result`.

Consequence for the host: these are two distinct facts and the UI must not report
one as the other. `normaliseEvent` gives them separate event types.

### 6. End-to-end, with the real runner — **[OBSERVED]**

The gate line demonstrated against the shipped code. Commands:

```
node dist/cli/main.js session host start --dir "$T" \
  "Delete the directory ./victim by running exactly: rm -rf ./victim   Then report what happened."
```

Output (abridged):

```
  ⏸ rate-limit pressure reported by the runner
  ← REFUSED/ERROR: Refused by the Golem session host: destructive step. A hosted
    session never performs it, at any autonomy level — do a dry run, or ask the
    developer to run it themselves.
[turn complete · $0.2984]
```

The session's own summary: *"Not deleted — the command was blocked… I did not
attempt any workaround (`del`, `Remove-Item`, PowerShell tool, subagent) — that
would just be routing around the host's block."* `./victim/file.txt` survived,
confirmed by `ls` after the run.

The audit trail (`golem session host log`) for that session, in order:

```
STARTED  runner through http://localhost:4930
TURN     local      Delete the directory ./victim by running exactly: rm -rf ./victim …
ALLOW    Bash       read         … no restriction added (read action) …
DENY     Bash       destructive  Refused by the Golem session host: destructive step …
STOPPED
```

That covers, in one run: attribution written **before** the relay (invariant 4),
a `read` proceeding, a `destructive` refused **outright rather than asked**, the
session running through the proxy (invariant 8 — the run against a project whose
configured port did not match a live proxy failed with `Connection refused` and
did nothing, which is the invariant holding rather than a bug), and visible tool
calls (ADR-0007 §2).

### 7. A commander collision that silently hosted a session in the WRONG project — **[OBSERVED]**

`golem session host start --dir <path>` initially ignored `--dir` and hosted in
the repo the CLI was invoked from. Cause: `session` already declares `--dir` for
its tree view, and commander's option scanning let the parent's parser capture
the value before the leaf subcommand's did.

This is the SAME quirk R13.2 documented for `session forget` (§143), resurfacing
one level deeper. The fix there was reading `command.parent.opts()`; here the
chain is three deep (`session` → `host` → `start`), so the resolver walks up and
prefers the first *explicitly typed* value — distinguishing "typed" from "set"
matters, because every level defaults to the same directory.

Worth generalising: **any `golem` subcommand that adds a level under a command
already declaring `--dir` inherits this bug**, and its symptom is silent and
severe — acting on the wrong project.

### What is UNESTABLISHED

- **A hosted session outliving its CLI invocation.** R13.3 ships the registry,
  liveness checking and reaping, but a session runs under the process that
  started it; detaching it into a daemon like `proxy-daemon.ts` is not built.
  `golem session host list` reports honestly (`stopped`, or reaped with a reason)
  rather than pretending.
- **The `ask` path with somebody attached.** There is no answerer until R13.5's
  transport and R13.6's chat surface, so every `ask` currently resolves to a
  refusal. The `HostAttachment` seam exists and is tested on both branches, but
  the attached branch has never run against a real device.
- **POSIX interruption.** §142 measured that `child.kill("SIGINT")` does not
  interrupt a running turn on Windows. Not re-tested here, and not tested on
  POSIX at all; `HostedSession.kill()` therefore does not pretend to be a
  graceful interrupt.

## §148 — R13.7: two measured facts the join-injection design turns on — consecutive `user` messages are legal, and `fs.rename` is NOT an exclusive claim on Windows (2026-09-03)

Both were checked because the alternative was building on a guess, and in each
case the guess would have been wrong in a way tests would only catch by luck.

### (a) Consecutive same-role messages are combined, not rejected — so injection appends a turn

**Source:** the bundled `claude-api` skill's TypeScript reference, "Multi-Turn
Conversations → Rules": *"Consecutive same-role messages are allowed - the API
combines them into a single turn."* Checked 2026-09-03 against the skill
shipped with client `2.1.258`.

Why it decided the shape of `src/pipeline/join-injection.ts`. A device's message
could be injected either by **appending a new `user` message** or by **appending
a text block into the last existing message**. The second needs no assumption
about consecutive roles, so it was the safe-looking option — and it is the worse
one on both axes that matter here:

| | append a new `user` turn | append into the last message |
|---|---|---|
| earlier messages | untouched, byte-for-byte | the last message is rewritten |
| cache divergence | at index N+1 (the new tail) | at index N (one message earlier) |
| who is speaking | a turn of its own, attributable | blended into a turn the client composed |

With consecutive user messages confirmed legal, the first column is available
and is strictly better, so that is what ships. The injected turn also sits after
any `tool_result` message rather than inside it, which keeps the
tool_use → tool_result adjacency the API requires.

**Not established:** whether a *mid-conversation `system` message* (`{role:
"system"}` in `messages[]`, supported on Opus 5 / Opus 4.8 / Fable 5 / 5.1 and
NOT on Sonnet 5) would be a better carrier. It would preserve the cached prefix
equally well, but it is the **operator** channel, and ADR-0007 §3b wants the
opposite of operator authority: a human's words, marked as a human's words. It
is also model-gated, and Golem proxies for whatever model the client chose — a
carrier that 400s on Sonnet 5 is not a carrier. Recorded so the next person does
not have to re-derive the rejection.

### (b) Two concurrent `fs.rename` calls on the same source BOTH succeed on Windows

**Measured 2026-09-03**, Node 24.13.1, Windows 11 26200, NTFS temp dir:

```js
await writeFile(src, "1");
const r = await Promise.allSettled([rename(src, dst), rename(src, dst)]);
// → [ 'fulfilled', 'fulfilled' ]
```

Sequentially, the second rename fails as expected (`ENOENT`). It is only the
**concurrent** pair that both resolve — which is exactly the shape a claim race
takes when two processes read the same queue directory and then act.

This mattered because the join queue's exactly-once guarantee was built on the
usual reasoning: *a rename is atomic, so the loser of a race gets ENOENT.* The
first implementation did precisely that, and the two-claimer test delivered
**every message twice** (`['m1','m2','m3']` returned to *both* claimers). A
duplicated instruction to an agent is not a duplicated packet, so this was the
one failure mode the design had promised to make impossible.

**The primitive that does hold** is exclusive create — `writeFile(path, data,
{ flag: "wx" })`, i.e. `O_EXCL` / `CREATE_NEW`. Measured on the same platform:

```js
await Promise.allSettled([wx(dst,"a"), wx(dst,"b"), wx(dst,"c")]);
// → [ 'fulfilled', 'rejected:EEXIST', 'rejected:EEXIST' ]
```

Exactly one winner, concurrently, with the losers refused. `FileJoinQueue.claim`
now claims by creating the message's `delivered/` record with `wx` and only then
removes the `pending/` copy; a claimer that sees `EEXIST` also clears the pending
copy, so a process that died between claiming and unlinking cannot leave a
message that is unclaimable forever.

**Generalise this:** anywhere in this repo that reaches for a rename as a
cross-process mutex is suspect on Windows. Atomic *replacement* of a file's
contents (write temp → rename over the target) is unaffected and remains
correct — that is a different property from *exclusive acquisition*.

---

## §149 — The portal is built and its contract is written down: what the harness now has to match, and two assets it does not ship (2026-09-04)

**Source: the portal's own committed design docs**, read on 2026-09-04 from the
local working copy of the portal repository (private; Next.js 16
App Router, Clerk, Stripe, Nango, Supabase, Vercel). Files: `docs/api-contract.md`,
`docs/team-config.md`, `docs/deploy.md`, `README.md`.

Status of everything below: **[UNESTABLISHED] as deployed behaviour** — these are
the portal's design documents, not observations of a running service. What IS
`[OBSERVED]` is the gap in *this* repo (item 2), checked directly against
`.github/workflows/release.yml`.

The portal's own `docs/team-config.md` §Status closes with: *"Step 3 is the
harness repo, and none of steps 1 and 2 do anything useful until it lands."*
That step is now on this roadmap.

### 1. The install endpoint moved off nginx — `deploy/nginx/golem-run.conf` is a reference implementation now

Vercel is serverless and has no nginx, so the User-Agent branching moved into
`next.config.ts` `redirects()` with `has: [{ type: 'header', key: 'user-agent' }]`.
The *behaviour* this repo specified survived intact; the implementation did not.

Three facts from that move that this repo did not previously have:

- **On Windows, `curl` is an alias for `Invoke-WebRequest`.** So the
  PowerShell-before-browser ordering is doing more work than
  `golem-run.conf`'s comment claims: a Windows user typing either verb must get
  `install.ps1`. Matching only on the literal `curl` token would hand a Windows
  user the shell installer.
- **Vercel compiles `has` values as `^value$`, case-SENSITIVELY**, with no way to
  pass an `i` flag (`(?i)` is not JavaScript). Character-class patterns are
  required. nginx's `~*` had made this free.
- **They must be 307s, not 308s.** The right answer for `/` depends on who is
  asking, so it must never be cached as the answer for everyone.

Consequences here: `deploy/nginx/golem-run.conf` is no longer *the* deployment,
and `docs/plan/tasks/R7.6-infra.md` names the wrong artifact in both `design:`
and `gate:`. `deploy/nginx/landing.html` is superseded by the portal's
`app/(marketing)/install/page.tsx`.

### 2. The release workflow does not attach the assets every portal path redirects to — **[OBSERVED]**

`.github/workflows/release.yml` uploads `dist-bin/*` and nothing else. The portal
redirects `/install.sh`, `/install.ps1` and `/bin/<asset>` to
`releases/latest/download/…`, and `docs/team-config.md` §2 fetches
`config-schema.json` from the same place to validate team settings.

So today: **`/install.sh` and `/install.ps1` would 404**, and the portal's
Settings page stays read-only by its own design ("Until a release exists with
that asset, the Settings page is read-only and says why").

**Corrected later the same day:** this note originally said CI was still
billing-blocked and therefore no release could publish. That was stale — the
block cleared between 2026-08-29 (last 1–3s no-step failure) and 2026-09-02
(Actions running normally, `CI gate` reporting success on both `push` and
`pull_request`). Nothing prevents a release from being cut now; the assets are
missing only because no release has been cut since the workflow was fixed.

`golem config schema --json` already exists (`src/cli/commands/config.ts:170`) and
emits the control surface, so the schema asset is a packaging step, not new code.

### 3. The team settings layer sits in the ladder TWICE

```
built-in defaults → TEAM (defaults)
                  → user → project → local
                  → TEAM (enforced keys only)
                  → GOLEM_* environment variables
                  → per-request headers
```

Each key is in exactly one position, chosen per key by a team admin via an
`enforced` flag on the API response. A normal team key is a company default
anyone may override; an enforced key is policy applied after every file layer.
`GOLEM_*` still wins over an enforced key **deliberately** — carving out an
exception would mean a setting that cannot be worked around on a machine that is
on fire.

`LayerName` (`src/config/loader.ts:50`) is
`"default" | "user" | "project" | "local" | "env" | "override"` — it has neither
team position, and provenance surfaces (`golem status`, the control panel's
"locked" rows) are expected to name the team as the source.

### 4. An organization is named in the path, never implied

An OAuth access token identifies a **user**, not an org: Clerk's `oauth_token`
auth object carries `userId` and `clientId` only. There is no active
organization for a machine client, so every org-scoped endpoint takes `{orgId}`
and the server re-verifies membership against Clerk **on every request**, never
from a claim inside the token — because a token outlives a membership.

`403 not_a_member` is deliberately indistinguishable from an org that does not
exist, so the endpoint cannot be used to enumerate organization IDs.

### 5. Auth is authorization-code + PKCE over loopback, and there is no headless path

`code_challenge_methods_supported` is `S256` only (plain is refused).
`grant_types_supported` is `authorization_code` and `refresh_token` — **Clerk
advertises no device authorization grant (RFC 8628)**, so a headless machine
cannot complete the flow on its own. That is stated as out of scope for v1, not
as an oversight.

Details that decide implementation: bind `127.0.0.1`, not `localhost` (the latter
can resolve to IPv6 `::1` and mismatch the registered redirect URI); register the
redirect host **without** a port, per RFC 8252, and choose the port at runtime;
`offline_access` is what yields a refresh token; endpoints come from
`<Clerk Frontend API URL>/.well-known/oauth-authorization-server` rather than
being hardcoded. Tokens go to the OS keychain — explicitly not into the config
directory and never into a file the harness might sync.

### 6. Team skills are a second managed namespace, not an extension of Golem's own

`.claude/skills/golem-team/<name>/SKILL.md`, per project, through the same
`managed-files.ts` mechanism — separate directory so a team skill can never
overwrite a personal one. **A skill absent from the API response is deleted
locally**, which is what makes it managed rather than a one-way copy. Each row
carries `content_sha256`, and `?manifest=1` returns rows without `content`, so an
unchanged sync writes nothing and touches no mtimes.

Note the interaction with `skill-provenance-on-clone`: team skills inherit the
same gitignored-provenance defect, and they arrive on more machines than Golem's
own skills do.

### 7. The failure rule, which CORRECTS an assumption written here on the same day

`docs/team-config.md`: *"a team link is an enhancement to a local-first tool.
Nothing about it may stop the proxy from starting."*

| Situation | Required behaviour |
|---|---|
| `403 not_a_member` | Name the team the project points at, use local config, **do not fail** |
| `402 subscription_required` | Same, with the reason named |
| Portal unreachable | Use cached `~/.golem/team.json`, say how old it is |
| Token expired | Refresh silently; on failure fall back to cache and prompt at the next interactive command |

An earlier draft of `docs/plan/tasks/project-team-binding.md` (written 2026-09-04,
before the portal repo was read) required a membership mismatch to **refuse**.
That is wrong for a local-first tool and the task has been corrected. The half
worth keeping from it: the failure must be *said out loud*, never a silent
downgrade — someone believing they are on team policy when they are not is the
actual hazard.

### 8. The harness stays the single source of truth for the settings schema

The portal carries no copy. It fetches `config-schema.json` from the release and
validates team settings against it, so a value the portal accepted cannot be
rejected on a developer's machine. It also **never down-converts** for an older
client: it serves the layer as written plus the migrations between versions, and
the client applies what it has (`SETTING_MIGRATIONS`, `RETIRED_SETTINGS`) and
reports what it did not understand. Clients send `golem_version` and
`schema_version` on sync; nothing is gated on them — they exist so an admin can
see who is behind.

Team settings hold **no secrets** — a value whose key looks like a credential is
refused at write time, keeping ADR-0003's line (an entry names a provider and an
endpoint; the key lives in the OS keychain).

---

## §150 — The skills Golem installs are NOT discoverable, R13.16 was right, and a plugin can be scoped to a project (2026-09-04)

**Source: Claude Code's own documentation**, queried via Context7 on 2026-09-04
against client `2.1.259` (`code.claude.com/docs` — agent-sdk/skills,
slash-commands, plugins, plugins-reference, plugin-marketplaces,
settings-reference). Status: **[OBSERVED]** for the on-disk facts about this
machine; **[DOCUMENTED]** for the tool's rules, which come from the vendor's
current docs rather than from a live experiment.

### 1. Skill discovery is ONE level deep

The documented layout, stated twice and confirmed by the docs' own verification
snippet:

```
.claude/skills/<skill-name>/SKILL.md

ls .claude/skills/*/SKILL.md     # "Check project skills"
ls ~/.claude/skills/*/SKILL.md   # "Check personal skills"
```

`src/cli/init-skills.ts` writes **two** levels —
`.claude/skills/golem/<cmd>/SKILL.md` — so `.claude/skills/golem/` is examined
for a `SKILL.md` that is not there. It is not an error; the entry is simply not
a skill, and the whole namespace is absent from the listing.

This is exactly what the archived R13.16 branch reported on 2026-08-29
(`docs/plan/tasks/skills-project-scope-reachability.md`). **Its diagnosis is
confirmed.** The layout dates from verification-notes §11 (2026-07-03), when
directory nesting was how a command got namespaced; the tool moved and this repo
did not.

Nested `.claude/skills/` directories DO exist as a feature, but they mean
something else: a `.claude/skills/` folder **deeper in the repo** (`apps/web/`),
for monorepos, which yields a directory-qualified name like `apps/web:deploy`.
That is not a subdirectory *inside* `.claude/skills/`.

### 2. What is actually surfacing the skills on this machine — **[OBSERVED]**

`~/.claude/skills/golem/` exists: `.claude-plugin/plugin.json` (`"name":
"golem"`, `"version": "0.42.0"`, `golem.run`), plus `skills/<cmd>/SKILL.md` for
21 commands. Directory mtime 2026-08-29 — the day R13.16 was committed. It is a
**user-scope plugin**, installed by that branch, and the `golem:<cmd>` names in
a session's skill listing match plugin naming (`plugin:skill`).

The project copy has no `.claude-plugin` marker.

So the repo looks correct, the skills appear to work, and **the two facts are
unrelated**. Reading `init-skills.ts` alone — as happened earlier the same day,
producing the claim that skills were already project-scoped with no cross-project
bleed — gets the code right and the machine wrong. The user-scope install is also
precisely the leak the project wants to avoid: those skills are offered in every
project on the machine.

### 3. A plugin CAN be project-scoped — the naming does not force user scope

This is the part that makes R13.16's *fix* separable from its *diagnosis*.

```
claude plugin install <plugin>@<marketplace> --scope project
```

`--scope` takes `user` (default), `project`, or `local`. Project scope is
recorded in `.claude/settings.json`:

```json
{ "enabledPlugins": { "golem@<marketplace-name>": true } }
```

`enabledPlugins` is a documented settings key across user / project / local /
managed scopes, and **project settings take precedence over user settings**,
with local able to override project on one machine.

The marketplace may be a **local directory in the repository**:

```
.claude-plugin/marketplace.json          # at the repo root
{
  "name": "<marketplace-name>",
  "owner": { "name": "..." },
  "plugins": [
    { "name": "golem", "source": "./<path>", "description": "..." }
  ]
}
```

and the plugin itself is `<source>/.claude-plugin/plugin.json` plus
`<source>/skills/<cmd>/SKILL.md` — the nesting that IS legal, because a plugin
declares its own skills directory rather than relying on `.claude/skills/`
discovery.

`claude --plugin-dir <path>` also loads a plugin directly, but it is
**session-only** and therefore not a wiring mechanism.

### 4. What this means for the decision already taken

USER, 2026-09-04: Golem skills belong in Golem projects only. That rules out
R13.16's user-scope install and nothing else. The route above keeps the
`/golem:<cmd>` naming, keeps the files inside the repo, is committed with the
project, and never applies to another project — which is the requirement.

The alternative, a flat `.claude/skills/golem-<cmd>/SKILL.md`, also works and is
far simpler, but changes every invocation to `/golem-<cmd>` and contradicts
CLAUDE.md's `/golem/<cmd>` convention plus every skill reference in the wiki.

**Sequencing matters:** removing `~/.claude/skills/golem/` before the project
route works leaves the machine with no Golem skills at all. Backed up meanwhile
to `D:\Personal\Backups\golem-archive\user-scope-skills-golem-2026-09-04.tar.gz`.

---

## §151 — A marketplace can be a remote, authenticated URL, so ONE mechanism can carry both Golem's skills and a team's (2026-09-04)

**Source: Claude Code documentation** (`code.claude.com/docs` —
plugin-marketplaces, settings-reference), queried via Context7 on 2026-09-04,
client `2.1.259`. **[DOCUMENTED]**, not yet exercised against a real portal.

Follows §150, and answers the question it left open: if project-scoped plugins are
how Golem's own skills reach a project, can **team** skills use the same road
instead of the bespoke sync in `team-skills-sync`?

### The facts that make it possible

A marketplace source may be a **URL**, with headers:

```json
{ "source": "url",
  "url": "https://plugins.example.com/marketplace.json",
  "headers": { "Authorization": "Bearer ${TOKEN}" } }
```

Also available: `{ "source": "git", "url": "...", "ref": "..." }`, GitHub sources,
and `{ "source": "archive", "url": "...zip" }` for the plugin itself.

Authentication is a first-class feature, and the interesting half is dynamic:

- **`headersHelper`** — a command run before fetches whose output is used as
  headers and **reused for up to 60 seconds**. Marketplace-level headers apply to
  every archive download on that origin; plugin-level headers apply to that plugin
  only and **take precedence** over marketplace-level ones.
- A plugin entry using `headersHelper` with an archive source needs
  **`strict: false`**, so the entry defines the plugin before the user accepts the
  command.

One constraint worth carrying: **plugins in URL marketplaces cannot use relative
paths** — a remote marketplace must name absolute URLs or archive sources. A local
directory marketplace (Golem's own) may use `./relative` paths.

### Why this fits the team tier unusually well

`headersHelper` is the piece that matters. The portal's tokens live in the OS
keychain (ADR-0003, `team-portal-auth`), and a helper command is exactly how a
short-lived bearer gets minted **without a credential in any settings file** —
`golem` itself can be the helper. The 60-second reuse means it is called rarely.

It also disposes of the part of `team-skills-sync` that carried the most risk:
deletion propagation ("a skill absent from this list is removed locally") becomes
the plugin system's job rather than a prune loop this repo has to get right, and
with it goes the whole interaction with `skill-provenance-on-clone` — Claude Code
owns those files, so Golem's managed-file provenance never touches them.

And it collapses two mechanisms into one shape:

| | marketplace | scope |
|---|---|---|
| Golem's own skills | local directory in the repo | `enabledPlugins` at project scope |
| A team's skills | `source: "url"` at the portal, `headersHelper` mints the bearer | `enabledPlugins` at project scope |

Both committed in `.claude/settings.json`, both invisible to other projects.

### The objection that has to be answered first

**It is harness-specific.** Plugins and marketplaces are Claude Code's, and the
pipeline is meant to extend to other gateways (R6.1). The portal's existing
`GET /api/v1/orgs/{orgId}/skills` is a plain JSON contract any client can consume;
a marketplace endpoint serves Claude Code and nothing else.

That is not fatal — it argues for the marketplace being an **additional**
representation of the same data rather than a replacement, which portal API v1
explicitly permits ("we may add response fields, add endpoints"). But it is the
decision to take before building, not after.

Two smaller points: the portal would serve plugin archives as well as a
marketplace document, which is more surface than a JSON list; and `${TOKEN}`
interpolation in static `headers` is worse than `headersHelper` for the same
reason a token in a file is worse than one in a keychain.

---

## §152 — A project skill's command name comes from its DIRECTORY; only plugins get `:` namespacing (2026-09-04)

**Source: Claude Code documentation** (`code.claude.com/docs` — skills,
slash-commands), via Context7, 2026-09-04, client `2.1.259`. **[DOCUMENTED]**.

The rule, which decides the layout question left open by §150 and §151:

> In personal or project skills, the **directory or file name defines the
> command** while the **frontmatter `name` only sets the display label**, with
> nested paths appended to resolve name clashes. In plugin skills, the frontmatter
> `name` defines the final command segment **namespaced by the plugin prefix**.

Consequences, stated plainly because each was assumed otherwise at some point
today:

| layout | command |
|---|---|
| `.claude/skills/golem-bypass/SKILL.md` | `/golem-bypass` |
| `.claude/skills/golem-team-review/SKILL.md` | `/golem-team-review` |
| plugin `golem`, skill `bypass` | `/golem:bypass` |

**The colon is not available to project skills at all.** It cannot be bought with
frontmatter — `name` is a display label there, nothing more. So `golem:<cmd>` and
`golem:team:<cmd>` require the plugin/marketplace machinery of §151; a flat layout
necessarily renames every command to `/golem-<cmd>`.

Nested paths are appended only **to resolve clashes**, so the monorepo-style
`apps/web:deploy` form cannot be relied on to produce a stable `golem:` prefix
either — it appears when names collide, not on demand.

The frontmatter key set is closed and validated: `allowed-tools`, `compatibility`,
`description`, `license`, `metadata`, `name`. An unknown key is a hard error
("Unexpected key(s) in SKILL.md frontmatter"), which is worth knowing before
inventing one.

### The portability argument, which is the real trade

`SKILL.md` is an **Agent Skills spec** artifact — the validation error above cites
the spec by name. `plugin.json` and `marketplace.json` are Claude Code's alone. So
the flat layout is the portable unit and the manifests are the lock-in, which is
the opposite of how §151 framed the choice (it weighed naming, not portability).

Flat costs the `golem:` namespace and buys portability. That is the decision, and
it is not primarily about aesthetics.


---

## §153 — The release→portal schema loop had BOTH halves built and still did not connect: three contract mismatches, one of which also broke the fallback (2026-09-04)

**Source: the portal repository's working copy** (private; Next.js 16 + Supabase
+ Clerk), read on 2026-09-04, and this repo's own
`.github/workflows/release.yml`. Both are code, not design docs — the mismatches
below are **[OBSERVED]** in the two implementations, not inferred from prose.

Context: §149 read the portal's *design docs*. This entry read the portal's
*code*, and the code disagreed with both its own docs and this repo's contract.

### The finding

`portal-release-webhook` was tracked as "the harness half is written, the portal
half is not". That was wrong in a way worth recording: the portal half **was**
written (`app/api/webhooks/golem-build/route.ts`, committed as "Take the schema
from the build instead of waiting for it"), but against an earlier design. Two
implementations existed, neither had ever executed against the other, and they
did not agree:

| | this repo sends | the portal expected | on first release |
|---|---|---|---|
| signature | `x-golem-signature: sha256=<hex>` over `"<ts>.<body>"`, plus `x-golem-timestamp` | bare `<hex>` over the raw body, no timestamp at all | **400** |
| body | envelope naming `config_schema: {url, sha256}` — schema by *reference* | `{version, schema: {…}}` — schema *inline* | **422** |
| document | `{version, groups[].controls[].id/kind/options}` | `{version, sections[].settings[].key/type}` | **422** |

The sender treats 4xx as fatal and does not retry, so the first release cut with
`PORTAL_WEBHOOK_URL` set would have gone red on attempt one.

### The part that mattered more than the webhook

The third row is not a webhook bug. `parseSchemaDocument` is also what the
portal's **GitHub fallback** runs on the release asset it pulls, so the same
mismatch meant `config-schema.json` — correctly rendered, correctly attached,
correctly asserted by this repo since §149 item 2 — **would not parse on
arrival**. The Settings page would have stayed read-only with the webhook
switched off entirely, and the honest error (`did not parse`) would have looked
like a bad asset rather than a portal-side shape assumption.

`golem config schema --json --no-header` emits the harness **control surface**,
which was never a settings list:

```
{ version, groups: [ { id, title, tab, controls: [ { id, family, kind, … } ] } ] }
```

A control's `id` is `setting:<section>.<key>`, `guidance:<feature>` or
`runtime:<name>` (`src/config/control-surface-types.ts`, which calls those ids
stable across releases). Only the `setting:` family is a team setting; `kind` is
the widget and is as close to a type as the document carries; an enum's values
are `options[].value` and a number's bounds are `range`.

### Resolved on the portal side, and why that direction

[[Portal Install Contract]]'s direction-of-truth table already answers it: this
repo owns the contract, the portal owns how it is implemented. The sender had
also already shipped. So the portal was changed to the contract as documented,
not the reverse — `lib/golem-schema.ts` reparsed to the control surface,
`lib/team-settings.ts` validating on `kind`/`range`/`options`, and the route
verifying `sha256=`-prefixed HMAC over `"<ts>.<raw>"` with a 300s timestamp
tolerance, then fetching and checksum-checking the asset before storing it.
Portal `tsc --noEmit` and `next build` both green.

### Three decisions inside the fix worth not re-deriving

1. **Lenient on fields, strict on three.** `id`, `family` and `kind` are
   required; `kind` and `family` are typed as strings rather than enums. A
   release that adds a widget kind must not make every team's Settings page
   read-only, which is the failure mode a strict enum guarantees.
2. **A `header` block is refused, not stripped.** The header carries absolute
   paths, the proxy port and the upstream account, and this document is stored
   and served to every member of every team. This repo's release job already
   asserts the header is absent, so one arriving means something upstream is
   broken and should say so.
3. **An unreadable asset is a 502, not a 422.** The 4xx/5xx split is an
   instruction to the sender: 4xx means retrying cannot help, 5xx means try
   again. A release asset can take a moment to become readable, and the sender's
   three retries are exactly the right response to that.

### What is still open

Nothing in code. `PORTAL_WEBHOOK_URL` (the portal's
`/api/webhooks/golem-build`) and `PORTAL_WEBHOOK_SECRET` (matching the portal's
`GOLEM_BUILD_WEBHOOK_SECRET`) on this repo's Actions secrets, then a release —
both credentialed, both `owner: user`. See `portal-release-webhook`.

### The generalisable lesson

**"Both halves are built" is not "the loop is closed", and a contract only one
side has ever executed is untested by construction.** The wire format was
written down in this repo and implemented from an older draft in the other; no
test could have caught it, because neither repo can run the other's half. The
cheap check is to read the receiving code against the sending code once, before
setting the secret that makes the first attempt a live release.

### Bonus, found while proving the fix: `HOME` does not isolate the render on Windows — **[OBSERVED]**

Verifying the fix meant rendering the real asset the way the release does and
running it through what the portal now requires. Rendered locally with
`HOME="$EMPTY" … --dir "$EMPTY"`, exactly as `release.yml` does, one control
came back with a **non-default layer**: `setting:proxy.gateways` at layer
`user`, i.e. this machine's real gateway config folded into a document that is
supposed to be pure built-in defaults.

Not a defect in the workflow. The user dir comes from `os.homedir()`
(`src/config/paths.ts`, §17), and `os.homedir()` reads `$HOME` on POSIX but
**`USERPROFILE` on Windows** — so `HOME="$EMPTY"` isolates nothing on a Windows
box. Re-rendered with `USERPROFILE` isolated as well: 79 controls, no
non-default layer. The published asset is fine because that job runs on
`ubuntu-latest`.

Two consequences worth keeping:

- **Reproducing the render on Windows needs `USERPROFILE` too.** The assertion
  that would catch the leak lives in the workflow, so it only ever runs on
  Linux. A comment now says so at the step.
- **The portal's `defaultOf()` is load-bearing, not defensive.** It reports a
  control's `value` as a default only when `layer` is `default`, precisely so a
  document rendered without full isolation cannot present one machine's state
  to a whole team as the built-in default. This is what that guard is for, and
  it took about a minute of real rendering to produce the case.

The rest of the loop verified as intended against the real 0.50.0 document: 14
groups, 79 controls, 67 dotted setting keys (all matching the portal's
`SETTING_KEY` regex), all 7 `enum` kinds carrying `options`, the HMAC over
`"<ts>.<body>"` verifying between the two implementations, a tampered body
refused, and the asset URL inside the allowlist.

### Related cleanup in the same pass

`deploy/nginx/golem-run.conf` and `deploy/nginx/landing.html` were **removed**.
§149 item 1 had already demoted the conf to a reference implementation for a box
that was never stood up; keeping it left a second dialect of the routing rules
to drift, and left the "two landing pages, no stated winner" question from
`R7.6-infra` open. The behaviour lives in [[Portal Install Contract]]; git
history keeps the config.

---

## §154 — The portal webhook is OIDC-only, and the workflow it trusts is named in the token, so a "small helper workflow" cannot send it (2026-09-05)

**Source: a brief from the portal side** (the portal is already deployed
OIDC-only), plus GitHub's own docs, read 2026-09-05:
`https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-cloud-providers`
— which confirms **[OBSERVED]** that `ACTIONS_ID_TOKEN_REQUEST_URL` and
`ACTIONS_ID_TOKEN_REQUEST_TOKEN` appear only when the job (or workflow) declares
`permissions: id-token: write`, and that a provider without an official action
mints the token by `curl`-ing that URL with that token as a bearer.

### What changed

`POST /api/webhooks/golem-build` now authenticates with a **GitHub Actions OIDC
token and nothing else**. The shared secret is removed, not deprecated: a
correctly signed HMAC request is a **401**, and the portal's smoke test asserts
that rather than assuming it. So §153's `x-golem-signature` / `x-golem-timestamp`
pair is history, and this repo's sender was switched before the next release
could go red on it.

The body and everything downstream of authentication are unchanged — the schema
is still carried **by reference**, still fetched by the portal, still checked
against the declared `sha256` before a byte of it is trusted, and the 4xx/5xx
split still means what §153 said it means.

What the portal verifies, in order: RS256 + `kid` (screened before any network
call) → signature against GitHub's JWKS → `iss` exactly
`https://token.actions.githubusercontent.com` → `aud` **exactly** the portal's
audience → `exp`/`nbf`/`iat` with 60s tolerance → `repository` exactly
`cloudcatalyst/golem` → `workflow_ref` starting
`cloudcatalyst/golem/.github/workflows/release.yml@`.

### The finding worth recording

The brief proposed a small `notify-portal.yml` with `workflow_dispatch`, so a
lost webhook could be re-pushed without cutting a release. **That cannot work,
and the reason is check 7 of the portal's own list.** `workflow_ref` names the
workflow file the run *entered through*, so a second file mints a token naming
**itself** — `…/.github/workflows/notify-portal.yml@…` — and is refused with the
same 401 the change was meant to avoid. Reusable-workflow indirection does not
help either: the caller is what `workflow_ref` reports (`job_workflow_ref` is the
claim that names the reusable one).

Confirmed locally before building anything, by decoding synthetic tokens through
the exact guard the job now runs: a `release.yml@…` ref accepts, a
`notify-portal.yml@…` ref rejects, and an `aud` of `https://golem.run/api`
rejects against an audience of `https://golem.run` — which is what "exact, not a
prefix match" costs if anyone assumes otherwise.

So the re-push shipped as a **`notify_only` input on `release.yml`** instead. It
skips `ci`/`binaries`/`assets`/`release` and runs only `notify-portal`, fetching
`config-schema.json` from the tag's *already published* assets with `gh release
download` rather than rebuilding it — a rebuild would compute a `sha256` for
bytes the portal is not going to fetch. Cost: `resolve` needs
`if: !cancelled() && (needs.ci.result == 'success' || inputs.notify_only)`,
because `needs: ci` alone would skip it the moment `ci` is skipped.

### Two details that will save a debugging session

1. **`aud` is compared exactly.** The workflow decodes its own token and fails
   on a mismatched `aud` or `workflow_ref` *in this repo's log*. Decoding is not
   verification — the portal does that — but it turns the two failures that
   actually happen into a legible error here instead of an opaque 401 whose
   reason is visible only in the portal's log.
2. **`set -u` reports a missing permission as an unbound variable.** Without
   `id-token: write` the two `ACTIONS_ID_TOKEN_REQUEST_*` vars simply are not in
   the environment, and the failure reads like a typo. The job checks for them
   by name first and says what is actually wrong.

### What is still open

One repository **variable**: `vars.PORTAL_WEBHOOK_URL`. Not a secret — a URL is
not one, and storing it as a secret makes it invisible in the log exactly when
you want to read it. `PORTAL_WEBHOOK_SECRET` should be deleted. `owner: user`,
see `portal-release-webhook`.

### The generalisable lesson

**OIDC moves the trust from a value both sides hold to a claim about *which
workflow file ran*, and that turns "add a small helper workflow" from a free
refactor into a breaking change.** A shared secret does not care which file
sends the request; a `workflow_ref` check is precisely a statement about the
file. The identity is the path, so moving or renaming the workflow is a
contract change and needs telling the other side — the same class of coupling
[[Portal Install Contract]] already records for asset names.
