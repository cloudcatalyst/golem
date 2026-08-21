---
title: Redaction Stage
type: concept
tags: [security, pipeline, redaction, t-c3, r1-batch]
sources: [src/pipeline/redaction-rules.ts, src/pipeline/redaction.ts, docs/plan/verification-notes.md, docs/plan/verification-notes.md#§55, docs/plan/verification-notes.md#§56, docs/plan/verification-notes.md#§137]
created: 2026-07-10
updated: 2026-08-22
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

## Where it runs

Redaction is **stage 1 of the pipeline and is never reordered after compression**.
The single exception is `proxy.bypass_all`, a deliberate full bypass where nothing
runs. It is **not** a dial value: ADR-0004 gave it its own persisted setting
precisely so that no number could turn redaction off, and it is CLI-only, never
the default, and surfaced loudly wherever it is active — see
[[Compression Levels]] and [[Architecture]].

```mermaid
flowchart LR
  IN["Request body / content to store"] --> L0{"proxy.bypass_all?"}
  L0 -->|"true — full bypass (CLI-only, warned loudly)"| RAW["Forward RAW · redaction OFF"]
  L0 -->|"false (default)"| P1["Pass 1 — rule table (table order)"]
  P1 --> P2["Pass 2 — high-entropy backstop"]
  P2 --> NEXT["then compression / storage / forward"]
```

## Known false-positive classes (entropy backstop)

The backstop is heuristic and has needed successive narrowing, each logged in
`docs/plan/verification-notes.md`:

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

See also [[Wiki-First Knowledge]] and docs/plan/verification-notes.md §55.

---

## Resolved: provider-key rule gaps closed (§24/§56, 2026-07-11, R1.4)

Four provider secret shapes previously relied only on the entropy-sweep
backstop (which can miss short or low-entropy instances) and now have
dedicated `REDACTION_RULES` entries in `src/pipeline/redaction-rules.ts`:

- `google-api-key` — `AIza` prefix + 35 base64url-ish chars (39 chars total).
- `stripe-key` — `sk_live_` prefix (underscore, distinct from the existing
  `sk-` `openai-key` rule) + 24-99 alphanumeric chars.
- `gcp-oauth-token` — `ya29.` prefix + 20-120 base64url chars.
- `azure-account-key` — contextual, redacts only the `AccountKey=` value
  (base64, optional `=`/`==` padding) up to the next `;` or end of string,
  leaving `AccountName=`/`EndpointSuffix=` legible — same pattern as the
  existing `connection-password` rule.

Corpus cases for all four live in `tests/unit/pipeline/redaction.test.ts`'s
`CASES` array. This closes the specific provider list named in §24; other
providers' key shapes remain on the entropy-sweep backstop only, per §24's
original "add rules as needed" stance — not a claim of exhaustive coverage.

See [[R1.4 — provider-key redaction rule gaps closed (T-C3)]] and
docs/plan/verification-notes.md#§56.

---

## Resolved: path-with-embedded-UUID false positive (§137, 2026-08-22)

Extends the §49 fix rather than replacing it. §49 required every chunk of a
path-like candidate to be purely alphabetic or purely numeric; a UUID or hash
segment (mixed letters + digits) failed both, so an otherwise-clean path —
notably the session scratchpad path and `.claude/worktrees/agent-<id>/` —
still redacted whole.

- **§137 — hex chunks.** `isPathLikeToken` now also accepts a chunk that is
  pure hex (dehyphenated digits/`a-f`, either case), gated by
  `MIN_CHUNKS_FOR_HEX_ALLOWANCE = 3` chunks. Safe by call order, not just by
  the guard: `isHighEntropyToken` already excludes a token that is pure hex
  **in its entirety** before `isPathLikeToken` ever runs, so any token that
  reaches `isPathLikeToken` with a hex chunk must have at least one other
  chunk that is not hex-clean — a real word, or a mix with a non-`a-f`
  letter. A 2-chunk `word-hexlike` adversarial pair (one chunk short of the
  floor) still redacts, proving the guard is load-bearing and not merely
  decorative.

See [[Redaction Path Placeholders]] for the full write-up — the mechanism
(including why the `/` vs `\` separator spelling matters independently of
this fix), what to do when a path comes back as a placeholder, and the
reversible-vs-standalone placeholder asymmetry — and
docs/plan/verification-notes.md#§137 for the dated measurement (exit codes,
suite totals, end-to-end round-trip verification).
