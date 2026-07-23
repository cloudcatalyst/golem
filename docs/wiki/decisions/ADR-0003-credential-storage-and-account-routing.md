---
title: ADR-0003 — R6.2 credential storage, account switching & multi-provider routing
type: adr
tags: [r6, security, credentials, routing, tos, threat-model]
sources: [docs/plan/proposals/r6-multi-provider-remote-memos.md, docs/golem-spec.md, docs/plan/verification-notes.md]
created: 2026-07-23
updated: 2026-07-23
---

# ADR-0003 — R6.2 credential storage, account switching & multi-provider routing

**Status: ACCEPTED (2026-07-23, USER decision).** This is the written threat
model + ToS review that gated R6.2 code (the standing WS-F rule; the same
"threat model reviewed before enforcement code" bar ADR-0002 set for R5.4).
**ToS scope decision (USER, 2026-07-23): "legitimate account/provider switching
only" — the automated quota-evasion half is OUT (not built).** R6.2 v1 (explicit
account switching) is built against these constraints; per-request
capability/availability routing (21e) and any route-on-exhaustion behaviour stay
out of scope pending a separate decision.

## Context

R6.2 = spec **21d** (account switching: hold several credentials, pick one per
request/policy) + **21e** (multi-LLM/quota routing: route by
cost/quota/capability/availability). The proxy already owns the request path and,
after R6.1, can front Anthropic-native and translated (OpenAI/Ollama/Gemini)
upstreams — so it is the natural place to select `(provider, account)` per
request. But R6.2 introduces the one thing R6.1 deliberately avoided: **Golem
custodying multiple provider secrets**. R6.1's single upstream key is an env var
(`GOLEM_UPSTREAM_API_KEY`) precisely to keep that surface minimal; R6.2 must
generalize it without creating a plaintext-secret store or a ToS-violating
feature.

Two gates dominate, and both are load-bearing:

### Gate 1 — ToS (USER decision; the crux)

There are two very different features hiding under "account/quota routing", and
they must not be blurred:

- **Legitimate account switching (defensible).** Selecting among the user's OWN,
  separately-legitimate accounts by an explicit policy — personal vs work, a
  per-project billing account, an org workspace vs a personal key, or routing a
  request to a *different provider* the user pays for. This is ordinary
  multi-account/multi-provider config. **Recommended IN scope.**
- **Quota arbitrage to evade limits (ToS-risky).** Automatically rotating across
  accounts / free tiers to circumvent a provider's rate limits or to get more
  than a single account's terms allow. Anthropic, OpenAI and Google all prohibit
  circumventing rate limits and creating/using multiple accounts to exceed
  quotas. Decision 21d/21e flag this explicitly. **Recommended OUT of scope /
  rejected** — Golem must not *design* an evasion mechanism (e.g. auto-rotate-on-
  429-to-dodge-the-limit). Routing away from an *exhausted* account to another
  legitimate one the user chose is a grey area the user must rule on; the safe
  default is **manual/declared** account choice, never automated limit-evasion.

**Decision needed from the user:** confirm scope = *legitimate account/provider
switching only* (recommended), explicitly excluding automated quota-evasion. The
design below assumes that answer; a different answer changes what is built.

### Gate 2 — credential storage (this threat model)

Multiple provider secrets is a new, high-value target. The invariants:

## Decision (recommended, contingent on the ToS answer)

### Scope
- **IN:** a multi-account **credential registry** (account id → provider +
  secret *reference*, never the secret inline); explicit **account/provider
  selection** by a declarative, user-authored policy; routing by
  capability/availability/explicit choice; an **audit log** of every selection;
  fail-closed behaviour.
- **OUT (not built):** automated quota-evasion / limit-circumvention rotation;
  any routing whose *purpose* is to exceed a provider's terms. If a
  route-on-exhaustion feature is ever wanted, it is a separate, explicitly-ToS-
  reviewed decision.

### Credential storage — invariants (the threat model)
1. **Secrets are never a setting.** No credential value in `settings.json`, the
   committed tree, `.golem/` synced state, logs, telemetry, the wiki, the CCR
   store, or any redaction-eligible surface. Settings hold only a non-secret
   account *identity* + a reference to where the secret lives.
2. **Storage mechanism — env-var-first (v1).** Generalize the existing
   `GOLEM_UPSTREAM_API_KEY` to a per-account env var
   (`GOLEM_UPSTREAM_API_KEY_<ACCOUNT>`), resolved at proxy start. Rationale: no
   new dependency (CLAUDE.md: no heavyweight native deps) and **no plaintext
   secret written to disk**. A gitignored `.golem/credentials.json` is
   **rejected for v1** — plaintext-on-disk is a worse posture than env. An OS
   keychain (macOS Keychain / Windows Credential Manager / libsecret) is a
   **verified future option** only if a light, cross-platform mechanism is
   confirmed (verification-notes item required first).
3. **Fail-closed.** An unknown/missing credential for the selected account →
   a clear error (or the existing "forwarding client's own auth" warning path),
   **never a silent fall-back to a different account** (that would spend on the
   wrong account and could mask an evasion). Missing policy → the current single
   `upstream_provider` behaviour, unchanged.
4. **No tool can read/write credentials.** No MCP surface sets or returns a
   secret or selects an account; only explicit CLI/config. Mirrors ADR-0002's
   "level cannot be set from within a tool call".
5. **Audit log.** Every `(request → account, provider, reason)` selection is
   appended to `.golem/state/` (like the autonomy log) — attribution is a
   security property; a compromised or misrouted request must be traceable.
6. **Redaction & fidelity untouched.** Routing/credential selection is a
   transport concern; it never transforms request/response content, and the
   Anthropic byte-faithful path is unaffected (as R6.1's auth-mapping already is).

### Routing correctness rail (21e)
Routing **must never silently degrade output** (Decision 21e). Models differ in
capability, tool-use format, and context limits; a route that cannot faithfully
serve the turn must be **visible/attributed**, not a silent swap — the same rail
R6.1 case (b) established (the response reports the real serving model, never a
Claude name). Auto-escalation/handoff across models (21a) is a **dependency, not
in this scope**.

## Threat model & default-safe proofs (to be met by the build)
- **Credential exfiltration surface.** Secrets only in env / (future) keychain;
  settings/logs/telemetry/wiki carry references, not values. A dump of any
  committed or synced file leaks no secret.
- **Wrong-account spend.** Fail-closed selection + audit log: a request is served
  by the explicitly-selected account or errors; it is never silently rerouted.
- **ToS evasion by construction.** No code path rotates accounts to beat a rate
  limit; the only account changes are user-declared. A 429 from the selected
  account surfaces to the client (as today), it does not trigger a hidden retry
  on another account.
- **Injection / tool tampering.** No MCP/tool surface can choose an account or
  read a credential; selection is config/CLI only, validated with zod.

## Consequences
- **Blocked until accepted + ToS answered.** This ADR + the user's ToS scope
  decision are prerequisites for any R6.2 code (ADR-0002 precedent).
- Env-var-first keeps R6.2 dependency-free and off-disk; a keychain backend is a
  later, separately-verified addition.
- Builds on R6.1 (adapters/translation, shipped). 21a escalation stays out.

Related: [[ADR-0002 — Cruise-control autonomy modes & approval gates]] (the
fail-closed / audit-log / no-tool-surface precedent this inherits), R6.1 case (a)
auth-mapping (the single-credential path this generalizes),
`docs/plan/proposals/r6-multi-provider-remote-memos.md` (the R6.2 memo).
