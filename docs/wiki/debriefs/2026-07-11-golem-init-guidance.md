---
title: golem-init guidance template — wiki promotion + local-model-first
type: debrief
tags: [init, guidance, wiki, delegate, decision-28]
sources: [docs/plan/next_batch.md, src/hooks/guidance.ts]
created: 2026-07-11
updated: 2026-07-16
---

> **Update 2026-07-16 (user decision):** the guidance target moved from the
> gitignored `CLAUDE.local.md` to the **committed `CLAUDE.md`** — the wiki/KB/
> coder-first practices are project defaults that should apply for every
> teammate, not per-machine. `CLAUDE.local.md` stays gitignored for a user's own
> notes + opt-in feature instructions (e.g. `golem prompt guidance`). See
> `debriefs/2026-07-16-R5.5.md`.

# golem-init guidance template — wiki promotion + local-model-first

Not a `next_batch.md` task ID — a direct user request to bake this session's
own working practices into the `CLAUDE.local.md` section every `golem init`
writes, so future projects get them without a human having to ask twice.

## What changed

`src/hooks/guidance.ts`'s `golemGuidanceSection()` (the marker-fenced text
written into `CLAUDE.local.md` by `writeGuidanceSection`) gained three things:

1. **Captures point back at the graph, not just the index.** Step 3 of the
   wiki-first ladder now names `ingest` and `golem note` alongside WebFetch as
   sources of raw, searchable-but-disconnected content. Step 4 was rewritten:
   a raw capture "has no place in the graph until it's a wiki page" — propose
   promoting it, citing the raw source and adding real outgoing wikilinks
   (`extractWikilinks`) to every related page, not just an orphaned chunk a
   vector search might surface once.
2. **Skim the index at session start.** A short paragraph ahead of the ladder
   tells Claude to read `WIKI.md`'s own Index once per session before
   searching — cheap, avoids duplicate work. This is a text instruction, not
   new automation — see "Considered and declined" below.
3. **New section: prefer the local model for coding drafts.** Grounded in
   `src/interfaces/policy.ts`'s real `LEVEL_TABLE` (`localDrafts` is `true`
   only at levels 4-5) rather than inventing a "local drafting enabled" flag
   `stats` doesn't report. Deliberately excludes any GPU/hardware pacing
   language — that's specific to this repo's dev box, not to every project
   `golem init` touches.

## Considered and declined

The user's phrasing floated "maybe an index could be built and loaded at the
start of a session." `golem hook session-start` (`src/cli/main.ts`) already
exists and currently only auto-restarts the proxy — it could be extended to
print a wiki summary automatically. Declined for this task: the user's own
"maybe" framing marks it as optional, and auto-generating + injecting a wiki
index is a materially bigger feature (new hook output contract, staleness
handling) than "bake practices into instructions." The text-based "skim
WIKI.md's Index" instruction satisfies the same intent at effort proportional
to what was asked. Left as a candidate for a future task if the manual-skim
instruction proves insufficient in practice.

## Verification

- `tests/integration/hooks/guidance.test.ts`: 3 new cases — session-start
  index-skim instruction present; capture-promotion step names `ingest` and
  `golem note` and requires real outgoing wikilinks; local-model section present,
  names `delegate` and level 4, and contains no "gpu" (case-insensitive).
- Existing `cli-init.test.ts` constraint (`CLAUDE.local.md` contains
  "wiki-first knowledge") still passes unchanged.
- Full gate: `tsc --noEmit`, `npm run lint`, `npm run format:check`, `npm test`
  (72 files / 695 tests) all clean. Rebuilt, restarted the proxy, confirmed
  `.golem/settings.json` still has `"level": 5`. Live-verified with a fresh
  `golem init` in a scratch directory — generated `CLAUDE.local.md` reads as
  expected.

See also [[Wiki-First Knowledge]] and [[Distillation Pipeline]].
