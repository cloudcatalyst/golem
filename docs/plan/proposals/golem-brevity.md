# Proposal: Golem brevity — decouple the slider into independent dials, add an output-side brevity dial

> **Status: SHIPPED (2026-07-30) for increments B1–B4; Workstream B deliberately
> NOT shipped.** Accepted by the user the same day it was proposed; spec entry is
> Decision 52 (ACCEPTED). Kept as the verified design record — the authoritative
> entry is Decision 52 in `docs/golem-spec.md`.
>
> - **B1–B4 landed:** the `brevity` dial on the frozen `SliderPolicy` (with the
>   redaction safety clamp), the marker-fenced injection stage, settings +
>   `SETTING_META` + `golem brevity` / `golem compression` + provenance on every
>   display, and the `UsageByBrevity` rollup behind `golem stats --brevity`.
> - **The dial ships OFF**, as this document required: `brevity.level` defaults to
>   a pinned `"off"` and `sliderPolicyForLevel` defaults the dial to `off` rather
>   than `auto`, so no pre-existing caller acquired a new output-mutating stage.
> - **Workstream B (tool-description shrinking) is scoped but unbuilt** —
>   measured at ~900 tokens of headroom, blocked on a tool-selection-accuracy
>   harness. Full reasoning in `verification-notes.md` §88; tracked in
>   `BACKLOG.md` (row 2026-07-24, now `discussed`).
>
> Companion external findings: `verification-notes.md` §87 (Caveman) and §88
> (the tools-block census).
>
> _Original proposal below._
>
> **Status: PROPOSED (2026-07-30), USER-REQUESTED.** Design-first: nothing frozen
> changes until this is signed off. Spec entry: Decision 52 (PROPOSED).
> Companion external findings: `verification-notes.md` §"Caveman (2026-07-30)".
>
> **Four design questions were answered by the user up front** and are treated as
> settled below: brevity is **never implied at slider ≤1**; profiles ship as
> **bundled data, not a wrapped upstream package**; an explicitly pinned dial
> **wins and sticks** over the combined slider; and tool-description shrinking is
> **in scope as a second workstream**.

## Problem

The slider is one dial driving one family of behaviour — input-side compression —
and on this project's primary upstream it currently does very little above level 1.

Two facts from the code, not from the docs:

- `compression.headroom_sidecar` defaults to **`false`** (`src/config/schema.ts`),
  because the sidecar needs `uv` + `headroom-ai` on the machine and CLAUDE.md
  forbids heavy default deps.
- The lossy semantic stage is **gated off on caching upstreams** by default
  (`upstreamAssumesCaching` in `src/providers/index.ts`, Decision 31), unless the
  research-only `compression.force_semantic_on_caching` is set.

So against Anthropic with stock settings, slider 2 and 3 differ from slider 1
mainly in *intent*, not in effect. Decision 23 already recorded the underlying
economics: compression pays ~0% on cached traffic. The slider is therefore a dial
whose top half is inert on the traffic we actually send.

Meanwhile there is a whole axis Golem does not touch: **output tokens**.

## What Caveman actually is (verified 2026-07-30)

`github.com/JuliusBrussee/caveman` — MIT, no telemetry, no backend. It is **not**
a compression library and does not transform the request payload. Installation
"drops a skill file into your agent" that "tells agent: drop filler, keep
substance, use fragments — but never touch code, commands, or errors." The model
then complies at generation time.

| | Headroom (slider today) | Caveman |
|---|---|---|
| Side of the request | **input** tokens | **output** tokens |
| Mechanism | transforms the payload in-pipeline | injects a prompt; the model complies |
| Cost | CPU | **adds ~1–1.5k input tokens/turn** (its own claim) |
| Delivery | library / Python sidecar | skill file + a session flag file per agent |

Its README puts "input tokens saved" at **0%** and volunteers that savings "can go
net-negative" on terse workloads. Levels are `lite` / `full` (default) / `ultra` /
`wenyan` (classical Chinese). Two adjacent components are *not* the speech skill:
`/caveman-compress` rewrites memory files (input-side, one-off), and
`caveman-shrink` is "MCP middleware. Wraps any MCP server, compresses its tool
descriptions" (input-side, per-request) — see Workstream B.

**So the user's instinct is right but the mechanism is different from what the
framing implies.** This is not a second compression stage; it is a
**request-mutation stage that steers output verbosity**.

## Why it is worth building anyway — better economics than the dial we have

Verified against current pricing (`claude-api` skill, Opus 5: $5/MTok input,
$25/MTok output; cache read ≈ 0.1× input):

- output tokens cost **5× uncached input** and **~50× cache-read input**
- output tokens are **never cached** — there is no cache-read discount to erode
- the directive's own input cost lands in the *cached* prefix after the first turn,
  i.e. at ~0.1× rates

Decision 23's finding — compression pays ~0% on cached traffic — is a statement
about the **input** side, and it does not transfer. A brevity dial attacks the one
axis where Anthropic's caching does not blunt the saving. Plausibly this is the
first dial that actually pays on our main upstream.

That is a hypothesis with a clear falsification test, not a claim: see
§Observability. We do not repeat the vendor's "65%".

## Design: three dials, slider becomes a preset over two of them

```
compression.level : 0..3                  input side  — what the slider drives today
brevity.level     : off|lite|full|ultra   output side — new
slider            : 0..3                  combined preset; sets both, each pinnable
```

`wenyan` is **excluded** — it changes the response language, which breaks
readability for the user and any downstream parsing. Not a candidate.

### Preset table (sensible defaults)

| slider | `compression` | `brevity` | rationale |
|---|---|---|---|
| 0 passthrough | off | off | Decision 30: nothing runs, redaction included |
| 1 lossless | lossless | **off** | see below |
| 2 balanced | balanced | lite | |
| 3 aggressive | aggressive | full | |
| *(never a preset)* | — | ultra | explicit opt-in only |

**Why brevity is off at level 1 (USER DECISION).** The CLAUDE.md fidelity rule is
about the *response* path ("SSE streaming and tool-use blocks pass through
byte-faithful"), and level 1 already mutates the request (redaction + lossless
compaction) — so injecting a directive would not literally violate it. It is
excluded on a stronger ground: level 1 is sold as **semantics-preserving**.
Compression at L1 changes bytes without changing meaning; a brevity directive
changes *what the model says*, which every user notices immediately. The default
install must not start answering in fragments. Level 1 stays a dial nobody has to
think about.

### Pin semantics (USER DECISION: pin wins and sticks)

Each dial is tri-state: `auto` (follow the slider) or a pinned value. Setting a
dial directly pins it; the slider stops driving that dial until `golem brevity
auto` / `golem compression auto`. Explicit beats implicit.

Cost of this choice, accepted: every surface must render provenance, e.g.
`slider 2 (balanced) · brevity pinned: ultra`. That is three displays
(`golem status`, statusline, VS Code panel) plus the `level` MCP tool's response.

The alternative — slider always overwrites — was rejected: silently discarding a
deliberate choice is the behaviour people file bugs about.

## Where it lands in the code

### Frozen contract: `src/interfaces/policy.ts`

`SliderPolicy` gains a sibling to `stages`, not a new key inside the frozen
`StageConfig`:

```ts
export type BrevityLevel = "off" | "lite" | "full" | "ultra";

export interface SliderPolicy {
  readonly level: SliderLevel;
  readonly stages: StageConfig;
  readonly brevity: BrevityLevel;   // NEW
  readonly overrides: Readonly<Record<string, unknown>>;
}
```

Riding in `overrides` (`{"brevity": "lite"}`) was considered and rejected: it is a
first-class dial, and an untyped key every consumer has to know about is worse than
a contract change. This is a **frozen-contract change** — it requires updating
`tests/contract/policy.contract.test.ts` and flagging every dependent workstream in
the PR description (CLAUDE.md hard rule).

`sliderPolicyForLevel` gains the preset mapping; the pin is resolved by the caller
that reads settings, so the pure function stays pure.

### New pipeline stage

Runs **after** redaction (hard rule: redaction is never reordered) and after
compression. Properties, all load-bearing:

- **`system` block only.** Never into `messages` — so tool-use blocks and the SSE
  response path are untouched, and the byte-faithful guarantee is unaffected.
- **Byte-stable per level.** The existing determinism requirement
  (`compression.ts`: "re-compressing a previously-sent message prefix MUST
  reproduce byte-identical output") extends to the directive. Fixed text per level,
  no interpolation, no timestamps.
- **Marker-fenced.** A sentinel wrapper makes the block detectable, so it is never
  doubled — including when the user has Caveman's *own* skill installed in Claude
  Code. Detect the marker (ours or theirs) and skip.
- **Skipped entirely at level 0**, and whenever `brevity` resolves to `off`.

Prompt-cache consequence, verified: the render order is `tools` → `system` →
`messages`, and any prefix byte change invalidates everything after it. So changing
brevity level invalidates the conversation's cached prefix **once**, then it is
stable. Acceptable, but it must be *stated* on the level-change surfaces rather
than discovered.

### Settings (`src/config/schema.ts` + `ui-model.ts`)

New keys, following the documented conventions (`snake_case`; env
`GOLEM_<SECTION>_<KEY>`):

```
brevity.level        → GOLEM_BREVITY_LEVEL        ("auto" | off | lite | full | ultra)
compression.level    → GOLEM_COMPRESSION_LEVEL    ("auto" | 0..3)
```

**Decision-50 constraint to honour:** `src/config/ui-model.ts` holds a
`SETTING_META` table annotated `satisfies { [P in LeafPath]: SettingMeta }` — adding
a settings key without describing it is a **compile error**. Both new keys need
label/summary/detail/`restart` metadata, and both want `ownedBy` set so a runtime
control (not a raw settings row) owns them, exactly as `slider.level` does today.

### Surfaces to update

`golem brevity <level|auto>`, `golem compression <level|auto>`, `golem slider`
(unchanged verb, now a preset), `golem status`, the statusline, the VS Code panel
and status bar, and the `level` MCP tool. This is the bulk of the work and it is
mostly mechanical, sitting on the one control surface Decision 50 built.

## Observability — the part that decides whether this ships

The machinery mostly exists. `src/telemetry/types.ts` already records
`UsageTotals.outputTokens` from the upstream `usage` block, already rolls up
per-level (`UsageByLevel`), and already has an A/B rollup precedent
(`aggregateUsageBySemanticForced`, built for the R2.6 Decision-31 question). So:

1. **Add `UsageByBrevity`**, mirroring `UsageByLevel`, bucketed by the brevity
   level in force for that sample. Reuse the R2.6 shape rather than inventing one.
2. **`CompressionStats` has no output axis** (`tokensBefore`/`tokensAfter` only) —
   that is the one genuine gap. Either extend it (frozen contract) or keep brevity
   reporting entirely in the telemetry store and off `CompressionStats`. **Prefer
   the latter**: `CompressionStats` describes the compression pipeline, and brevity
   is not part of it. One less frozen contract to touch.
3. **Report observed medians per level, labelled as estimates.** Never a single
   headline percentage, and never the vendor's number.
4. **Report the cost side in the same breath**: the measured input tokens the
   directive adds per turn (measure it; do not take ~1–1.5k on faith), and the
   one-off cache invalidation per level change.

The honest framing: this is an **observational** comparison across samples, not a
per-request A/B — the same request cannot be run both ways. Report it as such.
`force_semantic_on_caching` is the precedent for "ship the dial off, prove it with
a real rollup before believing it."

## Risks

- **Quality in an agentic loop.** Claude Code's own output quality partly rides on
  its prose reasoning; forcing fragments may degrade plan quality — and this repo
  dogfoods itself, so it would degrade our own signal too. Mitigation: never
  default above `lite`; `ultra` explicit-only; the dial is trivially reversible.
- **Self-reported accuracy.** "Technical accuracy 100%" and "code, commands,
  errors byte-for-byte exact" are the vendor's claims about a *prompt*, i.e. a
  best-effort instruction with no enforcement. Treat them as unverified. The
  redaction and fidelity guarantees are ours and are unaffected — this stage cannot
  weaken them, because it only appends to `system`.
- **Doubling with an installed Caveman skill.** Handled by marker detection above.
- **Net-negative on terse workloads.** The vendor volunteers this. It is exactly
  what the per-level rollup is for.

## Workstream B — tool-description shrinking (`caveman-shrink` equivalent)

Scoped here, **separate task**, under the *compression* dial rather than brevity.

The observation: Golem's proxy sees the entire `tools` array on every request, and
an agentic Claude Code request carries a large, near-constant block of tool
descriptions. Compressing that block is:

- **input-side** — the axis Headroom already owns, so it belongs on
  `compression.level`, not `brevity.level`;
- **deterministic** — a fixed transform over a fixed input, so it satisfies the
  cache-stability requirement outright;
- **cache-friendly** — `tools` renders *first*, so a stable transform keeps the
  whole prefix stable; an unstable one invalidates everything. This is the single
  biggest risk and the reason it must be its own design.

Open questions that make it a separate piece of work, not a sub-task:

1. Lossless or lossy? A tool description is *instructions to the model* — shrinking
   it can change tool-selection behaviour, which is a correctness question, not a
   token question. Needs its own measurement (does tool-choice accuracy hold?).
2. Which level does it attach to — is it lossless (level 1) or lossy (level ≥2)?
   Depends on (1).
3. Interaction with the 1024-token cacheable minimum and the 20-block lookback:
   shrinking the prefix can push a prompt *below* the cacheable minimum, turning a
   token saving into a cache loss. Must be checked, not assumed.
4. Golem is *also* an MCP server with 7 tools of its own — its own descriptions are
   in scope, and that part is a pure content edit needing no pipeline work at all.

Recommendation: do (4) opportunistically whenever the tool docs are touched; treat
(1)–(3) as a proper R-task with its own verification note.

## Increments

- **B0 (this document).** Design + Decision 52 PROPOSED + verification note. No code.
- **B1.** `policy.ts` brevity dial + contract tests + preset table. Frozen-contract
  PR, dependents flagged. No injection yet.
- **B2.** The injection stage, marker-fenced and byte-stable, plus recorded-shape
  integration tests proving the response path is untouched.
- **B3.** Settings + `SETTING_META` + pin resolution; `golem brevity` /
  `golem compression`; every display renders provenance.
- **B4.** `UsageByBrevity` rollup + `golem stats` reporting with the cost side.
  **Ship the dial defaulting to `off` until B4 produces a real number.**
- **B5.** Workstream B, on its own design.

## Not doing

- `wenyan` (breaks readability and downstream parsing).
- Wrapping or invoking the upstream installer (`install.ps1` / `claude plugin
  install`): it writes skill files and hooks into *specific agents*, which is the
  wrong layer for a proxy. Golem injects in-flight and covers every client with
  zero dependencies. The profile text is vendored with MIT attribution instead
  (USER DECISION: bundled profile data).
- A separate `golem-run-brevity` npm package. Considered; rejected for now as a
  second thing to publish and a lazy-load failure mode, for profiles that are a few
  hundred bytes of text.
