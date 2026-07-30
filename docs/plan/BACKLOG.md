# BACKLOG — ideas inbox

> **Created 2026-07-16** by R4.1 (the planning-collaboration surface, Decision 36).
> **Compressed 2026-07-30** (Decision 55): resolved rows are now one line pointing at
> the record, so open ideas are visible instead of buried under status prose.

This is the lightweight, committed inbox **before** something is work. An idea lands
here as one line, gets discussed, and then either graduates into a task document under
[`tasks/`](tasks/) or is dropped with the reason kept.

```
raw ──▶ discussed ──▶ promoted (a task document exists)
                 └──▶ dropped   (kept as a decision record)
```

## How this file works

- **One row per idea, newest at the top. One line.** Detail belongs in the task
  document, the debrief, or `verification-notes.md` — never here. A resolved row keeps
  a pointer, not a summary.
- **Human-editable and agent-appended.** A human may edit any row. The agent appends
  rows and updates a `Status`; it never rewrites or deletes another row's wording.
- **Driven by `/golem/plan`**, which reads recent `golem note` captures,
  `docs/wiki/questions/`, `.golem/distill/` drafts, this file, and the roadmap index,
  then co-drafts new rows with the user.
- **Source must be traceable:** a note timestamp (`note:2026-07-16T…Z`), a wiki page
  (`questions/<slug>.md`), a distill draft (`distill:<slug>`), a spec Decision, or
  `conversation` (say which session/date).

## Open

| Date | Idea | Source | Status |
|---|---|---|---|
| — | _(empty — every captured idea is currently promoted or dropped)_ | — | — |

## Resolved

Kept as a record. The pointer is the detail.

| Date | Idea | Outcome |
|---|---|---|
| 2026-07-29 | `tests/integration/cli-init.test.ts` flaky on Windows under full-suite load (5s timeout + `ENOTEMPTY` on recursive delete) | **FIXED 2026-07-30.** Mode (a) resolved by the global 20s `testTimeout` (§86c); mode (b) fixed at the class rather than the instance — all **85** temp-tree deletes across **72** files now share `tests/helpers/tmp.ts`'s retry-hardened `rmTemp`. Three consecutive full-suite runs green. `debriefs/2026-07-30-workstream-b-tool-selection.md` |
| 2026-07-25 | Architecture diagram — the dogfooding two-proxy setup | **DONE 2026-07-30** — lead diagram of `[[Dogfooding Golem]]` (two proxies + ports, daemon lifecycle, promote edge, Headroom sidecar). |
| 2026-07-25 | Architecture diagram — task multiplexing & prompt translation | **DONE 2026-07-30** — `[[Architecture]]` §6a and §6b, drawn from the source rather than from memory. |
| 2026-07-24 | Lazy tool-definition loading — native `defer_loading` passthrough and/or in-proxy pruning of the tools block | **REJECTED across two batches.** §89: native tool search is GA and Anthropic's to run (it does not shrink the request and does not bust the cache); the prose shrinker saves 0 (whitespace) or triples false positives (first-sentence). §100: of the block, **93.9% is client built-ins** and Golem's share is **1,130 tokens = 0.8% of a request** — so schema shrinking was rejected on arithmetic too. Line closed. `debriefs/2026-07-30-r8.s1-tool-schema-shrinking.md` |
| 2026-07-24 | Cache-hit observability + cache-busting detection | **SHIPPED 2026-07-30 as R8.1** (`golem stats --cache`; billed rate and prefix verdict never merged). Its first measurement re-ranked R8 (§93). **The verdict half then proved unreliable (§99)** → open task [R8.13](tasks/R8.13.md). |
| 2026-07-18 | Golem snooze — park a live session in-place until the limit resets | **SHIPPED 2026-07-22** — spec Decision 38 (#10–#16). Design record `proposals/golem-snooze.md`. Residual manual check: that quota restores for the next turn after a real reset. |
| 2026-07-18 | WebFetch should cache RAW pages, not prompt-specific answers | **SHIPPED 2026-07-23** — spec Decision 42, option A (the pre-hook fetches the page itself and serves it via `deny`; a failed self-fetch falls open). **Correction:** does *not* fully supersede the local-answer length gate — on the fail-open path WebFetch still runs and its summarisation call transits the proxy. `debriefs/2026-07-23-webfetch-raw-cache.md` |
| 2026-07-18 | Limit-prediction observability from the rate-limit headers | **SHIPPED 2026-07-22** as snooze P2a (`src/proxy/limit-prediction.ts`, observe-only). Feeds the document-and-hold trigger. |
| 2026-07-17 | Coder `refine` fired 0 rounds across all 5 LE2 tasks | **FIXED 2026-07-17** — root cause was *not* the prompt or threshold: the judge model was never pulled, so every judge call failed into a silent `catch`. Fixed with an explicit `RefineStatus` + a drafter self-review fallback. **The underlying gap is still open** — `golem devices` reports the tier catalog, not what Ollama has: [local-models](tasks/local-models.md). |
| 2026-07-16 | Webcache pre-cache freshness check (`If-None-Match` / `If-Modified-Since`) | **SHIPPED 2026-07-16** — opt-in `knowledge.webcache_revalidate`. `debriefs/2026-07-16-webcache-revalidation.md` |
