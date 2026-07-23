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
3. **NET-savings caveat (Decision-23 gate, §31/§32 lesson — UNRESOLVED).** The
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
