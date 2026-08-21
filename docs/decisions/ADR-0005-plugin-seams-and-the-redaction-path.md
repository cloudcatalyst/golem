---
title: ADR-0005 — Third-party plugins run inside the redaction path; there is no sandbox
type: adr
tags: [r8, plugins, redaction, threat-model, trust, supply-chain, honesty]
sources:
  [src/pipeline/redaction.ts, src/pipeline/redaction-rules.ts, src/plugins/, docs/golem-spec.md, docs/plan/tasks/R8.11.md]
created: 2026-08-21
updated: 2026-08-21
---

# ADR-0005 — Third-party plugins run inside the redaction path; there is no sandbox

**Status: ACCEPTED (2026-08-21).** Implements the in-process half of spec
Decision 53 clause (g), which named `golem plugin` as separate from `golem pkg`
precisely because of what this ADR is about. Does not modify ADR-0002 (autonomy
gates); it reuses its `outward`/`destructive` reasoning by analogy and says where
the analogy breaks.

## Context

Every organisation has private secret formats — an internal key prefix, a
bespoke employee id, a customer reference that is PII in their jurisdiction and
nowhere else. Today, extending Golem's redaction means **editing Golem**:
appending a row to `REDACTION_RULES` in a fork, and re-forking on every release.

That is the actual security posture this ADR is weighed against, and it is worse
than what is proposed here. The realistic outcomes of "no plugin seam" are:

1. the org forks Golem, and their fork drifts out of date — including out of date
   with security fixes to the redaction stage itself;
2. the org gives up and their private key format flows upstream unredacted;
3. the org does not adopt Golem.

None of those are safe. So the question is not "is loading third-party code
risky" — it is "which risk, and is the user told the truth about it".

## What a plugin actually is

Golem defines three seams a third party may register into:

| Seam | Runs | Sees |
|---|---|---|
| **Redaction rule** | Inside the redaction pass, after every built-in rule, before the entropy sweep | **Raw, unredacted text.** By necessity — a detector that cannot see the secret cannot detect it. |
| **Pipeline stage** | After redaction completes, before compression | Only already-redacted content. |
| **MCP tool** | On an MCP tool call | Whatever the caller passes it. |

All three run **in Golem's own process**, which is the same process that holds:

- the request body before redaction;
- `redactReversibleText`'s in-memory placeholder→plaintext map (R9.3), which
  exists so a remote `coder` draft can be de-redacted on return — i.e. a live map
  of the exact secrets that were just removed;
- whatever credentials the process has loaded for upstream routing.

## The honest part: there is no sandbox, and Node cannot give us one

**A plugin has the full authority of the Golem process. Golem cannot reduce
that.** This is not a gap to be closed later; it is a property of the runtime:

- `node:vm` is not a security boundary. The documentation says so. A module that
  can reach `process`, `require`, or any host object escapes it.
- `worker_threads` isolates *state*, not *authority*: a worker can `require("node:fs")`,
  open sockets, and read the same environment. Moving a plugin into a worker would
  buy crash isolation and cost the seams their whole purpose (a redaction rule
  must run synchronously inside the pass to be part of it).
- The Node permission model (`--permission`) is process-wide and set at launch. It
  cannot be scoped to one loaded module, and turning it on for Golem as a whole is
  a separate, unrelated piece of work.
- A separate OS process with a narrow IPC contract *would* be a real boundary —
  and that is `golem pkg`, the tier-2 spawn-target shape, which already exists.
  Anything that can be a subprocess should be one and does not need this ADR.

The task brief for R8.11 said: *"Sandboxing as a solved problem — if it needs a
sandbox to be safe, say so in the ADR rather than shipping."* So, said plainly:

> **Loading a Golem plugin is exactly as dangerous as adding a dependency to your
> own `package.json` and importing it. It is not less dangerous. The seams below
> constrain what a plugin is *asked* to do, not what it *can* do.**

Everything in the Decision section is therefore about making the trust decision
**explicit, narrow, visible, and reversible** — never about containment.

## Decision

### 1. Nothing loads unless a human named it

`plugins.load` is a list of specifiers, default `[]`. There is **no discovery**:
Golem never scans `node_modules`, never reads a `golem-plugin-*` naming
convention, never consults a registry. If a registry ever exists it is *a list of
names and pins, not a store* (Decision 53).

A specifier is either a **bare npm specifier resolved from the user's own project**
or a **local path**. Golem downloads nothing, ever — no auto-install on first use,
not even with consent. Installing is `npm install`, which the user already knows
how to audit.

`plugins.enabled` (default `true`) is a single switch that stops every plugin
loading without editing the list — the thing you reach for when a plugin is
suspected and you want it gone *now*.

### 2. A plugin may ADD to redaction. It may never remove, reorder, or replace

This is the load-bearing constraint, and it is enforced structurally rather than
by review:

- The rule table is assembled as **built-ins first, in their existing order, then
  plugin rules in load order, then the entropy sweep last** — the same shape the
  stage already documented for why provider-specific rules win the placeholder
  kind over the generic sweep.
- The registration API is **append-only**. There is no remove, no replace, no
  reorder, no "disable built-in" — those functions do not exist to be called.
  `REDACTION_RULES` itself is never handed to a plugin.
- A plugin rule's placeholder kind is **namespaced** as `<plugin-name>/<rule-id>`,
  so it cannot impersonate a built-in kind, and telemetry attributing a redaction
  to a plugin says which plugin.
- Registration happens **once, at startup, before the process serves anything**.
  This is not decoration: redaction must be a pure function of its input for
  prompt-cache prefix stability (verification-notes §14), so a table that could
  change mid-process would break caching for every downstream request. There is
  no runtime `addRule`.

**Proof obligation, tested:** for any input, the output of redaction with plugin
rules loaded contains no secret that the built-in table would have caught. Since
built-ins run first over the same text and the plugin table is a suffix, a plugin
rule can only ever redact *more*. A plugin rule that matches something a built-in
already replaced sees a placeholder, whose `[`/`]`/`:` characters no rule's
charset matches.

### 3. A plugin pipeline stage runs after redaction, and redaction runs again after it

A plugin stage never sees unredacted content, and — because a stage returns a new
body — **redaction is re-run over whatever it returned**. Redaction is idempotent
(placeholders are outside every rule's charset), so the second pass is free of
side effects and cannot renumber anything; what it buys is that a plugin stage
cannot introduce unredacted content into the request, whether by fetching it,
constructing it, or restoring it from somewhere.

That is the strongest available answer to "can a plugin weaken redaction through
the stage seam": not "we checked the code", but "the stage's output is redacted
too".

### 4. Absence and failure are no-ops, never error paths

- A specifier that does not resolve: recorded as a problem, skipped, session
  continues.
- A module whose export is not a valid plugin: skipped.
- `setup()` throws: that plugin contributes nothing, the others still load.
- A plugin *stage* throws at request time: the stage is skipped for that request
  and the pre-stage body is used. A plugin never fails a user's request.
- A plugin *rule* throws inside `validate`: the match is treated as "not a
  secret" — the same as a built-in validator returning false — and the rest of
  the table still runs.

Every problem is surfaced by `golem plugin` and counted, because a plugin that
silently does nothing is the failure mode this project keeps rediscovering.

### 5. What we deliberately do NOT do

- **No timeout on a plugin regex.** A pathological pattern (catastrophic
  backtracking) can hang the proxy. JavaScript regex execution is synchronous and
  cannot be interrupted; there is no honest mitigation short of a subprocess.
  Stated here rather than pretended away. `golem plugin` names the risk.
- **No capability list, no permission prompts per plugin.** They would be
  theatre: the plugin can do the thing regardless of what it declared.
- **No `golem plugin install`.** Installing third-party code is `npm`'s job, and
  `golem pkg`'s consent gate exists for tools Golem *spawns*, which is a different
  trust model. Offering an install verb here would imply a vetting Golem does not
  perform.
- **No marketplace, no registry service, no auto-update.** Out of scope by the
  task, and each would convert an explicit trust decision into an implicit one.

## Threat model

| Threat | Mitigated? | Why / what actually stops it |
|---|---|---|
| Plugin exfiltrates secrets it sees in a redaction rule | **No** | It has full process authority. The user chose to load it. This is the residual risk the ADR exists to state. |
| Plugin reads the R9.3 reversible-redaction map | **No** | Same process. It would have to reach the object, which is a local in a closure and not exported — an obstacle, not a boundary. |
| Plugin *weakens* built-in redaction | **Yes, structurally** | Append-only registration; built-ins always run first; no remove/reorder/replace API exists; `REDACTION_RULES` is never passed out. |
| Plugin *reorders* redaction after compression | **Yes, structurally** | Plugins cannot register a stage before redaction. Stage order is fixed by the pipeline, not by the plugin. |
| Plugin stage smuggles unredacted content into the request | **Yes** | Redaction re-runs over the stage's output. |
| Plugin breaks prompt-cache prefix stability | **Yes** | Rules are registered once at startup; there is no runtime mutation path. A plugin rule is as deterministic as a built-in or it is not a pure regex + validator, which is all the shape allows. |
| Plugin impersonates a built-in placeholder kind in telemetry | **Yes** | Kinds are namespaced `<plugin>/<rule>`; ids are charset-validated. |
| Plugin MCP tool shadows a built-in tool | **Yes** | A name collision with a built-in is rejected at registration. |
| Plugin loaded without the user knowing | **Yes** | Default `[]`, no discovery, no auto-download; `golem plugin` lists what loaded and from where. |
| Plugin hangs the proxy with a pathological regex | **No** | Stated in §5. No honest in-process mitigation. |
| Supply-chain compromise of a plugin's npm package | **No** | Identical to any dependency the user installs. Pin it; audit it; `plugins.enabled: false` turns everything off. |

The pattern in that table is deliberate: **every "yes" is a structural property of
the seam, and every "no" is a property of the runtime that Golem states rather
than obscures.** No row is mitigated by "we reviewed the plugin".

## Consequences

- Redaction gains an append-only extension point. `REDACTION_RULES` remains the
  single audited built-in table (T-C3), and the T-C3 corpus continues to govern
  built-ins only — a plugin's rules are the plugin author's audit surface, which
  `golem plugin` says out loud.
- `src/interfaces/` is unchanged. The plugin contract lives in non-frozen
  `src/plugins/types.ts`; if it stabilises it can be promoted later, and promoting
  it then is cheaper than freezing a first draft now.
- The proxy and the MCP server both grow an optional dependency on a loaded plugin
  set, defaulting to none, so an install with no plugins behaves byte-identically
  to one built before this ADR.
- Golem now has two extension surfaces with deliberately different answers to
  "how much do I have to trust this": `golem pkg` (a subprocess, a real boundary,
  consent-gated installs) and `golem plugin` (no boundary, no install). Keeping
  them separate — Decision 53(g)'s original call — is what lets each tell the
  truth.

## Alternatives considered

**Subprocess plugins with an IPC contract.** A real boundary, and rejected for
this task only because a redaction rule must run *inside* the pass: a per-rule
IPC round trip on every request, for a stage that already runs over every string
in the body, is not viable. Anything that can tolerate a process hop should be a
`golem pkg` tier-2 tool instead, and that route already exists.

**WASM-compiled rules.** A genuine sandbox for the *pure* seam (a regex has no
business touching the filesystem), and the most promising future direction — a
plugin that only adds redaction patterns does not need JavaScript at all. Not
built here: it needs a compilation toolchain the user would have to run, and it
solves only one of the three seams. Recorded as the successor to this ADR rather
than as a gap.

**Declarative-only redaction rules (a JSON/YAML pattern file, no code).** Covers
the majority use case — "our key prefix is `ACME-`" — with *no* code loading and
therefore no ADR needed at all. This is strictly safer and strictly less capable
(no `validate`, so no Luhn-style checks). It is the right default for most users
and is a natural follow-up; it does not remove the need for this ADR, because
pipeline stages and MCP tools are code by definition.
