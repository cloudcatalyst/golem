---
title: Webcache conditional revalidation (opt-in)
type: debrief
tags: [webcache, webfetch, http, cache, r4-followup]
sources: [src/hooks/web-fetch.ts, src/knowledge/web-cache.ts, docs/plan/BACKLOG.md]
created: 2026-07-16
updated: 2026-07-16
---

The first BACKLOG item, filed after the webcache served a 4–6-day-old,
truncated capture of a docs page during R4.7 (freshness was pure-TTL — a
changed page stayed served until the 7-day TTL lapsed).

## What landed (opt-in, default off)
- **`knowledge.webcache_revalidate`** setting (default `false`). When on, the
  PreToolUse(WebFetch) hook, before serving a cached URL, issues a **conditional
  request** (`If-None-Match` from a stored ETag, else `If-Modified-Since` from
  `Last-Modified`/`fetchedAt`):
  - **304** → serve cache; refresh stored validators + expiry (`updateMeta`).
  - **200** → resource changed → **drop the stale entry** and let the fetch
    re-run (post-hook re-caches + re-ingests fresh).
  - **`Cache-Control: no-store`** → drop the entry and re-fetch.
  - Honors an explicit freshness window (`max-age`/`Expires`) — no network call
    while provably fresh.
  - Revalidation failure (offline) → serve the cache (still within TTL).
- **WebCache** gained optional `etag`/`lastModified`/`expiresAt` (backward-
  compatible — legacy entries still parse), a merge-only `updateMeta`, and
  `delete` (`src/knowledge/web-cache.ts`).

## The invariant (why 200 drops rather than stashes)
An entry's validators must always describe **that entry's own content** — else a
later `304` (server matching the stored etag) would serve stale bytes as fresh.
So `put` overwrites: new content ⇒ any validators not passed for it are dropped,
never carried from the prior entry. Validators survive a write in exactly one
place — `updateMeta`, used only on `304`, where the content is unchanged. On
`200` the pre-hook `delete`s the entry instead of stashing the new validators
onto the old content: if the re-fetch is cancelled/declined, a bare miss simply
re-fetches later, whereas old-content-with-new-validators would be served as
fresh. (This also closes the same desync on the plain past-TTL re-fetch path,
where the old auto-merging `put` would have stamped stale validators onto freshly
fetched content.)

## Design notes
- Claude Code's WebFetch `tool_response` exposes processed markdown, **not HTTP
  headers**, so validators can only come from a request Golem makes itself —
  hence the conditional GET lives in the pre-hook (body cancelled; status +
  headers only). The pre-hook owns validators (via `updateMeta`/`delete`); the
  post-hook owns content (via `put`) — they never write conflicting views of the
  same entry, so no cross-hook merge is needed.
- Kept opt-in and gated in the CLI layer (`revalidate` + `revalidateEnabled`
  injected from `main.ts`, reading the setting) so `src/hooks/` stays free of a
  config dependency and existing pure-TTL behavior/tests are unchanged. Same
  opt-in-until-proven footing as `rerank_enabled` / `memory_federation_enabled`
  (Decision 23). Enable with `knowledge.webcache_revalidate=true`.

## Verification
`tsc`/lint/format clean; `npx vitest run` 936 green (+13: 6 WebCache
put-drops-stale-validators/updateMeta-merges/delete/legacy-parse, 7 pre-hook
revalidation — 304-serves, 200-drops+allows, conditional-headers-from-validators,
expiresAt-skips-network, no-store-drops, offline-serves, disabled-is-pure-TTL).
See [[Dogfooding Golem]].

