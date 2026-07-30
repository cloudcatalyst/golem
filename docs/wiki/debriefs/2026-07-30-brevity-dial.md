---
title: Brevity dial — the slider becomes a preset over two independent dials
type: debrief
tags: [brevity, slider, compression, decision-52, telemetry, output-tokens, caveman, proxy]
sources: [docs/golem-spec.md, docs/plan/proposals/golem-brevity.md, docs/plan/verification-notes.md, docs/plan/BACKLOG.md]
created: 2026-07-30
updated: 2026-07-30
---

# Brevity dial — the slider becomes a preset over two independent dials

Shipped **spec Decision 52** in one day: proposed, accepted, and landed as
increments B1–B4. The slider is no longer a single dial driving input-side
compression — it is a **preset over two independent, pinnable dials**,
`compression.level` (input) and the new `brevity.level` (output). Suite ended
**1640 green** across 147 files; `tsc` / `biome` / `format:check` clean by exit
code throughout.

The one increment deliberately **not** built is Workstream B (in-flight
`tools`-block shrinking) — see [[#What was not built, and why]].

## The idea, and the correction that made it better

The request was to put Caveman's `lite`/`full`/`ultra` levels on the slider "like
we do Headroom compression". Checking the source first (verification-notes §87)
found that framing is wrong in an important way:

| | Headroom (the slider today) | Caveman |
|---|---|---|
| Side | **input** tokens | **output** tokens |
| Mechanism | transforms the payload in-pipeline | injects a prompt; the model complies at generation time |
| Cost | CPU | **adds** ~1–1.5k input tokens/turn |

Its own README puts "input tokens saved" at **0%**. So this is not a second
compression stage — it is a **request-mutation stage that steers output
verbosity**.

That correction strengthened the case rather than weakening it. Output tokens
cost **5× uncached input and ~50× cache-read input** and are **never cached**, so
Decision 23's finding — compression pays ~0% on Anthropic's cached traffic —
is an *input-side* result that does not transfer. Meanwhile the measurement
showed the slider's top half was already close to inert here: the Headroom
sidecar defaults off, and the lossy semantic stage is gated off on caching
upstreams by default (Decision 31). Slider 2 and 3 differed from slider 1 mainly
in intent.

**It is still a hypothesis, not a result.** The dial ships OFF behind a rollup
that can falsify it; the vendor's "65% fewer output tokens" is a claim about
their workload and is not repeated anywhere in the code or the CLI.

## What shipped

- **B1 — the frozen contract.** `SliderPolicy` gained `brevity` *and*
  `compressionLevel` (the effective level that selects `stages`), so `level`
  stays the slider's identity for telemetry and displays while a pin drives the
  stage table. Contract tests updated per the hard rule.
- **B2 — the injection stage.** `src/pipeline/brevity.ts` appends a
  marker-fenced, byte-stable directive to the `system` block **only**. Never
  touches `messages`, so tool-use blocks and the SSE path stay byte-faithful.
- **B3 — settings and surfaces.** `brevity.level` / `compression.level` with
  `SETTING_META` entries, `golem brevity` / `golem compression`, and provenance
  on `golem status`, the status line, and the VS Code panel + status bar.
- **B4 — the honest rollup.** `aggregateUsageByBrevity` + `golem stats
  --brevity`, reporting billed output tokens per level **and** the directive's
  own input cost, labelled an observational estimate.

## Four design decisions worth keeping

1. **Brevity is never implied at slider ≤1.** Not because the byte-faithfulness
   hard rule forbids it (that rule governs the *response* path, and level 1
   already mutates the request via redaction) but because level 1 is sold as
   *semantics-preserving*: compression changes bytes without changing meaning,
   whereas brevity changes what the model **says**, which users notice
   immediately. The default install must not start answering in fragments.
2. **A pin wins and sticks.** Setting a dial stops the slider driving it until
   `auto`. Every surface spells out `pinned` vs `auto` vs `default` — a pin that
   looked like a preset would be worse than no pin.
3. **The profile is vendored, not wrapped.** Caveman is MIT and its substance is
   a prompt; its installer writes skill files and hooks into *specific agents*,
   which is the wrong layer for a proxy. Injecting in-flight covers every client
   with zero dependencies. `wenyan` (classical Chinese) is excluded — it breaks
   readability and any downstream parsing.
4. **The directive goes INTO the last `system` text block**, not after it. A new
   block would land outside the client's `cache_control` breakpoint and be
   re-billed at full price every turn — inverting the economics the dial exists
   for. It is inside the cached prefix instead, so it costs ~0.1× after the first
   turn, and a level change invalidates that entry exactly once.

## Five things the guards caught that review would not have

This batch is a good advert for the repo's own invariants — every one of these
was found by a test or the compiler, not by reading the diff.

1. **The redaction safety clamp.** `LEVEL_TABLE[0]` is the only row with
   `redaction: false`. A pinned `compression.level` of 0 at slider ≥1 would have
   switched **redaction off from a config key that says nothing about
   redaction** — a hard-rule violation reachable from a settings file. Fixed in
   two layers: the zod enum omits 0 entirely, and `resolveCompressionLevel`
   clamps a pinned 0 to 1. A contract test now asserts redaction is off **iff**
   the slider itself is 0, across the whole dial space.
2. **The `auto` default was wrong.** `sliderPolicyForLevel`'s `brevity` parameter
   first defaulted to `"auto"`, which silently switched brevity on for every
   existing level-≥2 caller. The context-substitution stage tests failed
   (unexpected telemetry events) and exposed it. It defaults to `off` now: a
   caller predating this decision must not acquire an output-mutating stage by
   omitting an argument.
3. **`ownedBy` was wrong.** The design said both new keys would be `ownedBy` a
   runtime control, mirroring `slider.level`. The Decision-50 sync test rejected
   the fabricated control ids — correctly: these are ordinary settings keys
   written through `setConfig`, so they deserve normal rows *and* scope choice,
   which pinning actually wants (a pin can be a committed project decision).
4. **A duplicate identifier in the barrel.** `BrevityLevel` is both a type and a
   const, so it belongs only in the value re-export — `tsc` said so immediately.
5. **`tsc`'s exit code, not its tail.** Checked by exit code throughout, per the
   standing lesson from the #15/#16/#19 CI failures: a piped `tsc | head` reports
   `head`'s status, which is always 0.

## What was not built, and why

**Workstream B — in-flight compression of the `tools` array** (the
`caveman-shrink` equivalent) is scoped and measured but unbuilt. The census
(verification-notes §88): Golem's own 11 MCP tool descriptions cost **~902 tokens
on every request**, before any other MCP server or Claude Code's built-ins. The
headroom is real.

Every candidate transform is nonetheless one of:

- **whitespace normalisation** — lossless and worth almost nothing;
- **rewriting the prose shorter** — real gains, but a tool description is
  *instructions the model reads to decide whether to call the tool*. Shortening
  it can change tool-selection behaviour. That is a **correctness** question, and
  there is no harness here that measures tool-selection accuracy;
- **native `defer_loading` + tool-search passthrough** — no description is
  rewritten, but it changes *when* tools are visible, and it is newer than these
  notes (verify against live docs first).

Plus two cache traps that must be settled first: `tools` renders **first** in the
prefix, so an unstable transform invalidates everything downstream on every
request; and shrinking can push a prompt *below* the minimum cacheable prefix,
converting a token saving into a total cache loss with no error.

**The next step is that harness, not the transform.** Tracked in `BACKLOG.md`
(row 2026-07-24, now `discussed`).

One self-inflicted finding worth remembering: adding the Decision-52 explanation
to the `level` tool description took it from ~78 → 191 tokens. Trimmed back to
114 — still +36 for two facts worth having (the old text claimed level 3 "adds
local drafts", wrong since Decision 31). **A workstream about shrinking the tools
block began by growing it.**

## Verification

- `npx tsc --noEmit`, `npm run lint`, `npm run format:check` — all **0** by exit
  code. `npx vitest run` — **1640 passed / 147 files**. `node --test` in
  `vscode-extension/` — **47 passed**.
- New tests: 18 policy contract (dials + the redaction clamp across the whole
  dial space), 15 brevity transform, 11 brevity pipeline stage, 10 telemetry
  rollup + report rows, 4 extension render.
- Deployed locally: rebuild → `golem proxy restart` (pid 40932) → extension
  `deploy:local`. `golem status` renders `Dials: brevity off (default) ·
  compression 3 (auto — follows slider 3)`. **A live `golem mcp serve` connection
  must be reconnected** for the trimmed `level` description to take effect.
- **Not verified end-to-end against the live upstream.** The injection is covered
  by unit and pipeline-stage tests (including byte-stability turn over turn); no
  real request was sent with brevity on, because doing so would have changed this
  session's own output style mid-batch and spent quota to prove what the stage
  tests already prove. The first real measurement is the user's to take, with
  `golem brevity lite` and `golem stats --brevity`.

## Loose ends

- **The dial is unmeasured by design.** `golem stats --brevity` currently reports
  the `off` baseline only (7,464 requests at ~859 output tokens/request on this
  project). Until an on-period exists there is no comparison and no claim.
- **Workstream B needs a tool-selection-accuracy harness** before any transform.
- **Cosmetic, pre-existing:** `golem config unset` leaves an empty `{}` parent
  section behind when the last key in a section is removed. Harmless (zod
  defaults fill it) and not caused by this batch, but it is why the local
  settings file needed a manual tidy after testing.

Related: spec Decisions 23, 30, 31, 50, 52 (`docs/golem-spec.md`) · [[Dogfooding Golem]]
