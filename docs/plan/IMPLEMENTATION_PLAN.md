# Golem Implementation Plan (P0 → P1)

> **Project renamed to Golem** (2026-07-03, spec Decision 19): npm `golem-run`, CLI `golem`, domain golem.run.

Companion to `edge-offload-spec.md`. Structured for **multi-agent Claude Code development**: workstreams are parallelizable, interfaces are frozen contracts, and every workstream lists its dependencies so agents don't collide.

> **Status (2026-07-11):** P0 and most of P1 are shipped and the test baseline is
> green (77 files / 728 tests). The forward-looking, release-grouped view now
> lives in `ROADMAP.md`; this document remains the workstream/interface
> reference. The `NEXT_BATCH.md` wiki-loop batch (T1–T7) fully landed — see the
> per-workstream ✅ notes below.

> **REVISED v1.1 (2026-07-03): implementation language is TypeScript** (spec Decisions 16–18, user decision). Layout, tooling, and interface signatures below are updated accordingly; the frozen interfaces now live as TypeScript in `src/interfaces/` and those files are authoritative over any snippet in this document.

---

## 0. Ground rules for all agents

1. **The spec is authoritative.** If implementation reveals the spec is wrong, stop and flag it — don't silently diverge. Update the spec's Decisions Log in the same PR.
2. **Verify before building on external facts.** The spec's "To verify against live docs" list (spec §9) MUST be resolved as task T0.1 before dependent work starts. Live docs: docs.claude.com (Claude Code hooks, slash commands, MCP), headroom-docs.vercel.app + github.com/chopratejas/headroom (config surface, memory API, code-graph).
3. **Contracts are frozen once merged.** Changes to `interfaces/` require a cross-workstream review.
4. **Cross-platform in every PR:** no Unix-only paths, shells, or signals; CI matrix (ubuntu/macos/windows) must pass; use `node:path`, `env-paths`, argument-array spawning.
5. **Pin the Headroom dependency** to an exact version; upgrades happen only via the contract-test task (T-C4).
6. **Test-first for contracts:** every interface in §2 ships with contract tests before implementations.

## 1. Repository layout

```
golem/
├── CLAUDE.md                    # agent guidance (provided)
├── package.json                 # npm "golem-run"; bin: golem; ESM; Node >= 22
├── tsconfig.json                # strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess
├── biome.json                   # lint + format (single tool)
├── vitest.config.ts
├── docs/
│   ├── edge-offload-spec.md     # the spec (source of truth)
│   ├── IMPLEMENTATION_PLAN.md   # this file
│   ├── verification-notes.md    # dated live-doc findings (T0.1+)
│   └── workstream-briefs/       # one brief per agent (WS-A..E)
├── src/
│   ├── interfaces/              # FROZEN CONTRACTS (workstream boundaries)
│   │   ├── compression.ts       # CompressionService interface
│   │   ├── inference.ts         # InferenceService interface (OpenAI-compat)
│   │   ├── knowledge.ts         # KnowledgeBase + FederatedSearch interfaces
│   │   ├── storage.ts           # BlobStore interface (local dir | S3-compat)
│   │   ├── policy.ts            # SliderPolicy + level table
│   │   └── index.ts             # barrel re-exports
│   ├── proxy/                   # WS-A: Anthropic-compatible proxy (HTTP + SSE passthrough)
│   ├── pipeline/                # WS-A: redaction → compression → forward
│   ├── compression/             # WS-A: Headroom adapter (implements interfaces/compression)
│   ├── mcp/                     # WS-B: unified MCP server (tools + prompts, @modelcontextprotocol/sdk)
│   ├── knowledge/               # WS-C: vector KB — ingestion, chunking, embed, rerank, watch
│   ├── inference/               # WS-D: Ollama client, capability detection, model catalog
│   ├── cli/                     # WS-E: golem init/status/index/slider/... (commander)
│   ├── dashboard/               # WS-E: local web UI (telemetry)
│   ├── config/                  # WS-E: settings hierarchy loader
│   └── telemetry/               # shared: savings attribution, SQLite event log
└── tests/
    ├── contract/                # interface contract tests (incl. headroom pin tests)
    ├── integration/             # proxy round-trip vs recorded Anthropic API shapes
    └── e2e/                     # golem init → Claude Code smoke (3 OS)
```

## 2. Frozen interface contracts (build these first)

> The TypeScript files in `src/interfaces/` are the authoritative contracts;
> the signatures below are the summary view.

### 2.1 CompressionService (`interfaces/compression.ts`)
```ts
interface CompressionService {
  compress(messages: readonly Message[], policy: SliderPolicy,
           projectId: string): Promise<CompressResult>
    // CompressResult: messagesOut, refs: CCRRef[], stageSavings: Record<string, TokenDelta>
  retrieve(ref: CCRRef): Promise<Original>
  stats(projectId?: string): Promise<CompressionStats>
}
```
Implementation: `compression/headroom-adapter.ts` wrapping the Headroom TS SDK (gaps per spec Decision 18). All Headroom imports live ONLY in this module. Binding rule: re-compressing a previously-sent prefix must be byte-identical (prompt-cache stability, verification-notes §14).

### 2.2 InferenceService (`interfaces/inference.ts`)
OpenAI-compatible chat + embeddings client with capability metadata:
```ts
interface InferenceService {
  chat(modelRole: Role, messages: readonly ChatMessage[], opts?: ChatOptions): Promise<ChatResult>
    // Role: "summarizer" | "extractor" | "classifier" | "drafter" | "judge"
  embed(texts: readonly string[], kind: "text" | "code"): Promise<Vector[]>
  capabilities(): HardwareTier   // P_CPU | P_MIN | P_MID | P_MAX
}
```
Role→model mapping comes from the catalog (WS-D), selected by detected tier.

### 2.3 KnowledgeBase + FederatedSearch (`interfaces/knowledge.ts`)
```ts
interface KnowledgeBase extends FederatedSearch {
  ingest(path: string, projectId: string, watch?: boolean): Promise<IngestReport>
}
interface FederatedSearch {
  search(query: string, projectId: string, k?: number, scopes?: ReadonlySet<Scope>): Promise<Hit[]>
    // MEMORY scope delegates to Headroom memory (embedded store, Decision 13), then merged + reranked
  getChunk(chunkId: string): Promise<Chunk>
}
```

### 2.4 SliderPolicy (`interfaces/policy.ts`)
Level 0–3 → per-stage config (**simplified from 0–5 by Decision 30; local drafts/local-first removed by Decision 31, 2026-07-11**). The slider is now a pure compression-aggressiveness dial:

| Level | name | redaction | lossless (dedup/compaction/cache-align) | tool-result cache | semantic compression | semantic cache |
|---|---|---|---|---|---|---|
| 0 | passthrough | ❌ **full bypass** | off | off | off | off |
| 1 | lossless | ✅ | ✅ | off | off | off |
| 2 | balanced | ✅ | ✅ | ✅ | stale turns only | strict |
| 3 | aggressive | ✅ | ✅ | ✅ | aggressive | loose |

> **Level 0 ("passthrough") runs nothing, redaction included** — the one sanctioned exception to the redaction hard rule (Decision 30), surfaced loudly wherever active. Legacy 0–5 configs migrate clamp-wise (0–3 face value; 4/5 → 3). Levels ≥2 are **lossy** and gated OFF on Anthropic-style caching upstreams (Decision 31) to preserve prompt-cache prefixes — they run only on non-caching gateways. The local model is invoked only via the explicit `delegate` MCP tool; a reachable local model shows "local + upstream" in the status surfaces.

### 2.5 MCP surface (WS-B owns; names frozen)
Tools: `search`, `fetch`, `ingest`, `expand` (CCR retrieve), `stats`, `level`, `delegate`, `devices`.
Prompts (→ slash commands): `slider`, `index`, `search`, `stats`, `expand`, `bypass`, `devices`, `delegate`.

## 3. Workstreams & task breakdown

### T0 — Bootstrap (serial, do first, single agent) — ✅ DONE 2026-07-03
- **T0.1 Doc verification:** resolve all four items in spec §9 "To verify" + TS-SDK parity (T0.1b); findings in `docs/verification-notes.md`. **Blocked: A2, B1, E2 — now unblocked.**
- **T0.2 Repo scaffold:** layout above, npm/tsconfig-strict/Biome/vitest, 3-OS GitHub Actions matrix.
- **T0.3 Freeze interfaces:** `src/interfaces/*.ts` + contract harnesses in `tests/contract/`.

### WS-A — Proxy, pipeline & compression (P0 core)
- A1: Anthropic-compatible proxy (TS) — transparent passthrough incl. **SSE streaming and tool-use blocks untouched**; recorded-shape integration tests. *(after T0.2)*
- A2: **Golem-native lossless CompressionService** (dedup, compaction, cache alignment, CCR store) per spec Decision 18; contract tests via `describeCompressionServiceContract`. Optional Headroom sidecar adapter is P2. *(after T0.1, T0.3)*
- A3: Pipeline: redaction stage (secret/PII patterns + entropy heuristics) → compression → forward; `x-golem-bypass` header; slider levels 0–2.
- A4: Telemetry events per stage → SQLite.

### WS-B — MCP server & Claude Code integration (P0)
- B1: Unified MCP server (stdio + HTTP): P0 tools `expand`, `stats`, `level`; prompt-based slash commands. *(after T0.1, T0.3)*
- B2: Claude Code wiring: hook (per T0.1 findings) swapping oversized tool outputs for CCR refs; guidance-file writer (CLAUDE.md section, coordinated with headroom learn).
- B3: P1 tools: `search`, `ingest`, `fetch`, `delegate`, `devices` (thin wrappers over WS-C/D).

### WS-C — Knowledge base (P1 headline)
- C1: Embedded vector store setup (spec Decision 17: LanceDB candidate, spike + decision memo required; Qdrant server mode via URL config); per-project collections; schema/migrations.
- C2: Ingestion: doc chunking (heading-aware md/html/pdf-text), code chunking (tree-sitter WASM vs native prebuilds — and **first evaluate reusing Headroom `--code-graph`**, decision memo required); file watchers (chokidar/fs.watch, Windows-correct). **✅ shipped:** heuristic pure-TS chunkers (notes §27); file watcher landed 2026-07-11 (T6, ADR-0001). *Follow-ups → ROADMAP R3: real HTML/PDF-text extractor, tree-sitter WASM opt-in.*
- C3: Embedding + rerank via InferenceService; CPU fallback.
- C4: Federated search: knowledge + Headroom memory (**via optional P2 sidecar only — Python-only subsystem, spec Decisions 13/18**), merged rerank; graceful KNOWLEDGE-only degradation.

### WS-W — Wiki knowledge store (spec Decision 28; W1 done, W2 done 2026-07-10, W3 done 2026-07-11)
Pages are canonical, vectors are a derived rebuildable index. Design: `docs/plan/proposals/wiki-knowledge-pivot.md`. Consumes WS-C machinery; `src/interfaces/knowledge.ts` untouched.
- W1: Make the wiki exist and be found first (config + scaffold, no new interfaces):
  - W1a: `wiki_dir` project-settings key (default `docs/wiki`), env `GOLEM_KNOWLEDGE_WIKI_DIR`.
  - W1b: `golem wiki init` — scaffold `wiki_dir` (WIKI.md zone-0 schema, `concepts/ entities/ sources/ syntheses/ decisions/ debriefs/ questions/ artifacts/`), idempotent like `golem init`.
  - W1c: search-rank boost for hits whose `sourcePath` is under `wiki_dir` (wiki pages beat raw chunks at equal similarity).
  - W1d: wiki-first retrieval guidance in the generated Claude Code surfaces (CLAUDE.local.md template / skills): wiki lookup → `search` → outside world.
- W2: Authoring surface (contract-first): NEW frozen `src/interfaces/wiki.ts` (readPage/upsertPage/resolveLink/backlinks) + contract tests; `wiki_read` + `wiki_upsert` MCP tools (plan-gated writes); `/golem/wiki-ingest <url>` + `/golem/wiki-query` skills; `golem wiki check` link/frontmatter lint. **✅ done** (skills shipped 2026-07-11, T2).
- W3 (post WS-D): local-model distillation queue (fetch → source note draft), `golem note` capture (Decision 20f), webcache backfill distillation, graph-first lookup step ahead of vector search. **✅ done 2026-07-11** (T3 distill engine, T4 `golem note`, T5 graph-first search). *Follow-up → ROADMAP R3.5: shape captured notes into draft pages.*
- W4: user-scope `~/.golem/wiki/` federation (Decision 20e local tier); weekly synthesis reports. *→ ROADMAP R3.4 (not started).*

### WS-D — Inference & hardware (P1/P2)
- D1: Capability detection (GPU/VRAM/unified memory, all 3 OS) → tier.
- D2: Ollama client (OpenAI-compat), model catalog per tier, pull-on-demand UX; endpoint URL-configurable (lab box ready).
- D3: Role routing (summarizer/extractor/classifier/drafter/judge) + Haiku-fallback option.

### WS-E — CLI, config, dashboard (P0)
- E1: Config loader: user → project → local → env → per-request. `env-paths`, zod-validated.
- E2: `golem init`: detect Claude Code; set base URL; register MCP; install commands + hooks; idempotent + `golem uninit`. *(after T0.1)*
- E3: `golem status|slider|stats|index|devices`; dashboard v0 (savings, cache hits, stage attribution).

### T-C — Cross-cutting (continuous)
- T-C1: Contract tests green on 3 OS per PR.
- T-C2: E2E smoke: `golem init` → Claude Code round-trip with savings > 0 at level 1.
- T-C3: Security review of redaction stage before first release.
- T-C4: Headroom upgrade playbook — applies to the pinned npm client and the P2 sidecar's PyPI pin (bump pin → contract tests → changelog diff; pins live in `src/compression/index.ts`).

## 4. Suggested agent assignment (5 parallel + 1 integrator)

| Agent | Workstream | Starts after |
|---|---|---|
| integrator | T0.1–T0.3, then reviews/merges, owns interfaces | — |
| agent-proxy | WS-A | T0.3 |
| agent-mcp | WS-B | T0.1/T0.3 |
| agent-knowledge | WS-C | T0.3 (C4 after WS-B B1 exists) |
| agent-inference | WS-D | T0.3 |
| agent-ux | WS-E | T0.2 (E2 after T0.1) |

## 5. P0 definition of done
1. `npx golem-run init` on Win/macOS/Linux configures Claude Code (base URL + MCP + skills + hook) idempotently.
2. Proxy passes recorded-shape tests incl. streaming + tool use; zero semantic change at level ≤1.
3. Level 1 shows measurable savings in `golem stats` on a real Claude Code session.
4. `/golem/slider`, `/golem/stats`, `/golem/expand`, `/golem/bypass` (+ `/mcp__golem__*` prompt twins) work in-session.
5. Redaction verified against a secrets corpus; CI matrix green.

## 6. Known unknowns (updated post-T0.1 — full table in verification-notes.md)
- ~~Exact Headroom config keys for per-stage control~~ ✅ resolved (notes §3).
- ~~`headroom wrap claude` conflict~~ ✅ confirmed conflicting; `golem init` must detect and refuse (notes §5; owner WS-E E2).
- ~~MCP prompt→slash-command surfacing~~ ✅ resolved: `/mcp__golem__<prompt>` + directory-namespaced skills (notes §10–11).
- Windows GPU detection reliability (WMI vs nvidia-smi) — owner WS-D D1.
- Embedded vector store choice (LanceDB vs sqlite-vec) — owner WS-C C1.
- tree-sitter WASM vs native prebuilds — owner WS-C C2.
- Headroom sidecar version handshake (npm 0.22.4 ↔ PyPI 0.28/0.29) — owner WS-A, P2.

## 7. Future workstreams (post-P1 — spec Decision 20, not yet scheduled)
Each needs a design memo before build; none touch frozen interfaces or P0 scope.

| ID (tentative) | Feature (spec ref) | Phase | Depends on |
|---|---|---|---|
| WS-F1 | Durable task queue & auto-resume (20a) | P2 | device/job scheduler §2.2, worktree state capture |
| WS-F2 | Task/question queue + local conversation multiplexing (20b) | P2/P3 | WS-D InferenceService, slider |
| WS-F3 | Self-hosted remote session access, no org account (20c) | P3/P4 | auth + relay/tunnel, Decision 12 LAN, threat model |
| WS-F4 | Cruise-control autonomy modes (20d) | P3 | MCP tool surface, approval-gate guardrails |
| WS-F5 | Tiered user/workspace/org shared standards & knowledge (20e) | P1 local → P4+ hosted | WS-C KnowledgeBase federation, config hierarchy |
| WS-F6 | Idea/note capture shaping project context (20f) | P2/P3 | WS-C ingest, Headroom-memory (ML sidecar) |
| WS-F7 | Writing-style adaptation & prompt translation (20g) | P3 | telemetry scoring, WS-D local LLM, memory |
| WS-F8 | Parallel conversations + mid-thread model escalation (21a) | P2/P3 | WS-D routing, WS-F1 task queue |
| WS-F9 | Remote monitoring / continuation / permission-granting (21b) | P3/P4 | auth+relay (WS-F3), Claude Code Notification+permission hooks; **security-critical** |
| WS-F10 | Dashboard-as-sidecar (terminal / VS Code) (21c) | P2 | E3 dashboard, Claude Code status-line hook / VS Code webview |
| WS-F11 | Account switching (21d) | P2/P3 | proxy credential routing, secure store; **ToS review** |
| WS-F12 | Multi-LLM / multi-model concurrency & quota routing (21e) | P3 | WS-F8, WS-F11; **ToS review**, capability-preserving router |
| WS-F13 | Cost-governance goals & benchmarks (21f) | continuous | A4 telemetry, B2 hooks, WS-D; benchmark vs. code.claude.com/docs/en/costs |
| WS-F14 | Provider-agnostic pre-LLM pipeline: front Azure AI Foundry / OpenRouter (22) | P3+ | upstream-adapter layer in WS-A proxy (Anthropic byte-faithful path unchanged), generalized translation; **product-positioning decision first** |

Note: WS-F5 at user (local) scope can begin alongside WS-C in P1; only workspace/org sync is the P4+ hosted (candidate paid) tier. WS-F9/F11/F12 carry security/ToS gates (spec Risks table) — design memo + review before build.
