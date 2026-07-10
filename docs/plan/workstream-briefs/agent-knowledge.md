# Workstream brief — agent-knowledge (WS-C: Knowledge base, P1 headline)

Read `CLAUDE.md` first; it binds. Spec: `docs/edge-offload-spec.md` §3.1, Decisions 13, 17, 18.
Live-doc facts you must honor: `docs/verification-notes.md` §4, §6, §16 and
contradiction C1 (no Headroom Qdrant backend).
Work on branch `ws-c`; claim tasks by ID in PR titles (e.g. "C1: ...").

## Mission
The Golem document knowledge base: ingest what the developer chooses (codebases,
guides, wikis, ADRs) into an embedded vector store, and give Claude ONE federated
retrieval call across knowledge + (when available) Headroom's conversational memory.

## Architecture you must build to (Decisions 13 + 17 + 18)
- **Embedded store:** Qdrant's embedded mode is Python-only. Default is a TS-native
  embedded store — **LanceDB (`@lancedb/lancedb` 0.31.0) is the leading candidate,
  sqlite-vec the fallback**. Your FIRST deliverable (C1) is a spike + decision memo
  in `docs/verification-notes.md` (dated) weighing: napi native-dep footprint,
  Arrow peer dep, Windows/macOS/Linux prebuilds, index size behavior. Qdrant
  **server** mode stays supported via config URL (LAN/NAS offload is config-only).
- **Memory federation:** Headroom memory is Python-only → `Scope.MEMORY` works only
  when the optional P2 sidecar is present; without it `search()` degrades
  gracefully to KNOWLEDGE-only (the interface already allows this).

## Task list (in order)
- **C1 — Store setup + decision memo.** Embedded store (per memo outcome) behind
  `src/knowledge/`; one table/collection per project — `no cross-project bleed` in
  the contract harness enforces it. Schema versioning from day one. Data paths via
  `env-paths`. Native deps must have prebuilds for all 3 OSes (CI proves it).
- **C2 — Ingestion.** Heading-aware doc chunking (md/html/pdf-text); code chunking
  at function/class granularity. Evaluate **web-tree-sitter (WASM) vs native
  prebuilds** for cross-platform safety (open question, notes table) — record the
  choice. Also evaluate Headroom's `--code-graph` (codebase-memory-mcp) before
  building an indexer (notes §6) — decision memo required. File watchers:
  `chokidar` or `node:fs.watch` (justify; Windows correctness required).
- **C3 — Embedding + rerank.** Through `InferenceService.embed()` (WS-D) only —
  never load an embedding model directly. CPU fallback must work (P-cpu profile:
  slow is fine, broken is not). Cross-encoder rerank on merged result sets.
- **C4 — Federated search.** Implement `FederatedSearch.search()` merging
  KNOWLEDGE (your store) + MEMORY (sidecar client, only when detected); merged
  rerank; graceful KNOWLEDGE-only degradation.

## Interfaces
- **Provides:** `KnowledgeBase` + `FederatedSearch` implementations
  (`src/interfaces/knowledge.ts` is frozen; register via
  `describeKnowledgeBaseContract("LanceDbKnowledgeBase", ...)` in
  `tests/contract/*.test.ts`).
- **Consumes:** `InferenceService` (WS-D) for embed/rerank; `src/config/` (WS-E);
  `src/telemetry/` for ingest/search metrics.

## Files owned
`src/knowledge/`, your contract registrations + integration tests. Do not touch
`src/interfaces/` or other workstream dirs.

## Dependencies
C1 can start now (interfaces frozen). C3/C4 need WS-D's `InferenceService` — until
it merges, develop against a fake implementing the interface (the
`describeInferenceServiceContract` harness defines expected behavior). MCP
exposure of your tools lands via WS-B B3, not you.

## Definition-of-done slice (P1, with P0-adjacent duties)
1. `describeKnowledgeBaseContract` green on all 3 OSes (embedded store, real files).
2. Ingest → search → getChunk round-trip on a representative corpus; per-project
   isolation proven.
3. Two decision memos recorded (embedded store; code chunking / code-graph), dated,
   in verification-notes.md.
4. MEMORY scope degrades gracefully when the sidecar is absent.
