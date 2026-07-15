# R4 batch — Co-developer core

> **✅ COMPLETE (2026-07-16).** All seven tasks (R4.1–R4.7) landed; see the
> retrospective `docs/wiki/syntheses/r4-co-developer-core-batch.md` and the ✅
> rows in `ROADMAP.md`. R5/R6 remain ON HOLD (Decision 36) pending an explicit
> user call. This brief is kept for reference until a successor batch supersedes
> it.

> **Written 2026-07-16** by the Decision 36 refocus session, replacing the
> completed `R3_BATCH.md` (retired; git history has it). This is the current
> actionable batch and is **self-contained** — read it top to bottom before
> picking a task. The multi-release view is `ROADMAP.md`; the
> workstream/interface reference is `IMPLEMENTATION_PLAN.md`; the spec
> Decisions Log (`docs/golem-spec.md`) is authoritative.

R4's theme (Decision 36): make the two unbuilt legs of the second-brain
pattern real — **a planning-collaboration surface** (the user and Claude read
captured notes/ideas together and turn them into tasks) and **a robust,
token-friendly local coder co-developer** (grounded, measured, iterating) —
plus the last robustness gaps in the distill/KB loop that pattern leans on.
Autonomy/orchestration (R5) and multi-provider/remote incl. the companion app
(R6) are ⛔ ON HOLD until this loop is proven.

**Kickoff prompt** (paste when you start the session, slider = 1):
*"Read docs/plan/R4_BATCH.md and start R4.1. For every task follow the Opening
moves in §1 — wiki + knowledge-base + local-model (`coder`) first — before
writing code or reaching outside the project."*

## 0. Session setup (once, before the first task)

1. Read `CLAUDE.md` and `CLAUDE.local.md` (repo root) — hard rules override this
   file. Key ones for R4: **never weaken redaction** (T-C3); proxy byte-fidelity
   at level ≤1; cross-platform (node:path, argument-array spawning, no /tmp, no
   POSIX signals); frozen `src/interfaces/` need contract tests first.
2. Restore savings if a prior session left the slider at 0: `golem slider 1`.
3. **Wiki-first ladder (from CLAUDE.local.md):** for any "how does X work",
   check `docs/wiki/WIKI.md` + `wiki_read` first, then `search`, then external.
4. **Coder-first:** use the `coder` MCP tool to have the local model draft
   code/tests before you finalize. Treat as a draft, not an answer. (R4.2–R4.4
   improve this very tool — dogfood it while building it.)
5. Baseline check: `npx tsc --noEmit && npm run lint && npx vitest run`
   (886 tests green at batch-writing time).

## 1. Batch-wide definition of done (every task)

- **Opening moves:** wiki index skim → `search`/`wiki_read` for prior art →
  `coder` draft where the task is big enough to pay for the round trip.
- `tsc --noEmit`, `npm run lint`, `npm run format:check`, `npx vitest run` all
  green on the task's final commit.
- New behavior has tests at the right layer (contract tests FIRST if any frozen
  interface is touched — none is expected in this batch).
- A dated debrief page in `docs/wiki/debriefs/` (plan-gated like every zone-2/3
  write: propose, get approval, write).
- Conventional commit(s), task ID in the title (e.g. `feat(mcp): R4.2 ...`).
- Mark the task done in `ROADMAP.md` when it lands.

## 2. Tasks (recommended order — R4.1 first, it shapes the rest)

### R4.1 (🛠️) — Planning-collaboration surface: notes/ideas → tasks, together

The missing piece of the second-brain loop. Today `golem note` captures ideas,
`distillNote` shapes them into draft `questions/`/`artifacts/` pages, and the
wiki holds open questions — but nothing closes the loop into **tasks**: that
has happened ad hoc in conversation, invisibly to the plan docs.

**What to build:**
- `docs/plan/BACKLOG.md` — a lightweight, committed ideas inbox with a stated
  format (one entry per idea: date, one-line statement, source link — note ts,
  wiki page, or conversation; status: `raw | discussed | promoted | dropped`).
  Human-editable; the agent appends via the normal plan-gate.
- A `/golem/plan` skill (installed by the same machinery as the other
  `/golem/*` skills — see `src/cli/skills.ts`) that drives the collaborative
  session: read recent `golem note` captures (see `src/cli/notes.ts` for the
  store), open `docs/wiki/questions/` pages, pending `.golem/distill/` drafts,
  `BACKLOG.md`, and `ROADMAP.md`; surface candidates; discuss with the user;
  then propose concrete task entries (BACKLOG updates, or ROADMAP/batch rows
  for approved items). **Writes are plan-gated** — the skill instructs the
  agent to propose and get approval before editing plan files, mirroring the
  article's plan-before-write ingestion contract (see
  `wiki/sources/llm-wiki-second-brain-obsidian.md`).
- The plan-collaboration contract, stated in the skill: cite sources for every
  proposed task (the note/question/page it came from), flag inference vs.
  stated user intent, admit gaps rather than inventing work.

**Read first:** `src/cli/skills.ts` (how skills are authored/installed),
`src/cli/notes.ts` + `src/knowledge/distill-store.ts` (what's readable),
`docs/wiki/sources/llm-wiki-second-brain-obsidian.md` (the contract),
`proposals/wiki-knowledge-pivot.md` §5.
**Wiki writes:** debrief; consider a `concepts/Planning Loop.md` page once the
shape settles (plan-gated).
**Size:** medium. **Interfaces:** none frozen touched (skill + doc conventions
+ possibly small CLI read helpers).

### R4.2 (🛠️) — Coder grounding: retrieval-augmented drafting

`registerCoderTool` (`src/mcp/server.ts` ~line 928) sends the local model only
`task` + optional caller-supplied `context`. The local model can't see the
project — drafts are context-blind unless Claude hand-feeds code in.

**What to build:** before calling `inference.chat("drafter", …)`, run the
existing search path (the same `FederatedSearch` the `search` tool uses, incl.
wiki boost) over the task text; inject the top hits into the prompt under a
clearly-labeled context block, **size-capped** (chars/tokens budget — the
drafter models are small; don't blow their context). Add an opt-out input
param (e.g. `ground: false`) and include which sources were injected in the
structured output so the caller can judge the draft's grounding. Degrade
gracefully: search failure/no KB = today's behavior, never an error.

**Read first:** `src/mcp/server.ts` (`registerCoderTool`, `boostWikiHits`,
how `search` assembles hits), `src/knowledge/rerank.ts` (Decision 34's
opt-in rerank — compose, don't duplicate).
**Wiki writes:** debrief.
**Size:** medium. **Interfaces:** none frozen touched (MCP layer composition;
`GolemMcpServerDeps` may gain a non-frozen optional field, precedent: R3.4's
`wikiSearch`).

### R4.3 (🛠️) — Honest tool telemetry: measure the co-developer

The R2.1 spike (verification-notes §59) found `search`/`fetch`/`ingest`/
`wiki_read`/`coder` entirely uninstrumented — Golem cannot say what its local
tools save. "Token-friendly co-developer" must be a measured claim
(Decision 23's evidence-first rule).

**What to build:** per-call telemetry events for the knowledge + coder MCP
tools (tool name, duration, result size; for `coder` additionally model +
draft length as a drafted-locally token bucket — tokens the paid model did not
generate). Reuse the existing telemetry store/event conventions
(`src/telemetry/types.ts` — note the `avoidedUpstream` precedent and its
optional-field compatibility convention) and surface a summary in
`golem stats` / the stats MCP tool.

**Read first:** `src/telemetry/types.ts` + `jsonl-store.ts`,
`src/mcp/server.ts` tool registrations, `docs/wiki/syntheses/r2.1-avoidedupstream-spike.md`.
**Wiki writes:** debrief.
**Size:** medium. **Interfaces:** none frozen touched (TelemetryEvent is
non-frozen; additive fields only, absent-parses-as-0 convention).

### R4.4 (🛠️) — Coder iteration loop: draft → judge → revise

One-shot drafts from a small model are hit-or-miss. The catalog already wires
a `judge` role at every tier (`src/inference/catalog.ts`), and
`InferenceService.chat` accepts `jsonSchema` forcing (the Decision 34
mechanism) — an iteration loop is expressible with zero interface changes.

**What to build:** an opt-in refinement pass on the `coder` tool (input param,
e.g. `refine: true`, default off — it multiplies local latency): draft with
`drafter`, critique with `judge` (structured verdict: issues + severity),
revise with `drafter` if the critique found real issues; cap at one revision
cycle. Surface what happened (rounds, critique summary) in the structured
output. Then harden the `/golem/develop` skill to use grounding (R4.2) +
refinement where they pay, and state when NOT to (small tasks — the round trip
must pay for itself, per CLAUDE.local.md).

**Read first:** `src/mcp/server.ts` (`registerCoderTool`),
`src/knowledge/rerank.ts` + `src/knowledge/distill.ts` (jsonSchema-forcing
patterns to reuse), `src/cli/skills.ts` (`develop` skill).
**Wiki writes:** debrief.
**Size:** medium. **Interfaces:** none frozen touched.

### R4.5 (🛠️) — Distill-draft promotion UX + wiki-lint cleanup

Drafts accumulate in `.golem/distill/` (from `golem wiki distill` and
`golem note distill`) but the promote step — reviewing a draft and applying it
as a real wiki page — is manual file surgery. Close the capture → distill →
promote loop. Same task, second leg: the wiki has accumulated lint debt —
`golem wiki check` reports **18 pre-existing issues** as of 2026-07-16 (broken
wikilinks in dated debriefs/syntheses that name pages by inexact titles, a few
pages with no wikilinks at all, and WIKI.md's `[[Page Title]]` frontmatter
example being counted as a link). Promotion writes into this graph, so clean
it as part of the same work.

**What to build:**
- A `golem wiki promote [id|--list]` flow: list pending drafts (provenance,
  target page, age), show a draft, and on explicit confirmation write it
  through the same append-and-refine semantics as `wiki_upsert` (Decision 29 —
  union-merge frontmatter, dated separator, never wholesale rewrite), then
  archive/remove the draft. Non-TTY without an explicit id/`--yes` refuses
  rather than prompts (the Decision 26 consent convention). Keep the plan-gate
  framing: promotion is the human approving; the command is the mechanical
  write.
- Wiki-lint cleanup: fix the 18 `golem wiki check` issues — repair dated
  pages' broken wikilinks to point at the real page titles (fixing a link is
  a mechanical path repair, not a history rewrite; leave prose alone), add a
  minimal wikilink to the link-less pages, and teach the checker to ignore
  fenced/example wikilinks like WIKI.md's schema block if that's the cleaner
  fix. Then run `golem wiki check` green and consider adding it to CI for
  `docs/wiki/` (the Decision 28 proposal's own risk-table suggestion).

**Read first:** `src/knowledge/distill-store.ts` (draft storage,
`findDraftByNoteTs`), `src/wiki/` (store/upsert semantics + the checker),
`src/cli/distill-note.ts` + `src/cli/synthesize.ts` (CLI patterns).
**Wiki writes:** debrief; update `concepts/Distillation Pipeline.md` (the
promote stage exists now) — plan-gated. The link repairs themselves are
zone-2/3 edits: propose the fix list, get approval, apply.
**Size:** medium. **Interfaces:** none frozen touched (check whether
`src/interfaces/wiki.ts` upsert already covers the write path — it should).

### R4.6 (🛠️) — `FileVectorDriver.#flush()` stream-write fix

The R3.7 spike (`wiki/syntheses/r3.7-lancedb-scale-spike.md`) found `#flush()`
rewrites the whole collection via `Array.join` and hard-crashes
(`RangeError: Invalid string length`) between 30k–50k chunks. The raw-article
KB (goal 2) grows monotonically; fix before it hits the wall.

**What to build:** the spike's own recommendation — stream the collection to
disk (write chunks incrementally / `createWriteStream`) instead of building
one giant string; keep the write atomic (temp file + rename, the usual
pattern). Re-run the spike's synthetic-scale benchmark to confirm the crash
point is gone and search latency is unchanged.

**Read first:** the R3.7 synthesis page, `src/knowledge/` FileVectorDriver
(find the exact file before editing).
**Wiki writes:** debrief; append the fix outcome to the R3.7 synthesis page
(plan-gated).
**Size:** small. **Interfaces:** none frozen touched (driver internal).

### R4.7 (🔬) — Drafter quality/catalog re-verification

The co-developer thesis stands or falls on draft quality. Spec Decision 6
marks per-tier models as **advisory — re-verify current best at build time**;
the catalog was last verified around `qwen2.5-coder`'s generation.

**What to do:** re-verify current best small coder models per tier against
live sources (record findings, dated, in `docs/plan/verification-notes.md`);
if the catalog changes, update `src/inference/catalog.ts` (advisory, no
interface change). Define and run a small draft-quality check: a handful of
representative repo tasks through `coder` (with R4.2 grounding once landed),
scored accept/revise/reject — the honest baseline R4.3's telemetry will track
over time. Fold in R1.6's macOS/Linux manual checklist rows if non-Windows
hardware is available this batch (else leave the questions page standing).

**Read first:** `src/inference/catalog.ts`, spec Decision 6,
`wiki/questions/r1.6-ollama-verification-blocked.md`.
**Wiki writes:** debrief + a synthesis page with the measured accept-rate
(plan-gated).
**Size:** small/medium (spike). **Interfaces:** none touched.

## 3. Deferred (do NOT start without asking the user)

- **R5 (autonomy & orchestration)** and **R6 (multi-provider & remote, incl.
  the R6.3 companion app)** — ⛔ ON HOLD per Decision 36 until the R4
  co-developer loop is proven robust; each task needs a design memo + a
  separate explicit ask (the standing WS-F gate).
- The hosted workspace/org knowledge tier (off-roadmap entirely).

## 4. Post-batch

When R4 lands (or stalls on a gate): mark tasks done in `ROADMAP.md`, record
any new spec Decisions Log entries properly, write the batch retrospective
synthesis (mirroring `syntheses/wiki-knowledge-loop-batch.md`), and revisit
the R5/R6 hold with the user — the hold lifts only on an explicit user call,
informed by R4.3/R4.7's measurements.
