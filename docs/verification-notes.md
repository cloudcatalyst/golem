# EOL Verification Notes (live-doc findings)

Live-document verification record required by CLAUDE.md and IMPLEMENTATION_PLAN T0.1.
All findings below were checked against live docs on **2026-07-03** unless noted.
Add new dated entries below; never rewrite history — corrections get a new entry.

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
`/mcp__golem__slider` (golem_set_slider) and `loadConfig()`/`golem slider` would
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
- `ccrRefsRetrieved` is 0 in telemetry: retrievals happen via the `golem_expand`
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
