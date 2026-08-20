---
title: Auto-Index Cost
type: concept
tags: [knowledge, embeddings, indexing, performance, gpu, session-start]
sources: [src/cli/auto-index.ts, src/cli/commands/mcp-serve.ts, src/knowledge/file-driver.ts, src/config/schema.ts]
created: 2026-08-21
updated: 2026-08-21
---

# Auto-Index Cost

Keeping the [[Knowledge Base]] fresh costs **GPU time, at session start, on the
user's machine**. This page records what that cost actually is, the two ways it
used to be paid over and over, and the three rules that now bound it.

Measured on this repo (RTX-class GPU, `bge-m3` via Ollama, `FileVectorDriver`):

| Work | Time |
|---|---|
| 8 changed files | ~42 s |
| 114 changed files | ~10 min |
| per file | **~5 s** |

## Who triggers it

`golem hook session-start` → the proxy/MCP daemons start → `golem mcp serve` calls
`ensureProjectIndexed` **fire-and-forget** (`void`, so startup never blocks). Every
new Claude Code session is therefore a potential multi-minute embed. `golem index`
is the same call made explicitly.

## The two repeat-cost bugs (fixed R11.2)

**1. Progress was only recorded at the end.** `manifest.json` (embedder signature +
`sourcePath → mtime/size` per file) was written once, after the whole sync. Chunks
streamed to disk as they were embedded, so a killed run left its *vectors* but no
*record* — and the next session recomputed the identical set. A session shorter
than the sync could never make progress, so the spike repeated forever with no file
changing. Observed live: manifest stuck 5 days while `chunks.jsonl` kept growing.

Now the sync **checkpoints every `INDEX_CHECKPOINT_FILES` (20) files**, starting from
the previously recorded states and advancing one batch at a time — the manifest never
claims a file whose chunks aren't stored yet, and finished batches stay finished.
Deletions are applied and checkpointed first: they cost no embedding.

**2. Nothing bounded a single automatic run.** A `git checkout` rewrites mtimes
wholesale, so a branch switch alone makes hundreds of "changed" files. Now
`knowledge.auto_index_max_files` (default **50**, `0` = uncapped) makes the automatic
caller **defer** past the cap: nothing is embedded, the manifest is untouched, and the
log says to run `golem index`. Only `mcp serve` passes the cap — `golem index` is the
explicit ask and syncs whatever is pending.

The cap is deliberately **not** applied to the first-run or embedder-change full
build: a project with no index has no search at all, and those builds announce
themselves (see `planBuildEmbedder`'s notices in [[Knowledge Base]]).

## One project, one collection

A collection directory is `sha256(canonicalProjectId(projectId))[0..16]`. The id is
usually an absolute path, and the same project arrives spelled differently —
`d:\repo` / `D:\repo` / `D:/repo` / `D:\repo\`. Each spelling used to hash to its own
collection, each re-embedding the tree independently: this repo carried **three
collections, 231 MB, two unreachable**. `canonicalProjectId` now uppercases the drive
letter, folds `/` to `\`, and drops trailing separators — for Windows paths only,
since `\` is a legal filename character on POSIX and folding it there would merge two
different directories.

## Symptom → cause

- *"Huge GPU spike on every new session, nothing changed"* → a sync that never gets
  to record itself (fixed), or a genuinely large changed-set (now deferred).
- *`.golem/knowledge` has several fat directories* → duplicate collections from
  different path spellings (fixed; delete the stale ones by hand).
- *Ollama shows `bge-m3` resident at 100% GPU* → expected during a sync; it holds a
  keepalive window afterwards.

Related: [[Knowledge Base]], [[Configuration Surfaces]], [[Dogfooding Golem]].
