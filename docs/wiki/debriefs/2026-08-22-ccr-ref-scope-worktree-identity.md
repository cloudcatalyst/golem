---
title: ccr-ref-scope — a worktree is the same project, and "expired" was a guess
type: debrief
tags: [ccr, compression, worktree, git, knowledge, unknownReferror, r11.2]
sources: [docs/plan/tasks/ccr-ref-scope.md, docs/plan/verification-notes.md, src/shared/git-worktree.ts, src/compression/ccr-store.ts, src/interfaces/compression.ts, docs/wiki/concepts/CCR Ref Scope.md]
created: 2026-08-22
updated: 2026-08-22
---

# ccr-ref-scope — a worktree is the same project, and "expired" was a guess

Task: `docs/plan/tasks/ccr-ref-scope.md`. Full evidence, the reproduction
transcript, the before/after end-to-end run, and the five-command verification
log live in `docs/plan/verification-notes.md` §138. This debrief is the
outcome and the lessons, not the record.

## Outcome

`expand` returned "Unknown or expired CCR ref" for refs a `PostToolUse` hook
had written minutes earlier, from inside a git linked worktree. Fixed by
treating a worktree as the **same project** as its main checkout for CCR
purposes — the identical call already made for the vector index
(`canonicalProjectId`) — resolved through one new shared function,
`src/shared/git-worktree.ts#resolveWorktreeRoot`, that both routes now call so
neither can drift from the other's answer. `UnknownRefError` gained `location`
and `reason: "not-found" | "corrupt"`, replacing one message that covered
three different causes (never stored, stored under a different root, and a
genuinely corrupt envelope) with text that names what was checked and where.
Wiki page: [[CCR Ref Scope]].

## Key lessons

**"Expired" was never checked before it was printed.** The message had said
"Unknown or expired" since the store was written, and nobody had grepped for
an eviction policy before repeating the word. It took one grep
(`prune|evict|ttl|maxEntries` across `CcrStore` and `LocalDirBlobStore`) to
find nothing — the class never prunes, so every prior reader who saw
"expired" was told a false explanation for a real failure. The general
lesson: an error message is a claim, and a claim inherited from whoever wrote
the `throw` statement first is not automatically true of the current
implementation.

**Reproduce before fixing, even when the hypothesis is obviously right.** The
task doc's two-roots hypothesis was airtight from a code read alone — but
"airtight from a read" and "confirmed" are different states, and the
difference is a real `git worktree add`, a real hook invocation, and a real
`UnknownRefError` in a failing test committed *before* the fix
(`0f37604`, `tests/integration/ccr-worktree-scope.test.ts`). This is the only
way to be sure the fix addresses the actual failure rather than a plausible
retelling of it, and it leaves a permanent regression test at the exact seam
that broke rather than only at units that already worked.

**One identity function, not one opinion per call site (R11.2's shape,
repeated).** The task doc pointed at `canonicalProjectId` explicitly and
asked that "whatever this task decides should agree with it." The
alternative — writing a second, independent worktree-resolution routine for
CCR — would have created exactly the kind of drift R11.2 fixed once already
for Windows path-spelling variants. Both `NativeLosslessCompression.forProjectDir`
/ the hook's write side, and `canonicalProjectId`, now call
`resolveWorktreeRoot` from one file. A future third caller has a place to go
instead of inventing its own answer.

**Filesystem reads over a subprocess, verified against the real on-disk
shape.** `forProjectDir` is called synchronously at four production sites
plus tests; making worktree resolution async to shell out to `git` would have
forced all of them async, well outside this task's `touches` list. Reading
git's own bookkeeping directly (`.git` file → `gitdir:` pointer →
`commondir`) kept the function pure, synchronous, and — because its parsing
was checked against a real worktree's actual on-disk files in this repo
before being finalized — grounded in the true format rather than a
remembered approximation of it.

**A split error only pays off if every call site uses the split.** Extending
`UnknownRefError` in the frozen interface was the easy half; the real work
was finding and updating every place that constructed one with the old
implicit defaults (`src/mcp/server.ts`'s `expand` catch block,
`src/mcp/in-memory-compression.ts`'s stub) so the new `location`/`reason`
actually reaches a reader instead of silently defaulting to
"an unspecified CCR store" everywhere.

## What stayed out of scope, deliberately

No eviction or retention policy was added — the store still never prunes,
and whether it should is a separate, unopened disk-usage question. The
marker format (`hash=<64-hex>`) and redaction behaviour are unchanged.

## Verification

`npx tsc --noEmit`, `npm run lint`, `npm run format:check`, `npx vitest run`
(233 files / 2998 tests passed, 1 file / 2 tests skipped), `golem wiki check`
(172 pages + 1 doc) — all exit 0. End-to-end demonstration ran against the
rebuilt `dist/` artifacts (not source-via-vitest): a worktree-issued ref
retrieved byte-identical from the main checkout via `expand`'s real code
path, and an unsatisfiable ref's message named the exact `.golem\ccr` path
searched. Full transcript: verification-notes.md §138.

See also [[Compression]], [[Knowledge Base]], [[Change Ledger]].
