# Golem Implementation Plan — workstream & interface reference

Companion to `docs/golem-spec.md`. Originally structured for multi-agent P0/P1
development (parallel workstreams, frozen contracts); **P0/P1 shipped**, so this
document now serves as the workstream/interface reference. The forward-looking
view is `ROADMAP.md` — a generated index over the committed task documents in
`plan/tasks/` (spec Decision 55); shipped history is `SHIPPED.md`, and completed
batch briefs are retired to git history.

> **Status (2026-07-16, Decision 36):** P0, P1, and releases R1–R3 are shipped;
> the test baseline is green (886 tests). The per-agent workstream briefs and
> completed batch files were retired (git history + wiki debriefs are the
> record). The roadmap is refocused on the co-developer core (R4); autonomy and
> multi-provider/remote work (R5/R6) is on hold.

---

## 0. Ground rules for all agents

1. **The spec is authoritative.** If implementation reveals the spec is wrong, stop and flag it — don't silently diverge. Update the spec's Decisions Log in the same PR.
2. **Verify before building on external facts.** Live docs: docs.claude.com (Claude Code hooks, slash commands, MCP), headroom-docs.vercel.app + github.com/chopratejas/headroom. Record dated findings in `docs/plan/verification-notes.md`.
3. **Contracts are frozen once merged.** Changes to `src/interfaces/` require contract-test updates first and a cross-workstream flag in the PR.
4. **Cross-platform in every PR:** no Unix-only paths, shells, or signals; CI matrix (ubuntu/macos/windows) must pass; use `node:path`, `env-paths`, argument-array spawning.
5. **Pin the Headroom dependency** to an exact version; upgrades happen only via the contract-test task (T-C4).
6. **Test-first for contracts:** every interface in §2 ships with contract tests before implementations.

## 1. Repository layout

```
golem/
├── CLAUDE.md                    # agent guidance
├── package.json                 # npm "golem-run"; bin: golem; ESM; Node >= 22
├── tsconfig.json                # strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess
├── biome.json                   # lint + format (single tool)
├── vitest.config.ts
├── docs/
│   ├── golem-spec.md            # the spec (source of truth #1)
│   ├── plan/                    # planning docs
│   │   ├── IMPLEMENTATION_PLAN.md   # this file
│   │   ├── ROADMAP.md               # generated index over tasks/ (Decision 55)
│   │   ├── tasks/                   # one committed task document per open item
│   │   ├── SHIPPED.md               # one line per landed release/task
│   │   ├── BACKLOG.md               # ideas inbox (pre-task)
│   │   ├── verification-notes.md    # dated live-doc findings (source of truth #3)
│   │   └── proposals/               # active design proposals (created per feature; retired when shipped/dropped)
│   └── wiki/                    # the project's own wiki (Decision 28; see WIKI.md)
├── src/
│   ├── interfaces/              # FROZEN CONTRACTS (workstream boundaries)
│   │   ├── compression.ts       # CompressionService
│   │   ├── inference.ts         # InferenceService (OpenAI-compat)
│   │   ├── knowledge.ts         # KnowledgeBase + FederatedSearch
│   │   ├── wiki.ts              # WikiStore (W2, Decision 28)
│   │   ├── local-answer.ts      # LocalAnswerService (Decision 33)
│   │   ├── storage.ts           # BlobStore (local dir | S3-compat)
│   │   ├── policy.ts            # SliderPolicy + level table (0–3, Decision 30)
│   │   └── index.ts             # barrel re-exports
│   ├── proxy/                   # Anthropic-compatible proxy (HTTP + SSE passthrough)
│   ├── pipeline/                # redaction → compression → forward
│   ├── compression/             # native lossless + Headroom sidecar adapter (pins here)
│   ├── mcp/                     # unified MCP server (tools + prompts)
│   ├── knowledge/               # vector KB — ingestion, chunking, embed, rerank, distill, watch
│   ├── wiki/                    # wiki store, federated reader, frontmatter
│   ├── inference/               # Ollama client, capability detection, model catalog, bootstrap
│   ├── hooks/                   # Claude Code hooks (PostToolUse CCR swap, WebFetch cache, guidance)
│   ├── cli/                     # golem init/status/index/slider/wiki/note/... (commander)
│   ├── dashboard/               # local web UI (telemetry)
│   ├── config/                  # settings hierarchy loader
│   └── telemetry/               # savings attribution, event log
└── tests/
    ├── contract/                # interface contract tests (incl. headroom pin tests)
    ├── integration/             # proxy round-trip vs recorded Anthropic API shapes
    └── e2e/                     # golem init → Claude Code smoke (3 OS)
```

## 2. Frozen interface contracts

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
Implementation: `compression/headroom-adapter.ts` wrapping the Headroom sidecar (spec Decision 18). All Headroom imports live ONLY in this module; pins live in `src/compression/index.ts`. Binding rule: re-compressing a previously-sent prefix must be byte-identical (prompt-cache stability, verification-notes §14).

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
Role→model mapping comes from the catalog (`src/inference/catalog.ts`), selected by detected tier. `opts.jsonSchema` forces structured output (the Decision 34 mechanism — reused for rerank, distill, synthesize).

### 2.3 KnowledgeBase + FederatedSearch (`interfaces/knowledge.ts`)
```ts
interface KnowledgeBase extends FederatedSearch {
  ingest(path: string, projectId: string, watch?: boolean): Promise<IngestReport>
}
interface FederatedSearch {
  search(query: string, projectId: string, k?: number, scopes?: ReadonlySet<Scope>): Promise<Hit[]>
    // MEMORY scope delegates to the Headroom memory sidecar (Decisions 13/18, R3.6), merged by score
  getChunk(chunkId: string): Promise<Chunk>
}
```
Wiki pages are indexed by the same machinery (Decision 28: pages canonical, vectors derived); wiki authoring is the separate frozen `interfaces/wiki.ts` (W2, Decision 29 append-and-refine semantics).

### 2.4 SliderPolicy (`interfaces/policy.ts`)
Level 0–3 → per-stage config (**simplified from 0–5 by Decision 30; local drafts/local-first removed by Decision 31**). The slider is a pure compression-aggressiveness dial:

| Level | name | redaction | lossless (dedup/compaction/cache-align) | tool-result cache | semantic compression | semantic cache |
|---|---|---|---|---|---|---|
| 0 | passthrough | ❌ **full bypass** | off | off | off | off |
| 1 | lossless | ✅ | ✅ | off | off | off |
| 2 | balanced | ✅ | ✅ | ✅ | stale turns only | strict |
| 3 | aggressive | ✅ | ✅ | ✅ | aggressive | loose |

> **Level 0 ("passthrough") runs nothing, redaction included** — the one sanctioned exception to the redaction hard rule (Decision 30), surfaced loudly wherever active. Legacy 0–5 configs migrate clamp-wise (0–3 face value; 4/5 → 3). Levels ≥2 are **lossy** and gated OFF on Anthropic-style caching upstreams (Decision 31) to preserve prompt-cache prefixes — they run only on non-caching gateways. The local model is invoked only via the explicit `coder` MCP tool (Decision 35); a reachable local model shows "local + upstream" in the status surfaces.

### 2.5 MCP surface (names frozen — Decisions 27/35 gate renames)
Tools: `search`, `fetch`, `ingest`, `expand` (CCR retrieve), `stats`, `level`, `coder`, `devices`, `wiki_read`, `wiki_upsert`.
Prompts (→ slash commands): `slider`, `index`, `search`, `stats`, `expand`, `bypass`, `devices`, `coder`.
Skills: `/golem/<cmd>` incl. `research`, `wiki-ingest`, `note`, `develop` (and `plan`, R4.1).

## 3. Workstreams — all P0/P1 workstreams shipped

Per-task history lives in the wiki debriefs and the spec Decisions Log; only
the map and the follow-up pointers remain here.

| Workstream | Scope | Status |
|---|---|---|
| T0 | Bootstrap: doc verification (T0.1), scaffold, interface freeze | ✅ 2026-07-03 |
| WS-A | Proxy, pipeline (redaction → compression → forward), native lossless, telemetry | ✅ shipped; semantic sidecar opt-in (Decision 23), context substitution + local-answer seams (R2.2/R2.3) |
| WS-B | Unified MCP server, Claude Code wiring (hooks, guidance writer), P1 tools | ✅ shipped; tool names per Decisions 27/35 |
| WS-C | Knowledge base: chunking, embedding, drivers, watcher, extractors, tree-sitter opt-in, MEMORY federation (C4, R3.6) | ✅ shipped; follow-up → **R4.6** (flush stream-write) |
| WS-W | Wiki knowledge store W1–W4 (Decision 28) | ✅ shipped; follow-up → **R4.5** (promote UX), **R4.1** (planning loop) |
| WS-D | Inference: capability detection, Ollama client + bootstrap (Decision 26), role routing | ✅ shipped; follow-up → **R4.7** (catalog re-verify), R1.6 manual rows open |
| WS-E | CLI, config hierarchy, dashboard, init/uninit, VS Code extension, statusline | ✅ shipped |

### T-C — Cross-cutting (continuous, still binding)
- T-C1: Contract tests green on 3 OS per PR.
- T-C2: E2E smoke: `golem init` → Claude Code round-trip. ✅ in CI (R1.7).
- T-C3: Security review of redaction changes — standing gate, not a one-off.
- T-C4: Headroom upgrade playbook — the pinned npm client and the sidecar's PyPI pin (bump pin → contract tests → changelog diff; pins live in `src/compression/index.ts`).

## 4. P0 definition of done — ✅ met

Kept for the record: `npx golem-run init` idempotent on 3 OSes; recorded-shape
proxy fidelity at level ≤1; measurable stats; skills + prompt twins working;
redaction verified against the secrets corpus; CI matrix green.

## 5. Known unknowns (open items only — full history in verification-notes)

- Headroom sidecar version handshake across pin bumps (npm ↔ PyPI) — revisit at each T-C4 upgrade.
- R1.6: macOS/Linux Ollama setup checklist rows unrun (no non-Windows hardware to date) — `wiki/questions/r1.6-ollama-verification-blocked.md`.
- Decision 33 confidence calibration on real queries — needs a human-reviewed served answer before ACCEPTED.

## 6. Future workstreams (spec Decision 20) — WS-F ↔ ROADMAP index

> **Not a remaining-work queue.** Every WS-F workstream maps to a numbered task
> id (renumbered by Decision 36: autonomy = R5, multi-provider/remote = R6).
> Build status, ordering, and gates live on the **task document** in
> `plan/tasks/<id>.md` (spec Decision 55) — run `golem task index --summary` for
> what is open. This table is only the WS-F→task-id crosswalk and spec-ref map.
> Each item still needs its design memo + explicit ask before build; none touch
> frozen interfaces or shipped scope.

| ID | Feature (spec ref) | → ROADMAP | Depends on |
|---|---|---|---|
| WS-F1 | Durable task queue & auto-resume (20a) | **R5.1** | device/job scheduler §2.2, worktree state capture |
| WS-F2 | Task/question queue + local conversation multiplexing (20b) | **R5.3** | InferenceService, slider |
| WS-F3 | Self-hosted remote session access, no org account (20c) | **R6.3** | auth + relay/tunnel, Decision 12 LAN, threat model |
| WS-F4 | Cruise-control autonomy modes (20d) | **R5.4** | MCP tool surface, approval-gate guardrails |
| WS-F5 | Tiered user/workspace/org shared standards & knowledge (20e) | ✅ user/local tier shipped (R3.4); workspace/org **hosted** tier is P4+, off-roadmap | KnowledgeBase federation, config hierarchy |
| WS-F6 | Idea/note capture shaping project context (20f) | ✅ capture + shaping shipped (T4, R3.5); planning loop → **R4.1** | ingest, distill |
| WS-F7 | Writing-style adaptation & prompt translation (20g) | **R5.5** | telemetry scoring, local LLM, memory |
| WS-F8 | Parallel conversations + mid-thread model escalation (21a) | **R5.3** (parallel convos) + **R6.2** (model escalation) | WS-D routing, WS-F1 task queue |
| WS-F9 | Remote monitoring / continuation / permission-granting (21b) | **R6.3** | auth+relay (WS-F3), Notification+permission hooks; **security-critical** |
| WS-F10 | Dashboard-as-sidecar (terminal / VS Code) (21c) | **R5.2** | dashboard, status-line hook / VS Code webview |
| WS-F11 | Account switching (21d) | **R6.2** | proxy credential routing, secure store; **ToS review** |
| WS-F12 | Multi-LLM / multi-model concurrency & quota routing (21e) | **R6.2** | WS-F8, WS-F11; **ToS review**, capability-preserving router |
| WS-F13 | Cost-governance goals & benchmarks (21f) | **R6.4** | telemetry, hooks, WS-D; benchmark vs. code.claude.com/docs/en/costs |
| WS-F14 | Provider-agnostic pre-LLM pipeline: front Azure AI Foundry / OpenRouter (22) | **R6.1** | upstream-adapter layer (Anthropic byte-faithful path unchanged); positioning unblocked by Decision 32, build gated on memo + explicit ask |

Note: WS-F9/F11/F12 carry security/ToS gates (spec Risks table) — design memo + review before build.
