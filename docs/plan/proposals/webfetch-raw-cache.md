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

## Design (chosen: Option B — PostToolUse alongside)

Two candidate fetch points were weighed:

- **Option A — PreToolUse replace.** On a miss, Golem fetches raw, caches it, and
  serves raw via the deny-reason, skipping Claude Code's WebFetch entirely.
  Single canonical fetch; but turn-1 loses prompt-targeting, and Golem's
  server-side fetch can be blocked where Claude's WebFetch succeeds.
- **Option B — PostToolUse alongside (chosen).** Turn 1: Claude Code's WebFetch
  still runs (Claude gets its prompt-targeted answer, as today). In PostToolUse,
  Golem *separately* fetches the raw page and caches/ingests THAT — never the
  answer. Repeat fetches serve raw from cache. Lowest risk: turn-1 UX unchanged;
  a failed raw fetch caches **nothing** (an honest miss), never poisoning the
  cache with the answer. Cost: two fetches on first access.

### What shipped

- **`src/knowledge/raw-fetch.ts` — `fetchRawPage(url)`.** `fetch()` → dispatch on
  content-type: HTML → `extractHtmlText`, PDF (content-type or `.pdf` path) →
  `extractPdfText`, else verbatim text. Returns `{ content, headers }` where
  `headers` carry `etag`/`last-modified`/`cache-control`/`expires` — a bonus that
  seeds the revalidation validators from a *real* fetch (previously they only
  appeared after a separate conditional GET). Throws on non-2xx / network error.
- **`WebCacheEntry.raw?: boolean`** marks entries holding the raw page. New writes
  set it; legacy answer-entries lack it. `WebCacheMeta` + `put`/`updateMeta`
  thread it through (preserved across a 304 metadata merge).
- **PostToolUse rewrite.** When raw mode is active (fetcher wired + gate on), it
  calls `fetchRaw(url)` → redact (hard rule, before storage) → cache with
  `raw:true` + validators → ingest raw into the KB. A throw caches nothing.
  Legacy answer-capture remains as the gate-off fallback.
- **PreToolUse.** When raw mode is on, a legacy answer-entry (no `raw` marker) is
  treated as a miss so it self-heals (re-fetched + re-cached as raw). Cheap raw
  entries skip the config read; only a legacy entry consults the gate.
- **Config `knowledge.webcache_fetch_raw` (default true).** Opt-out to the legacy
  behavior. CLI wires `fetchRaw: fetchRawPage` + a gate reading the key.

### Why the local-answer length-gate is NOT removed

The BACKLOG hoped this would supersede the `MAX_LOCAL_ANSWER_QUERY_CHARS = 1000`
band-aid. It does not, under Option B: Claude Code's WebFetch makes an *internal
summarization model call* that transits Golem's **proxy**, and on a cache **miss**
that call still happens — so local-answer could still hijack a tiny page. The
gate guards the proxy path; raw-caching guards the hook path. (Option A *would*
have superseded it, since WebFetch never runs.) The gate stays.

## Tests

`tests/unit/knowledge/raw-fetch.test.ts` (5) + new cases in
`tests/integration/hooks/web-fetch.test.ts` (raw-caches the page not the answer;
caches nothing on fetch failure; legacy fallback when gated off; PreToolUse
ignores legacy entries / serves raw / stays backward-compatible when off).

## Follow-ups

- Option A (serve raw directly on a miss) could later eliminate the double fetch
  and let the length-gate retire — deferred; Option B is the low-risk first cut.
