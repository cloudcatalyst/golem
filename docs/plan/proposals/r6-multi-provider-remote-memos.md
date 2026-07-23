# R6 — Multi-provider & remote — design memos

> **Status: PROPOSED (2026-07-23) — review-gate artifact, no code.** R6 is
> `⛔ ON HOLD` (ROADMAP.md; spec Decision 36). The hold has one shared gate: not
> before the R4 co-developer loop is proven robust (met), **and each task still
> needs its written design memo + a separate explicit ask before any code**
> (the standing WS-F gate, spec Decisions 20/21). This file is that written
> memo for the three build-eligible tasks — **R6.1** (provider adapters),
> **R6.2** (account/quota routing), **R6.4** (cost-governance benchmarks). It
> makes the release *review-ready*; it does **not** authorize the build. **R6.3**
> (remote steering / companion app) is **deliberately excluded** — the user has
> explicitly deferred it (Decision 36; ROADMAP R6.3); see the note at the end.
>
> Precedent for this file's shape: the retired `r5-autonomy-orchestration-memos.md`
> (one per-release memo file, later distilled into ADR-0002 + the R5 debriefs).
> Security-heavy tasks graduate to a threat-model ADR (ADR-0002 style) at their
> build ask; R6.2 in particular will.

## Sources

- Spec Decisions Log (`docs/golem-spec.md`): **22** (provider-agnostic pre-LLM
  pipeline), **32** (positioning committed; R6.1/WS-F14 unblocked but build is a
  separate ask), **21a/21d/21e** (escalation, account switching, multi-LLM/quota
  arbitrage), **21f** (cost-governance benchmarks), **23/31** (compression is
  situational; semantic stage gated OFF on caching upstreams), **36** (the hold).
- `docs/plan/ROADMAP.md` R6 table + "Concentrated decision/research backlog".
- Frozen contracts: `src/interfaces/policy.ts`, `src/interfaces/compression.ts`,
  `src/interfaces/inference.ts`. Proxy seams: `src/proxy/types.ts`
  (`ProxyRequest`, `RequestPipeline`, `ProxyServerOptions.upstreamBaseUrl`),
  `src/proxy/server.ts`, `src/proxy/pipeline.ts` (`isCachingUpstream`).
- Risks table (`docs/golem-spec.md` §8): the remote / credentials / ToS rows.

## Cross-cutting hard rules (bind all three memos)

Non-negotiable, from CLAUDE.md and the spec. Any R6 build that cannot honor
these is not buildable as specced:

1. **The Anthropic path is byte-faithful and untouched.** Foundry/OpenRouter
   adapters are a **separate code path**; they must never weaken or slow the
   Claude path (Decision 22 "Architecture", Decision 32 boundary). The
   recorded-shape integration tests for level ≤1 must still pass unchanged.
2. **Redaction runs first, always, at every level ≥1** — and is *more* valuable
   fronting a third party (secrets must not leak to any provider; Decision 22).
   No adapter may transform or forward content before the redaction stage.
3. **Frozen interfaces are contracts.** `SliderPolicy`/`CompressionService`/
   `InferenceService` changes require contract-tests-first + a flagged PR. The
   working assumption below is **additive, no frozen-interface change** wherever
   possible; any exception is called out.
4. **No heavyweight native deps in the default install.** Provider SDKs, if any,
   must be light or optional; prefer speaking the wire protocol directly over
   pulling a vendor SDK.
5. **ToS is a design input, not an afterthought** (Decisions 21d/21e). A feature
   that only works by violating a provider's terms is not designed — it is
   flagged for the user and stopped.

---

## R6.1 — Provider-agnostic adapters

**Goal (ROADMAP).** Front Foundry / OpenRouter as upstreams; Anthropic
byte-faithful path untouched. Positioning-unblocked by Decision 32; this is the
enabling architecture beneath R6.2's multi-provider routing (Decision 22 is
"the enabling architecture beneath 21e").

### Problem / why now

Today the proxy is a **transparent Anthropic-API passthrough**. `upstreamBaseUrl`
can already point at any host, including a gateway with a path prefix
(`src/proxy/types.ts`: "the incoming request target is appended to it verbatim").
So two very different cases hide behind one word "adapter":

- **(a) Anthropic-protocol gateways.** A gateway that itself speaks the Anthropic
  Messages API (some OpenRouter/Foundry deployments proxy Anthropic models
  through the native schema). Fronting these is *mostly already possible* —
  point `upstreamBaseUrl` at the gateway, swap the auth header. The remaining
  work is auth/header mapping and the `isCachingUpstream` classification.
- **(b) Foreign-protocol gateways.** A gateway that speaks **OpenAI Chat
  Completions** (OpenRouter's native surface, Azure Foundry's). Here the
  request body, the response body, the SSE event shapes, and the tool-use
  blocks all differ from Anthropic's. This needs **real bidirectional protocol
  translation**, and — critically — a **response-transform seam the proxy does
  not have today** (`src/proxy/types.ts`: "Response bodies otherwise have NO
  seam by design").

The honest framing for the review: R6.1's cost is almost entirely case (b).

### Proposed design

- **A `ProviderAdapter` seam, additive, selected by upstream identity.** A new
  non-frozen interface (candidate `src/providers/`), e.g.
  `translateRequest(anthropicReq) → upstreamReq` and
  `translateResponseStream(upstreamStream) → anthropicStream`. The **Anthropic
  adapter is the identity** and is the default — the existing byte-faithful path
  *is* that adapter, unchanged. This keeps rule #1 structural: a non-Anthropic
  adapter is a different object, never a modification of the passthrough.
- **Request side rides the existing `RequestPipeline` seam** where possible
  (redaction → compression happen in Anthropic-schema terms first, then the
  adapter translates the *already-redacted, already-processed* request to the
  target protocol as the final step). Redaction never sees a foreign schema and
  is never reordered (rule #2).
- **Response side needs a new, opt-in, non-Anthropic-only transform path.** This
  is the one architecturally significant change and must be scoped as such: the
  byte-faithful response pipe stays the default and the *only* path for
  Anthropic; the translating path exists solely when a foreign adapter is
  active. The recorded-shape tests must prove the Anthropic path never enters
  it.
- **Compression/caching per provider.** Anthropic's byte-identical-prefix cache
  rule is not universal (Decision 22 "Stage generalization"). `isCachingUpstream`
  already assumes caching when the upstream is unknown/Anthropic (Decision 31) —
  a foreign, non-caching gateway is exactly where the **semantic stage is
  allowed to engage** and where Decision 23's "situational savings" claim
  finally has real traffic. This unblocks the re-scoped **R2.6** live A/B
  (ROADMAP: "unblocks-with-R6.1").

### Interfaces / scope

- **No frozen-interface change expected** for the adapter seam itself
  (`ProviderAdapter` is additive). `CompressionService` is unchanged. The
  response-transform path is a proxy-internal (`src/proxy/`) addition, not an
  `src/interfaces/` change — but it touches the byte-faithful guarantee's
  blast radius, so it is the highest-scrutiny part of the build and needs its
  own recorded-shape tests before it lands.
- New config: an upstream/provider selector (candidate `upstream.provider` +
  per-provider `base_url`/auth). Default stays Anthropic.

### Open questions (must close before build)

1. **Case (a) vs (b) split** — which gateways do we actually target first? An
   Anthropic-protocol OpenRouter deployment is a days-not-weeks task; full
   OpenAI-schema translation is the large one. Recommend scoping the first
   build to **(a) only** and treating (b) as a follow-on.
2. **Tool-use fidelity across schemas.** Anthropic `tool_use`/`tool_result`
   blocks ↔ OpenAI `tool_calls`/`role:tool`. Golem's whole value depends on not
   silently degrading tool-bearing turns (the same rail as Decision 25's
   escalation). Needs a faithfulness test corpus before (b).
3. **Streaming shape parity** — Anthropic SSE (`message_start`,
   `content_block_delta`, …) vs OpenAI streaming deltas. Recorded-shape fixtures
   for each provider.
4. **Auth model** per provider (header name, key storage) — overlaps R6.2's
   credential-storage question; do not build credential storage twice.

### Verification-first tasks (cheap, do first)

- Confirm, against **live docs** (per the CLAUDE.md verify rule), the current
  Anthropic-vs-OpenAI request/response/SSE/tool-use schemas for OpenRouter and
  Azure Foundry; record in `verification-notes.md`. Do **not** build from memory.
- Confirm which target gateways expose an Anthropic-native schema (case a).

### Status

**Case (a): DONE 2026-07-23** (verification-notes §73; debrief
`2026-07-23-R6.1a.md`). Shipped the `upstream_provider`/`upstream_auth_scheme`
config, `src/providers/` (auth-scheme resolution + header mapper + caching
assumption), the additive `mapUpstreamHeaders` proxy seam, and the
`assumeCachingUpstream` fix so Claude-via-Azure isn't misclassified as
non-caching. Anthropic default path byte-identical (no mapper); +14 tests, 1184
green. **Live-unverified** — no real Azure Foundry / OpenRouter credentials
in-session (a user-side end-to-end check remains, like R7.3's binaries).

**Case (b): IN PROGRESS** — per the user's goal (2026-07-23): OpenAI/ChatGPT +
Ollama (local & LAN) via one OpenAI-Chat-Completions adapter + the
response-transform seam, then Gemini. Sliced b1→b4.
- **b1 DONE 2026-07-23** (debrief `2026-07-23-R6.1b1.md`): non-streaming
  Anthropic↔OpenAI translation + the `translateUpstream` proxy seam (the only
  path that parses a response body; Anthropic path stays a raw pipe); providers
  `openai`/`ollama`, `proxy.upstream_model`. **Live-verified against local
  Ollama** (verification-notes §74). +12 tests, 1196 green.
- **b2 DONE 2026-07-23** (debrief `2026-07-23-R6.1b2.md`): SSE streaming
  translation (`OpenAIChatSSETranslator`, OpenAI deltas → Anthropic event
  stream), piped live by the proxy; the request now honors `stream:true`.
  **Live-verified vs Ollama** (verification-notes §75) — this is the slice that
  makes real Claude Code traffic usable against an OpenAI-schema upstream.
- **b3 DONE 2026-07-23** (debrief `2026-07-23-R6.1b3.md`): full tool-use mapping —
  request `tools`/`tool_choice`, `tool_use`↔`tool_calls`, `tool_result`↔`role:tool`;
  response `tool_calls`→`tool_use` (non-streaming + streaming `input_json_delta`
  with sequential blocks). Unit-verified exhaustively; live tool-call round-trip
  needs a backend model that emits native `tool_calls` (Ollama `qwen2.5-coder`
  returned the call as text — verification-notes §76).
- **OpenAI: functional 2026-07-23** — no new code; the b1–b3 translator + the
  `openai` provider (bearer key via `GOLEM_UPSTREAM_API_KEY`, `upstream_base_url`
  + `upstream_model`). Provider wiring locked with tests. OpenAI emits native
  `tool_calls`, so it live-verifies b3's tool path (a user-side check with a key).
- **b4-gemini: NEXT, checkpoint-gated.** Gemini is a full SECOND translator
  (different schema: `contents`/`parts`/`functionCall`, `role:"model"`) plus a
  proxy-seam extension (query-param `?key=` auth + dynamic model-in-path /
  `alt=sse`, which `mapUpstreamHeaders` can't do). API verified (§77); not
  live-testable in-session. Recommend confirming before building (size + seam
  change + no live test). **Case (b) core — OpenAI + Ollama — is complete.**

---

## R6.2 — Account switching + multi-LLM / quota routing

**Goal (ROADMAP).** Account switching (21d) + multi-LLM/quota routing (21e):
distribute spend across accounts/quotas; route per request by
cost/quota/capability/availability. **🔒 security-gated.**

### Problem

The proxy already owns the request path, so it is the natural place to swap
credentials and route (Decision 21d). Two capabilities:

- **21d — account switching:** hold multiple credentials (Claude subscriptions /
  API keys / org workspaces) and pick one per request/policy.
- **21e — multi-LLM/quota arbitrage:** route a request to a backend chosen by
  cost/quota/capability/availability, across providers (depends on R6.1 adapters
  and R6.2's own account layer).

### The two gates that dominate this task

1. **🔒 Secure credential storage.** Golem would custody multiple provider
   credentials. This is a new, high-value secret store — it must never land in a
   committed file, the `.golem/` tree that syncs, logs, telemetry, the wiki, or
   any redaction-eligible surface. Candidate: OS keychain via a light,
   cross-platform mechanism (rule #4 forbids a heavy native dep — needs a
   verified cross-OS option). **This needs a threat-model ADR (ADR-0002 shape)
   before any code**, same bar R5.4 met.
2. **🔒 ToS compatibility — the hard blocker.** Decision 21d is explicit:
   "whether rotating across accounts/free quotas to reduce spend is compatible
   with provider Terms of Service — must not design a ToS-violating feature
   (flag for explicit review)." Decision 21e repeats it. **This is a
   user/legal decision, not an engineering one**, and it gates the *quota-
   arbitrage* framing specifically. Account *switching* for legitimate separate
   accounts (e.g. personal vs work, or per-project billing) is a different, more
   defensible case than *rotating to dodge quotas*. The memo must not blur them.

### Proposed design (contingent on both gates clearing)

- **A `Router` policy layer above the adapter seam.** Given a request + a policy
  + live quota/limit state (Golem already parses `anthropic-ratelimit-unified-*`
  headers into `.golem/state/limit.json` — Decision 38 / `limit-prediction.ts`),
  pick `(provider, account)`. Reuses R6.1 adapters for the provider half.
- **Correctness rail (Decision 21e "seamless is hard").** Routing must **never
  silently degrade output.** Models differ in capability, tool-use format, and
  context limits. The rule mirrors Decision 25's escalation rail: a route that
  can't faithfully serve the turn (e.g. a smaller model on a tool-heavy turn)
  must be visible/attributed, not a silent swap. Extends R6.1's tool-fidelity
  corpus.
- **Every credential swap and route is audit-logged** (ADR-0002 precedent: the
  autonomy log). Attribution is a security property here.
- **Depends on 21a** (mid-thread escalation/handoff) for the "escalate this turn
  to a stronger model" case — note it as a dependency, not in-scope for the
  first cut.

### Interfaces / scope

- Additive: a non-frozen `Router` + credential-store seam. Built on R6.1's
  `ProviderAdapter`. No frozen-interface change expected.
- New config: account registry (identity + storage-ref, **never the secret
  itself**), routing policy.

### Open questions (must close before build)

1. **ToS review outcome** (blocker; user decision). Which of {separate-account
   switching, cross-account quota rotation} is in scope?
2. **Cross-OS keychain** with no heavyweight native dep — verify options
   (`verification-notes.md`).
3. **Routing policy surface** — declarative config vs learned; start declarative.
4. **Handoff coherence** (21a) — deferred dependency, but the context-handoff
   problem must be acknowledged.

### Status

**PROPOSED, blocked on two gates.** Do **not** start before (a) the ToS review
returns a clear in-scope answer, and (b) a credential-storage threat-model ADR
is written and reviewed. Sequence **after R6.1** (needs its adapters). This is
the highest-severity R6 task after R6.3.

---

## R6.4 — Cost-governance benchmarks

**Goal (ROADMAP).** Adopt Claude Code's "Manage costs effectively" doc
(Decision 21f) as explicit product goals + benchmarks; measure Golem's savings
against its stated baselines. **🛠️ build-only — the only R6 task with no 🔒
security/ToS gate**, and the lowest-friction place to start if the user wants
R6 momentum without touching the credential/adapter surface.

### Problem

Decision 21f makes the cost doc (https://code.claude.com/docs/en/costs, fetched
2026-07-04 — **re-verify before building; it may have changed**) the north-star
for Golem's token-reduction thesis. Golem already implements several of its
tips as automatic features (CCR output-swap = the doc's test-output-filtering
hook; local `coder` delegation; A4 telemetry ≈ `/usage`). What's missing is the
**benchmark**: measuring Golem's actual savings against the doc's baselines
(~$13/dev/active-day; agent teams ~7× tokens) and surfacing the same metrics the
doc tracks (per-tool/subagent/MCP attribution, 24h/7d windows).

### Proposed design

- **A `golem bench cost` (or extension of `golem stats`) that reports against
  the doc's metric set.** Golem already has the raw material: R4.3 per-tool
  telemetry (`kind:"tool"` events, `aggregateToolUsage`), R1.1 net-of-cache
  `usage` telemetry (`UsageSniffer`, `aggregateUsageByLevel`), and the
  `avoidedUpstream` bucket (R2.2). This task **composes existing telemetry into
  the doc's framing** — per-tool/subagent/MCP attribution over 24h/7d — rather
  than adding new capture.
- **Honest-measurement discipline (the §32 lesson).** Decision 21f explicitly
  warns against a repeat of the §31 artifact: any savings number must be
  cache-aware and net-of-cache (Decision 23/31 — on Anthropic, lossless is ~0%;
  the real lever is `avoidedUpstream`, not compression). The benchmark must
  report savings **honestly scoped by upstream**, not a headline number.
- **Automate the doc's manual tips where safe** (goal (i)): output filtering
  (done — CCR), local delegation (done — `coder`), MCP-tool-search efficiency,
  keeping CLAUDE.md lean. This part is incremental and mostly already shipped;
  the benchmark is what's new.

### Interfaces / scope

- Additive, read-only over existing telemetry. **No frozen-interface change.**
  No proxy-path change (pure observability, like R1.1/R4.3). Lowest blast radius
  of the three.

### Open questions

1. **Re-verify the cost doc** — its baselines and metric list may have moved
   since 2026-07-04 (`verification-notes.md`).
2. **Baseline attribution** — the doc's ~$13/dev/day is *its* number on *its*
   assumptions; the benchmark should compare like-for-like or state the gap, not
   claim a false delta.
3. **Continuous vs one-shot** — Decision 21f says "continuous once picked up";
   scope the first cut as a one-shot report, wire it into `golem stats`
   afterward.

### Status

**DONE (first cut) 2026-07-23.** Cost-doc re-verified (verification-notes §72);
shipped `golem bench cost` composing existing telemetry, honestly scoped, +11
tests (1170 green). See debriefs/2026-07-23-R6.4.md. Follow-on (deferred,
demand-gated): wire it into `golem stats`, and make it continuous per Decision
21f's "continuous once picked up".

---

## R6.3 — Remote steering / companion app — OUT OF SCOPE (deferred)

Not memo'd here **by the user's explicit deferral** (Decision 36; ROADMAP R6.3).
Recorded so the exclusion is visible, not an oversight. It is the highest-severity
surface in the product — remote permission-granting = remote authorization of
code execution (Risks table: "a compromise = RCE"). When it is picked up it needs
its own dedicated threat-model ADR (self-hosted relay, mTLS, device-paired auth,
conservative default-deny on link loss, every remote approval audit-logged) —
strictly more than a memo. Its shared groundwork (the blocked-state hook → local
state API, Decision 21b) partly overlaps the already-shipped R5.2
`SessionStateReport`, which is worth noting for whoever revives it.

---

## Recommended build order & graduation checklist

If the hold is lifted, the low-to-high-risk order is:

1. **R6.4** — pure observability, no gate. Fastest, safest R6 win.
2. **R6.1 case (a)** (Anthropic-protocol gateways) — small; unblocks R2.6.
3. **R6.1 case (b)** (OpenAI-schema translation) — the real adapter build;
   response-transform seam is the scrutiny point.
4. **R6.2** — only after R6.1 adapters exist **and** the two 🔒 gates (ToS
   review + credential threat-model ADR) have cleared.

Each task graduates from PROPOSED → build only when: (a) its `verification-notes.md`
live-doc pass is done, (b) its 🔒 gates (if any) are cleared, and (c) the user
gives the separate explicit build ask (the standing WS-F gate). Security-heavy
tasks (R6.2, and R6.3 when revived) additionally produce an ADR-0002-style
threat model before code.

Related: [[ADR-0002 — Cruise-control autonomy modes & approval gates]] (the
default-deny/fail-closed/audit-log precedent R6.2 and R6.3 inherit),
`src/proxy/pipeline.ts` (`isCachingUpstream`), `src/proxy/limit-prediction.ts`.
