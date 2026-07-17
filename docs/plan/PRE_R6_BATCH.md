# Pre-R6 batch — loose-ends closeout

> **Written 2026-07-17.** With R1–R5 shipped and R6 (multi-provider & remote)
> deliberately ON HOLD (security/ToS-gated), this batch closes the carried-over
> loose ends tracked in `ROADMAP.md` (the "Carried-over loose ends" table and the
> per-release "open remainder" notes) so the ledger is clean before R6 is
> revisited. It is intentionally small and mostly *verification* work — most of
> the underlying robustness bugs were already fixed by the 2026-07-17 commit #2
> (`fix(knowledge,inference): KB embedder mismatch, local timeout, file-watcher
> abort`), recorded in verification-notes §66/§67/§68.
>
> `CLAUDE.md` + `CLAUDE.local.md` hard rules override this file (never weaken
> redaction; proxy byte-fidelity at level ≤1; cross-platform; frozen
> `src/interfaces/` need contract tests first; no heavyweight native deps in the
> default install). Wiki-first ladder + `coder`-first drafting per
> `CLAUDE.local.md`. `ROADMAP.md` is the multi-release view; the spec Decisions
> Log (`docs/golem-spec.md`) is authoritative for any decision this batch records.

## Theme

Nothing here is new product surface. It is: prove (or retire) the one unproven
core claim (Decision 33 local-answer), take the fair follow-up measurement that
the same work unblocks, close one small orchestration gap, and tidy the ledger
of things that are blocked-not-broken.

## Batch-wide definition of done (every task)

- `tsc --noEmit`, `npm run lint`, `npm run format:check`, `npx vitest run` all
  green on the task's final commit (baseline at batch start: 1018 tests green,
  `tsc` clean 2026-07-17).
- New behavior tested at the right layer; zod at any new external surface.
- A dated debrief in `docs/wiki/debriefs/` (plan-gated); spec Decisions Log
  entry for any decision flipped/retired.
- Conventional commit(s), task ID in the title (e.g. `chore(knowledge): LE1 …`).
- Mark the task done in `ROADMAP.md` (update the loose-ends table) when it lands.

## Recommended order

**LE5 → LE1 → LE2 → LE3 → LE4.** LE5 (embed-size robustness) now gates a fair,
stock-model LE1/LE2 — it was discovered while executing LE1 and is the reason the
semantic index would not build. LE1 can still be *measured* this session on a
local workaround index (see LE5 note), but the proper sequence fixes LE5 first so
LE1/LE2 run on a stock `bge-m3`. LE3 is independent and small; LE4 is bookkeeping
and can land anytime.

---

### LE1 (🔬🧭) — Decision 33 semantic re-review → flip or retire
**Source:** ROADMAP loose end #1; spec Decision 33; verification-notes §64 (+ its
2026-07-17 update), §67.

The ROADMAP's #1 gate. Decision 33's local-answer sub-mode ("the proxy answers a
retrieval-shaped question from the KB without an upstream call") is still
PROPOSED because the one human-reviewed served answer (§64) was **wrong** — it
served a raw code constant for "what does slider level 0 mean?" while the correct
prose scored *below* the 0.6 floor. Two structural causes were identified; both
robustness halves are now fixed (fail-open try/catch in R5; the silent
cross-embedder-space zero-scoring in §67). What was never established: a *fair*
re-review on a **semantically-built** index, because the box only had a lexical
(512-dim hash) index — semantic ranking was never actually exercised.

Steps:
1. Ensure the tier's text embed model is pulled (**P_MID → `bge-m3`**, confirmed
   via `golem devices`; note §64 said "nomic-embed-text" — that is the *low*-tier
   embedder, not this box's).
2. `golem index` to rebuild the project index semantically; confirm the manifest
   signature flips `lexical:hash-v1-512` → `semantic:*` and the dim changes.
3. Re-run the §64 conceptual-question sample through
   `KnowledgeLocalAnswerService.tryAnswer` at the default 0.6 floor. Record, per
   question: served vs declined, the served text, and its correctness.
4. **Decide (the point of the task):**
   - If ≥1 *correct* served answer clears the floor and no *wrong* answer does →
     propose flipping Decision 33 PROPOSED→ACCEPTED (with the served sample as
     evidence).
   - If wrong answers still clear the floor, or nothing correct does → the honest
     call is to **retire** Decision 33 (or re-gate on a concrete ranking fix, see
     LE-note below), not leave it parked indefinitely.
5. Update the spec Decisions Log (Decision 33 status), the ROADMAP loose-ends
   table, and verification-notes §64 with the outcome + evidence.

**Outcome (2026-07-17, done — verification-notes §69b):** re-reviewed on a real
`semantic:bge-m3` index (buildable only after LE5's three fixes). 11/13 served,
2 declined. Semantic ranking is a clear improvement over lexical — wiki/spec
prose now genuinely wins several questions (search, redaction, wiki-first). **But
the §64 failure mode persists:** `*.test.ts`/code chunks still outrank prose for
definitional queries — "slider level 0" and "slider level 1" each serve a wrong
test constant (`const LEVEL_0 = …`) *above* the 0.6 floor, while the correct
"What is Golem?" prose (0.589) is declined *below* it. Serving-wrong > declining,
so **Decision 33 stays PROPOSED** (not flipped, not retired).

**LE1 follow-on (the now-concrete gate):** finding #2 must be fixed for the
local-answer path — exclude or down-weight `*.test.ts` (and likely all code) from
the local-answer source set and prefer wiki/spec/doc prose (a source-type weight
mirroring `boostWikiHits`, `src/mcp/server.ts`, applied above the frozen search
contract), and/or raise the floor / require a prose top-source for definitional
queries. Then re-run this sample; flip to ACCEPTED only when no wrong answer is
served. Test files are the cheapest, highest-impact exclusion (they repeat query
terms verbatim). This is the graduated task LE1 produces.

### LE2 (🔬) — Fair local-model quality re-measurement on the semantic index
**Source:** verification-notes §63 (R4.7 follow-up: "grounded/refined accept-rate
awaits an MCP reconnect"); R3.1 rerank.

R4.7 measured an **ungrounded, lexical-era** coder baseline (2/5 accept, 3/5
revise, 0/5 reject) and explicitly deferred the grounded/refined number until the
MCP server picked up the R4.2 grounding + R4.4 refinement build. LE1 pulls the
semantic embedder, which is the same embedder grounding (R4.2) and rerank (R3.1)
depend on — so this is the moment to take the fair number. Reconnect/respawn
`golem mcp serve` (so it runs the built code + semantic index), then:
- Re-run the R4.7 representative tasks through `coder` with grounding on and
  `refine` on; record the grounded/refined accept-rate vs the ungrounded
  baseline, using R4.3's `tool_usage` drafted-locally telemetry.
- Spot-check `knowledge.rerank_enabled` on the semantic index (a few queries)
  to confirm rerank behaves sensibly in the semantic space, not just lexical.
- Record in a syntheses page; this is measurement, not a code change (unless a
  clear defect surfaces).

### LE3 (🛠️) — Grounding injection into `golem task run`
**Source:** ROADMAP R5.3 row ("Grounding-injection into `run` is a follow-up");
verification-notes / R5.3 debrief.

R5.3's local multiplexing (`src/tasks/multiplex.ts`, `serviceTaskLocally`)
services queued tasks on the Ollama tier but does **not** inject KB/wiki
grounding the way `coder` does since R4.2. Reuse the shared `gatherGrounding`
(R4.2) in the `serviceTaskLocally` path so locally-serviced tasks are grounded
consistently with `coder`. Degrade to ungrounded on any failure (same contract
as R4.2). No frozen interface change expected; add unit coverage.

### LE5 (🛠️🔬) — Semantic embed path is not robust to oversized chunks
**Source:** discovered 2026-07-17 while executing LE1 (this session); Ollama
server log; `src/knowledge/chunker.ts`, `src/inference/ollama-client.ts`.

**Finding (new).** The semantic KB index has **never actually built end-to-end on
this repo** — the lexical hashing embedder (no token limit) masked it. Rebuilding
semantically with `bge-m3` fails reproducibly: Ollama's runner errors
`input (4096 tokens) is too large to process ... current batch size: 2048` and
the model runner process then crashes (its internal `/tokenize` port dies),
surfacing as `inference endpoint returned 400`.

**Two compounding root causes (both fixed this session, `src/inference/ollama-client.ts`):**
1. **Oversized single input.** `chunker.ts`'s `MAX_CHUNK_CHARS = 2_000` is a
   **soft** cap (splits on paragraph boundaries only); a dense unsplittable block
   (a wide markdown table in `verification-notes.md`, a long `golem-spec.md`
   section) yields a chunk that tokenizes to ~4096 tokens. `OllamaClient.embed`
   forwarded inputs **without bounding**, and stock `bge-m3` has physical batch
   2048 < its 4096 context, so any input over 2048 tokens errored
   (`input … too large to process`). Model-side `num_batch` tuning did **not**
   help (raising it just moved the failure to a runner crash).
2. **Whole corpus in one request.** `knowledge-base.ts` `#embedAndStore` embeds
   *every* chunk of a kind in a **single** `embed()` call → one `/v1/embeddings`
   request over thousands of inputs. Ollama opens a localhost connection to its
   model runner per input, so after ~1 min of rapid connections the dial gets
   refused (**Windows ephemeral-port / TIME_WAIT exhaustion**; no runner crash or
   CUDA-OOM in the server log — 7 GB VRAM free throughout, different ephemeral
   port each failure). This 400s the whole request and loses all progress.

**Fixes shipped this session (bounding + batching, in `OllamaClient.embed`):**
- `MAX_EMBED_INPUT_CHARS = 6000` — each input is truncated to a conservative
  char budget that stays under a 2048-token physical batch for latin/code text.
  Stored chunk text is unchanged; only the embedding vector uses the head. (CJK
  packs more tokens/char — token-accurate bounding is a future refinement.)
- `EMBED_BATCH_SIZE = 64` — inputs are sent in sequential bounded batches so each
  request is short and localhost connections drain between them.
- No frozen interface touched; `+2` unit tests (truncation + batch order),
  8/8 in the ollama-client suite.

**Verified:** stock (freshly-pulled) `bge-m3` now builds the full project index
semantically end-to-end — no model tuning required. A temporary session
workaround (`ollama create bge-m3` with a larger `num_batch`) was tried first and
**reverted** (`ollama pull bge-m3` restored stock); it is not part of the fix.

**Third cause — LE5c (reindex does not clear on embedder change), found after
1+2 were fixed:** with 1+2 fixed the semantic build completes, but `golem index`
(`main.ts` → `knowledge.ingest`) upserts into the **pre-existing** collection
without clearing it. `FileVectorDriver.openCollection` loads the old `dim` from
`meta.json` and `upsert` only sets `dim` when it is 0 (file-driver.ts:126), so a
lexical→semantic reindex writes 1024-dim vectors into a collection still labelled
`dim:512`, keeps the stale lexical chunks, and produces a mixed-dim collection
that §67's `assertEmbedderSpaceMatch` (correctly) refuses to query
(`EmbedderMismatchError`). `fullIndex` in `auto-index.ts` has the same gap — its
comment says "signature changed → clear + full rebuild" but it does **not**
actually clear. This is the exact real-world path: *user runs `golem index`
lexically, later pulls bge-m3, re-runs `golem index`* → unqueryable index.

**LE5c fix (planned, small + contained):** in `FileVectorDriver.upsert`, when an
incoming vector's length differs from a non-zero `col.dim`, treat it as an
embedder-space change → clear the collection's records (and their `#chunkIndex`
entries) and reset `dim` to the new length before storing. Protects every caller
(`golem index`, `mcp serve`, autoindex) at one seam; add a unit test
(lexical→semantic reindex auto-resets, incremental same-dim reindex does not).
Session unblock used to get LE1's measurement: manually `rm -rf` the collection
dir before a clean rebuild — **not** the fix.

**Follow-up (optional, not blocking):** a **hard** char cap in the chunker
(suspenders) so oversized chunks never form; a small retry around each embed
batch; and clearing stale chunks on a same-dim rebuild of deleted files (milder —
`ensureProjectIndexed`'s incremental delete already covers the mcp-serve path).

**Status:** LE5a (input bounding) + LE5b (batching) ✅ fixed + tested this
session; LE5c (reindex clear-on-embedder-change) diagnosed, fix planned. Fold all
three into the LE5 debrief when the batch is written up.

### LE4 (📋) — Ledger tidy: re-scope the blocked-not-broken items
**Source:** ROADMAP loose-ends table (R2.6, R1.6); §68 CI fix; R5.5 debrief.

Pure bookkeeping — make the roadmap honest about what is *waiting* vs *unfinished*:
- **R2.6 live semantic-forced A/B:** re-tag as **unblocks-with-R6.1**, not a
  standalone loose end. It is only meaningful on a non-caching upstream, which
  does not exist until the provider adapters land (R6.1). Infra
  (`force_semantic_on_caching`, `aggregateUsageBySemanticForced`) is already
  built and tested.
- **R1.6 macOS/Linux Ollama verification:** confirm the checklist in
  `docs/wiki/questions/r1.6-ollama-verification-blocked.md` is current; keep it
  hardware-blocked (no non-Windows hardware this session).
- **CI health:** confirm the CI run is green after commit #2's §68 file-watcher
  fix (the fix is committed; verify the run actually passes before calling §68
  closed).
- **R5.5 prompt-translation scoring loop:** record explicitly that it **stays
  deferred** (demand-gated per its debrief) so it is not mistaken for unfinished
  work. No code.

## Post-batch

Update the ROADMAP loose-ends table (ideally emptying it), record any spec
Decisions Log change from LE1, and note whether R6 is ready to be revisited with
the user. If LE1 flips Decision 33 to ACCEPTED, the "one unproven core claim" is
resolved and the co-developer thesis is fully evidence-backed.
