# BACKLOG — ideas inbox

> **Created 2026-07-16** by R4.1 (the planning-collaboration surface, spec
> Decision 36). This is the lightweight, committed inbox that closes the
> second-brain loop into **tasks**: captured ideas (`golem note`), open wiki
> `questions/`, and pending distill drafts land here as one-line candidates,
> get discussed with the user, and graduate into `ROADMAP.md` / the current
> batch brief when promoted.

## How this file works

- **One row per idea.** Newest at the top of the table.
- **Human-editable and agent-appended.** A human can edit any row directly.
  The agent only ever *appends* rows or updates a `Status`, and only through
  the plan-gate — it proposes the exact edit and waits for approval before
  writing (spec Decisions 28/29). It never rewrites or deletes another row's
  wording.
- **Driven by `/golem/plan`.** That skill reads recent `golem note` captures,
  `docs/wiki/questions/`, `.golem/distill/` drafts, this file, and
  `ROADMAP.md`, then co-drafts new rows here with the user.

### Columns

| Column | Meaning |
|---|---|
| **Date** | `YYYY-MM-DD` the idea was logged here. |
| **Idea** | One-line statement of the idea (what, not how). |
| **Source** | Where it came from, so it can be traced and verified: a note timestamp (`note:2026-07-16T…Z`), a wiki page (`questions/<slug>.md`), a distill draft (`distill:<slug>`), a spec Decision, or `conversation` (an idea raised live — say which session/date). |
| **Status** | `raw` (captured, not yet discussed) · `discussed` (talked through with the user, not yet a task) · `promoted` (graduated into `ROADMAP.md`/a batch — link the task ID) · `dropped` (decided against — keep the row as a record of the decision). |

An idea flows `raw → discussed → promoted`/`dropped`. Promoted rows stay here
with a pointer to their task ID; dropped rows stay as a decision record. This
file is an index of *ideas*, never a place to duplicate task detail — that
lives in `ROADMAP.md` and the batch brief.

## Ideas

| Date | Idea | Source | Status |
|---|---|---|---|
| 2026-07-16 | Webcache pre-cache freshness check: on a repeat WebFetch, send a conditional request (`If-None-Match` from a stored `ETag`, `If-Modified-Since` from `Last-Modified`); on `200` replace the cache + re-distill, on `304` serve cache. Honor `Cache-Control`/`Expires` (`no-store`/`max-age`) so a changed page isn't served stale (as the Claude Code docs were during R4.7). | conversation (2026-07-16 R4 session) | promoted — shipped 2026-07-16 (opt-in `knowledge.webcache_revalidate`); see debriefs/2026-07-16-webcache-revalidation.md |
