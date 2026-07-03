# Golem Implementation Plan (P0 → P1)

> **Project renamed to Golem** (2026-07-03, spec Decision 19): npm `golem-run`, CLI `golem`, domain golem.run.

Companion to `edge-offload-spec.md`. Structured for **multi-agent Claude Code development**: workstreams are parallelizable, interfaces are frozen contracts, and every workstream lists its dependencies so agents don't collide.

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
Level 0–5 → per-stage config. Initial mapping (tune against Headroom's real config surface after T0.1):

| Level | redaction | headroom lossless (dedup/compaction/cache-align) | tool-result cache | semantic compression | semantic cache | local drafts | local-only answers |
|---|---|---|---|---|---|---|---|
| 0 | ✅ | off | off | off | off | off | off |
| 1 | ✅ | ✅ | off | off | off | off | off |
| 2 | ✅ | ✅ | ✅ | off | off | off | off |
| 3 | ✅ | ✅ | ✅ | stale turns only | strict | off | off |
| 4 | ✅ | ✅ | ✅ | + low-relevance sections | normal | ✅ | off |
| 5 | ✅ | ✅ | ✅ | aggressive | loose | ✅ | per-project opt-in |

### 2.5 MCP surface (WS-B owns; names frozen)
Tools: `golem_search`, `golem_get_chunk`, `golem_index_path`, `golem_expand` (CCR retrieve), `golem_stats`, `golem_set_slider`, `golem_delegate`, `golem_devices`.
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
- B1: Unified MCP server (stdio + HTTP): P0 tools `golem_expand`, `golem_stats`, `golem_set_slider`; prompt-based slash commands. *(after T0.1, T0.3)*
- B2: Claude Code wiring: hook (per T0.1 findings) swapping oversized tool outputs for CCR refs; guidance-file writer (CLAUDE.md section, coordinated with headroom learn).
- B3: P1 tools: `golem_search`, `golem_index_path`, `golem_get_chunk`, `golem_delegate`, `golem_devices` (thin wrappers over WS-C/D).

### WS-C — Knowledge base (P1 headline)
- C1: Embedded vector store setup (spec Decision 17: LanceDB candidate, spike + decision memo required; Qdrant server mode via URL config); per-project collections; schema/migrations.
- C2: Ingestion: doc chunking (heading-aware md/html/pdf-text), code chunking (tree-sitter WASM vs native prebuilds — and **first evaluate reusing Headroom `--code-graph`**, decision memo required); file watchers (chokidar/fs.watch, Windows-correct).
- C3: Embedding + rerank via InferenceService; CPU fallback.
- C4: Federated search: knowledge + Headroom memory (**via optional P2 sidecar only — Python-only subsystem, spec Decisions 13/18**), merged rerank; graceful KNOWLEDGE-only degradation.

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
