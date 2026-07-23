---
title: R6 — Multi-provider & remote batch retrospective
type: synthesis
tags: [r6, retrospective, multi-provider, proxy, providers, accounts, tos]
sources: [docs/plan/proposals/r6-multi-provider-remote-memos.md, docs/wiki/decisions/ADR-0003-credential-storage-and-account-routing.md, docs/wiki/debriefs/2026-07-23-R6.4.md, docs/wiki/debriefs/2026-07-23-R6.1a.md, docs/wiki/debriefs/2026-07-23-R6.1b1.md, docs/wiki/debriefs/2026-07-23-R6.1b2.md, docs/wiki/debriefs/2026-07-23-R6.1b3.md, docs/wiki/debriefs/2026-07-23-R6.1b4-gemini.md, docs/wiki/debriefs/2026-07-23-R6.2-account-switching.md, docs/plan/verification-notes.md]
created: 2026-07-24
updated: 2026-07-24
---

# R6 — Multi-provider & remote (batch retrospective)

R6 was `⛔ ON HOLD` (Decision 36). The user lifted it and drove the whole
buildable release in one long session (2026-07-23), starting from a written
design-memo gate (`proposals/r6-multi-provider-remote-memos.md`) and proceeding
task-by-task with a checkpoint before each large or gated slice. **Ten PRs
(#31–#40)**; suite **1159 → 1237 green**; **no frozen `src/interfaces/` change**
and the **Anthropic byte-faithful path untouched** throughout.

| # | What | Debrief / record |
|---|---|---|
| R6.4 | `golem bench cost` — cost-governance benchmark over existing telemetry | [[R6.4 — Cost-governance benchmark (golem bench cost)]] |
| R6.1(a) | Front Anthropic-**protocol** gateways (Azure Foundry / OpenRouter / custom): provider selector + auth mapping + Claude-via-Azure caching fix | [[R6.1 case (a) — Anthropic-native upstream gateways]] |
| R6.1(b1) | Non-streaming Anthropic↔OpenAI translation + the response-transform seam | [[R6.1 case (b) b1 — OpenAI-schema translation (non-streaming) + response-transform seam]] |
| R6.1(b2) | SSE streaming translation (OpenAI deltas → Anthropic events) | [[R6.1 case (b) b2 — streaming translation (OpenAI SSE → Anthropic events)]] |
| R6.1(b3) | Tool-use mapping (`tool_use`↔`tool_calls`, streaming `input_json_delta`) | [[R6.1 case (b) b3 — tool-use translation (tool_use ↔ tool_calls)]] |
| R6.1(b4) | OpenAI provider functional (no new code) + Gemini `generateContent` translator | [[R6.1 case (b) b4-gemini — Google Gemini generateContent translator]] |
| R6.2 | Account switching: registry + `active_account` + `golem account`, gated by [[ADR-0003 — R6.2 credential storage, account switching & multi-provider routing]] | [[R6.2 v1 — account switching (multi-account/provider selection)]] |

## What R6 delivers

Claude Code can now run against **Anthropic (default, byte-faithful), Azure
Foundry / OpenRouter-Anthropic, OpenAI, Ollama (local & LAN), or Gemini** — by
setting `proxy.upstream_provider` (+ `upstream_base_url`/`upstream_model` and a
credential), or by defining `proxy.accounts` and `golem account use <id>`. The
cost benchmark (`golem bench cost`) measures Golem's own savings against the
re-verified cost-doc baselines.

## Through-lines

1. **Verify before building.** Every provider's wire protocol was checked against
   live docs first and recorded dated: gateway protocols (§73), the cost doc
   (§72), Gemini's `generateContent` API (§77). The Gemini build only started
   after its API was verified — the CLAUDE.md rule paid off (Gemini's auth is a
   query param, not a header, which reshaped the seam).
2. **The response-transform seam is the one real architectural addition.** The
   proxy was a byte-faithful passthrough with *no* response seam by design.
   Case (b) added `translateUpstream` — the only path that parses/reserializes a
   response — kept strictly opt-in and **never active on the Anthropic path**.
   Two provider families (OpenAI Chat Completions; Gemini) plug into it; the
   seam grew a per-request `path` override for Gemini's model-in-path + `?key=`.
3. **Honesty rails.** A translated response reports the **real serving model**,
   never a `claude-*` name; the status surfaces show the **active provider/
   account** (not a stale base URL); the cost benchmark is scoped as Golem's own
   contribution, not a `/usage` replacement.
4. **Security/ToS gated by an ADR, decided by the user.** R6.2 shipped only the
   half the user's ToS decision approved — **legitimate account switching**;
   automated quota-evasion is OUT. Secrets are env-only (never a setting, no
   plaintext-on-disk); selection is fail-closed and audit-logged; no tool surface
   touches credentials (ADR-0003, inheriting ADR-0002's posture).
5. **Live where possible, honest where not.** Ollama (local) gave a
   credential-free live path — non-streaming, streaming, and account-routed were
   all live-verified (§74/§75/§78). OpenAI, Gemini, and the Anthropic-native
   gateways are unit- + integration-verified; a real cloud end-to-end check needs
   the user's keys (recorded as the remaining R6.1 verification, like R7.3's
   binaries).

## Honest gaps / what's NOT done

- **Live cloud unverified** — OpenAI/Gemini/Azure-Foundry need real keys (user-side).
- **Tool-use is unit-verified, not live** — the local Ollama model returned tool
  calls as *text*; OpenAI (native `tool_calls`) is the backend that will confirm
  the b3 path.
- **21e per-request routing** (route by capability/availability) + route-on-
  exhaustion — deliberately OUT of R6.2 v1; each needs its own decision (and
  route-on-exhaustion is ToS-adjacent). One active account per proxy run today.
- **R6.3 companion app** — deferred by the user; the highest-severity surface
  (remote approval = remote code execution), needs its own threat-model ADR
  before any code.
- **OS-keychain credential backend** — env-var-first shipped; keychain is a
  verified-future option (needs a light cross-platform mechanism first).
- **R2.6 live A/B** — now *possible* on a real non-caching upstream (OpenAI/
  Ollama), still not run.

## The recurring flake (not R6)

Across full-suite runs, `cli-init.test.ts > golem init idempotent` failed
intermittently under parallelism (§68-class Windows fs concurrency) and was
**green standalone every time** — unrelated to R6 (which touches
`src/providers/` + the proxy seam, not init/file-watching). Worth a real fix
someday, but not an R6 regression.

## State

R6.1 (a+b), R6.2 (account switching), and R6.4 are shipped and merged. R6.3 stays
deferred; 21e routing stays a future decision. The WS-F↔ROADMAP crosswalk and
the full Decisions-Log rationale remain authoritative (`IMPLEMENTATION_PLAN.md`
§6; `docs/golem-spec.md` Decisions 21/22/32).

Related: [[Redaction Stage]] (runs before any translation — more valuable
fronting a third party), [[Compression]] (why the caching classification gates
the lossy stage per provider).
