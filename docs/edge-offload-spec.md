# Project Spec: Golem — edge offload for Claude

**Status:** **v1.3 — approved for implementation kickoff** (see IMPLEMENTATION_PLAN.md, CLAUDE.md, KICKOFF_PROMPT.md)
**Date:** 2026-07-03

> **RENAMED (v1.3, Decision 19): the project is "Golem"** (domain **golem.run**; npm `golem-run`; CLI `golem`). Every "EOL" in this document reads as "Golem"; concrete renamed identifiers are listed in Decision 19. The working title "Edge Offload Layer" survives only in this file's name and historical notes.

---

## 1. Vision & Goals

**EOL is an agentic developer assistant layer for Claude** — a local-first service that gives Claude instructable tools backed by the developer's own hardware (GPU, storage, vector DB, local LLMs), while transparently cutting token spend on every request. Token savings are the floor; the ceiling is Claude acting as a materially better coding assistant because it can search, delegate, execute, and remember locally instead of consuming context.

1. **Fewer tokens** sent to and received from Claude models, reducing cost and latency.
2. **Quality impact is minimal**, and where quality is traded for savings, the trade is explicit and user-controlled via a **quality/savings slider**.
3. Claude is **taught to delegate**: retrieval, summarization, extraction, cheap generation, test execution, and memory all become local MCP tools Claude prefers over raw context consumption.
4. Targets **typical developer-grade edge compute**: a single dev laptop or desktop with a mainstream GPU (8–16GB NVIDIA) or Apple Silicon (16–64GB unified memory). Larger GPUs (24GB) and additional LAN machines are exploited when present but never required; a CPU-only machine still gets the full lossless pipeline.
5. **Cross-platform as a hard requirement:** native Windows, macOS, and Linux from P0 — no WSL dependency. Enforced by a 3-OS CI matrix; every dependency choice must have native support on all three (the decided stack already does: Python/uvx, Ollama native Windows builds, Qdrant embedded client, ONNX/tree-sitter Windows wheels, and `headroom-ai` explicitly supports Windows). Platform-specific paths/config via `platformdirs`.
6. **Familiar Claude-style UX:** configuration and interaction mirror Claude Code conventions — slash commands (`/eol:...`), a settings.json hierarchy (user → project), and CLAUDE.md-style guidance files — so adoption feels like an extension of the tool developers already know.

### 1.1 Relationship to Headroom (DECIDED v0.3: embed, don't rebuild)

Headroom (`headroom-ai`, Apache 2.0, Python + TypeScript) already ships the compression layer this spec originally described: an Anthropic-compatible proxy, an MCP server (`headroom_compress`, `headroom_retrieve`, `headroom_stats`), content-aware compressors (AST-based code compression via tree-sitter, statistical JSON compression, log/diff/text compression via a small HF model), reversible Compress-Cache-Retrieve (CCR), cache alignment, per-project SQLite+HNSW memory, `headroom wrap claude` one-command integration, failure learning, and output-token reduction.

**EOL therefore depends on `headroom-ai` as its compression stage** and differentiates on everything agentic:

| Capability | Headroom | EOL adds |
|---|---|---|
| Compression, CCR, cache alignment | ✅ core | Slider gating, redaction pre-stage, savings telemetry |
| Proxy / MCP / agent wrap | ✅ | Unified with EOL's tools in one MCP server & one init command |
| Memory | ✅ Conversational fact memory: inline extraction, scoping, supersession, hybrid retrieval, **Qdrant backend** | Adopted as-is on shared Qdrant. EOL adds the **document knowledge base**: ingestion of guides/wikis/codebases, GPU embeddings, tree-sitter chunking, reranking, file watchers, federated search across memory + knowledge |
| Local models | One HF compression model | **Tiered local-LLM delegation** (Ollama): summarize, extract, classify, route, draft, judge |
| Developer-assistant tools | — | Local test/lint execution → failure digests; git-aware context; Whisper/OCR media preprocessing; speculative prefetch |
| Hardware awareness | — | Capability tiers, model auto-selection, optional LAN workers |

Risk note: Headroom's scope is expanding (it recently added memory and learning); revisit the boundary each release and upstream generic improvements rather than forking.

### 1.2 Headroom integration design (DECIDED v0.4: library mode behind an adapter)

Evidence from the codebase (v0.28.0, Apache 2.0, Rust-accelerated core via maturin): the base package is lightweight (tiktoken, pydantic, click, ast-grep), with `[proxy]`, `[code]`, and `[ml]` extras and lazy, ImportError-guarded imports. It is already factored for embedding — **no fork or service extraction needed.**

**Integration mode:** EOL owns the single HTTP proxy process and calls Headroom **as a library** (`compress(messages)` / CCR retrieve) inside its pipeline: `redaction → headroom.compress(slider-mapped config) → forward to Anthropic`. Rejected alternatives: proxy-chaining (`EOL proxy → headroom proxy → API`) doubles processes and latency and splits config; MCP-to-MCP is only suitable for explicit tools, not the transparent path.

**Isolation:** Headroom sits behind an internal `CompressionService` interface (`compress(messages, policy) → (messages', refs)`, `retrieve(ref) → original`, `stats()`), version-pinned, with contract tests run on every upgrade — it's a beta-velocity dependency (0.x with documented breaking pins).

**Config-level reworks (no code changes):**
- **Adopt Headroom's memory for conversational facts** (REVERSES v0.4's "disable" decision after source review): it provides inline fact extraction (preferences, decisions, entities, insights) with zero added latency, hierarchical scoping (user/session/agent/turn), temporal supersession chains, hybrid vector+FTS retrieval, LoCoMo-benchmarked evals, and Claude Code sync writers. ~~Critically it supports a **native Qdrant backend** (`HEADROOM_QDRANT_*`), so it shares EOL's Qdrant instance in dedicated collections.~~ **[CORRECTED v1.1 — refuted by T0.1 verification: no Qdrant backend exists; memory stays on Headroom's embedded SQLite+HNSW+FTS5 store and federation spans two stores. See Decision 13.]**
- **Memory/knowledge division of labor:** Headroom memory = *learned from conversations*; EOL knowledge base = *ingested from documents* (guides, style guides, wikis, codebases). EOL's `search_local` federates both (query memory + knowledge collections, rerank merged results) so Claude gets one retrieval call.
- **Coordinate `headroom learn`** and memory's CLAUDE.md sync writers with EOL's guidance writer — one merged guidance file, no conflicting instructions.
- **Kompress vs. local LLM:** Kompress (ONNX INT8, no torch) stays the default text compressor; slider ≥4 may route text compression to EOL's tiered local LLM for higher-quality abstractive summaries.
- **Unified MCP surface:** EOL's MCP server re-exports Headroom's retrieve/stats/memory tools under the EOL namespace alongside its own tools — Claude sees one coherent toolset.
- **Evaluate Headroom's `--code-graph`** (file-watching code index for compression) in P1 before building EOL's tree-sitter indexer from scratch — reuse or extend if suitable.

### Non-goals (v1)
- Cloud-hosted deployment (local/LAN only)
- Replacing Claude for primary reasoning tasks
- Fine-tuning local models
- Datacenter/server-class GPU support as a design driver

### Target hardware profiles (developer-grade)

| Profile | Typical hardware | Local capability |
|---|---|---|
| **P-cpu** | Any dev machine, no usable GPU | Full lossless pipeline: redaction, dedup, compaction, exact caching. CPU embeddings (slow but viable for small indexes) |
| **P-min** | 8GB NVIDIA (3060/4060), 16GB Apple Silicon | + fast embeddings, reranking, OCR, Whisper, 3–4B LLM (Q4) for light summarization/classification |
| **P-mid** ⭐ *primary design target* | 12–16GB NVIDIA (4070/4070Ti/4080), 24–36GB Apple Silicon (M-series Pro/Max) | + 7–8B LLM (Q4–Q5): summarization, extraction, routing, semantic compression — the full slider range |
| **P-max** | 24GB (3090/4090), 48GB+ Apple Silicon | + 14B models (Q4–Q6), local judge/critic, higher-quality drafts |

**Design rules:** (a) every feature must degrade gracefully down this ladder — a missing capability disables or downgrades a stage, never breaks the system; (b) the flagship experience is tuned and eval'd on **P-mid**; (c) meaningful savings (slider 0–2) require no GPU at all.

---

## 2. Architecture Overview

A **hub-and-worker** design with three integration surfaces sharing one core engine.

```
┌─────────────────────────────────────────────────────────┐
│  CLIENTS                                                │
│  Claude Code │ Claude Desktop/App │ Your API apps       │
└──────┬──────────────┬──────────────────┬────────────────┘
       │ (proxy)      │ (MCP)            │ (SDK)
┌──────▼──────────────▼──────────────────▼────────────────┐
│  EOL HUB (one machine, always on)                       │
│  ┌────────────┐ ┌───────────┐ ┌──────────────────────┐  │
│  │ API Proxy  │ │ MCP Server│ │ Python/TS SDK        │  │
│  └─────┬──────┘ └─────┬─────┘ └─────────┬────────────┘  │
│        └──────────────┼──────────────────┘              │
│              ┌────────▼─────────┐                       │
│              │ Core Engine      │                       │
│              │ • Pipeline mgr   │                       │
│              │ • Quality slider │                       │
│              │ • Job scheduler  │                       │
│              │ • Device registry│                       │
│              │ • Cache store    │                       │
│              │ • Vector DB      │                       │
│              │ • Telemetry      │                       │
│              └────────┬─────────┘                       │
└───────────────────────┼─────────────────────────────────┘
        │ gRPC/HTTP over LAN (optional — single machine is default)
        ┌───────────────┼───────────────────┐
┌───────▼──────┐ ┌──────▼───────┐ ┌─────────▼────────┐
│ LOCAL WORKER │ │ WORKER B     │ │ WORKER C         │
│ (same box)   │ │ (optional)   │ │ (optional)       │
│ 8–16GB GPU or│ │ spare desktop│ │ 24GB GPU         │
│ Apple Silicon│ │ 8–12GB GPU   │ │ 14B LLM,         │
│ embed, 7–8B  │ │ embed, OCR,  │ │ draft/judge      │
│ LLM, whisper │ │ 3–4B LLM     │ │                  │
└──────────────┘ └──────────────┘ └──────────────────┘
```

### 2.1 Integration surfaces

**DECIDED (v0.2): single process, two doors, one-command install.** EOL ships as one local service exposing the proxy and the MCP server simultaneously, sharing one engine/cache/index. Install and adoption flow:

1. `uvx eol init` (MVP; later: single static binary / `brew install eol`)
2. Init auto-detects Claude Code, sets `ANTHROPIC_BASE_URL=http://localhost:<port>`, runs `claude mcp add eol` — done.
3. P0 lossless savings begin immediately, **no GPU and no model download required**.
4. On first GPU-gated feature use, EOL detects Ollama (or offers to install it) and pulls the tier-appropriate models.

Rationale: the proxy is the only mechanism that sees *every* request (Claude Code hooks only intercept tool I/O, not the model request stream), giving Headroom-style savings with zero client changes; MCP is the standard, documented way to give Claude instructable tools. The two compose: the proxy compresses, and Claude can call `get_original(ref)` via MCP to reverse it when needed.

| Surface | Mechanism | Primary use |
|---|---|---|
| **Transparent proxy** | `ANTHROPIC_BASE_URL` pointed at EOL hub; hub forwards to `api.anthropic.com` | Automatic pre/post-processing for *any* client that honors the env var (Claude Code, all Anthropic SDKs). Claude Desktop/app cannot repoint its base URL → it gets MCP-only, which is acceptable: token pain concentrates in agentic workflows |
| **MCP server** | stdio (local) + streamable HTTP (LAN) | Claude explicitly calls tools: `search_local`, `summarize_local`, `cache_lookup`, `delegate_task`, `index_path` |
| **SDK** | Thin wrapper over Anthropic SDK | Your own apps get pipeline + tools programmatically |

The proxy handles *implicit* savings (compression, dedup, caching). MCP handles *explicit* delegation (Claude chooses to retrieve 5 relevant chunks instead of ingesting 50 files). Both share the same engine, caches, and indexes.

### 2.2 Device registry & job scheduler
- Workers run a lightweight agent that reports: GPU model, VRAM, current load, installed models, disk space.
- Hub maintains a capability table and routes jobs by **task → minimum capability tier** (tiers map to the hardware profiles above):
  - **Tier 0 (CPU-only ok):** exact-match caching, dedup, redaction, chunking
  - **Tier 1 (≥6GB VRAM / 16GB unified):** embeddings, reranking, OCR, Whisper transcription, 3–4B LLM
  - **Tier 2 (≥12GB VRAM / 24GB unified):** 7–8B LLM (summarization, extraction, semantic compression, routing)
  - **Tier 3 (≥24GB VRAM / 48GB unified, optional):** 14B LLM (drafting, judging, complex extraction) — a bonus tier, never assumed
- Graceful degradation: if a tier is unavailable, tasks fall back one tier with a quality note, or to Claude Haiku via API if the user allows, or the stage is skipped.
- **Single-machine mode is the default and primary deployment** (hub + worker co-located). Multi-machine LAN workers are an optional extension.
- **LAN "lab" hardware is architected in from P0, delivered incrementally:** every backing service is URL-addressable in config from day one — inference endpoint (`OLLAMA_HOST` on a lab GPU box), Qdrant (embedded → server mode on a lab box or NAS), and the CCR/blob store (local dir → any S3-compatible endpoint, e.g. MinIO on a NAS). That makes *manual* offload of storage and processing pure configuration long before P4's fleet module adds discovery, health checks, and automatic scheduling. mTLS + token auth on all LAN-exposed services; localhost-only by default.

---

## 3. Offload Capabilities

### 3.1 RAG / local vector search — the EOL knowledge base
Scope: **documents the developer chooses to ingest** — codebases, developer guides, style guides, wikis, ADRs, API docs. Complements (does not replace) Headroom's conversational memory; both live in the same Qdrant instance, and `search_local` federates across memory + knowledge collections with a shared reranker.
- **Vector DB — DECIDED (v0.3): Qdrant.** Default deployment uses qdrant-client's **embedded local mode** (on-disk, no server process — keeps install friction at zero); users can point config at a Qdrant server/Docker instance for bigger indexes or LAN sharing. **One collection per project** (mirrors Headroom's no-cross-project-bleed principle), plus an opt-in shared "knowledge" collection for cross-project docs.
- **Embeddings:** GPU-accelerated local models (e.g., bge-m3 or nomic-embed) — code-aware and text models.
- **Indexers:** file-watcher daemons for chosen paths; tree-sitter–based code chunking (function/class granularity); doc chunking with heading awareness.
- **MCP tools:** `index_path`, `search_local(query, k, filter)`, `get_chunk(id)`.
- **Token effect:** Claude retrieves k relevant chunks (~2–5K tokens) instead of whole-directory reads (~50–500K tokens).

### 3.2 Context compression & summarization (powered by `headroom-ai`)
EOL wraps Headroom's pipeline (CacheAligner → ContentRouter → per-type compressors → CCR store) rather than reimplementing it, and adds:
1. **Redaction pre-stage** — strip secrets/PII before anything leaves the machine (runs before Headroom).
2. **Slider gating** — maps EOL slider levels to Headroom aggressiveness/config per content type.
3. **Semantic compression** (slider ≥3) — EOL's tiered local LLM summarizes stale conversation turns and low-relevance sections, a heavier step than Headroom's compressors; originals go into the same CCR store so `headroom_retrieve` / EOL `get_original(ref)` reverses everything uniformly.
4. **Savings telemetry** — per-stage attribution surfaced in the EOL dashboard (extends `headroom_stats`).

### 3.3 Local LLM subtasks
Roles for local models (routed by tier):
- **Summarizer** — conversation compaction, doc/file digests
- **Classifier/Router** — "does this request even need Claude?" triage; intent tagging
- **Extractor** — structured JSON extraction from logs, HTML, PDFs
- **Draft/Critic** — generate cheap first drafts locally; Claude refines (slider-gated)
- **Reranker** — cross-encoder rerank of RAG hits before sending to Claude

Runtime — **DECIDED (v0.2): Ollama-first behind an OpenAI-compatible interface.** EOL talks to local models via the OpenAI-compatible chat/embeddings protocol; Ollama is the blessed default backend (dev-familiar, one-line install, manages model pulls and quantization, CUDA + Apple Metal). Anything speaking the same protocol — llama.cpp server, LM Studio, vLLM — is a drop-in swap via config. Bundled llama.cpp is a v2 fallback for zero-dependency installs; vLLM is opt-in only (Linux/CUDA, serving-scale benefits irrelevant to a single dev). Model catalog auto-selected per node: ~3–4B on P-min, 7–8B on P-mid, 14B on P-max, all quantized (Q4–Q5 default).

### 3.4 Caching & dedup
- **Exact response cache** — hash(request) → response, TTL-configurable.
- **Semantic cache** — embed the query; if cosine sim > threshold to a prior query, offer cached answer (slider-gated; high slider = strict threshold or off).
- **Tool-result cache** — repeated `read_file`/`grep`-style results in agentic loops served from cache with mtime invalidation.

### 3.5 Additional offload candidates (per your ask)
- **Media pre-processing:** local Whisper for audio→text; local OCR/vision captioning so images/PDFs arrive as compact text, not costly image tokens.
- **Local code execution & test running:** run tests/linters locally, send Claude the condensed failure digest instead of full output.
- **Git-aware context:** send diffs/summaries of changes rather than full files; local commit-history summarization.
- **Speculative prefetch:** while Claude responds, pre-index/pre-embed files it will likely request next.
- **Artifact/output storage:** large generated outputs stored locally, referenced by link, not re-sent each turn.
- **Session memory:** long-term project memory in the local vector DB — recall via search instead of resending history.
- **Batch/off-peak queueing:** non-urgent jobs queued to Anthropic Batch API (50% cost) — an offload in time rather than space.

---

## 4. Quality/Savings Slider

Global setting 0–5 with per-capability overrides. Every lossy operation declares its slider gate.

| Level | Behavior |
|---|---|
| 0 — Passthrough | Redaction only. No token reduction. Baseline for evals. |
| 1 — Lossless | Dedup, structural compaction, cache alignment. **Zero quality risk.** Default. |
| 2 — Conservative | + tool-result caching, log condensation, RAG replaces bulk file dumps when confidence high |
| 3 — Balanced | + semantic compression of stale context, semantic cache (strict threshold), local extraction |
| 4 — Aggressive | + local drafts for Claude to refine, looser semantic cache, heavier summarization |
| 5 — Max savings | + local LLM answers simple queries entirely; Claude only for hard tasks |

**Design rule:** everything lossy is *reversible* — originals retained locally; Claude can request expansion via MCP when it detects it's missing context.

### Quality guardrails
- **Eval harness:** replay a recorded task suite at each slider level; score with an LLM judge (Claude, sampled) + task success metrics; publish tokens-saved vs. quality-delta curves.
- **Canary mode:** N% of requests sent both compressed and raw; responses compared to detect regressions.
- **Per-request escape hatch:** header/flag `x-eol-bypass: true`.

---

## 5. Telemetry & UX
- Dashboard (local web UI): tokens saved/spent, cache hit rates, cost estimate, per-stage savings attribution, per-device utilization, quality-delta from canary runs.
- CLI: `eol status`, `eol devices`, `eol index <path>`, `eol slider 3`, `eol replay-eval`.

### 5.1 Claude-style slash commands & configuration (v0.6)
`eol init` installs EOL commands into Claude Code following its native conventions, so control never requires leaving the session:

| Command | Action |
|---|---|
| `/eol:slider <0-5>` | Set quality/savings level (session-scoped) |
| `/eol:index <path>` | Ingest a directory/file into the knowledge base |
| `/eol:search <query>` | Explicit federated search (knowledge + memory) |
| `/eol:stats` | Tokens saved, cache hits, per-stage attribution |
| `/eol:expand <ref>` | Retrieve an original from the CCR store |
| `/eol:bypass` | Disable all lossy stages for the next request(s) |
| `/eol:devices` | Show local + LAN worker capability/status |
| `/eol:delegate <task>` | Route a subtask to a local model explicitly |

Mechanism: MCP prompts (surfaced by Claude Code as `/mcp__eol__...` slash commands) plus project command files installed under `.claude/commands/` for ergonomic short names. **Verify against current Claude Code docs at build time** — command file format and MCP-prompt surfacing have evolved across releases. **[VERIFIED v1.1 (T0.1, 2026-07-03): colon names like `/eol:slider` are not supported; short names install as directory-namespaced skills `.claude/skills/eol/<cmd>/SKILL.md` → `/eol/<cmd>`. Read every `/eol:<cmd>` in this spec as `/eol/<cmd>`. See Decision 14 and verification-notes.md §10–11.]**

Configuration mirrors Claude Code's hierarchy: `~/.eol/settings.json` (user) → `<project>/.eol/settings.json` (project, committable) → `<project>/.eol/settings.local.json` (personal, gitignored) → env vars → per-request headers. `eol init` also appends EOL usage guidance to the project's CLAUDE.md (coordinated with `headroom learn`'s writers, per §1.2).

## 6. Tech Stack (decided — REVISED v1.2 per Decisions 16–18)
- **Language:** **TypeScript** (Node ≥ 22, ESM; Fastify or equivalent for the proxy HTTP layer) — user decision, see Decision 16. Distributed via npm (`npx eol init`); single-binary packaging (`bun build --compile`) is a later optimization. ~~Python (FastAPI), uvx/pipx~~
- **Compression:** **EOL-native TS lossless stage** (dedup, compaction, cache alignment, CCR) behind the `CompressionService` adapter for P0; optional pinned Headroom **Python sidecar** for ML-heavy stages at slider ≥3 (Decision 18). EOL owns the proxy process
- **Vector DB:** embedded TS-native store by default (**LanceDB candidate**, Decision 17); Qdrant server mode optional via config URL; one collection/table per project
- **Inference:** Ollama default backend behind an OpenAI-compatible interface (llama.cpp server / LM Studio / vLLM drop-in via config) — unchanged
- **Embeddings/rerank:** served via Ollama where available; ONNX-runtime (node) or transformers.js as CPU fallback; cross-encoder reranker on GPU — WS-C/WS-D validate
- **MCP:** official **TypeScript** MCP SDK (`@modelcontextprotocol/sdk`) — stdio + streamable HTTP transports; one EOL server exposing both EOL tools and re-exported Headroom tools
- **Cache/metadata store:** SQLite (`node:sqlite` / better-sqlite3) + content-addressed blob dir (aligned with Headroom's CCR store)
- **Code parsing:** tree-sitter via WASM bindings (web-tree-sitter) or native prebuilds — WS-C picks in C2 (cross-platform prebuilds are the constraint)

## 7. Phased Roadmap
- **P0 — Foundation:** `eol init` installs the EOL service (proxy owning the request path, Headroom as embedded library) for Claude Code + registers the unified MCP server and `/eol:*` commands; redaction pre-stage, slider levels 0–2, savings dashboard, 3-OS CI. *Mostly integration work, not compression R&D.*
- **P1 — RAG (first big differentiator):** Qdrant indexing (tree-sitter code chunks + docs), GPU embeddings, reranking, MCP tools `index_path` / `search_local` / `get_chunk`, file watchers; teach Claude via CLAUDE.md guidance that `eol init` installs ("prefer search_local over bulk file reads").
- **P2 — Local LLM delegation:** Ollama detection + tiered model catalog; summarizer/extractor/classifier tools; semantic compression; slider levels 3–4; local test/lint execution → failure digests.
- **P3 — Assistant depth:** git-aware context tools, Whisper/OCR preprocessing, speculative prefetch, session memory beyond Headroom's, level 5 (per-project opt-in).
- **P4 — Fleet (optional module):** device registry, scheduler, LAN workers for devs with a spare GPU box; canary quality evals.

## 8. Risks & Mitigations
| Risk | Mitigation |
|---|---|
| Compression removes context Claude needed | Reversibility + MCP expansion tool + canary evals |
| Local LLM quality too low on small GPUs | Tier routing; fall back to Haiku or skip stage |
| Proxy breaks streaming/tool-use semantics | Pass through SSE untouched at level ≤1; extensive contract tests against real API shapes |
| Prompt-cache interference (edits break prefix stability) | Cache-alignment stage explicitly optimizes for prefix stability |
| Semantic cache serves stale/wrong answers | Strict thresholds, TTL, slider-gated, never for tool-use requests |
| LAN security (prompts traverse network) | mTLS between hub/workers; redaction before transit; localhost-only default |

## 9. Decisions Log & Remaining Items

### Decided
1. **Build on `headroom-ai`** for compression/proxy/CCR; EOL differentiates on agentic developer-assistant capabilities (v0.3). **Integration is library-mode behind a `CompressionService` adapter — no fork, no extraction, no proxy-chaining; unified MCP namespace (v0.4, see §1.2).**
2. **Memory architecture (v0.5, reverses part of v0.4):** adopt Headroom's conversational memory on its **Qdrant backend**; EOL builds the **document knowledge base** (guides/wikis/codebases) in the same Qdrant instance; `search_local` federates both. Evaluate Headroom's `--code-graph` before building a code indexer from scratch.
3. **Qdrant** — embedded local mode default, per-project collections (v0.3, user decision).
4. **Python** implementation, `uvx` distribution (v0.3).
5. **Ollama-first** runtime behind OpenAI-compatible interface (v0.2).
6. **Models per tier (advisory — re-verify current best at build time):** ~4B-class instruct on P-min, ~8B-class on P-mid, ~14B-class on P-max (Qwen/Llama/Gemma families, Q4–Q5); multilingual embedding model (bge-m3 class) + cross-encoder reranker (bge-reranker-v2 class), all pullable via Ollama/HF.
7. **Level-5 local-only answers: per-project opt-in**, never global default.
8. **MCP exposes the slider**: `eol_set_slider` (session-scoped) + `eol_stats`, so Claude can request more context fidelity mid-task and report savings.
9. **OS support (REVISED v0.6): Windows, macOS, and Linux natively from P0** — no WSL requirement; 3-OS CI matrix; `platformdirs` for config/cache paths; Ollama native builds on all three.
10. **Claude Code hooks complement the proxy:** a PostToolUse-style hook compresses/swaps oversized tool outputs for CCR refs before they enter context (the proxy can't shrink what's already in the client's transcript); the proxy handles everything request-level.
11. **Claude-style UX (v0.6):** `/eol:*` slash commands via MCP prompts + `.claude/commands/` files; settings.json hierarchy (user → project → local → env → per-request) mirroring Claude Code conventions.
12. **LAN lab offload (v0.6):** all backing services (inference, Qdrant, blob store) URL-addressable from P0 so manual offload to lab hardware is config-only; P4 adds discovery/scheduling; S3-compatible blob backend for NAS storage.
13. **Headroom memory backend (v1.1, 2026-07-03, revises the Qdrant detail of Decision 2 after T0.1 live verification):** Headroom memory has **no Qdrant backend** — `HEADROOM_QDRANT_*` does not exist; its store is embedded SQLite + HNSW + FTS5. EOL adopts Headroom memory **on its own embedded backend**, and `search_local` federates across **two stores** (EOL's Qdrant knowledge collections + the Headroom memory API), merged and reranked. The rest of Decision 2 (division of labor, federation, `--code-graph` evaluation) stands. Note: Headroom's `[memory]` extra pulls sentence-transformers (torch), so memory-backed features ship under EOL's `[ml]` extra. See verification-notes.md C1.
14. **Slash-command surface (v1.1, revises §5.1 naming after T0.1):** current Claude Code does not support colon-namespaced command names; namespacing is directory-based skills. EOL installs `.claude/skills/eol/<cmd>/SKILL.md` → **`/eol/<cmd>`** (e.g. `/eol/slider 3`), plus MCP prompts surfacing as `/mcp__eol__<cmd>`. All `/eol:*` spellings in this spec are to be read as `/eol/<cmd>`. See verification-notes.md C2.
15. **Headroom pin & compressor defaults (v1.1):** *(pin now applies to the Headroom TS SDK per Decision 16/18; the 0.28.0 Python pin below documents the pre-pivot state)* `headroom-ai[code]==0.28.0` (PyPI latest 2026-06-29; 0.29.0 imminent — upgrades only via T-C4). The §1.2 "Kompress ONNX INT8" claim is unconfirmed: Kompress is a torch-requiring HF model under Headroom's `[ml]`; EOL's default install relies on Headroom's non-ML compressors (SmartCrusher / TextCrusher / code / CCR). Headroom base deps include `litellm` (heavier than spec assumed — accepted). See verification-notes.md C3/C4.
16. **Implementation language: TypeScript (v1.2, 2026-07-03, USER DECISION — supersedes the "Python" part of Decision 4 and §6).** Rationale: maintainer fluency (TS is the user's primary language); the official MCP TypeScript SDK is the most mature; Claude Code's own ecosystem (skills, hooks, `.claude/` assets) is TS-native; Headroom ships a TypeScript SDK (parity verification in progress — see Decision 18); performance was not decisive since the proxy hot path is I/O-bound SSE forwarding and Headroom's compression core is Rust regardless of caller. Distribution: npm — `npx eol init` replaces `uvx eol init` everywhere in this spec; a single-binary build (`bun build --compile`) is a later packaging optimization. Tooling: Node ≥ 22, ESM, `tsc --strict`, Biome, vitest, zod at boundaries. `uv`/`uvx` mentions elsewhere in this spec are historical.
17. **Embedded vector store (v1.2, revises the "embedded" half of Decision 3):** Qdrant's zero-install embedded local mode is a **Python-client-only** feature, unavailable from TypeScript. Default local store becomes an embedded TS-native engine — **LanceDB is the leading candidate** (WS-C task C1 validates with a spike + decision memo in verification-notes.md; sqlite-vec is the fallback candidate). Qdrant **server** mode remains fully supported via config URL for bigger indexes and LAN/NAS offload (Decision 12 unchanged). The `KnowledgeBase` interface is store-agnostic, so this is contained to WS-C.
18. **Headroom integration in TypeScript (v1.2 FINAL, 2026-07-03, verified — partially revises Decision 1's "embed as library"):** T0.1b verification found the `headroom-ai` npm package (0.22.4) is a **thin HTTP client to the Python proxy — it contains no compression logic**; memory, MCP server, and all compressors are Python-only (verification-notes.md §16). Embedding Headroom as a TS library is impossible. Therefore:
    - **P0: EOL-native TypeScript lossless stage** behind the `CompressionService` adapter — dedup, structural/JSON compaction, tool-result caching, cache-prefix alignment, and the CCR store (SQLite + content-addressed blobs). These are Headroom's non-ML parts; slider levels 0–2 need nothing more. The default install stays pure TS/Node — no Python requirement, preserving the `npx eol init` zero-friction story.
    - **P2+: optional Headroom Python sidecar** for ML-heavy semantic compression (SmartCrusher heuristics, Kompress-class models) at slider ≥3: EOL detects/installs `headroom-ai[proxy]` (pinned; Python 0.28.0 at verification time) and spawns/manages `headroom proxy` as a child worker behind the same adapter; the pinned `headroom-ai` npm client (0.22.4) becomes the typed transport. Graceful degradation: no Python → slider ≥3 semantic stages fall back to EOL's tiered local LLM (Ollama) or stay off.
    - Headroom conversational memory (Decision 13) is likewise Python-only → MEMORY-scope federation moves behind the optional sidecar; `search_local` degrades to KNOWLEDGE-only without it.
    - Consequence for Decision 1: "build on headroom-ai" narrows to "adopt Headroom's *architecture* (CCR, cache alignment, content-aware routing) and interoperate with its sidecar for ML stages"; upstream generic improvements where possible.
19. **Project name: Golem (v1.3, 2026-07-03, USER DECISION).** Renamed from "EOL / Edge Offload Layer"; the domain **golem.run** is registered for onboarding new users and documentation. Concrete renamed surfaces (all previously "eol"-prefixed forms are dead — nothing has shipped, so no aliases or migration shims):
    - npm package **`golem-run`** (bare `golem` is npm-squatted since 2022; `golem-run` matches the domain), CLI binary **`golem`**, onboarding command **`npx golem-run init`**.
    - MCP: server registered as `golem`; frozen tool names `golem_search`, `golem_get_chunk`, `golem_index_path`, `golem_expand`, `golem_stats`, `golem_set_slider`, `golem_delegate`, `golem_devices`; prompts surface as `/mcp__golem__<prompt>`.
    - Skills: `.claude/skills/golem/<cmd>/SKILL.md` → `/golem/<cmd>` (per Decision 14 naming rules).
    - Config: `~/.golem/settings.json` → `<project>/.golem/settings.json` → `<project>/.golem/settings.local.json`; env prefix `GOLEM_<SECTION>_<KEY>`.
    - Per-request escape hatch header: `x-golem-bypass`.
    - CLI verbs unchanged in shape: `golem status|slider|stats|index|devices|init|uninit`.

### To verify against live docs before P0 — ✅ RESOLVED 2026-07-03 (task T0.1)
All four items verified; dated findings with URLs live in `verification-notes.md`. Summary:
- Claude Code hook events/schema and `claude mcp add` syntax: captured (notes §8–§9). PostToolUse **can** replace tool output via `updatedToolOutput` — Decision 10 confirmed feasible.
- `headroom wrap claude`: launches Headroom's own proxy — **conflicts with the EOL-owned proxy; mutually exclusive.** `eol init` must detect and refuse (notes §5).
- Headroom config surface: per-stage typed config objects (`SmartCrusherConfig`, `CacheAlignerConfig`, `RollingWindowConfig`, `IntelligentContextConfig`, …) — the slider mapping target (notes §3).
- Prompt caching: byte-identical prefix, tools→system→messages hierarchy, 4 breakpoints, workspace-scoped. Binding rule: re-compression of previously-sent turns must be byte-stable (notes §14).
