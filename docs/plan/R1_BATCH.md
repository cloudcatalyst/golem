# R1 batch — Honest baseline (ship-readiness)

> **Written 2026-07-11** by the revalidation session, replacing the completed
> `NEXT_BATCH.md` (T1–T7, all landed). This is the current actionable batch and
> is **self-contained** — read it top to bottom before picking a task. The
> multi-release view is `ROADMAP.md`; the workstream/interface reference is
> `IMPLEMENTATION_PLAN.md`; the spec Decisions Log
> (`docs/edge-offload-spec.md`) is authoritative.

R1's theme: make the current build **correct, measured, and honestly
positioned** before any public / golem.run push. No new architecture, no frozen
interface changes. Two tasks (R1.1, R1.2) are the strategic gates the whole
compression story hangs on — do them first.

**Kickoff prompt** (paste when you start the session, model = Sonnet, slider = 1):
*"Read docs/plan/R1_BATCH.md and start R1.1. For every task follow the Opening
moves in §1 — wiki + knowledge-base + local-model (`delegate`) first — before
writing code or reaching outside the project."*

## 0. Session setup (once, before the first task)

1. Read `CLAUDE.md` and `CLAUDE.local.md` (repo root) — hard rules override this
   file. Key ones for R1: **never weaken redaction outside a reviewed change**
   (T-C3); proxy byte-fidelity at level ≤1; cross-platform (node:path,
   argument-array spawning, no /tmp, no POSIX signals).
2. Restore savings if a prior session left the slider at 0:
   `golem slider 1` (redaction + byte-faithful, recommended for R1 coding). Note:
   levels ≥2 (semantic compression) only do anything on a non-caching upstream —
   on Anthropic they fall back to lossless (Decision 31). **But note the redaction
   caveat below for R1.3/R1.4.**
3. **Wiki-first ladder (from CLAUDE.local.md):** for any "how does X work",
   check `docs/wiki/WIKI.md` + `wiki_read` first, then `search`, then external.
4. **Delegate-first:** use `delegate` to have the local model draft prose/code
   sketches/corpus strings before you finalize. Treat as a draft, not an answer.
5. **Redaction-work escape hatch (verification-notes §23):** R1.3 and R1.4 edit
   secret patterns. An agent whose own session is routed through the redacting
   proxy **cannot see ground-truth secret strings** (they come back
   `[REDACTED:…]`). Do redaction-corpus work from a session with
   `ANTHROPIC_BASE_URL` unset (direct Anthropic), or at minimum verify on-disk
   bytes with `grep`/byte dumps, not the model's view.

## 1. Batch-wide definition of done (every task)

**Opening moves — do these FIRST on every task (wiki + KB + local-model-first):**

1. `wiki_read "WIKI"` for the index, then read the wiki pages the task names.
2. `search` the task's topic before touching code or any external source
   (graph-first: wiki/title hits rank ahead of vector hits); `fetch` a hit's
   full text when needed.
3. Only if the wiki/KB come up empty, go to WebFetch / external docs — a
   previously-fetched URL is served from cache automatically.
4. `delegate` a first draft of the change (code sketch, prose, corpus strings)
   to the local model, then review and finalize it yourself — never ship the
   draft verbatim. **`delegate` is the only path that engages the local model at
   any level, so call it explicitly** — the slider is a compression dial only
   and never auto-drafts (Decision 31).
5. Learned something durable? Propose a wiki page/update (plan-gated) in the
   debrief step rather than letting it evaporate.

- `npx tsc --noEmit`, `npm run lint`, `npm run format:check`, `npm test` all
  clean. Contract tests BEFORE implementation when a task adds an interface.
- Hard rules honored (see §0.1). Redaction changes are T-C3-gated: extend the
  corpus/audit tests with the new NEGATIVE cases AND prove every existing
  POSITIVE (real-secret) case still redacts; call the change out prominently in
  the commit; note the cache-prefix implication (emitted bytes change for
  affected inputs, like `COMPACTION_VERSION`).
- Verify by driving the real flow, not just tests. Rebuild + restart to test
  live: `npm run build`, then `golem proxy restart` if the proxy is involved.
- Conventional commit(s) with the task ID (e.g. `fix(pipeline): R1.3 …`), one
  task per commit series, Co-Authored-By trailer per harness default.
- Wiki debrief `debriefs/2026-MM-DD-R1.N.md` + `WIKI.md` index line (standing
  approval for THIS batch, same terms as the prior batch). Any OTHER wiki write
  still needs the normal plan gate.
- If blocked on an unresolved unknown: write the dated question into
  `docs/verification-notes.md` AND `docs/wiki/questions/`, then take another
  task — don't guess.

## 2. Tasks (recommended order — do R1.1 and R1.2 first)

### R1.1 (🔬 gate) — Net-of-cache savings A/B measurement

**Why:** the #1 strategic gate. Decision 23 / verification-notes §30–§36
established that gross input-token reduction is meaningless on a **caching**
upstream — dropping/reshaping history changes prefix bytes and can flip a 0.1×
cache read into a 1.0× miss on the whole suffix (net-negative). **No savings
number may ship until the NET-of-cache effect is measured live.**

**Deliverable (measurement, not a feature):** a dated `verification-notes.md`
entry + a `syntheses/` wiki page reporting real billed token accounting from
live traffic, with and without the Headroom sidecar (slider ≤1 vs ≥2), across
enough requests to be credible. The honest metric is the upstream response's
`usage` block: `input_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`, `output_tokens` — compare **total billed cost**, not
gross forwarded tokens.

**Approach sketch:** the proxy already sees every upstream response. Capture the
`usage` block from real responses into telemetry (small additive field in the
JSONL event — keep old lines parsing) so an A/B can be computed from recorded
data rather than eyeballed. Run a representative real Claude Code session at
level 1 (byte-faithful, cache intact) and again at level 3 (Headroom on), or
alternate per-request, and tabulate billed cost each way. Watch the §37 lesson:
attribute reduction to the right stage, don't let redaction masquerade as
compression.

**Read first:** verification-notes §14, §30–§32, §34, §36, §37; `src/proxy/`
(response path), `src/telemetry/jsonl-store.ts`, `src/pipeline/` (stage events).
Wiki: `wiki_read "Redaction Stage"`; search "savings telemetry cache".
**Wiki writes:** debrief; the `syntheses/` A/B page.
**Size:** medium (mostly measurement + a small telemetry field). **Local model:**
draft the results-table prose.

### R1.2 (🧭 decision) — Positioning + golem.run copy

**Why:** golem.run copy and whether the R5.1 provider-adapter work is ever worth
building both hang on one call: **assistant-for-Claude** vs **universal pre-LLM
processor** (Decision 22 vs 23). This is a USER decision — the task is to frame
it crisply and get the call recorded, not to decide unilaterally.

**Deliverable:** a spec Decisions Log entry (new decision or an update to 22/23)
recording the positioning call and its consequences, plus revised golem.run copy
that leads with the evidence-based pillars (redaction / local tools / routing /
honest observability) and scopes compression as *situational*.

**Approach:** write the decision memo with the two positioning options, what each
commits the roadmap to (R5.1 in/out), and a recommendation grounded in §30–§36.
Bring it to the user via the plan gate before editing the spec or any public
copy. Blocks on R1.1's numbers for the copy's savings language — sequence R1.1
first, or draft copy with the number as a placeholder.

**Read first:** spec Decisions 22, 23; verification-notes §30–§37.
Wiki: `wiki_read "Wiki-First Knowledge"` (for the synthesis pattern).
**Wiki writes:** debrief; a `syntheses/` positioning page (plan-gated — propose
before writing).
**Size:** small-medium (writing + one user decision). **Local model:** draft
copy variants.

### R1.3 (🛠️🔒 T-C3) — Redaction: credit-card false-positive on sparse digit runs

**Problem (verification-notes §50):** the `credit-card` rule
(`(?<![\d.-])\d(?:[ -]?\d){12,18}(?![\d.-])`, `src/pipeline/redaction-rules.ts`)
allows unbounded single-space/single-dash separators before the Luhn gate. A long
run of small space-separated numbers (e.g. an ASCII-code dump) can contain a
13–19-digit window that passes Luhn by chance → false `[REDACTED:credit-card:N]`
on non-card data.

**What to build:** tighten the separator handling before the Luhn check — e.g.
cap the separator-run length and/or require separator consistency (all-space or
all-dash, not mixed). Real cards are written with consistent, sparse grouping;
ASCII dumps are not. Add the §50 repro (space-separated small ints) as a NEGATIVE
corpus case and prove real card numbers (contiguous, and single-consistent-
separator formats) still redact.

**Read first:** `src/pipeline/redaction-rules.ts` (credit-card rule + `luhnValid`),
`tests/unit/pipeline/redaction-corpus.ts`,
`tests/unit/pipeline/redaction-audit.test.ts`, verification-notes §50, §37/§49
for the T-C3 pattern.
Wiki: `wiki_read "Redaction Stage"`.
**Wiki writes:** debrief; append the new false-positive class to
`concepts/Redaction Stage.md`.
**Size:** small-medium, T-C3-gated. **Local model:** generate negative-corpus
digit-run strings.

### R1.4 (🛠️🔒 T-C3) — Redaction: provider-rule gaps

**Problem (verification-notes §24 residual):** no dedicated rule for Google API
keys (`AIza…`), Stripe keys (`sk_live_…` — underscore, so the `sk-` OpenAI rule
misses it), GCP `ya29.` tokens, or Azure connection strings. High-entropy
instances are caught by the entropy net; low-entropy or short ones may pass.

**What to build:** append bounded, non-ReDoS patterns to `REDACTION_RULES` for
each provider, each with a corpus positive case; confirm no new false positives
on the existing negative corpus (repo paths, integrity hashes, ASCII dumps).
Follow the module's determinism/prefix-stability rules.

**Read first:** `src/pipeline/redaction-rules.ts` (rule table + audit rationale),
`tests/unit/pipeline/redaction-corpus.ts`, verification-notes §24.
Wiki: `wiki_read "Redaction Stage"`.
**Wiki writes:** debrief; extend `concepts/Redaction Stage.md`'s rule table.
**Size:** small (mechanical, per-rule). **Local model:** draft realistic (fake)
provider-key fixtures for the corpus.

### R1.5 (🛠️) — Batch housekeeping (partially done this session)

**Already done 2026-07-11 (this session):** `ROADMAP.md` created;
`IMPLEMENTATION_PLAN.md` marked W2-skills/W3/T6 shipped; old `NEXT_BATCH.md`
removed.

**Remaining:** propose (plan-gated) a `syntheses/` wiki page tying the T1–T7
debriefs together — the prior batch's post-batch step that was never taken (old
NEXT_BATCH §5). Link the seven debriefs and the concept pages they touched.

**Read first:** `docs/wiki/WIKI.md` index + the `debriefs/2026-07-1*.md` pages.
**Wiki writes:** the `syntheses/` page (propose first).
**Size:** small. **Local model:** draft the synthesis prose from the debriefs.

### R1.6 (🔬) — macOS + Linux manual Ollama-setup verification

**Why:** verification-notes §48's checklist has Windows ✅ but macOS (with and
without Homebrew) and Linux and Windows-without-winget rows still "NOT YET RUN".
Decision 26's real install/pull path has no CI coverage by design — it must be
manually exercised once per OS.

**What to do:** on real (or throwaway) hardware per row, run `golem ollama status`
then `golem ollama setup`, confirm the documented behavior (install plan, daemon
wait, model pull, smoke test, or the clean manual-fallback when the package
manager is absent), and record the dated outcome in the §48 table.

**Read first:** verification-notes §48; `src/inference/ollama-bootstrap.ts`,
`install-runner.ts`, `src/cli/ollama.ts`.
**Wiki writes:** debrief noting which OSes were covered.
**Size:** small per OS, but gated on hardware availability — may span sessions.
**Local model:** n/a (it IS the install path under test).

### R1.7 (🛠️🧭) — T-C2 cross-OS e2e smoke in CI + Linux fs.watch reliability

**Why:** T-C2 (cross-OS `golem init` → round-trip smoke) is still deferred, and
ADR-0001 / §51 flag native Linux recursive `fs.watch` as **unverified-reliable**
on the Node 22 line — the repo's own CI is the place to prove it.

**What to build:** a GitHub Actions matrix (ubuntu/macos/windows) running an e2e
smoke — `golem init` in a scratch project, proxy up, a byte-faithful level-1
round-trip against a recorded/fake upstream, `golem stats` shows an event — plus
a watcher integration test that exercises recursive watching on Linux. If Linux
recursive watch proves flaky, wire the ADR-0001 fallback (per-directory watch, or
chokidar behind the `FileWatcher` seam). **Decision point:** runner strategy for
the parts that need Ollama/uv (skip vs. stub) — record it as a dated note before
building.

**Read first:** `.github/workflows/` (existing matrix), IMPLEMENTATION_PLAN
§T-C2/§T-C1, verification-notes §51, `docs/wiki/decisions/ADR-0001-file-watcher.md`,
`src/knowledge/` watcher module (T6).
**Wiki writes:** debrief; update ADR-0001 status if the Linux finding changes it.
**Size:** medium-large; do last. **Local model:** draft the workflow YAML +
the smoke-test script.

## 3. Deferred (do NOT start without asking the user)

- All of ROADMAP R2–R5 (R2 is gated on R1.1's measurement landing first).
  This **subsumes** W4, C4, and every `IMPLEMENTATION_PLAN.md` §7 WS-F
  workstream — all are now scheduled as R3–R5 tasks (see §7's WS-F↔ROADMAP
  crosswalk), so there is no separate "WS-F backlog" to start.

## 4. Post-batch

When R1 lands: mark each task done in `ROADMAP.md`, confirm the golem.run copy
reflects R1.2, and spin R2 into its own batch brief only after R1.1's A/B numbers
are recorded — they may reshape R2 entirely.
