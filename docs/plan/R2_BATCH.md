# R2 batch — Real savings, evidence-gated

> **Written 2026-07-11**, spun up per `ROADMAP.md`'s post-batch instruction
> ("spin R2 into its own batch brief only after R1.1's A/B numbers are
> recorded") once R1 (R1.1–R1.7) landed. Self-contained — read top to bottom
> before picking a task. `ROADMAP.md` is the multi-release view;
> `IMPLEMENTATION_PLAN.md` is the workstream/interface reference; the spec
> Decisions Log (`docs/edge-offload-spec.md`) is authoritative.

R2's theme: **every build here is gated on R1.1's measurement, no repeat of
the §31 artifact** (ROADMAP). R1.1 landed with a null result on Anthropic
(verification-notes §54: levels 1/3 are pipeline-identical there today), so
R2's real work is finding where a live A/B signal *can* exist and proving it
before building anything that claims savings.

**Kickoff prompt** (paste when you start a session): *"Read
docs/plan/R2_BATCH.md and continue with the next unblocked task. For every
task follow the Opening moves in §1 — wiki + knowledge-base + local-model
(`delegate`) first — before writing code or reaching outside the project."*

## 0. Session setup (once, before the first task)

1. Read `CLAUDE.md` and `CLAUDE.local.md` — hard rules override this file.
   Key ones for R2: **frozen interfaces need contract tests + cross-workstream
   flagging before changes** (R2.3 explicitly needs a new one); proxy
   byte-fidelity at level ≤1 never regresses; cross-platform always.
2. `golem slider 1` if a prior session left it elsewhere.
3. Wiki-first ladder: `wiki_read "WIKI"` → `search` → external, same as R1.
4. `delegate`-first for code/prose drafts, same as R1.

## 1. Batch-wide definition of done (every task)

Identical to `R1_BATCH.md` §1 — wiki/KB/delegate opening moves, full
`tsc`/`lint`/`format:check`/`test` gate, hard rules honored, drive the real
flow (not just tests — R1.1's gzip bug was invisible to fixtures by
construction, the same risk applies here), conventional commit(s) per task
ID, wiki debrief + `WIKI.md` index line (standing approval for THIS batch,
same terms), log-and-move-on if blocked.

**One R2-specific addition:** any task that touches `src/interfaces/` (R2.3
is the likely one) needs contract tests written FIRST and the PR description
must flag every dependent workstream, per CLAUDE.md's hard rule — don't skip
straight to the implementation because the batch brief describes the shape.

## 2. Tasks, in dependency order

### R2.5 (🔬) — Verify Headroom `read_lifecycle` disable — ✅ DONE 2026-07-11

Resolved: disabling it is possible but not the right lever (the cache-risky
half is already off by default; the library's real cache-safe mechanism is
proxy-only and architecturally out of reach for Golem's sidecar topology).
See verification-notes §58, `debriefs/2026-07-11-R2.5.md`. **This unblocks
R2.6's shape**, which is now specified below, not "build if R2.5 clears" —
it cleared, with a different answer than either branch ROADMAP anticipated.

### R2.6 (🛠️) — Cache-safe structural tier: re-enable default `compress()` on Anthropic, prove it net-safe — ⚠️ PARTIAL 2026-07-11

Mechanism + measurement infra shipped: opt-in `compression.force_semantic_on_caching`
settings leaf, an `isCachingUpstream()` bypass scoped to the semantic pipeline
stage only (the gate function itself is untouched), a `semanticForced`
telemetry tag, and `aggregateUsageBySemanticForced`/`semanticForcedReportRows`
reusing R1.1's exact `effectiveInputTokens` formula. Full gate green (`tsc`,
Biome, 738/738 vitest). **The live real-traffic A/B (step 2 below) was
deliberately NOT run** — it requires restarting the golem proxy this
session's own Claude Code traffic depends on, a live change to shared
infrastructure judged too risky to make unilaterally mid-session. Gate
defaults OFF until that follow-up produces a real number. See
verification-notes §60, `debriefs/2026-07-11-R2.6.md`.

**Why:** R2.5 found the current default Headroom `compress()` call (stale-Read
replacement + `CacheAligner` + `ContentRouter`, `compress_superseded` already
off) is Headroom's own conservative, cache-aware configuration — the thing
Decision 31 blanket-disabled on Anthropic via `isCachingUpstream()` was a
coarser gate than the risk actually requires. R1.1 already built the exact
measurement infra (`UsageSniffer`, `aggregateUsageByLevel`) this needs and
found nothing to point it at yet — this is where it points.

**What to build:**
1. A new opt-in path that runs the existing `semanticCompression` stage on
   Anthropic hosts too (bypass — not remove — `isCachingUpstream()`'s gate
   for this specific configuration), gated behind its own flag so it can be
   A/B'd against the current gate-off behavior without a permanent slider
   change yet.
2. Run real Claude Code traffic both ways (gate-on vs gate-off-for-this-tier)
   and compare **billed** `cache_read_input_tokens` totals via the existing
   `UsageSniffer`/`aggregateUsageByLevel` machinery — the honest metric R1.1
   established, not gross tokens.
3. If net-positive (or at least not net-negative) across enough requests to
   be credible: propose flipping the gate for this configuration specifically
   (spec Decisions Log entry — this modifies Decision 31's gate, needs a
   decision memo, not a silent code change) and update the slider's level
   table docs/status output accordingly.
4. If net-negative or inconclusive: document why and leave Decision 31's gate
   as-is — a negative result here is still the deliverable.

**Read first:** verification-notes §58 (this task's own gate), §54 (R1.1 —
the infra to reuse), §14/§32/§34 (cache economics); `src/pipeline/pipeline.ts`
(`isCachingUpstream`), `src/proxy/usage-sniffer.ts`,
`src/telemetry/usage-report.ts`, `src/compression/headroom-worker.py`.
**Wiki writes:** debrief; update the R1.1 synthesis page or add a new one
with the A/B result (plan-gated, propose first).
**Size:** medium — mostly a scoped flag + real-traffic measurement, not new
architecture. **Interfaces:** none frozen touched if done as an internal
gate bypass rather than a `policy.ts`/`SliderPolicy` change — confirm before
starting; if it does need a `policy.ts` change, that's contract-tests-first.
**Local model:** draft the A/B results write-up.

### R2.1 (🔬) — Decision 24 spike: measure real `avoidedUpstream` volume — ✅ DONE 2026-07-11

Resolved, but not with a clean go/no-go: `search`/`fetch`/`ingest`/
`wiki_read` MCP tool calls carry **no telemetry at all** today, so the
direct number R2_BATCH asked for can't be produced from real data yet. The
one real instrumented proxy signal — the CCR reference-swap/`expand`
mechanism — shows **0 retrievals against 1051 stored refs** across this
repo's whole telemetry history: encouraging, but it measures tool-output
dedup, not KB-answer substitution. See verification-notes §59,
`debriefs/2026-07-11-R2.1.md`, `syntheses/r2.1-avoidedupstream-spike.md`.
**This reshapes R2.2**: it should ship its own `avoidedUpstream` telemetry
bucket from day one (see below) rather than treating R2.1 as a prior
green-light gate — R2.1 found the *instrument* doesn't exist yet, not that
the opportunity doesn't. R2.3 stays gated behind R2.2, now for a confirmed
reason (zero telemetry basis for the aggressive sub-mode), not just
sequencing convention.

### R2.4 (🛠️) — Fix the `expand`↔Headroom-CCR gap — ✅ DONE 2026-07-11

Confirmed root cause from the pinned `headroom-ai==0.30.0` source: every
elision transform's `hash=<hex>` marker is a reproducible SHA-256/MD5-prefix
digest of the pre-elision content, keyed into Headroom's own in-process
store that Golem's TS `CcrStore` never receives. Fixed with
`backfillHeadroomCcrRefs` (`src/compression/headroom-ccr-bridge.ts`): diffs
the semantic stage's pre/post messages, verifies each `hash=` marker against
SHA-256/MD5 of the replaced content, and backfills Golem's own `CcrStore`
under that exact hash — no marker-text rewriting, so the existing `expand`
path resolves it unchanged. Wired via a new non-frozen
`GolemPipelineOptions.headroomCcrStore` option; `src/cli/proxy-runtime.ts`
points it at the same `.golem/ccr` directory the proxy and `expand` already
share. `tsc`/Biome/vitest all green (79 files, 748 tests — 18 new/extended
for this fix). See verification-notes §61, §38,
`debriefs/2026-07-11-R2.4.md`.

### R2.2 (🛠️) — Context-substitution (conservative sub-mode)

**R2.1 cleared** (with the reshaped finding above) — proceed. Since R2.1
found the CCR-adjacent signal encouraging but no direct telemetry for
KB-answer substitution, treat the new `avoidedUpstream` bucket below as
part of this task's deliverable, not an afterthought — it's the
measurement instrument R2.1 couldn't build standalone.

**What to build (per spec Decision 24, sub-mode 1):** when a request
references material already in the KB/web-cache, replace that span with a
compact reference the model can `expand`/`fetch`, behind the compression
seam + a new `avoidedUpstream` telemetry bucket (same durable-JSONL pattern
as `recordRetrieval` in `src/telemetry/index.ts`). Must obey byte-stability/
cache rules (§14) — only elide spans NOT in the stable cached prefix, or
accept a miss only when the net saving beats it.

**Read first:** spec Decision 24 sub-mode 1; R2.1's findings;
`src/interfaces/compression.ts` (confirm this fits the existing
`CompressionService` contract as the spec expects, or flag if it doesn't).
**Wiki writes:** debrief.
**Size:** medium-large. **Interfaces:** likely fits behind the existing
frozen `CompressionService` contract per Decision 24's own scope note —
confirm before assuming no contract-test work is needed.

### R2.3 (🛠️🔒) — Local-answer sub-mode contract + recorded-shape tests

**Gated on R2.2 landing first** (R2.1 cleared, with a reshaped finding: see
above) — this is the aggressive, opt-in, highest-risk sub-mode
(proxy-as-responder, skips the upstream entirely), and there is currently
zero telemetry basis for it (verification-notes §59) until R2.2's
`avoidedUpstream` bucket has real data to look at.
Decision 31 removed the old `localResponse` seam (Decision 25's mechanism),
so this **re-introduces a proxy-response path from scratch as its own new
contract** — not a revival of the deleted code.

**What to build:** a new frozen interface/contract (contract tests FIRST,
per CLAUDE.md) for a proxy-as-responder path: confidence-gated KB-composed
answers for retrieval-shaped turns, never fabricated, clearly labeled in the
transcript (mirroring Decision 25's old labeling convention:
*"**Golem** Used \<model\> locally — verify independently."*), never the
default, opt-in only. Full recorded-shape test coverage before this ships
even behind a flag.

**Read first:** spec Decision 24 sub-mode 2, Decision 25 (the retired
precedent — read for the labeling/escalation pattern, not the removed code),
Decision 31 (why it was removed); `src/proxy/types.ts`,
`tests/integration/helpers/anthropic-fixtures.ts`.
**Wiki writes:** debrief; a decision memo if this changes spec scope.
**Size:** large; do last. **Interfaces:** NEW frozen contract — flag every
dependent workstream in the PR description per the hard rule.

## 3. Deferred (do NOT start without asking the user)

- R3, R4, R5 and everything they contain (already indexed to WS-F/C4/W4 —
  see `IMPLEMENTATION_PLAN.md` §7's crosswalk).

## 4. Post-batch

When R2 lands (or stalls on a gate): mark tasks done in `ROADMAP.md`, fold
R2.6's A/B result into golem.run copy if it changes the situational-savings
claim, and only then consider spinning R3 into its own batch brief.
