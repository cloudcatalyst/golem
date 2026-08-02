---
title: ADR-0005 — Model routing: two lanes, named per request, and what a name may reach
type: adr
tags: [r8, routing, models, credentials, threat-model, prompt-injection, decision-56]
sources:
  [
    "docs/plan/tasks/R8.19.md",
    "docs/plan/tasks/R8.16.md",
    "docs/plan/tasks/21e.md",
    "docs/plan/proposals/r8-local-model-backends.md",
    "docs/golem-spec.md (Decision 56)",
    "docs/decisions/ADR-0003-credential-storage-and-account-routing.md",
    "docs/decisions/ADR-0004-plugin-seams.md",
    "src/inference/providers.ts",
    "src/providers/index.ts",
  ]
created: 2026-08-01
updated: 2026-08-01
---

# ADR-0005 — Model routing: two lanes, named per request, and what a name may reach

**Status: PROPOSED (2026-08-01) — awaiting user acceptance.** R8.19 and R8.16 both state
the ordering: no routing or spawn code lands before this is accepted. Written as their
build gate, on the ADR-0004 precedent. Spec **Decision 56** settles the *product*
direction (two lanes, no default model, local-only as an end state); this ADR settles the
*threat model* for letting a request name a route.

## Context

Decision 56 asks for one addressable set of model endpoints, usable in either lane,
nameable per request:

| lane | what it is | today |
|---|---|---|
| **thinker** | the brain a conversation or an agent plans with | `proxy.upstream_*`, `proxy.accounts` |
| **coder harness** | the executor that drafts, edits, runs | `coder` MCP tool, `inference.providers` |

The user's own examples are the requirement:

> "Use Fable 5 to plan the tasks for feature X to be developed by one or more agents using
> the default local coder" · "I have coding challenge y which I'd like to use Opus 4.8 via
> OpenRouter to solve." · "Can you task my lan's Ollama server to plan feature z using
> Gemma 4" · "Please plan, task and deliver project xyz using Kimi K3 on my Moonshot AI
> subscription, using as many agents as you need"

Read together: **thinker and coder are chosen independently, by name, at the moment of
asking** — not a session-wide mode, not a config edit.

Two existing decisions constrain this. **ADR-0003** drew the line at *"legitimate
account/provider switching only — the automated quota-evasion half is OUT"*, and stores
credentials in the OS keychain with a fail-closed resolver. **Decision 53 / ADR-0004**
established that a guarantee comes from the absence of a mechanism, not from a flag.

The hazard is not credential *storage* — R6.2 solved that. It is that **a prompt is
attacker-influenceable in a way a config file is not.** Golem's own knowledge base
ingests fetched web pages; its `coder` reads repository files; an agent reads issue text.
If "use Kimi K3 on my Moonshot subscription" is a sentence the model interprets, then a
hostile document can contain that sentence too — and the loss is not a leaked secret but
**spend on the user's most expensive subscription**, plus a redaction boundary bypassed if
the named route is not Golem's own path.

## Decision

### 1. Two registries federate; they do not merge

`proxy.accounts` holds credentialed upstreams (ADR-0003, OS credential store).
`inference.providers` holds local endpoints (R8.15) and **cannot hold a secret** — it
names an env var at most. Merging them would put a credential reach into a table that is
committed to a repo in the project scope.

So they stay separate and a resolution layer federates them, for the same reason
`golem ext` and `golem plugin` stayed separate: the boundary *is* the security property.
A route name resolves in one registry or the other, never both, and which one is reported.

### 2. A route is selected through a structured surface, never by interpretation

**The load-bearing rule.** Golem never parses "use Opus 4.8 via OpenRouter" out of prose.
A route is named through a typed surface — an MCP tool argument (`route: "openrouter"`),
`golem account use`, a `/golem/route` prompt — and natural language is mapped onto that
surface **visibly**, by the harness, in a way the user can see in the transcript.

The distinction is auditable reach. If the model interprets prose, every document in
context is a potential router. If the model must emit a structured argument, the set of
reachable routes is finite, enumerable, and logged.

### 3. Only declared routes are reachable, and undeclared names are refused

A name that is not in `proxy.accounts` or `inference.providers` is an error, not a
best-effort resolution. No inference from a model string to a provider, no "looks like an
OpenAI id so try OpenAI", no implicit base URL. This is what makes point 2 enforceable
rather than advisory: the reachable set is exactly what the user configured.

### 4. Credentialed routes require a standing grant; local routes do not

Selecting a **local** endpoint spends nothing and leaves nothing: freely nameable per
request.

Selecting a **credentialed** route spends the user's money, so naming it in a request is
not by itself authorisation. The grant is the configuration act — the account exists in
`proxy.accounts` and is marked routable — and per-request selection then chooses **among
already-granted accounts**. An account the user has not marked routable can only be
activated by `golem account use`, which is a human at a terminal.

This is deliberately narrower than "any credential in the store is one prompt away".

### 5. A spawned harness gets a Golem-supplied, local-only provider set

R8.16 spawns little-coder, the first ext with an **egress capability of its own**: it
speaks `anthropic/*` and `openai/*` natively, so a spawned session pointed at a cloud
model would leave the machine **without transiting Golem's proxy or its redaction stage**.

"We documented it" is not the same as "it cannot happen". The provider set handed to a
spawned harness is constructed by Golem, contains local endpoints only, and is enforced at
spawn. A harness that cannot be configured that way is not admitted as an ext.

Sub-harnesses also run **serially** by default: two of them contend for one local
inference server and finish slower than one.

### 6. Route-on-exhaustion stays absent

21e splits, and only the explicit half is built:

| | what | status |
|---|---|---|
| **21e-a** | explicit, user-named per-request routing | in scope for R8.19 |
| **21e-b** | automatic route-on-exhaustion / rotate-on-429 | **absent**, and not implemented-and-disabled |

A `429` from a named upstream is reported to the user, who may then name another. A human
deciding is the whole distinction ADR-0003 drew; a mechanism that could be flipped on is
not a guarantee.

### 7. Switching is priced and reported, never silently expensive

Two costs a switch imposes and must state:

- **Cache.** Switching thinker mid-conversation discards the cached prefix on the old
  upstream; §104's arithmetic puts a bust at ~3.3× an append turn. Reported, not
  discovered.
- **Fidelity.** The Anthropic-native path stays byte-faithful and translated providers
  stay a separate code path. A per-request switch must not smuggle a translated response
  onto the native path.

### 8. "No upstream" is a visible state

Decision 56's local-only end state is reachable by pointing both lanes at local
endpoints. It must be *surfaced* — status, statusline, `golem status` — so "am I spending
money right now?" is always answerable without reading config. Same discipline as level 0's
loud redaction-off warning: a mode with cost consequences announces itself.

## Consequences

**Accepted costs.** A resolution layer instead of one table. Natural language does not
route by itself — the user (or the harness, visibly) names the lane, which is slightly
more friction than "just say it in a sentence" and is the entire point. Accounts must be
marked routable before a request can select them, so the first per-request switch to a new
provider needs one CLI act.

**What this buys.** A hostile document cannot spend the user's Moonshot subscription. A
spawned coder cannot exfiltrate a prompt around the redaction stage. The reachable route
set is enumerable, so "what could this request have touched?" has an answer.

**What is still open.** Whether an agent inherits its parent's route grant or must be
given one explicitly — R8.19 should settle it in the narrow direction (inherit the *set*,
not the ability to widen it) and record the outcome here.

## Alternatives rejected

- **One merged model registry.** Simpler to explain, but it puts a credential reach into
  a table that is committed in project scope, and it makes "local only" a property you
  must audit rather than one the boundary gives you.
- **Interpreting routes from prose.** What the user literally asked for, and the reason
  this ADR exists: it makes every ingested document a router. The compromise is that the
  harness may *translate* prose into a structured selection, visibly.
- **Route-on-429 behind a default-off flag.** Rejected on ADR-0004's precedent: the
  guarantee is the absence of the mechanism.
- **Trusting the spawned harness's own config.** Rejected — an egress path Golem cannot
  see is an egress path Golem cannot redact.
