# Proposal: WebFetch raw-page caching

> **Status: SHIPPED (2026-07-23), spec Decision 42.** Landed on branch
> `feat/webfetch-raw-cache`. Kept as the verified design record; the
> authoritative entry is Decision 42 in `docs/golem-spec.md`.

## Problem

Claude Code's WebFetch tool does not return the raw page — it returns a
**prompt-specific answer**: the fetched page run through a summarization model
against the call's `prompt`. Golem's `PostToolUse(WebFetch)` capture hook cached
that `tool_response` keyed by URL alone. Three consequences:

1. **Wrong answer served on a re-fetch.** Fetch `docs/api` with prompt "list the
   params" → the params answer is cached as "the page." A later fetch of the
   same URL with prompt "what's the auth model" is served the *params* answer.
2. **Poor KB citation source.** A prompt-specific answer masquerading as a page
   pollutes the vector KB and the wiki-first ladder (Decision 28).
3. **Local-answer hijack surface.** A hijacked local-answer could be cached *as*
   the page (the vector behind the #8 context-carrying fix and the local-answer
   length-gate band-aid).

The hard constraint: the PostToolUse hook only ever receives the *answer*, never
the raw page markdown — so to cache the raw page, **Golem must fetch it itself**.

## Design (chosen: Option A — PreToolUse replace)

Two candidate fetch points were weighed. **Option A was chosen** (a mid-review
switch from an initial Option B cut, USER decision — the extra complexity buys a
single canonical fetch and a more faithful serve):

- **Option A — PreToolUse replace (chosen).** On a cache miss (or a
  stale/changed/legacy entry), the `PreToolUse` hook fetches the raw page itself,
  caches + ingests it, and serves it back via a `deny` decision — so Claude
  Code's WebFetch **never runs** on the happy path. If Golem's own fetch fails,
  the hook **falls open** and lets WebFetch run. Single canonical fetch; the
  served content is the raw page (prompt-independent), not a summary.
- **Option B — PostToolUse alongside (rejected).** Turn 1 lets WebFetch run and
  caches the raw page separately afterward. Lower risk (turn-1 UX unchanged) but
  two fetches on every first access, and it never removes the double-fetch.

### What shipped

- **`src/knowledge/raw-fetch.ts` — `fetchRawPage(url, timeoutMs?)`.** `fetch()`
  (with an `AbortSignal.timeout`, default 15 s, because it now blocks the tool's
  critical path) → dispatch on content-type: HTML → `extractHtmlText`, PDF
  (content-type or `.pdf` path) → `extractPdfText`, else verbatim. Returns
  `{ content, headers }` where `headers` carry `etag`/`last-modified`/
  `cache-control`/`expires` — seeds the revalidation validators from a *real*
  fetch (previously they only appeared after a separate conditional GET). Throws
  on non-2xx / network error / timeout.
- **`WebCacheEntry.raw?: boolean`** marks entries holding the raw page. New writes
  set it; legacy answer-entries lack it. `WebCacheMeta` + `put`/`updateMeta`
  thread it through (preserved across a 304 metadata merge).
- **PreToolUse is now the fetch-cache-serve engine.** `rawMode` (fetcher wired +
  gate on) is computed up front. A fresh raw cache hit is served as before
  (revalidation unchanged, except a `no-store` / `200-changed` verdict now
  re-fetches raw rather than deferring to the tool). A miss / stale / changed /
  legacy-answer entry routes through `fetchCacheAndServe`: fetch raw → redact
  (hard rule, before storage) → cache `raw:true` + validators → best-effort KB
  ingest → serve raw via `deny`. A failed fetch or empty extraction returns false
  → the hook falls open (WebFetch runs).
- **PostToolUse is a no-op in raw mode** (the pre hook owns caching). It fires only
  when the pre hook fell open (Golem's fetch failed); it deliberately does **not**
  cache WebFetch's answer then — that is the bug. It keeps the legacy
  answer-capture only when raw mode is OFF.
- **Config `knowledge.webcache_fetch_raw` (default true)** for opt-out to the
  legacy behavior. CLI wires `fetchRaw: fetchRawPage` + a gate reading the key.

### Why the local-answer length-gate is NOT removed

The BACKLOG hoped this would supersede the `MAX_LOCAL_ANSWER_QUERY_CHARS = 1000`
band-aid. It does not — even under Option A. Claude Code's WebFetch makes an
*internal summarization model call* that transits Golem's **proxy**, where
local-answer can hijack it. Option A skips WebFetch on the happy path (so that
call never happens then), but on the **fail-open path** — a page Golem couldn't
fetch itself — WebFetch still runs and its internal call still transits the proxy.
So Option A *narrows* the gate's exposure (only pages Golem can't fetch) but does
not eliminate it. The gate guards the proxy path; raw-caching guards the hook
path; they are complementary, and the gate stays.

## Trade-offs accepted (Option A)

- **The served raw page is capped at `MAX_SERVED_CHARS` (~8k) in the deny reason**,
  same as a cache hit; the full page is in the cache + KB (`search`/`fetch`).
  Claude no longer gets WebFetch's prompt-focused summary on the first fetch — it
  gets the raw (truncated) page. Faithful and prompt-independent, which is the
  point, but a behavior change worth noting.
- **Golem's server-side fetch can be blocked where Claude's WebFetch succeeds**
  (bot walls, JS-rendered pages). The fail-open path covers this — the tool runs
  and (raw mode) nothing is cached, so it simply retries next time.
- **The self-fetch is on the tool's critical path**, hence the 15 s timeout.

## Tests

`tests/unit/knowledge/raw-fetch.test.ts` (5) + a rewritten Decision-42 block in
`tests/integration/hooks/web-fetch.test.ts`: miss → fetch+cache(raw)+ingest+serve;
fail-open on fetch error (nothing cached); legacy-answer entry re-fetched as raw;
fresh raw hit served without re-fetching; revalidation-200 re-fetches raw;
PostToolUse no-op in raw mode; raw-mode-off legacy fall-through.
