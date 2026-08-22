---
title: Redaction Path Placeholders
type: concept
tags: [security, pipeline, redaction, t-c3, dogfooding]
sources: [src/pipeline/redaction-rules.ts, src/pipeline/redaction.ts, docs/plan/tasks/redaction-path-uuid.md, docs/plan/verification-notes.md#§140]
created: 2026-08-22
updated: 2026-08-22
---

# Redaction Path Placeholders

A companion to [[Redaction Stage]], scoped to one recurring symptom: a real
filesystem path comes back as `[REDACTED:high-entropy:N]` somewhere in a tool
result, a heredoc readback, or a pasted command. This page is what to do when
that happens, and why it happens to paths specifically.

## Why paths are the shape that trips this

`ENTROPY_CANDIDATE_RE` (`src/pipeline/redaction-rules.ts`) matches unbroken
32–128-char runs of `[A-Za-z0-9+/=_-]` — deliberately, because real
base64/base64url secrets use that exact charset including `/`, `-`, `_`. A
POSIX-style absolute path is therefore one candidate token end to end.
`isPathLikeToken` is the guard that keeps an ordinary path out of the entropy
sweep, by splitting on `/-_` and requiring every chunk to be recognizably
clean (pure-alpha, pure-numeric, and — since R12/`redaction-path-uuid`,
§140 — pure-hex, gated by a 3-chunk floor). A UUID or hash segment is exactly
the shape most likely to slip past the alpha/numeric checks; see
[[Redaction Stage]] for the full false-positive history (§31/§37/§49/§50/§140).

**The separator matters independently of all of that.** The candidate charset
includes `/` but not `\`. A Windows-spelled path (`C:\Users\...\<uuid>\...`)
breaks into short runs at every backslash and never reaches the 32-character
floor, so it survives even when the identical POSIX-spelled path would not
have (before §140) or would (after). This is why the symptom can look
separator-dependent, and why the task that fixed the false positive
(`redaction-path-uuid`) also required a test asserting **both spellings of the
same path agree** — a fix that only cleared the POSIX form would leave the
confusing half of the bug in place.

## What to do when a path comes back as a placeholder

1. **Do not trust the view you were just shown.** The write path is
   byte-faithful; only the read-back VIEW into a model's context can be
   corrupted. Concluding "the write failed" from a placeholder in a heredoc
   readback or a `cat` result is the single most common wrong turn here — see
   `docs/plan/tasks/redaction-path-uuid.md`'s "Third sighting" for a
   reproduction where a heredoc wrote three lines perfectly and the `cat`
   view corrupted two of them.
2. **Measure the file, don't re-read it for content.** Before assuming
   anything is broken:
   - `wc -l` / `wc -c` — did the expected number of lines/bytes land?
   - `grep -c REDACTED <file>` — is `REDACTED` actually on disk, or only in
     what a tool echoed back?
   - `md5sum <file>` (or any checksum) — a stable fingerprint you can compare
     across two separate reads without re-displaying the content itself.
   These three commands were how §140's end-to-end verification told "ground
   truth on disk" apart from "what the view showed" without ever re-pasting
   the path itself.
3. **Never re-paste a path out of tool output into the next command.** This
   is copy-forward poisoning: a path that appeared once in a corrupted view is
   now sitting in conversation history in its placeholder (or partially
   corrupted) form, so retyping it — even by hand, even generated
   programmatically from something that referenced it — reproduces the
   corruption in the NEXT command, one step removed from the original cause.
   Generate a fresh reference instead: a new `mktemp -d`, a fresh
   `crypto.randomUUID()`, or recompute the path from something that has not
   itself passed through a redacted view.
4. **On Windows, spelling the path with `\` is a workaround available today**
   (not a fix — the underlying false positive on POSIX-spelled paths with
   UUID/hash segments is what §140 addresses). If a command's own construction
   allows either spelling, prefer `\`.
5. **This can happen to programmatically generated strings too, not just
   paths.** A 32+ char mixed-case run generated via `charCodeAt`/`crypto`
   with no literal anywhere in the source still measures as high-entropy and
   still redacts — reproduced live while drafting §140's tests. If a
   diagnostic string comes back redacted, that is not necessarily evidence of
   an authoring typo; measure it the same way as a path (steps 2 above) before
   assuming you mistyped something.

## The reversibility asymmetry

Golem has **two** redaction entry points, not one, and this is the source of
a second, milder confusion the `redaction-path-uuid` task brief flagged
explicitly ("Note for whoever fixes it"):

- **`redactStandaloneText`** — the one-way pass used for ordinary pipeline
  traffic, storage, and (functionally) for what a Bash/Read/Grep tool result
  looks like once Claude Code's own request round-trips it back through
  Golem's proxy. A placeholder produced here has no restoration map. It is
  gone from that view, permanently, from the reader's side.
- **`redactReversibleText`** — used for a one-shot dispatch to a non-local
  `coder` target (R9.3; see `docs/wiki/debriefs/2026-08-09-r9.3-coder-any-target.md`).
  Secrets are redacted going out, the target does its work on placeholder
  text, and the SAME per-value restoration map (kept in memory for that one
  dispatch only, never serialized or logged) puts the real values back into
  the result before it returns.

Both produce placeholders that look identical:
`[REDACTED:<kind>:<n>]`. There is no visual cue distinguishing "this will be
restored because it went through a reversible round trip" from "this is
exactly what you get, permanently, because it went through the standalone
pass." **A path pasted back from one call can resolve and from another
call cannot, and the placeholder text gives no indication which is which.**
That is more confusing than a hard failure would be, precisely because it
sometimes works — a reader who has seen it resolve once reasonably expects it
to resolve again.

There is no fix implied here (the two entry points exist for good reasons —
reversibility is only safe for a scoped, in-memory, one-shot round trip, not
for anything that gets logged or stored) — only the practical rule: **treat
every placeholder as non-restorable unless you know, from the calling code,
that it passed through `redactReversibleText`.** For ordinary tool output —
the case this page is about — assume it is not.

## See also

- [[Redaction Stage]] — the full rule table + entropy-backstop reference,
  including the false-positive history this page's fix (§140) extends.
- `docs/plan/verification-notes.md#§140` — the dated write-up: what changed
  in `isPathLikeToken`, the call-order safety argument, and the end-to-end
  verification (ground truth on disk vs. the tool-output view, both path
  families, both separator spellings, and a negative control proving
  redaction is not weakened for non-path secrets).
- `docs/wiki/debriefs/2026-08-09-r9.3-coder-any-target.md` — where
  `redactReversibleText` was introduced.
