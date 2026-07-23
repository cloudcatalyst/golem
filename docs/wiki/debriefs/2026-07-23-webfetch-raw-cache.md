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

## What shipped

- **`fetchRawPage(url)`** (`src/knowledge/raw-fetch.ts`) — `fetch()` → dispatch
  on content-type: HTML → the existing dependency-free `extractHtmlText`, PDF
  (content-type *or* `.pdf` path) → `extractPdfText`, else verbatim. Returns
  `{ content, headers }`; the headers carry `etag`/`last-modified`/
  `cache-control`/`expires`, which now seed the revalidation validators from a
  **real** fetch (previously they only appeared after a separate conditional
  GET). Throws on non-2xx / network error.
- **`WebCacheEntry.raw?: boolean`** distinguishes a raw-page entry from a legacy
  answer entry; threaded through `WebCacheMeta`, `put`, and `updateMeta`
  (preserved across a 304 metadata merge, since the content is unchanged).
- **PostToolUse rewrite.** Raw mode active (fetcher wired + gate on): fetch raw
  → redact (hard rule, before storage) → cache `raw:true` + validators → ingest
  raw. **A failed raw fetch caches nothing** — an honest miss beats poisoning the
  cache with the answer. Legacy answer-capture stays as the gate-off fallback.
- **PreToolUse.** When raw mode is on, a legacy answer-entry (no `raw` marker) is
  treated as a miss so it self-heals — re-fetched and re-cached as the raw page.
  Raw entries skip the config read; only a legacy entry consults the gate.
- **Config `knowledge.webcache_fetch_raw`** (default **true**), opt-out to legacy.

## Design calls worth remembering

- **Option B (PostToolUse alongside), not Option A (PreToolUse replace).** Option
  A would have Golem serve raw directly on a miss and skip Claude Code's WebFetch
  — a single fetch, and it would have let the length-gate retire. Rejected for
  the first cut because it loses turn-1 prompt-targeting and Golem's server-side
  fetch can be blocked where Claude's WebFetch succeeds. Option B keeps turn-1 UX
  identical; cost is two fetches on first access. Option A is a recorded
  follow-up.
- **The local-answer length-gate (`MAX_LOCAL_ANSWER_QUERY_CHARS = 1000`) stays.**
  The BACKLOG hoped raw-caching would supersede it. It does not under Option B:
  Claude Code's WebFetch makes an *internal summarization model call* that
  transits Golem's **proxy**, and on a cache **miss** that call still fires — so
  the local-answer hijack surface on the proxy path is untouched by a hook-path
  fix. Two different interception points; the gate guards the one raw-caching
  doesn't. (Option A would have retired it, since WebFetch never runs.)
- **Redaction still runs before storage** (hard rule) — the raw content goes
  through the pipeline redact + built-in secret strip exactly as the answer did.
- Drafted `fetchRawPage` with the `coder` tool first per the local-coder practice
  (cold-load timeout on the first call, `qwen2.5-coder:7b` draft on the second);
  the draft had the shape but imported `node-fetch`, dropped the interface decls,
  missed the `await` on the async PDF extractor, and mutated a `readonly` object —
  the value was in the review half (cf. [[Dogfooding Golem]]).

## Verification

`tsc --noEmit`, Biome lint + format, and `vitest run` (**1158** tests, incl. 5
new `raw-fetch` unit + 6 new web-fetch integration cases) all green.

CI note: GitHub Actions remains billing-blocked (see
debriefs/2026-07-23-statusline-golem-dir-gating.md) — verified locally, same as
PRs #25/#27.

## Interfaces

No frozen `src/interfaces/` change. `WebCacheEntry`/`WebCacheMeta` (non-frozen,
`src/knowledge/web-cache.ts`) gain optional `raw`; `WebFetchHookOptions`
(non-frozen) gains injectable `fetchRaw`/`fetchRawEnabled` seams.
