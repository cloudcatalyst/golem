---
title: Multi-target routing — many local and upstream models through one proxy
type: proposal
tags: [proxy, routing, providers, r6, 21e, architecture]
sources: [docs/decisions/ADR-0003-credential-storage-and-account-routing.md, docs/plan/tasks/21e.md, docs/golem-spec.md]
created: 2026-08-08
updated: 2026-08-08
status: DRAFT — awaiting spec Decision + ADR amendment
---

# Multi-target routing

**The ask.** Golem should front *many* local and upstream models concurrently:
the ability to divert a piece of work to a specific model when there is a good
reason, and for a sub-agent to branch off onto its own model.

**Diversion is out-of-band (USER refinement, 2026-08-08).** The main
conversation is not re-routed mid-flight. Instead:

- an **MCP tool call** (`coder`) runs work on a named target and returns the
  result as a tool result — the conversation's cache prefix is never touched, so
  there is no cache fragmentation at all; or
- a **sub-agent branches off** with its own model — a fresh conversation, so its
  prefix is separate by construction.

This is strictly better than the rules-engine design this memo originally
proposed. In-band per-turn routing is what fragments the cache, and it is now
simply not a mechanism Golem offers. The routing table below shrinks from six
precedence levels to three, and the declarative rules engine is dropped.

**The answer to "multiple proxies or a smart proxy?": one smart proxy, one
port.** Claude Code has exactly one `ANTHROPIC_BASE_URL`. Multiple proxy
processes would each need their own port and could not be selected per request
by the client, so they cannot deliver the feature at all. Concurrency is not the
constraint — Node already serves requests concurrently; the constraint is that
one `undici.Pool` is bound at proxy construction. That is the whole structural
blocker, and it is small.

Optional extra (cheap, not required): the *same process* can bind several ports,
each with a different default target, for pinning a second client to a different
default. That is a listener loop, not a second proxy.

## Scope decisions taken (USER, 2026-08-08)

These three answers shape everything below.

1. **No failover.** Routes are static and purpose-declared. A 429 or exhaustion
   surfaces to the client exactly as today. No code path routes around an
   exhausted target. This keeps the build inside ADR-0003's accepted ToS line
   and means **Phase 1 needs no new ToS review**.
2. **Sticky by default, explicit override.** A route binds at conversation start
   and sticks for that conversation. *Superseded in practice by the out-of-band
   refinement above*: since no mechanism re-routes a live conversation, "sticky"
   reduces to "resolve once per conversation", and the override case disappears.
3. **Agents suggest, config decides.** No MCP surface *selects* a target. An
   agent may emit a preference; user-authored policy decides whether to honour
   it, and it is off by default.

## The core pivot: `Target` as the unifying abstraction

Today there are two unrelated notions of "a model Golem can talk to":

- an **upstream** — one at a time, from `proxy.accounts` + `active_account`,
  resolved once per proxy run by `resolveActiveUpstream`; and
- the **local coder** — a separate path entirely, reached only by the `coder`
  MCP tool through `OllamaInferenceService`, never through the proxy.

The pivot is to collapse both into one registry. **A local model is just a
target whose provider is `ollama`.** "Optional local coder" stops being a
special case and becomes an ordinary row in the table.

Critically, this **keeps the credential model exactly as ADR-0003 built it** by
splitting two concerns that are currently fused:

| Registry | Answers | Secrets? |
|---|---|---|
| `proxy.accounts` (exists) | *whose credential* — id → provider + OS-keychain reference | reference only, never a value |
| `proxy.targets` (new) | *which endpoint + model* — id → provider, base_url, model, `account` ref, trust | none |

Several targets may share one account. That is what makes "many upstream models"
work without multiplying credentials: one Anthropic key can back an `opus`
target and a `haiku` target. Because targets hold no secrets, the entire
ADR-0003 threat model carries over untouched.

```toml
[[proxy.targets]]
id         = "main"
provider   = "anthropic"
base_url   = "https://api.anthropic.com"
account    = "personal"          # → existing credential registry; omit to inherit client auth
# model omitted → byte-faithful passthrough of the client's own model id

[[proxy.targets]]
id         = "coder"
provider   = "ollama"
base_url   = "http://127.0.0.1:11434/v1"
model      = "qwen2.5-coder:14b"
trust      = "local"

[[proxy.targets]]
id         = "cheap"
provider   = "openrouter"
base_url   = "https://openrouter.ai/api/v1"
model      = "openai/gpt-oss-20b:free"
account    = "openrouter"
trust      = "third-party"
```

`trust` is new and load-bearing: it sets a **redaction floor**. A target may
*raise* the floor (a third-party gateway gets more redaction than your own
Anthropic account), never lower it. This preserves the CLAUDE.md hard rule
"redaction must never be weakened or reordered" under a routing feature that
otherwise widens where your context can go.

## Route resolution

A pure function of request signals + policy. First match wins; every level is
an *explicit, user-authored* act.

| # | Level | Authored by | Scope |
|---|---|---|---|
| 1 | Virtual model id in body — `model: "golem/coder"` | user / sub-agent definition | conversation |
| 2 | Header `x-golem-target: <id>` | hook / config | conversation |
| 3 | `proxy.default_target` | user config | fallback |

The declarative rules engine (`when = { thinking = true }` etc.) is **dropped**.
It existed only to serve in-band per-turn diversion, which the out-of-band model
replaces. Nothing keys on per-turn signals any more, so the cache-hostile rule
class cannot be expressed — a constraint worth keeping deliberately.

**Level 1 is the headline, and it needs no ADR amendment at all.** Claude Code
already lets a subagent declare its own model in frontmatter, and `/model` sets
one interactively. A subagent defined with `model: golem/coder` sends that id on
every request it makes; the proxy maps it to the `coder` target and, because a
subagent is its own conversation, the binding is sticky and cache-safe by
construction. That delivers "direct agents to route to a different local or
upstream model" through pure configuration — the agent does not choose, its
definition does.

> **Verified 2026-08-08 — PASSES.** `verification-notes.md §114`. Claude Code's
> model-id recognition check *"runs only on the Anthropic API […] behind an LLM
> gateway or a custom `ANTHROPIC_BASE_URL`, your provider or gateway defines the
> model names, so Claude Code passes any string through without checking it."*
> Golem is a custom base URL, so the check is disabled by construction, and
> sub-agent frontmatter documents "a full model ID" as an accepted `model` value.
> The level-2 fallback is **not** needed.
>
> Two caveats carried into the tasks: Anthropic *"doesn't support routing Claude
> Code to non-Claude models through any gateway"* (unsupported, not prohibited —
> and Golem already sits here via R6.1 case b), and the slash in `golem/coder`
> still wants one empirical confirmation (§114 caveat 5).

Because nothing re-routes mid-conversation, a binding is simply resolved once
per conversation. The key already exists: `conversationKey()` — the hash of the
first message — computed identically by `session-tree.ts:101` and
`cache-prefix.ts`, so routing, session recording, and cache-prefix observation
all agree on what "a conversation" is. A bounded LRU in
`.golem/state/route-bindings.json` (mirroring session-tree's 32, same atomic
temp+rename, fail-open discipline) is sufficient, and is only an *optimisation*
— level 1 is already stable across a conversation's turns because the client
sends the same model id every turn.

> Conversation identity has a known collision (verification-notes §99):
> multiplexed short conversations through one proxy share a key. For routing the
> failure is benign — both land on the same default — so R8.13 (the identity
> fix) is a *nice-to-have*, not a dependency, under this design.

## Diversion: the `coder` tool vs a sub-agent

Two mechanisms, and the honest answer is that they are **not competing — they
serve different model capability classes.**

### What `coder` already is

It is worth being accurate here, because it is further along than "a single-shot
local completion": `coder` today spans `coder-tools.ts`, `coder-edit.ts` and
`coder-refine.ts` (~780 lines) and already provides a drafter model, an optional
**judge** model, N critique→revise rounds, up-front grounding from the KB/wiki
(`gatherGrounding`), and an `edit` mode with filesystem containment against
`projectRootDir`. That is already a Golem-orchestrated multi-call loop.

What it lacks versus a true sub-agent is **model-driven tool use**: the model
cannot decide to read another file, grep, or run a test. Grounding is gathered
before the call, not pulled by the model during it.

### The selection rule: capability tier decides the mechanism

| | `coder` MCP tool | Sub-agent on a routed model |
|---|---|---|
| Best for | small local models (3B–14B) | capable models (Claude, GPT-class, Kimi) |
| System prompt | small, Golem-authored, task-shaped | Claude Code's full prompt + tool schema |
| Tool surface | narrow, chosen by Golem | everything the sub-agent is granted |
| Loop control | Golem (rounds, budget) | Claude Code |
| Conversation | none — out-of-band tool result | fresh conversation |
| New machinery | generalize the `target` param | none |

**This is why `coder` should NOT simply become a sub-agent.** Claude Code's
system prompt plus full tool schema is very large, and small local models have
both short context and weak tool-calling — handing a 7B model forty tools and a
multi-thousand-token preamble is the reliable way to make it fail. `coder` earns
its place precisely by giving a weak model three tools and a tight prompt.

Conversely, for a *capable* target there is no reason to build an agent loop
inside Golem: a sub-agent whose definition names `golem/<target>` already gets a
full agentic loop, its own context, and correct routing, with **zero new Golem
machinery**.

So: **generalize `coder`'s target, and use sub-agents for heavyweight work.**
The two mechanisms share one spine — the target registry. `coder(target:
"cheap")` and a sub-agent with `model: golem/cheap` resolve the *same config
row*. That shared registry is what justifies the `Target` abstraction even
though proxy-side routing shrank.

### Blocker 1 — `coder` on a remote target is an unredacted egress path

**`src/mcp/` contains no redaction calls at all.** The coder path reaches the
model through `InferenceService` → Ollama directly, never through the proxy, so
it never crosses the redaction stage.

Today that is *sound*, because the only reachable target is a local Ollama: the
content never leaves the machine, which is the whole local-first premise. **The
moment `coder` can name a remote target, it becomes an egress path that bypasses
redaction** — and it ships exactly the sensitive material you would most want
redacted (KB/wiki grounding, and in `edit` mode, project source). That is a
direct violation of the CLAUDE.md hard rule *"redaction must never be weakened
or reordered"*.

This is a risk **introduced by the change**, not an existing bug — but it is
non-negotiable and must land in the same slice that generalizes the target.

*The fix is cheap.* `redactRequestBody` and `redactStandaloneText` are already
standalone exported functions in `src/pipeline/redaction.ts:206/149` — no proxy
hop, no refactor. Required behaviour:

- a **local** target (`trust = "local"`) may keep today's direct path;
- any **non-local** target redacts before dispatch, at that target's `trust`
  floor;
- the placeholder table must round-trip so the returned draft is de-redacted
  before it reaches the caller — a detail worth an explicit test, since a draft
  full of `[REDACTED_1]` is useless.

### Blocker 2 — `InferenceService` is a frozen contract

`src/interfaces/inference.ts` is a **FROZEN CONTRACT** whose stated doctrine is
role-based dispatch: *"Role→model mapping comes from the WS-D model catalog,
selected by the detected hardware tier; **callers never name concrete
models**."* A `coder` tool that names a target contradicts that principle
head-on, and CLAUDE.md requires frozen-contract changes to update tests and flag
dependent workstreams.

**Recommendation: do not amend the frozen contract.** Instead introduce a
`TargetDispatcher` *above* it:

- `InferenceService` keeps its exact present meaning — local, tiered,
  role-based. Untouched, no workstream flagged.
- `TargetDispatcher` resolves a target id, then either delegates to
  `InferenceService` (local target, mapping the requested role through the
  existing catalog) or dispatches to a remote target reusing the R6.1
  translators — after redaction.

`coder` gains an optional `target` parameter; omitted, it behaves exactly as
today. This keeps Phase 1 clear of `src/interfaces/` entirely.

### Sub-agent side

Nothing to build, assuming the model-id verification passes. The one addition
worth having is that `golem init` should scaffold example sub-agent definitions
per target, so the mechanism is discoverable rather than folklore.

## Code changes, layer by layer

### `src/proxy/server.ts` — the only structural blocker

Three concrete edits:

1. **`Pool` → pool registry.** `server.ts:70` builds one `Pool` from
   `upstreamBaseUrl` in the constructor. Replace with a lazy
   `Map<origin, Pool>`, bounded, all entries closed in `close()`. Per-origin
   pooling is exactly what undici is designed for; concurrency across targets
   falls out for free.
2. **Resolve the route before the pipeline.** Currently the pipeline runs, then
   transport concerns are applied from `this.config` (`server.ts:158-188`). The
   order must become **read body → resolve route → pipeline → translate →
   forward**, because the route determines two pipeline inputs: the redaction
   floor (from `trust`) and `assumeCachingUpstream` (from
   `upstreamAssumesCaching(route.provider)`, which gates the lossy semantic
   stage). Redaction still runs first *within* the pipeline, so the hard rule
   holds.
3. **Read transport from the route, not the config.** `basePath`,
   `mapUpstreamHeaders`, and `translateUpstream` become fields of the resolved
   route. The rest of `handle()` — the SSE byte pipe, the usage sniffer, the
   translating branch, error mapping — is untouched.

### `src/proxy/types.ts`

- `ProxyServerOptions.resolveRoute?: (req: ProxyRequest) => ResolvedRoute`.
- **Keep the existing single-upstream fields as the degenerate one-target case.**
  When `resolveRoute` is absent, the proxy behaves exactly as today. This is the
  difference between a risky rewrite and an additive change: every existing
  recorded-shape and byte-fidelity test keeps passing unmodified.
- `ProxyRequest` gains an optional `route` field so the pipeline can see the
  decision — additive and opt-in, following the `respondDirectly` precedent
  (Decision 33) rather than inventing a new seam.

### `src/providers/`

- `targets.ts` (new) — target registry resolution, fail-closed on an unknown id
  in the same spirit as `resolveActiveUpstream`: never silently substitute a
  different target.
- `routing.ts` (new) — the precedence chain above as a **pure function**
  returning `{ targetId, reason, sticky }`. No I/O, exhaustively unit-testable,
  and `reason` is what the audit log records.
- `accounts.ts` — unchanged in substance; `resolveActiveUpstream` stays for the
  single-target path and the migration shim.
- The capability helpers (`isTranslatingProvider`, `upstreamAssumesCaching`,
  `upstreamChatCompletionsPath`, …) are already pure functions of
  `(provider, baseUrl)`. **They need no changes at all** — this is why the pivot
  is tractable.

### `src/cli/proxy-runtime.ts`

- Build one translator **per target**, memoized, from the same logic now at
  lines 324-371 — currently a straight-line block over the single active
  upstream; it becomes a function called per target.
- **Credential preflight for N targets.** The CLI already resolves the active
  account's key from the OS store and injects it at spawn via
  `perAccountEnvVar` (Decision 47). Generalize to every account referenced by a
  target. **No new secret mechanism is required** — `perAccountEnvVar` was
  already designed per-account.
- Warn at startup for each misconfigured target (missing credential, translating
  provider with no `model`, doubled version segment) instead of only the active
  one. `doubledVersionSegment` already exists for this.

### Observability — the part that quietly needs the most work

- `served-model.ts` — a single snapshot keyed by `accountId` becomes a map keyed
  by target. Today a mismatch returns `null` to avoid a confident-wrong display;
  with N targets, display surfaces must show *which target served what*, per the
  spec's 21e correctness rail ("the responding model is always visible").
- `limit-prediction.ts` — **this is a real gap, already observable.** During the
  research for this memo Golem reported its auto-park was *blind* because the
  active upstream emits no `anthropic-ratelimit-unified-*` headers. With N
  targets that becomes structural: limit state must be tracked per target, and
  targets that emit no headers must be shown as "unmonitored" rather than
  silently dragging the whole prediction blind. Snooze/park (Decision 45)
  currently assumes one window.
- `context-ledger.ts`, telemetry, and cost attribution (R8.8) all gain a target
  dimension.
- **Audit log** — ADR-0003 invariant 5 already requires every
  `(request → account, provider, reason)` selection be appended to
  `.golem/state/`. Extend the tuple with `target` and the routing `reason`. The
  mechanism exists; it needs a field.

### `src/mcp/`

This is where Phase 2 lands — and it is now the *primary* diversion mechanism,
not an afterthought:

- `coder` gains an optional `target` param, enumerated to agent-selectable
  targets only (open question 5).
- A `TargetDispatcher` sits between `coder` and the frozen `InferenceService`.
- **Redaction before dispatch** for any non-local target — the blocker above.

No proxy-side suggestion channel is built.

### New CLI surfaces

- `golem target list | add | show | test` — `test` reuses the existing
  credential-probe path per target.
- `golem route explain` — given a model id / header / request shape, print which
  target it resolves to **and why** (the `reason` string from `routing.ts`). Less
  critical than in the first draft now that there are three precedence levels
  rather than six, but still the cheapest way to make a misrouted request
  visible before it bills wrong.
- `golem local *` becomes thin aliases over target operations.
- `golem status` gains a routes table with per-target limit state.

## Decisions and rules this contradicts

| Artifact | Conflict | Proposed resolution |
|---|---|---|
| **ADR-0003 invariant 4** — "no MCP surface … selects an account" | Agents influencing routing | **Narrow, not reverse.** Add: a tool may *suggest* a declared route; it may never select an account, read a secret, or name an undeclared endpoint. Config decides whether a suggestion is honoured; default off. Scope decision 3 keeps this amendment small. |
| **ADR-0003 "OUT: route-on-exhaustion"** | — | **No conflict.** Scope decision 1 keeps failover out. Phase 1 is unblocked without a new ToS review. |
| **Decision 21d** — "one account is active per proxy run" | Directly superseded | New spec Decision: per-request target selection among user-declared targets. `active_account` → `default_target` with a migration shim. |
| **Decision 31** — slider never auto-engages the local model | A route *can* send a whole conversation to a local model | **Clarify, don't reverse.** The slider remains a compression dial and still never engages a model. Routing is a separate, explicitly-declared axis. But a local target serving the main conversation must be surfaced loudly — this is exactly the failure mode Decision 31 was written to prevent, arriving by a different door. |
| **CLAUDE.md** — "Proxy byte-faithful at ≤ level 1" | Byte-fidelity is a property of the *provider*, not the proxy | Restate **per route**: a route to an Anthropic-protocol target is byte-faithful; a translating route is not, and never was (R6.1 case b). Recorded-shape tests become a per-route matrix. |
| **`accounts.ts:8`** — "There is NO per-request routing here (that is 21e, future)" | The comment becomes false | Update alongside the code. |
| **`src/interfaces/inference.ts`** — FROZEN: "callers never name concrete models" | `coder(target: …)` names a target | **Do not amend.** Add a `TargetDispatcher` layer above it (see above). Phase 1 never touches `src/interfaces/`. |
| **CLAUDE.md** — "redaction must never be weakened or reordered" | `coder` on a remote target bypasses redaction entirely (`src/mcp/` has no redaction calls) | **Blocking.** Redact before dispatch for any non-local target, in the same slice that generalizes the target. Placeholder table must round-trip. |

## Risks

- ~~**Cache fragmentation.**~~ **Designed out.** With diversion out-of-band and
  in-band routing fixed per conversation, no mechanism can fragment a
  conversation's prefix. This was the dominant economic risk in the first draft
  and it is now structurally absent rather than mitigated.
- **Unredacted egress via `coder`** (blocker 1 above) — now the highest-severity
  risk in the proposal, and the one that must not slip a slice.
- **Blind limit prediction across targets.** Already happening with one target;
  N targets make it structural. Must be visible per target, never silently
  degraded.
- **Wider secret exposure in the daemon.** The proxy process env now carries N
  keys instead of 1. The keys are still never settings and never on disk in
  plaintext, but the blast radius of a proxy compromise grows. Worth an explicit
  line in the ADR amendment.
- **Prompt-injection steering.** A poisoned tool result trying to push context to
  an attacker-favoured target. Mitigated hard by scope decision 3 (suggestions
  off by default, allowlist only, no ad-hoc endpoints) plus the `trust`
  redaction floor.
- **Silent quality degradation.** The spec's standing 21a/21e risk row. Routing
  must never trade correctness for cost without signalling it; per-target
  attribution is the mitigation and is not optional.
- **Test surface growth.** Byte-fidelity and recorded-shape tests multiply across
  the route matrix.

## Phasing

Written up as three task docs. The shared registry is split out so the proxy work
and the `coder` work become **independent siblings** that may land in either
order.

**[R9.1] Target registry (M).** `proxy.targets`; fail-closed resolution;
per-target credential preflight and startup warnings; `golem target` commands;
`active_account` → `default_target` shim. **No behaviour change** — the registry
is inert configuration until R9.2/R9.3 consume it, which is what makes it safe
to land alone.

**[R9.2] Proxy serves many targets (M).** Pool registry; three-level
`resolveRoute`; per-target attribution; clear error for an unknown id. Delivers
sub-agent branching. *Verification gate cleared (§114); one residual empirical
slash check.* `depends_on: R9.1`.

**[R9.3] `coder` on any target (M).** `TargetDispatcher` above the frozen
`InferenceService`; optional `target` param; **redaction before dispatch for
every non-local target**, with placeholder round-trip. Delivers "divert when
there is a good reason". Touches no frozen interface. `depends_on: R9.1`.

**Later — polish (S).** `golem route explain`, per-target limit state, `golem
init` scaffolding of example sub-agent definitions per target.

**Dropped — the declarative rules engine and the `x-golem-prefer` suggestion
channel.** Both existed to serve in-band per-turn diversion. Out-of-band
diversion replaces them, so neither is built, and the ADR-0003 invariant-4
amendment they required is **no longer needed** (but see open question 5).

**Deferred indefinitely — failover / route-on-exhaustion.** Out per scope
decision 1 and ADR-0003. Re-opening it needs a fresh, explicit ToS review.

## Open questions

1. **Does Claude Code forward arbitrary model ids?** The gate on Phase 1's UX
   (see the verification note above).
2. **What happens to `upstream_model` on a byte-faithful target?** Today a
   translating target substitutes the configured model and a byte-faithful one
   forwards the client's id. With virtual model ids the client's id becomes a
   *routing key* rather than a model request — so a byte-faithful target needs a
   rule for what model id it actually forwards after `golem/coder` is consumed.
3. **Should `trust` levels be enumerated or free-form?** Enumerating
   (`vendor | local | lan | third-party`) makes the redaction floor auditable;
   free-form makes it extensible. Recommend enumerated.
4. **Multi-port binding** — worth building in Phase 1, or defer until someone
   actually runs a second client?
5. ~~**Does `coder(target: …)` re-open ADR-0003 invariant 4?**~~ **RESOLVED
   (USER, 2026-08-08): the triggering conversation chooses, bounded to the range
   config declares.** The "agent vs tool" framing was the wrong axis — `coder` is
   a narrow tool, and the model in the conversation decides either way, so that
   distinction draws no security line. The control that carries the weight is
   whether a selection can reach anything undeclared; it cannot. Invariant 4
   forbids selecting an *account* or reading a *secret*, and this does neither.
   Targets are selectable by default with a per-target `agent_selectable = false`
   opt-out for expensive ones. See R9.3.

   > **Amended 2026-08-09 (R8.33).** This answer originally leaned on a
   > precedent that no longer exists: *"the `level` tool lets a conversation set
   > slider level 0, disabling redaction entirely, so choosing among declared
   > targets is strictly safer."* R8.33 removed exactly that capability — the
   > `level` tool now accepts 1–3 and level 0 is a CLI-only act, per ADR-0002
   > threat item 4. The **conclusion stands and is in fact better supported**:
   > the repo's settled position is now that a conversation may adjust *how much*
   > processing happens but may never turn redaction **off**, and target
   > selection among declared targets that all keep redaction on sits squarely on
   > the permitted side of that line. What is no longer available is the
   > a-fortiori argument — R9.3 must justify selectability on its own terms, and
   > the `trust` redaction floor is what does that work.
