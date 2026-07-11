---
title: Redaction Stage
type: concept
tags: [security, pipeline, redaction]
sources: [src/pipeline/redaction-rules.ts, src/pipeline/redaction.ts, docs/verification-notes.md, docs/verification-notes.md#§55]
created: 2026-07-10
updated: 2026-07-11
---

# Redaction Stage

Golem strips secrets/PII from traffic before anything is transformed, stored, or
forwarded (CLAUDE.md hard rule: never weaken or reorder this stage after
compression). Two passes, always in this order:

1. **Rule table** (`REDACTION_RULES` in `src/pipeline/redaction-rules.ts`) — one
   auditable list, applied in table order: PEM private-key blocks first (so
   narrower rules can't shred their base64 body), then provider key shapes
   (most-specific-first, e.g. `sk-ant-` before generic `sk-`), then structured
   formats (JWT, connection-string passwords), then PII (Luhn-gated credit-card
   numbers, emails). Order is part of the audit surface — see the file's
   top-of-file doc comment.
2. **High-entropy backstop** (`isHighEntropyToken`) — catches uncontexted
   secrets the table missed. Candidates are unbroken base64/base64url-charset
   runs bounded to 32-128 chars (`ENTROPY_CANDIDATE_RE` /
   `ENTROPY_MAX_CANDIDATE_CHARS`), scored by Shannon entropy against a 4.2
   bits/char threshold.

Both passes are pure functions of the input (no clock, no randomness, no
config) — required for prompt-cache prefix stability — and idempotent:
placeholders (`[REDACTED:<kind>:<n>]`) use a charset no rule's pattern matches,
so re-redacting redacted text is a no-op.

## Known false-positive classes (entropy backstop)

The backstop is heuristic and has needed successive narrowing, each logged in
`docs/verification-notes.md`:

- **§31 — integrity hashes.** `sha512-<base64>` SRI/npm-lockfile `integrity`
  values are content hashes, not secrets, and saturate `package-lock.json`.
  Excluded via `INTEGRITY_HASH_RE` prefix check.
- **§37 — unbounded candidate length.** The original candidate regex had no
  ceiling, so large base64 blobs (images, minified assets) were wholesale
  redacted — lossy over-redaction that also inflated the savings metric.
  Fixed with the 128-char ceiling; a run longer than that isn't matched at
  all (the lookahead fails), so a blob is left completely intact rather than
  sliced.
- **§49 — path-like tokens.** The candidate charset includes `/`, `-`, `_`
  (needed because real base64/base64url secrets legitimately contain them),
  which let a whole repo path or a versioned/slugged filename with mixed
  case and digits (ADR names, dated filenames) form one candidate and clear
  the entropy threshold. Fixed by `isPathLikeToken`: split the candidate on
  `/-_` and require every resulting chunk to be purely alphabetic or purely
  numeric — the signature of a real path/slug. Real random secret material
  drawn from a 64-symbol alphabet is very unlikely to land every chunk
  entirely in one character class, so this doesn't reopen the door for
  actual secrets (proven by a regression case: a dash-delimited token whose
  chunks mix letters and digits still redacts).

Each fix is intentionally narrow rather than a blanket exclusion of the
triggering character, per the hard rule against weakening redaction — every
negative case added to guard a false positive is paired with a positive case
proving real secrets of that shape still redact
(`tests/unit/pipeline/redaction-audit.test.ts`).

## Open, not yet fixed

The credit-card rule's Luhn gate (`luhnValid`) allows unbounded
space/dash-separated digit runs before checking length — a long run of small
numbers separated by single spaces or dashes can coincidentally contain a
13-19-digit window that passes the Luhn checksum, producing a false
`[REDACTED:credit-card:n]` on non-card data. Discovered incidentally while
debugging visual tool-output redaction, not yet logged with a
verification-notes entry or scheduled.

See also [[Wiki-First Knowledge]].

---

## Resolved: credit-card separator-format guard (§50/§55, 2026-07-11)

The "Open, not yet fixed" credit-card item above is now fixed (R1.3). Adding
it to the **Known false-positive classes** list, in the same style as §31/§37/§49:

- **§50/§55 — credit-card Luhn-only gate.** The bare `luhnValid` check let any
  13-19 digit window through regardless of grouping, so a space-separated
  ASCII byte dump (irregular 1-3-digit groups) could pass Luhn by chance and
  get redacted as a card number. Fixed by `isCreditCardLike`
  (`luhnValid && hasConsistentSeparatorChar && hasUniformGrouping`):
  separators must be a single consistent character (all-space or all-dash,
  never mixed) AND every digit group between separators must be the same
  length. Consistent-separator-character alone would *not* have fixed the
  repro — an all-space, irregularly-grouped byte dump is already "consistent"
  under that narrower reading; uniform grouping is the check that actually
  defeats it. `luhnValid` itself is unchanged, still exported standalone.
  Regression cases (contiguous and 4-4-4-4-grouped Luhn-valid test cards)
  confirm real card shapes still redact
  (`tests/unit/pipeline/redaction-audit.test.ts`).

See also [[Wiki-First Knowledge]] and docs/verification-notes.md §55.

