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
| 2026-07-18 | **Golem snooze** — park a LIVE Claude session in-place until the usage limit resets, via a heartbeating MCP wait-tool. A tool call is a near-free wait (no model tokens while it blocks), and Claude Code has no hard max tool duration — a long tool call survives indefinitely by emitting progress notifications (idle timeout, 30 min stdio default, raisable/0-disable). So `snooze` blocks the session foreground with a ~60s progress heartbeat until reset, then returns and Claude continues in the SAME window (context intact) — the one approach that resumes in-place, unlike spawn (Decision 37) or tmux puppeting. Pairs with the limit-prediction row (predict → snooze). Spike-first: (1) confirm a heartbeating stdio tool holds past 30 min + past auto-background as a foreground block, (2) confirm quota restores for the next turn after reset mid-session, (3) pick the least-fragile trigger. | conversation (2026-07-18 local-answer session) | **SHIPPED 2026-07-22** — spec Decision 38; landed #10–#16 (snooze tool + limit-prediction + document-and-hold trigger, on by default). Design record: `docs/plan/proposals/golem-snooze.md`. Residual manual check: quota restores for the next turn after a real reset. |
| 2026-07-18 | WebFetch should cache RAW pages, not summaries, and consume wiki-first: the PostToolUse WebFetch hook caches the tool's returned text — for Claude Code's WebFetch that's the prompt-specific ANSWER, keyed by URL — so a later fetch of the same URL with a different prompt is served a stale/wrong answer, and (pre-fix) a hijacked local-answer got cached AS the page. Desired flow: on WebFetch, check the webcache/KB; on a miss ALWAYS do a real fetch (never KB-substitute) and cache the RAW page; then consume via the Decision 28 ladder — distilled wiki note first, raw KB cache second. Open constraint: the PostToolUse hook only receives the tool's answer, not the raw markdown, so caching raw needs Golem to fetch the page itself (or capture markdown another way). Supersedes the local-answer length-gate band-aid for WebFetch and closes the tiny-page residual (a <1000-char page could still reach local-answer). | conversation (2026-07-18 local-answer session) | **SHIPPED 2026-07-23** — spec Decision 42, branch `feat/webfetch-raw-cache`. **Option A (PreToolUse replace):** the pre-hook fetches the raw page itself on a miss (`fetchRawPage`), caches/ingests it (`raw:true`), and serves it via `deny` so WebFetch never runs on the happy path; a failed self-fetch falls open (WebFetch runs, nothing cached), PostToolUse is a no-op in raw mode. Config `knowledge.webcache_fetch_raw` (default on). **Correction:** does NOT fully supersede the length-gate — on the fail-open path WebFetch still runs and its internal summarization call transits the proxy, so the gate stays (Option A only narrows its exposure). Design record: `docs/plan/proposals/webfetch-raw-cache.md`; debrief 2026-07-23-webfetch-raw-cache.md. |
| 2026-07-18 | Limit-prediction observability: the proxy already sees Anthropic's per-response `anthropic-ratelimit-unified-*-utilization`/`-reset` headers on every turn — surface a forecast ("5h window ~95% used, ~N min to limit") in the status line / session-state / `golem status`. Observe-and-predict only — a proxy cannot pause/resume the interactive TUI (Decision 37), so this complements (does not replace) an external session-automation tool that does the actuation. In-scope as honest observability; needs none of the removed auto-resume code. | conversation (2026-07-18 auto-resume session) | **SHIPPED 2026-07-22** — as snooze P2a (`src/proxy/limit-prediction.ts`, observe-only `onResponseHeaders` hook → `.golem/state/limit.json`); spec Decision 38. Feeds the document-and-hold trigger; a `golem status`/statusline surface can build on the persisted state. |
| 2026-07-17 | Coder `refine` (judge→revise) fired 0 rounds across all 5 LE2 tasks — the judge never flagged high/medium issues, even a `module.exports`/CJS error it should catch. Investigate the judge prompt/verdict-schema/threshold so refinement actually catches obvious defects; re-measure accept-rate after. | conversation (2026-07-17 PRE-R6 batch); syntheses/le2-grounded-refined-coder-quality.md | **fixed 2026-07-17** — root cause was NOT the prompt/threshold: the judge model (`qwen2.5:14b`) simply isn't pulled, so every judge call failed and a silent `catch` reported `rounds:0`. Fix: explicit `RefineStatus` (no silent skips) + judge→drafter self-review fallback; E2E-verified it now revises. See debriefs/2026-07-17-pre-r6-loose-ends.md. |
| 2026-07-16 | Webcache pre-cache freshness check: on a repeat WebFetch, send a conditional request (`If-None-Match` from a stored `ETag`, `If-Modified-Since` from `Last-Modified`); on `200` replace the cache + re-distill, on `304` serve cache. Honor `Cache-Control`/`Expires` (`no-store`/`max-age`) so a changed page isn't served stale (as the Claude Code docs were during R4.7). | conversation (2026-07-16 R4 session) | promoted — shipped 2026-07-16 (opt-in `knowledge.webcache_revalidate`); see debriefs/2026-07-16-webcache-revalidation.md |
