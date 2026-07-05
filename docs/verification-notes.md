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
  caller's job; B3's `golem_search`/`golem_index_path` MCP tools will build it.
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
backs `golem_expand` and lossy-level reversibility), but "cut token spend via
compression" as the lead claim does not survive contact with real cached traffic.

## §33 — B3: knowledge base wired to Claude (2026-07-05)

Realized the "local tools" pillar (the durable value from Decision 23): the
unified MCP server now exposes the three P1 knowledge tools, backed by a real
local-inference embedder.

- **Tools:** `golem_search` (semantic search → hits with `chunk_id` + preview),
  `golem_get_chunk` (full chunk by id), `golem_index_path` (ingest a file/dir).
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
  is indexed in the BACKGROUND (never blocks startup) so `golem_search` is
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
its own CCR, `golem_expand` cannot retrieve it — Golem's expand is wired to the
TS CCR store, not Headroom's (verification-notes §32 open item). On tool-heavy
traffic this rarely triggers (tool content is excluded), but on very long
prose-heavy sessions a compressed earlier turn is not recoverable from the model
side. Symptoms to attribute to balanced mode if seen: (a) referencing a stale file
version, (b) "forgetting" mid-conversation detail from >4 turns back, (c) any
Foundry 4xx that disappears at level ≤2. Mitigation if it bites: `golem slider 1`
(same redaction, no semantic stage).

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
