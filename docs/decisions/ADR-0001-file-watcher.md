---
title: ADR-0001 File Watcher Backend
type: adr
tags: [knowledge, file-watching, cross-platform, decision]
sources: [docs/plan/next_batch.md, docs/plan/verification-notes.md]
created: 2026-07-11
updated: 2026-07-11
---

# ADR-0001: File Watcher Backend

**Status:** accepted

## Context

`GolemKnowledgeBase.ingest(path, projectId, watch: true)` throws
`NotImplementedYetError` (`src/knowledge/knowledge-base.ts`) — `golem index
--watch` and the `ingest` MCP tool's `watch: true` are unimplemented
promises (T6, C2 follow-up). The wiki data flow (see
[[Wiki-First Knowledge]]) also wants "wiki write → watcher → vector index"
so a fresh wiki page shows up in search without a manual re-index.

The existing incremental machinery already does the hard part —
`IncrementalIngest.reindexFiles` / `removeSourcePaths`
(`src/knowledge/knowledge-base.ts`), driven today by `ensureProjectIndexed`'s
mtime/size diff on `golem mcp serve` startup (`src/cli/auto-index.ts`). T6
only needs to drive that same machinery from live filesystem events instead
of a one-shot startup scan, debounced and batched so a burst of saves (or a
`git checkout`) doesn't trigger one reindex per file.

CLAUDE.md's cross-platform hard rule applies: native Windows, macOS, Linux,
CI green on all three. This ADR is the required decision memo (plan §6 known
unknown) before implementation starts.

## Options considered

**1. `node:fs.watch({ recursive: true })` everywhere.**
Zero added dependency. Verified (nodejs.org + nodejs/node issue tracker,
2026-07-11 — see verification-notes §51) that `recursive` is natively
supported on Windows and macOS, but Linux support is newer (added via PR
#45098, landing in the Node 20 line) and has documented reliability bugs
(issue #48437: recursive watch timing out on Ubuntu in 20.3.0) with no
confirmation found that they're fully resolved on Node 22. Using this option
as-is risks silently-flaky watching on Linux specifically — unacceptable
given the cross-platform hard rule, since Linux CI would be the one matrix
leg most likely to flake.

**2. `node:fs.watch` non-recursive, with our own directory-tree walk.**
Watch each directory individually (already have the traversal logic in
`src/knowledge/ingest.ts`'s `collectFiles`/`scanFiles`), adding/removing
per-directory watchers as subdirectories appear/disappear. Reliable on all
three platforms (this is the mode every platform has always supported), at
the cost of writing and testing that bookkeeping ourselves. Still needs a
debounce + re-stat layer regardless — `fs.watch` is independently known to
emit duplicate events, miss rapid-fire changes, and vary `rename` vs
`change` semantics by OS.

**3. `chokidar`.** Pure-JS dependency (no native bindings, so it doesn't
trip CLAUDE.md's "no heavyweight native deps" rule, which targets native
deps specifically), normalizes recursive watching and event semantics across
all three platforms, widely used. Cost: one more dependency to track,
version, and audit — and per the T6 brief, any added dependency (native or
not) warrants this memo, which is what this ADR is.

## Decision

Ship **Option 2** as the default: `node:fs.watch` with `recursive: true`
where natively reliable (Windows, macOS) and a manual per-directory
watch-and-rewalk on Linux, both behind one internal `FileWatcher` interface
in `src/knowledge/` so the backend is swappable without touching callers.
Every backend runs through the same debounce (coalesce a burst of events per
file/directory into one reindex) + re-stat (confirm the file has settled,
not caught mid-write) layer before calling `reindexFiles`/`removeSourcePaths`.

Do **not** add `chokidar` pre-emptively. Keep it as the documented fallback
(Option 3) behind the same `FileWatcher` interface, to swap in only if this
repo's own Linux CI run or dogfooding shows native watching is unreliable in
practice. Zero added dependency is worth trying first since the interface
seam makes the swap cheap later; adding a dependency "just in case" is not.

## Consequences

- No new dependency in the default install.
- Linux gets slightly more of our own code (the per-directory watcher
  bookkeeping) instead of leaning on Node's newer recursive support there —
  more surface to test, but avoids depending on a feature with an open
  reliability question on our target Node line.
- The `FileWatcher` interface must be designed now to make a later
  chokidar swap (if needed) a backend change only, not a caller change.
- Windows path handling (backslashes, drive letters) needs explicit test
  coverage in the per-directory watcher bookkeeping, per the CLAUDE.md
  cross-platform rule — `node:path` throughout, no hardcoded separators.

See also [[Distillation Pipeline]] and [[Wiki-First Knowledge]].
