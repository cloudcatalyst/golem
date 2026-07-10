# Next batch — wiki knowledge loop (W3 + leftovers)

> **Written 2026-07-10 by the integrator session (Fable), immediately after the
> full-codebase review landed (commits `0c34167`, `5141e22`).** This document is
> **self-contained on purpose**: the conversation that produced it is being
> cleared, and the executing sessions (Claude Sonnet as the main model, with the
> local Ollama model via the `delegate` MCP tool) start fresh from this file.
> Read it top to bottom before picking a task.

## 0. Session setup (once, before the first task)

1. Read `CLAUDE.md` and `CLAUDE.local.md` (repo root) — the hard rules there
   override everything, including this file.
2. The proxy daemon and VS Code extension were redeployed on 2026-07-10 and are
   current. The slider was set to `0` (passthrough) for the review session;
   restore savings before working: `golem slider 4` (drafts on, local-first
   off — recommended for dev work) or `5` if local-first answers are wanted.
3. **Wiki-first knowledge ladder (mandatory, from CLAUDE.local.md):** for any
   "how does X work" question, check `docs/wiki/WIKI.md` + `wiki_read` first,
   then the `search` MCP tool, and only then WebFetch/external docs.
4. **Delegate-first (user's standing instruction):** use the `delegate` MCP tool
   to have the local model produce first drafts (code sketches, summaries,
   commit-message drafts, doc prose) before writing final code yourself. Treat
   its output as a draft to review, never as a final answer. If the local model
   is down, note it and continue without it.

## 1. Wiki read/write protocol for THIS batch (user-approved 2026-07-10)

Every task below both **reads from and writes to** the project wiki
(`docs/wiki/` — see its `WIKI.md` for zones, frontmatter, and write rules).

**Reads (start of task):** `wiki_read "WIKI"` for the index, plus the pages
named in the task. Also `search` for the task's topic before touching code —
the vector index covers the wiki, `docs/`, and previously fetched pages.

**Writes (end of task):** the user has granted **standing approval, scoped to
this batch**, for the wiki writes listed per task below plus, for every task:

- a debrief page `debriefs/2026-MM-DD-<task-id>.md` (type `debrief`) recording:
  what was built, key decisions made and why, anything surprising, and open
  follow-ups. Link the relevant concept/entity pages.
- updating the **Index** section of `docs/wiki/WIKI.md` with one line per page
  added (the index is currently empty — start it).

Any wiki write NOT listed in the task's "Wiki writes" line still requires the
normal plan gate (propose to the user first). All WIKI.md rules apply to every
write: required frontmatter (`title, type, tags, sources, created, updated` —
note `sources` is required, the parser rejects pages without it), ≥1 wikilink
per page, link-don't-restate, redaction before storage, append-and-refine.

**Important distinction:** this standing approval covers the *development
tasks* writing what they learn. It does **not** loosen the *runtime* rule —
features you build must keep wiki writes plan-gated per spec Decision 29
(auto-append autonomy: never through P1/P2). See
`docs/wiki/questions/wiki-write-autonomy.md`.

## 2. Batch-wide definition of done (every task)

- `npx tsc --noEmit`, `npm run lint`, `npm run format:check`, `npm test` all
  clean. Contract tests BEFORE implementations when a task adds an interface.
- Hard rules honored: `src/interfaces/` frozen (changes need contract-test
  updates + call-out), cross-platform (node:path, argument-array spawning, no
  /tmp, no POSIX signals), no heavyweight native deps in core `dependencies`,
  redaction before any content is stored/forwarded, proxy byte-fidelity at
  level ≤1 untouched.
- Verify by driving the real flow (run the CLI/hook/tool you changed), not just
  tests. Rebuild + restart to test live behavior: `npm run build`, then
  `golem proxy restart` if the proxy is involved; the MCP server respawns with
  a new Claude Code session.
- Conventional commit(s), task ID in the message (e.g. `feat(wiki): W3a …`).
  One task per commit series. End commit messages with the Co-Authored-By
  trailer per the harness default.
- Wiki debrief written + WIKI.md index updated (see §1).
- If blocked on an unresolved unknown: write the question into
  `docs/verification-notes.md` (dated) AND `docs/wiki/questions/`, then pick up
  the next task — don't guess.

## 3. Tasks (in recommended order)

### T1 (warm-up) — telemetry: wire `ccrRefsRetrieved`

**Problem:** `golem stats` / dashboard always report `ccr_refs_retrieved: 0`
from durable telemetry — `src/telemetry/jsonl-store.ts` hardcodes it (see the
comment citing verification-notes §25). Retrievals happen in the MCP server's
`expand` tool (`src/mcp/server.ts`) and in `NativeLosslessCompression.retrieve`
(in-memory count only, lost when the process exits).

**Approach sketch:** add a small `TelemetryEvent` variant (or a nullable field)
for a retrieval event; emit it from the `expand` tool path (the MCP serve
wiring in `src/cli/main.ts` / `src/cli/mcp-compression.ts` is where the
telemetry store and the compression service meet); fold it in
`JsonlTelemetryStore.aggregate`. Keep the JSONL append-only format
backward-compatible (old lines must still parse).

**Read first:** `src/telemetry/*`, `src/cli/mcp-compression.ts`,
verification-notes §25/§30. Wiki: none exist for this yet.
**Wiki writes:** debrief only.
**Size:** small. **Local model:** draft the aggregate-function change.

### T2 (W2 leftover) — ship the missing wiki skills

**Problem:** IMPLEMENTATION_PLAN §WS-W W2 lists `/golem/wiki-ingest <url>` and
`/golem/wiki-query` skills as part of W2, but `src/cli/skills.ts` `P0_SKILLS`
contains only slider/stats/expand/bypass — the wiki skills were never written.
`golem init` installs skills from that table.

**What to build:** two new SKILL.md entries following the existing pattern
(thin prompts delegating to the frozen MCP tool names):
- `/golem/wiki-query <topic>` — instructs Claude: `wiki_read` the index, try
  title/graph lookup, fall back to `search`, answer with page citations.
- `/golem/wiki-ingest <url>` — instructs Claude: fetch (the WebFetch KB cache
  hook will capture raw content), distill a source note IN ITS OWN WORDS
  citing the URL, **propose the page to the user, and only on approval** call
  `wiki_upsert` into `sources/<slug>.md` (plan-gated per Decision 29).
Update `golemInitStatus`/tests that enumerate skills if they assert counts.

**Read first:** `src/cli/skills.ts`, `src/cli/init.ts` (skill install loop),
`docs/wiki/WIKI.md` write rules, spec Decision 27–29 in
`docs/edge-offload-spec.md` Decisions Log.
Wiki: `wiki_read "Wiki-First Knowledge"`.
**Wiki writes:** debrief only.
**Size:** small. **Local model:** draft the SKILL.md prose.

### T3 (W3a) — distillation engine + lazy webcache distill

**Goal (proposal §4 data flow):** a fetched page is stored twice — raw in
`.golem/webcache` (exists) and as a **distilled source note draft** ready for
the wiki. Decision 29 answered "backfill lazily, on next access", and runtime
wiki writes stay plan-gated, so the engine produces **drafts in zone 1**, never
auto-commits pages.

**What to build:**
1. `src/knowledge/distill.ts` (new, no interface changes): given raw page text
   + URL, call `InferenceService.chat("summarizer", …)` to produce a source
   note draft — facts in our own words, citing the URL, with suggested
   frontmatter (type `source`, kebab-case slug, tags) and candidate wikilinks
   (match against existing page titles via the wiki store). Redaction is
   already applied before webcache storage; do not weaken it.
2. Draft store: `.golem/distill/<slug>.md` (zone 1, gitignored — verify
   `.golem` handling in the repo's `.gitignore` posture for user projects;
   in THIS repo `.golem` is partially tracked, so add an ignore rule for
   `.golem/distill/` if needed).
3. CLI: `golem wiki distill <url>` (distill one cached page now) and
   `golem wiki distill --pending` (list drafts awaiting review). Lazy backfill:
   when the web-fetch PRE hook serves a cached URL, note in its output when a
   draft exists (pointer, not content).
4. Review path: extend the `/golem/wiki-ingest` skill (T2) so it prefers an
   existing draft over re-distilling.

**Constraints:** fail-open everywhere (no Ollama → clear message, no crash);
the hook path must stay fail-safe (exit 0, stderr only); never block the
pre-fetch gate on inference (drafting belongs in the post hook or CLI, async).

**Read first:** `docs/plan/proposals/wiki-knowledge-pivot.md` §4–5,
`src/hooks/web-fetch.ts`, `src/knowledge/web-cache.ts`,
`src/inference/service.ts` (roles), `src/wiki/file-wiki-store.ts`.
Wiki: `wiki_read "Wiki-First Knowledge"`, `wiki_read "wiki-write-autonomy"`.
**Wiki writes:** debrief; a new `concepts/Distillation Pipeline.md` (type
`concept`) documenting the queue design and the zone-1 draft location; update
the `Wiki-First Knowledge` page's data-flow section (append-and-refine).
**Size:** the big one. **Local model:** it IS the feature — exercise
`delegate`/summarizer heavily while building; capture prompt-quality findings
in the debrief.

### T4 (W3b) — `golem note` capture (spec Decision 20f)

**Goal:** frictionless idea/note capture that feeds the same distill/review
path. `golem note "text"` appends to a zone-1 capture log
(`.golem/notes/notes.jsonl` — timestamped, append-only); `golem note list`
shows recent; distillation (T3 engine) can shape a note into a draft
`questions/` or `artifacts/` page for plan-gated promotion.

**Constraints:** capture must be instant and dependency-free (no inference on
the capture path); redact before storing (reuse `pipelineRedact` +
`stripKnownSecrets` from `src/hooks/redact.ts`).

**Read first:** spec Decision 20f, T3's engine, `src/cli/main.ts` command
patterns. Wiki: `wiki_read "Wiki-First Knowledge"`.
**Wiki writes:** debrief; extend `concepts/Distillation Pipeline.md` with the
note-capture flow.
**Size:** small-medium. **Local model:** draft the note→question shaping prompt.

### T5 (W3c) — graph-first lookup in `search`

**Goal (proposal §2):** `query → 1. exact/alias title + wikilink-graph lookup
→ 2. vector search`, all behind the existing `search` MCP tool (calling
convention unchanged — frozen `Hit` shape from `src/interfaces/knowledge.ts`).

**What to build:** in the MCP `search` tool path (`src/mcp/server.ts`, where
`boostWikiHits` already lives): before vector search, try (a) exact/alias
title match against wiki pages, (b) 1-hop wikilink-graph expansion from
matched titles (the `WikiStore` interface already exposes `resolveLink` /
`backlinks`). Convert page matches into `Hit`s (score above vector hits,
`sourcePath` = wiki-relative path so existing boost/preview logic works) and
de-duplicate against vector results. Wiki store scans are O(pages) file reads
— fine at current scale, but memoize per call, not per process.

**Constraints:** `src/interfaces/knowledge.ts` and `src/interfaces/wiki.ts`
are frozen — if either genuinely needs a new method, write the contract test
first and flag the change loudly in the PR/commit. Degrade cleanly when the
wiki is absent/disabled.

**Read first:** `src/mcp/server.ts` (search tool + boostWikiHits),
`src/wiki/file-wiki-store.ts`, proposal §2.
Wiki: `wiki_read "Wiki-First Knowledge"`.
**Wiki writes:** debrief; append a "retrieval order" section to
`concepts/Wiki-First Knowledge.md`.
**Size:** medium. **Local model:** draft the title/alias matching helper +
its unit tests.

### T6 (C2 follow-up) — file watching for incremental index freshness

**Problem:** `GolemKnowledgeBase.ingest(path, projectId, watch: true)` throws
`NotImplementedYetError` (`src/knowledge/knowledge-base.ts`), so
`golem index --watch` and the `ingest` tool's `watch: true` are broken
promises. The wiki data flow also wants "wiki write → watcher → vector index".

**What to build:** a watcher module in `src/knowledge/` that drives the
EXISTING incremental machinery (`IncrementalIngest.reindexFiles` /
`removeSourcePaths` — note `deleteBySourcePaths` batching landed 2026-07-10;
debounce and batch events, don't reindex per keystroke).
**Decision memo required first** (plan §6 known unknown): `node:fs.watch`
(recursive is Windows/macOS-only; Linux needs per-directory watchers) vs
`chokidar` (pure-JS dep, allowed — the "no heavyweight deps" rule targets
NATIVE deps, but adding any dep still deserves the memo). Write the memo as a
dated entry in `docs/verification-notes.md` AND as
`docs/wiki/decisions/ADR-0001-file-watcher.md`, get the tests green on the CI
matrix mindset (Windows paths!), then implement.

**Read first:** `src/knowledge/knowledge-base.ts`, `src/knowledge/ingest.ts`
(scanFiles), `src/cli/auto-index.ts` (manifest sync — keep the manifest
consistent when the watcher reindexes), verification-notes §27.
**Wiki writes:** debrief; the ADR page above; an `entities/` page for the
chosen watcher library if an external dep is added.
**Size:** medium-large; do last. **Local model:** draft the debounce/batching
logic and the decision-memo comparison table.

### T7 — redaction: stop the entropy sweep eating repo paths

**Problem (live repro, 2026-07-10 — see verification-notes §49):** at every
slider level, the high-entropy sweep replaces ordinary repo paths (e.g.
`docs/wiki/decisions/ADR-0001-file-watcher`, seen live) with
`[REDACTED:high-entropy:N]` in the model's request context, because
`ENTROPY_CANDIDATE_RE` includes `/-_` so a whole path forms one candidate
token with mixed case + digits and high alphabet entropy. Disk content is
unaffected; the model's *view* is corrupted — an agent can't open a path it
sees as a placeholder, and this hits every conversation that mentions such a
path.

**What to build:** tune `isHighEntropyToken` (or the candidate regex) in
`src/pipeline/redaction-rules.ts` to reject path-like candidates — e.g. a
candidate containing `/` whose segments are short, dictionary-ish,
mostly-lowercase words is a path, not a secret. Be careful: standard-base64
secrets legitimately contain `/`; do NOT blanket-exclude slashes.

**Hard constraint (T-C3):** redaction may never be weakened outside a reviewed
change. The fix MUST extend `tests/unit/pipeline/redaction-corpus.ts` with the
new negative cases (repo paths, versioned filenames, ADR names) AND
demonstrate every existing positive (real-secret) case still redacts. Call
the change out prominently in the commit; determinism/prefix-stability rules
in the module header apply (this changes emitted bytes for affected inputs —
note the cache-prefix implication like COMPACTION_VERSION does).

**Read first:** `src/pipeline/redaction-rules.ts` (entropy section + audit
rationale comments), `src/pipeline/redaction.ts`,
`tests/unit/pipeline/redaction-corpus.ts`, verification-notes §31/§37/§49.
**Wiki writes:** debrief; a `concepts/Redaction Stage.md` page (type `concept`)
documenting the rule table, the entropy heuristic, and its known
false-positive classes.
**Size:** small-medium, high leverage — consider doing it FIRST since it
improves every other task's context fidelity. **Local model:** generate
candidate negative-corpus strings (paths, slugs, versioned names).

## 4. Deferred (do NOT start without asking the user)

- **W4** — user-scope `~/.golem/wiki/` federation + weekly synthesis reports.
- **C4** — MEMORY-scope federated search (needs the P2 Headroom Python sidecar).
- **T-C2** — cross-OS e2e smoke in CI (needs runner setup decisions).
- Anything in IMPLEMENTATION_PLAN §7 (WS-F*).

## 5. Post-batch

When the batch lands: update `docs/plan/IMPLEMENTATION_PLAN.md` (mark W3, the
W2-skills leftover, and the C2 follow-up done with dates), propose a
`syntheses/` wiki page tying the batch's debriefs together, and delete this
file (its content will live in the wiki + plan history).
