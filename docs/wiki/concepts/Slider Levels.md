---
title: Slider Levels
type: concept
tags: [pipeline, slider, compression, redaction, decision-30, decision-31]
sources: [src/interfaces/policy.ts, docs/golem-spec.md, docs/plan/verification-notes.md#§69c]
created: 2026-07-17
updated: 2026-07-17
---

# Slider Levels

Golem's **slider** is a single global dial (0–3) that sets how aggressively the
pipeline compresses a request. It is *only* a compression-aggressiveness dial
(Decision 31): it never engages the local model — that happens solely via the
explicit `coder` MCP tool. The four levels (simplified from an older 0–5 scale by
Decision 30) map to per-stage switches in the frozen `SliderPolicy` contract
(`src/interfaces/policy.ts`, `LEVEL_TABLE`):

| Level | Name | What runs |
|---|---|---|
| **0** | `passthrough` | **Nothing — not even redaction.** A deliberate, byte-faithful full bypass. |
| **1** | `lossless` | Redaction + byte-faithful lossless dedup/compaction/cache-align. **Default.** |
| **2** | `balanced` | + lossy semantic compression (stale-turn drop) + strict semantic cache. |
| **3** | `aggressive` | + max semantic compression + loose semantic cache. |

Each level is additive — a higher level runs everything the lower one does, plus more.
The `*` stages are lossy and engage **only on non-caching upstreams** (see
[[Compression]]); on Anthropic's cached traffic they are gated off, so levels 2–3
behave like level 1. For how these stages sit in the full request path, see
[[Architecture]].

```mermaid
flowchart TB
  L0["Level 0 · passthrough"] --> N["Nothing runs — redaction OFF (warned loudly)"]
  L1["Level 1 · lossless (default)"] --> S1["Redaction + lossless<br/>dedup · compaction · cache-align"]
  L2["Level 2 · balanced"] --> S2["L1 + lossy semantic* + strict semantic cache*"]
  L3["Level 3 · aggressive"] --> S3["L2 + max semantic* + loose semantic cache*"]
```

## Level 0 is the one place redaction is off

Redaction is mandatory and un-weakenable at **every level ≥ 1** — it always runs
first, before any content is transformed, stored, or forwarded (a CLAUDE.md hard
rule; see [[Redaction Stage]]). **Level 0 (`passthrough`) is the single deliberate
exception** (Decision 30, a USER decision): secrets/PII reach the upstream raw, so
it is a conscious opt-out equivalent to not using the proxy at all. It is never
the default and is surfaced loudly wherever active (`golem slider 0`, `status`,
the statusline, and the `level`/`slider`/`bypass` MCP surfaces all warn that
redaction is off).

## Levels 1–3 are byte-fidelity → savings trade-offs

Level 1 is byte-faithful (lossless only) and is the default. Levels 2–3 add lossy
semantic compression, which only pays on non-caching upstreams — see
[[Compression]] for why higher levels give ~0% honest savings on Anthropic's
cached traffic. The exact per-stage config is the authoritative `LEVEL_TABLE` in
`src/interfaces/policy.ts`; this page is the conceptual summary, not a
duplicate of that table.

See also [[Compression]], [[Redaction Stage]], and [[Wiki-First Knowledge]].
