---
title: WebFetch caches the RAW page, not Claude Code's prompt-specific answer
type: debrief
tags: [webfetch, webcache, knowledge-base, hooks, redaction, decision-42, dogfooding]
sources: [src/knowledge/raw-fetch.ts, src/hooks/web-fetch.ts, src/knowledge/web-cache.ts, src/config/schema.ts, src/cli/main.ts]
created: 2026-07-23
updated: 2026-07-23
---

# WebFetch caches the RAW page, not the answer (Decision 42)

Closes a long-standing correctness bug in the WebFetch capture path, promoted
from the BACKLOG (logged 2026-07-18). Related: [[Dogfooding Golem]], the
wiki-first knowledge loop (Decision 28).

## The durable principle

**Claude Code's WebFetch does not return the page — it returns a
prompt-specific *answer*** (the page summarized against the call's `prompt`).
So a hook that caches `tool_response` keyed by URL alone is caching an answer,
not a page: a later fetch of the same URL with a different prompt gets served
the earlier answer, and the vector KB fills with answers masquerading as
sources. **To cache the raw page, Golem must fetch it itself** — the hook never
sees the raw markdown.

## What shipped (Option A — PreToolUse replace)

- **`fetchRawPage(url, timeoutMs?)`** (`src/knowledge/raw-fetch.ts`) — `fetch()`
  (with an `AbortSignal.timeout`, default 15 s — it now blocks the tool's critical
  path) → dispatch on content-type: HTML → the existing dependency-free
  `extractHtmlText`, PDF (content-type *or* `.pdf` path) → `extractPdfText`, else
  verbatim. Returns `{ content, headers }`; the headers carry `etag`/
  `last-modified`/`cache-control`/`expires`, which now seed the revalidation
  validators from a **real** fetch (previously they only appeared after a separate
  conditional GET). Throws on non-2xx / network error / timeout.
- **`WebCacheEntry.raw?: boolean`** distinguishes a raw-page entry from a legacy
  answer entry; threaded through `WebCacheMeta`, `put`, and `updateMeta`
  (preserved across a 304 metadata merge, since the content is unchanged).
- **PreToolUse is the fetch-cache-serve engine.** On a miss / stale / changed /
  legacy-answer entry (raw mode on), `fetchCacheAndServe` fetches raw → redacts
  (hard rule, before storage) → caches `raw:true` + validators → best-effort KB
  ingest → serves the raw page via a `deny`, so **WebFetch never runs on the happy
  path**. A failed fetch or empty extraction → **fall open** (return false, let
  WebFetch run). A fresh raw hit is served from cache with no self-fetch;
  revalidation is unchanged except a `no-store`/`200-changed` verdict now
  re-fetches raw rather than deferring to the tool.
- **PostToolUse is a no-op in raw mode** — the pre-hook owns caching, so it fires
  only when the pre-hook fell open (Golem's fetch failed) and then caches
  **nothing** (storing the answer is the bug). Legacy answer-capture survives only
  with raw mode OFF.
- **Config `knowledge.webcache_fetch_raw`** (default **true**), opt-out to legacy.

## Design calls worth remembering

- **Option A (PreToolUse replace), switched from an initial Option B cut**
  (mid-review, user's call). B let WebFetch run turn 1 and cached raw separately
  afterward — lower risk but two fetches per first access and never removes the
  double-fetch. A gives a single canonical fetch and serves the faithful raw page.
  Trade-offs accepted: turn 1 gets the raw page (≤8k in the deny reason; full page
  in cache + KB) instead of WebFetch's prompt-focused summary, and Golem's
  server-side fetch can be blocked where Claude's WebFetch succeeds — the fail-open
  path covers that (tool runs, nothing cached, retried next time).
- **The local-answer length-gate (`MAX_LOCAL_ANSWER_QUERY_CHARS = 1000`) stays —
  even under Option A.** The BACKLOG hoped raw-caching would retire it. It does
  not: Claude Code's WebFetch makes an *internal summarization model call* that
  transits Golem's **proxy**, where local-answer can hijack it. Option A skips
  WebFetch on the happy path (so that call never happens then), but on the
  **fail-open path** the tool still runs and its internal call still transits the
  proxy. So Option A only *narrows* the gate's exposure (to pages Golem can't
  fetch itself); the gate remains the safety net. Two complementary interception
  points — hook path (raw-caching) and proxy path (the gate).
- **Redaction still runs before storage** (hard rule) — the raw content goes
  through the pipeline redact + built-in secret strip, and the redacted content is
  also what's served to Claude in the deny reason.
- Drafted `fetchRawPage` and `fetchCacheAndServe` with the `coder` tool first per
  the local-coder practice (`qwen2.5-coder:7b`; the first call cold-load-timed-out).
  The drafts had the shape but leaked defects each time — `node-fetch` import, a
  dropped `await` on the async PDF extractor, a mutated `readonly` object, an
  over-broad try that swallowed cache/serve errors as "fetch failed", a
  `console.warn` — so the value was again in the review half (cf.
  [[Dogfooding Golem]]).

## Verification

`tsc --noEmit`, Biome lint + format, and `vitest run` (**1158** tests, incl. 5
new `raw-fetch` unit + a rewritten Decision-42 integration block) all green.

CI note: GitHub Actions remains billing-blocked (see
debriefs/2026-07-23-statusline-golem-dir-gating.md) — verified locally, same as
PRs #25/#27.

## Interfaces

No frozen `src/interfaces/` change. `WebCacheEntry`/`WebCacheMeta` (non-frozen,
`src/knowledge/web-cache.ts`) gain optional `raw`; `WebFetchHookOptions`
(non-frozen) gains injectable `fetchRaw`/`fetchRawEnabled` seams.
