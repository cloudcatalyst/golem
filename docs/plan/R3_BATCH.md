# R3 batch — Knowledge depth

> **Written 2026-07-11**, spun up per `ROADMAP.md`'s post-batch instruction
> ("only then consider spinning R3 into its own batch brief") once R2 (R2.5,
> R2.6⚠️partial, R2.1, R2.4, R2.2, R2.3) landed. Self-contained — read top to
> bottom before picking a task. `ROADMAP.md` is the multi-release view;
> `IMPLEMENTATION_PLAN.md` is the workstream/interface reference; the spec
> Decisions Log (`docs/edge-offload-spec.md`) is authoritative.

R3's theme: the retrieval spine (WS-C: hashing embedder, `bge-m3` semantic
upgrade, `FileVectorDriver`, wiki W1-W3, graph-first search) exists and
works — R3 makes it genuinely **deep**: better inputs (real HTML/PDF/code
extraction), better ranking (rerank), and more of the user's own knowledge
in scope (wiki federation, note shaping). Unlike R2, nothing here is gated
on a savings measurement; the gates are narrower — one frozen-interface-
adjacent design decision (R3.1) and one new subsystem scope decision (R3.6).

**Kickoff prompt** (paste when you start a session): *"Read
docs/plan/R3_BATCH.md and continue with the next unblocked task. For every
task follow the Opening moves in §1 — wiki + knowledge-base + local-model
(`delegate`) first — before writing code or reaching outside the project."*

## 0. Session setup (once, before the first task)

1. Read `CLAUDE.md` and `CLAUDE.local.md` — hard rules override this file.
   Key ones for R3: **no heavyweight native deps in the default install**
   (R3.3's tree-sitter WASM and R3.7's LanceDB must stay optional add-ons,
   never core `dependencies`); frozen interfaces need contract tests +
   cross-workstream flagging before changes (R3.1 is the likely one);
   cross-platform always.
2. `golem slider 1` if a prior session left it elsewhere.
3. Wiki-first ladder: `wiki_read "WIKI"` → `search` → external, same as R1/R2.
4. `delegate`-first for code/prose drafts, same as R1/R2.

## 1. Batch-wide definition of done (every task)

Identical to `R1_BATCH.md` §1 / `R2_BATCH.md` §1 — wiki/KB/delegate opening
moves, full `tsc`/`lint`/`format:check`/`test` gate, hard rules honored,
drive the real flow where testable (a chunker/extractor task should be run
against a real sample file, not just fixtures), conventional commit(s) per
task ID, wiki debrief + `WIKI.md` index line (standing approval for THIS
batch, same terms as R1/R2), log-and-move-on if blocked.

**One R3-specific addition:** R3.2/R3.3 are add-ons to the existing chunker
(`src/knowledge/`) — confirm which frozen interface, if any, they touch
before starting (`src/interfaces/knowledge.ts` is the likely candidate for
R3.1's rerank surface, not for the extractor/chunker tasks, which should be
implementable as internal strategy additions with no interface change).

## 2. Tasks, in dependency order

Ordered cheapest/most-independent first; the two gated tasks (R3.1 design
decision, R3.6 subsystem-scope decision) sit at the end so the rest isn't
blocked waiting on either.

### R3.2 (🛠️) — Real HTML/PDF-text extractor

Today `.html`/`.rst`/`.pdf` route through the plain text chunker (raw markup
or binary bytes get chunked as if they were prose), which measurably
degrades both keyword and semantic search quality on any ingested doc that
isn't already Markdown/plain text.

**What to build:** a real extractor for `.html` (strip tags, keep visible
text + basic structure) and `.pdf` (text-layer extraction) in
`src/knowledge/`, selected by file extension the same way the existing
chunker dispatches today. Pick lightweight pure-JS/WASM libraries (no
heavyweight native deps — hard rule); if a specific library needs an
add-on-only decision, flag it before adding to `package.json` dependencies.

**Read first:** `src/knowledge/` chunker dispatch (find the extension-based
entry point), `docs/wiki/concepts/Distillation Pipeline.md`.
**Wiki writes:** debrief.
**Size:** small–medium. **Interfaces:** none frozen touched (extends
internal chunking strategy, not `src/interfaces/knowledge.ts`) — confirm
before starting.

### R3.3 (🛠️) — tree-sitter (WASM) opt-in syntax-aware code chunker

Code files currently chunk the same way prose does (fixed-size/line-based),
which can split mid-function and hurt retrieval precision on code queries.

**What to build:** an opt-in syntax-aware chunker using `tree-sitter`'s WASM
build (no native compilation — respects the "no heavyweight native deps in
default install" hard rule), splitting on function/class boundaries for the
languages already common in this repo (TS/JS at minimum). Ship as a
separate opt-in package or lazy-loaded module, same pattern the ML
compression tier already uses for its optional add-on.

**Read first:** how the ML/semantic tier's optional-add-on packaging works
(precedent for "optional, not core `dependencies`"), current chunker's
line/size-based splitting logic.
**Wiki writes:** debrief.
**Size:** medium. **Interfaces:** none frozen touched if scoped as an
optional chunking strategy — confirm before starting.

### R3.5 (🛠️) — note→distill shaping

`golem note` capture and the distillation engine (`golem wiki distill`,
T3/T4) both ship, but raw captured notes don't yet get shaped into the
wiki's own `questions/`/`artifacts/` page conventions — they sit as
undifferentiated captured text.

**What to build:** extend the distillation path so a `golem note` capture
can be shaped into a draft `questions/` or `artifacts/` page (frontmatter,
wikilinks, zone placement) following `WIKI.md`'s page conventions, offered
as a plan-gated proposal (never auto-committed) the same way every other
wiki write in this repo works.

**Read first:** `docs/wiki/concepts/Distillation Pipeline.md`,
`debriefs/2026-07-10-T4.md` (`golem note` capture),
`debriefs/2026-07-11-T3.md` (distillation engine).
**Wiki writes:** debrief.
**Size:** small–medium. **Interfaces:** none frozen touched.

### R3.4 (🛠️) — W4: user-scope `~/.golem/wiki/` federation + weekly synthesis reports

Wiki W1–W3 (project-scoped) shipped; W4 extends federation to a user-scope
wiki at `~/.golem/wiki/` (cross-project knowledge, Decision 20e's local
tier) plus a weekly synthesis report rollup.

**What to build:** a user-scope wiki root alongside the existing
project-scoped `docs/wiki/`, federated into `search`/`fetch` the same way
`FederatedSearch` already merges knowledge + wiki sources today; a
scheduled/triggered synthesis pass that produces a weekly digest page (in
the style of `syntheses/wiki-knowledge-loop-batch.md`).

**Read first:** `docs/wiki/concepts/Wiki-First Knowledge.md`,
`docs/wiki/syntheses/wiki-knowledge-loop-batch.md`, `IMPLEMENTATION_PLAN.md`
WS-W section, spec Decision 20e.
**Wiki writes:** debrief; this task's own output IS a wiki-writing feature,
so its synthesis-report writes must themselves stay plan-gated per
`WIKI.md`'s zone-2 rule — don't build an auto-commit path.
**Size:** medium. **Interfaces:** none frozen touched (federation reuses
`FederatedSearch`) — confirm before starting; if user-scope needs a new
source kind in `src/interfaces/knowledge.ts`, that's contract-tests-first.

### R3.7 (🔬🧭) — LanceDB scale driver spike

ROADMAP flags this as "optional; only pays at 10⁵+ vectors." Before writing
a new vector-driver implementation, spike whether this repo (or any
realistic single-project KB) is anywhere near that scale yet.

**What to do:** measure the current `FileVectorDriver`'s real
query/ingest latency at this repo's actual chunk count (`golem stats` or
equivalent), extrapolate to 10⁴/10⁵/10⁶ chunks, and record a go/no-go
recommendation — mirroring R2.5's pattern (a verify-first spike that can
legitimately conclude "not the right lever yet"). Do NOT build the LanceDB
driver itself unless the measurement shows `FileVectorDriver` is already a
bottleneck at realistic scale.

**Read first:** `src/knowledge/` vector driver interface + `FileVectorDriver`
implementation, spec §26/§39.
**Wiki writes:** debrief (+ a synthesis page if the finding is non-trivial,
mirroring `syntheses/r2.1-avoidedupstream-spike.md`'s pattern).
**Size:** small (spike only). **Interfaces:** none touched — read-only
measurement task.

### R3.1 (🧭🛠️) — Rerank surface: design decision, then build if approved

The frozen `InferenceService` (`src/interfaces/`) has no `rerank` method
today. Adding cross-encoder or chat-judge reranking at slider ≥2 means
either extending that frozen contract or introducing a new optional
reranker interface alongside it — a design choice, not just an
implementation detail, per the ROADMAP backlog's own flag ("touches the
design of an optional inference surface, frozen-interface-adjacent").

**What to do:** first, write a short design decision (proposed spec
Decisions Log entry, mirroring how Decision 33 was proposed inline for
R2.3) choosing between (a) extending frozen `InferenceService` with an
optional `rerank` method — contract-tests-first, flag every dependent
workstream — or (b) a new, separate optional `Reranker` interface that
degrades gracefully when absent (closer precedent: how semantic embedding
degrades to the hashing embedder when Ollama is absent). Only after that
decision is recorded, build the chosen shape (cross-encoder via the
existing local-inference path, or a chat-judge prompt via `delegate`) gated
behind slider ≥2 per the ROADMAP note.

**Read first:** spec §29, `src/interfaces/knowledge.ts` /
`src/interfaces/inference.ts` (confirm exact names before editing),
`src/knowledge/hashing-embedder.ts` (the "degrade gracefully" precedent).
**Wiki writes:** debrief; the design decision itself likely belongs in the
spec Decisions Log (propose, don't silently add).
**Size:** medium (design) + medium (build). **Interfaces:** likely touches
`src/interfaces/` — contract-tests-first once the shape is chosen.

### R3.6 (🛠️) — C4: MEMORY-scope federated search — ⛔ do NOT start without asking

Requires the **optional P2 Headroom Python sidecar** (spec Decisions
13/18) — a whole separate Python-only subsystem that has never been built
in this repo (still listed as not-started in `IMPLEMENTATION_PLAN.md` §7).
This is a materially larger scope than any other R3 task: a new runtime
(Python), a new IPC/handshake surface (npm↔PyPI version pinning per T-C4),
and a new "no heavyweight native deps in the default install" boundary to
design around. **"Proceed with R3" does not by itself authorize starting a
new subsystem this large — ask the user explicitly before beginning R3.6**,
same standing as R4/R5's design-memo gates.

**Read first (when authorized):** `IMPLEMENTATION_PLAN.md` line ~100 (MEMORY
scope / Headroom memory merge sketch), line ~143 (C4 definition), spec
Decisions 13/18.

## 3. Deferred (do NOT start without asking the user)

- **R3.6** specifically (see above) — new Python sidecar subsystem.
- R4, R5 and everything they contain (already indexed to WS-F — see
  `IMPLEMENTATION_PLAN.md` §7's crosswalk).

## 4. Post-batch

When R3 lands (or stalls on a gate): mark tasks done in `ROADMAP.md`, fold
any spec Decisions Log entries (R3.1's design decision) into the Decisions
Log properly, and only then consider spinning R4 into its own batch brief —
R4 needs a design memo per task before any code per ROADMAP's backlog.
