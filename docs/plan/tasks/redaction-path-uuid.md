---
task: redaction-path-uuid
title: An absolute path containing a UUID is redacted as a secret, so scratchpad and worktree paths cannot be used as command arguments
state: queued
owner: agent
size: M
design: No memo. The whole surface is the entropy heuristic in `src/pipeline/redaction-rules.ts` — `ENTROPY_CANDIDATE_RE`, `ENTROPY_THRESHOLD_BITS`, `isPathLikeToken`, and the exclusion list documented above `isEntropySecret`. Precedent for this exact class of narrowing: verification-notes §49 (repo paths and ADR filenames), and §31/§37 (over-redaction inflating "savings").
gate: A local filesystem path that happens to contain a UUID survives the pipeline intact, and every secret shape the table and the entropy net catch today is still caught. Proven by adding the path case to the existing entropy tests, not by inspection.
depends_on: []
touches: [src/pipeline/redaction-rules.ts, tests/unit/pipeline, docs/plan/verification-notes.md, docs/wiki]
created: 2026-08-22
updated: 2026-08-22
---

## The symptom, seen twice independently

An agent tried `curl -o <scratchpad>/f.md` and the command that ran was
`curl -o C:[REDACTED:high-entropy:1].md`. The same session hit it again from the
main conversation: git worktree paths came back as placeholders and could not be
passed to `git -C`, `cd`, or anything else — a placeholder pasted back is not a
path, so the command silently targets the wrong place or fails.

Two sightings, two different path families (the session scratchpad under
`AppData/Local/Temp/claude/…/<uuid>/scratchpad`, and
`.claude/worktrees/agent-<id>/`), so this is not a fluke.

## The mechanism, precisely

Read `isPathLikeToken` and the exclusion list before changing anything. The chain
that produces the bug:

1. `ENTROPY_CANDIDATE_RE`'s charset is `[A-Za-z0-9+/=_-]`, which **includes `/`**.
   So a POSIX-style absolute path is one unbroken candidate run.
2. The scratchpad path's run is ~117 characters — comfortably inside the
   32–128 window, so the length ceiling that protects big blobs does not fire.
3. `isPathLikeToken` splits on `/`, `-`, `_` and requires **every** chunk to be
   purely alphabetic or purely numeric. A UUID's chunks (`7245f241`, `a18c`,
   `b9e8`) mix letters and digits, so **one UUID segment disqualifies the whole
   path** from the path-like exclusion.
4. Mixed case plus digits gives it 3 of 3 character classes, and on its own
   alphabet the path measures above `ENTROPY_THRESHOLD_BITS` (4.2).

So it is redacted. The heuristic was tuned on repo-relative paths
(`docs/decisions/ADR-0012-file-watcher`, §49) whose chunks are clean words and
clean numbers, and a UUID is the shape that breaks that assumption.

## Why fixing it does NOT weaken redaction

This matters, because "redaction must never be weakened" is a hard rule and this
task must not be read as an exception to it.

**The exclusion already exists for the same material standing alone.** The
documented list above `isEntropySecret` excludes *"pure hex (dashes/underscores
ignored): git SHAs, sha256 content hashes, **UUIDs**, and Golem's own CCR
`hash=<sha256>` markers"* — on the stated grounds that they saturate developer
traffic and are not secrets. So a bare UUID is already deemed non-secret; the
inconsistency is that the *same* UUID inside a path currently flips the path into
a secret. Making those two agree removes a false positive and admits nothing new:
no byte that is redacted today, other than these paths, stops being redacted.

The narrowest change consistent with that reasoning is to let a chunk that is
**pure hex** count as a clean chunk in `isPathLikeToken`, alongside pure-alpha and
pure-numeric. Consider also whether the rule should require a chunk count or a
recognisable path shape before accepting hex chunks, so that a hyphenated secret
does not qualify by accident — argue the choice in the code comment the way §49's
reasoning is argued today.

**Do not** solve it by allowlisting the scratchpad or worktree directories. A
path-shaped allowlist is a list that goes stale, it only helps the two families
already noticed, and it makes the rule depend on where Golem happens to be
installed.

## The adversarial case the tests must cover

The reason to be careful: a real secret can contain hyphens, and hex is a subset
of the base64 alphabet. So the new tests must include a hyphenated,
hex-looking-but-random token that **must still be redacted**, alongside:

- the scratchpad path (POSIX and Windows separators);
- a `.claude/worktrees/agent-<id>` path;
- a bare UUID and a bare git SHA (already excluded — assert they stay excluded);
- the §49 repo-path and ADR-filename cases (assert unchanged);
- every existing entropy fixture (the suite is the regression net).

Build the random material at runtime per the standing fixture rule — a literal
secret gets redacted out from under you, and a literal placeholder passes
vacuously.

## Note for whoever fixes it

There is a related, milder harm worth recording while you are here: because
these placeholders are *reversible* in some paths and not others, a path pasted
back from tool output sometimes resolves and sometimes does not, which is
confusing in a way a hard failure would not be. Say in the wiki page what a
reader should do when a path comes back as a placeholder.

## Out of scope

Touching the rule table, the reversible-redaction map (R9.3), or the entropy
threshold itself. Widening the candidate charset. Making redaction configurable
per directory.

## Gate detail

`npx vitest run tests/unit/pipeline` green with the new cases, the two real path
families verified end-to-end through an actual tool call, and a dated
verification-notes section recording the measurement in the manner of §49 — what
was excluded, on what reasoning, and what was deliberately left redacted.
