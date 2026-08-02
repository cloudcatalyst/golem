# Golem Implementation Plan — workstream & interface reference

Companion to `docs/golem-spec.md`. P0/P1 shipped; the forward-looking view is
`ROADMAP.md` (generated index over `plan/tasks/`, Decision 55). Shipped history
is `SHIPPED.md`; completed batch briefs retired to git history.

> **Status (2026-07-16, Decision 36):** P0, P1, R1–R3 shipped (886 tests).
> The roadmap is refocused on the co-developer core (R4); autonomy and
> multi-provider/remote work (R5/R6) on hold.

## Ground rules

1. **Spec is authoritative.** If implementation reveals the spec is wrong, stop and flag it — update the Decisions Log in the same PR.
2. **Verify before building on external facts.** Live docs: docs.claude.com (Claude Code hooks, skills, MCP), headroom-docs.vercel.app + GitHub. Record dated findings in `docs/plan/verification-notes.md`.
3. **Contracts frozen once merged.** `src/interfaces/` changes need contract-test updates first + cross-workstream flag.
4. **Cross-platform every PR:** `node:path`, `env-paths`, argument-array spawn. CI matrix (ubuntu/macos/windows) must pass.
5. **Headroom pinned exactly.** Upgrades via T-C4 playbook only.
6. **Test-first for contracts.** Every interface ships with contract tests before implementations.

## Repository layout (key paths)

```
golem/
├── CLAUDE.md
├── docs/
│   ├── golem-spec.md            # spec + Decisions Log
│   ├── plan/                    # ROADMAP.md, tasks/, SHIPPED.md, BACKLOG.md, proposals/
│   └── wiki/                    # project wiki (Decision 28)
├── src/
│   ├── interfaces/              # frozen contracts
│   ├── proxy/                   # Anthropic-compatible proxy
│   ├── pipeline/                # redaction → compression → forward
│   ├── compression/             # native lossless + Headroom adapter
│   ├── mcp/                     # unified MCP server
│   ├── knowledge/               # vector KB
│   ├── wiki/                    # wiki store
│   ├── inference/               # Ollama client, catalog, bootstrap
│   ├── hooks/                   # Claude Code hooks (CCR swap, guidance, WebFetch cache)
│   ├── cli/                     # golem init/status/index/… (commander)
│   ├── config/                  # settings hierarchy loader
│   └── telemetry/               # savings attribution
└── tests/
    ├── contract/                # interface contract tests
    ├── integration/             # proxy round-trip vs recorded shapes
    └── e2e/                     # golem init → Claude Code smoke
```

## Frozen interfaces

Actual TypeScript files in `src/interfaces/` are authoritative. Key contracts:

- **CompressionService** (`interfaces/compression.ts`): compress, retrieve, stats. Headroom adapter only (`compression/headroom-adapter.ts`); pins in `src/compression/index.ts`.
- **InferenceService** (`interfaces/inference.ts`): chat + embed + capabilities(). Role→model from catalog, tier-detected.
- **KnowledgeBase + FederatedSearch** (`interfaces/knowledge.ts`): ingest, search (MEMORY→Headroom), getChunk.
- **SliderPolicy** (`interfaces/policy.ts`): level 0–3 table (Decision 30). 0 = passthrough (redaction off, loud warning). 1 = lossless. 2 = balanced (lossy). 3 = aggressive (lossy). Levels ≥2 gated OFF on caching upstreams (Decision 31).
- **MCP surface** (Decisions 27/35): tools `search`, `fetch`, `ingest`, `expand`, `stats`, `level`, `coder`, `devices`, `snooze`, `wiki_read`, `wiki_upsert`, `code`. Prompts → slash commands. Skills → `/golem/*`.

## Known unknowns

- Headroom sidecar version handshake (npm ↔ PyPI) — revisit at each T-C4 upgrade
- R1.6: macOS/Linux Ollama setup rows unrun (no non-Windows hardware tested)
- Decision 33 confidence calibration — needs human-reviewed served answer

## Future workstreams (WS-F → ROADMAP crosswalk)

Each maps to a numbered task doc in `plan/tasks/`. Run `golem task index --summary` for current status.

| ID | Feature | → ROADMAP | Depends on |
|---|---|---|---|
| WS-F1 | Durable task queue & auto-resume | R5.1 | device/job scheduler, worktree state capture |
| WS-F2 | Task queue + local conversation multiplexing | R5.3 | InferenceService, slider |
| WS-F3 | Self-hosted remote session | R6.3 | auth + relay, Decision 12 LAN, threat model |
| WS-F4 | Cruise-control autonomy modes | R5.4 | MCP surface, approval gates |
| WS-F5 | Tiered shared standards & knowledge | ✅ user/local shipped; hosted P4+ | KB federation, config hierarchy |
| WS-F6 | Idea/note capture → project context | ✅ shipped; planning loop → R4.1 | ingest, distill |
| WS-F7 | Writing-style adaptation | R5.5 | telemetry scoring, local LLM, memory |
| WS-F8 | Parallel convos + model escalation | R5.3 / R6.2 | WS-D routing, WS-F1 task queue |
| WS-F9 | Remote monitoring / permission-granting | R6.3 | auth+relay, notification hooks; **security-critical** |
| WS-F10 | Dashboard-as-sidecar | R5.2 | dashboard, status-line hook |
| WS-F11 | Account switching | R6.2 | proxy credential routing, secure store; **ToS review** |
| WS-F12 | Multi-LLM concurrency & quota routing | R6.2 | WS-F8/F11; **ToS review** |
| WS-F13 | Cost-governance goals & benchmarks | R6.4 | telemetry, hooks, WS-D |
| WS-F14 | Provider-agnostic pipeline (Foundry/OpenRouter) | R6.1 | upstream-adapter layer; gated on memo + explicit ask |