---
title: Decision 53 — the dependency-tier ladder and `golem ext`
type: debrief
tags: [decision-53, ext, dependencies, headroom, caveman, rtk, audit]
sources: [src/ext/, src/cli/ext.ts, src/knowledge/extractors.ts, LICENSE, docs/plan/proposals/r8-context-economy.md, docs/plan/verification-notes.md]
created: 2026-07-30
updated: 2026-07-30
---

Workstream P of the R8 proposal, shipped first at the user's direction ("this
architecture piece comes before the other external tool improvement
suggestions"). Concept page: [[Managed Tools]].

## What prompted it

A question, not a plan: *"Is Headroom installed by Golem, and is Caveman also
installed? Are they both running right now?"* The only way to answer was to grep
the process table. That is the actual defect — the policy existed in three places
in code and nowhere in prose, and no surface reported it.

The answer, once checked: `compression.headroom_sidecar = true` in this repo and
`uv` is present, but **no Headroom process has ever run** (the lossy semantic
stage is its only caller and it is gated off on caching upstreams). Caveman is
**not installed at all**. One idle spawn target, one absent program — precisely
what tiers 2 and 3 are supposed to look like, and unreportable before now.

## What shipped

- **Spec Decision 53** — the four-part invariant, the tier ladder
  (1 / 2 / 3a / 3b), the three integration shapes, and the four-criterion
  admission bar.
- **`src/ext/`** — `manifest.ts` (nine rows of data, no behaviour), `detect.ts`
  (spawn-free), `status.ts` (pure over injected probes), `index.ts`.
- **`golem ext [list|status] [--json] [--verbose]`** via `src/cli/ext.ts`.
- **Two audit fixes:** `unpdf` made genuinely optional; `LICENSE` added.
- **45 tests.**

## Three things worth remembering

**1. "No binaries" was the wrong reading of our own rule.** The first draft of
the advice to the user leaned on "no heavyweight native deps". Checking the
precedents gave a better rule: *ship no third-party bytes*. A binary is fine as a
spawn target. That reframing is what makes RTK admissible as a peer and Caveman's
`caveman-shrink` admissible as a future ext, where the weaker rule would have
banned both for the wrong reason.

**2. Refusing to report liveness was the right call, and it is the feature.**
The obvious design was a `running: true|false` column. It would have been a lie
for the Headroom sidecars, which are spawned per use — and a *misleading truth*
for a sidecar that is enabled but structurally unreachable. The `gate` field
carries that instead, and the enabled-but-gated Headroom row is now the clearest
output on the surface. Same instinct as Decision 49 (verbatim model ids): a
display that simplifies past the truth is worse than a verbose one.

**3. A pin is not a passthrough.** The user's stated goal was to "benefit from
the native features they continue to roll out". Bumping
`HEADROOM_SIDECAR_PYPI_PIN` does **not** do that: `headroom-worker.py` is Golem's
own script, so it defines the reachable API surface, and new upstream features
need the worker edited. Naming the real coupling point changed the follow-up task
from "watch for releases" to "make the worker forward an opaque options bag".

## Corrections to earlier claims in this session

- The `unpdf` row: `optionalDependencies` does **not** shrink the default install
  (npm installs optional deps unless told otherwise). It makes absence
  *tolerable*, which is what the code now needs. Going further — devDependency
  plus an explicit `npm install unpdf` — would remove working PDF ingest from
  existing users, a regression nobody asked for. Recorded so the row is not
  mistaken for an install-size win.
- RTK's savings claim is not something we need to rebut: its README already says
  "not the same as cutting your bill" and that its token counts are `bytes / 4`
  estimates (§90). The comparison to make is against Golem's real billed `usage`,
  and the user has declined a formal A/B in favour of just running it.

## Follow-ups (not built here)

| Item | Where |
|---|---|
| `headroom-worker.py` → thin passthrough | R8 memo, Workstream P3 |
| `golem ext install/upgrade` (Tier 2 install path, with consent) | Decision 53(e) leaves it out on purpose |
| `/caveman-compress` as an ext (input-side `CLAUDE.md` rewrite) | P3a |
| Point `golem bench tools` at `caveman-shrink` instead of rebuilding | P3b, §89 |
| Assert Golem's `deny` wins against RTK's `updatedInput` rewrite | **R8.12 — §91, undocumented upstream** |
| Surface ext rows in the control panel / VS Code | unscheduled |

## Related

- [[Managed Tools]] — the concept page this decision creates
- [[Compression]] · [[Slider Levels]] — the gate behind the Headroom row
- [[Configuration Surfaces]] — where `enabledBy` keys are edited
- verification-notes §90 (RTK), §91 (hook precedence — **open**), §92 (the audit)
