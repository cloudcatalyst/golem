/**
 * Adversarial code review — a deliberate perspective-shift technique, distinct
 * from `/code-review` (single-pass bug hunting) and `/golem-fresh-eyes`
 * (code-vs-docs drift): three hostile personas, each REQUIRED to find something,
 * so a self-review can't quietly agree with itself.
 *
 * Seeded from a community skill (ekreloff, "adversarial-reviewer") and reshaped
 * to Golem conventions: git-diff scoping via $ARGUMENTS, this repo's hard rules
 * folded into the severity table, and hand-off to `/golem-develop` / `/golem-plan`
 * instead of the source skill's own slash-command surface.
 */

const adversarialReview = `---
description: Adversarial code review — three hostile personas (Saboteur, New Hire, Security Auditor) that must each find a real issue, deduplicated into a severity-ranked BLOCK/CONCERNS/CLEAN verdict
invocationMode: user
---

The user wants a genuinely critical review of a change — a review from the same
model that wrote (or just read) the code shares its blind spots, so this skill
forces three separate adversarial perspective shifts instead of one agreeable
pass. Scope: $ARGUMENTS (default: unstaged + staged \`git diff\`; if both are
empty, \`git diff HEAD~1\`. \`--diff <ref>\` reviews that diff; \`--file <path>\`
reviews the whole file, not just its changed lines).

If nothing is found to review, say "Nothing to review" and stop.

## Step 1 — read full context, not just the diff
For every touched file, read the WHOLE file — bugs live in how new code interacts
with what was already there, not only in the changed lines. Note the change's
purpose (fix / feature / refactor / config / test) and any project convention it
should follow (CLAUDE.md, linter config, the patterns already in the surrounding
code).

## Step 2 — run all three personas
Each MUST surface at least one finding. "No issues" from a persona means it has
not looked hard enough yet — go back and look again before moving on. Do not
hedge or soften a finding ("this might possibly be a concern...") — state the
concrete failure or drop it.

**The Saboteur** — trying to break this in production. For each changed
function: unvalidated input, state that can go inconsistent, unsynchronized
concurrent access, a swallowed exception or a misleading error return, an
assumption about data format/size/availability a caller can violate, an
off-by-one/overflow/null dereference, a leaked resource (handle, connection,
subscription, listener). Ask, per function: worst input? external call
fails/times out/returns garbage? runs twice, concurrently, or never? what if
neither branch is correct? If the code is genuinely solid, name its most fragile
assumption instead of manufacturing a bug.

**The New Hire** — reading this for the first time, six months from now, with
zero context from the author. Names that don't say what they hold, logic that
needs 3+ other files to follow, magic numbers or strings, a function doing more
than its name claims, missing types that force tracing the call chain, drift
from the surrounding style, a test that pins implementation instead of
behaviour, a comment explaining *what* instead of *why*. Read each changed
function as a stranger would — can you tell what it does from name + signature +
body alone? If it's genuinely clear, name the likely point of confusion for a
newcomer instead.

**The Security Auditor** — OWASP-informed, one trust boundary at a time (user
input, API calls, the database, the filesystem, env vars): injection
(SQL/NoSQL/command/LDAP reaching a query or shell without parameterization),
broken auth (hardcoded credentials, a new endpoint with no auth check, a token in
a URL or log), data exposure (secrets in an error message/log/response, missing
encryption), insecure defaults (debug mode, permissive CORS, wildcard
permissions), missing access control (IDOR, a missing role check, a
privilege-escalation path), dependency risk (a new dependency with a known CVE),
and secrets committed as "temporary". If the change genuinely has no security
surface, name the closest thing to one instead of inventing a vulnerability.

**Break the self-review trap deliberately**: read bottom-up (last function
first), state each function's contract before reading its body and check the
body against it, assume every variable can be null/undefined until proven
otherwise, assume every external call fails, and ask "if this change were
deleted, what would break" — "nothing" is itself a finding.

## Step 3 — classify severity

| Severity | Meaning | Action |
|---|---|---|
| CRITICAL | data loss, security breach, or production outage | blocks merge |
| WARNING | a likely edge-case bug, a perf regression, or a real maintainability hit | fix, or explicitly accept the risk with a stated reason |
| NOTE | style or a minor improvement | author's discretion |

A finding two or more personas raised independently is promoted one severity level
(NOTE → WARNING → CRITICAL) — convergence across personas is signal, not noise.

## Step 4 — deduplicate and report

Merge the same issue caught by multiple personas (note which ones caught it,
since that drives promotion), then produce:

\`\`\`markdown
## Adversarial Review: <what was reviewed>
**Scope:** <files/lines/change type>
**Verdict:** BLOCK / CONCERNS / CLEAN

### Critical Findings
### Warnings
### Notes
### Summary
<2-3 sentences: overall risk, and the single most important fix>
\`\`\`

BLOCK = 1+ CRITICAL. CONCERNS = no criticals but 2+ warnings. CLEAN = notes only.
Judge this repo's hard rules while reviewing, not generic taste: a frozen
interface under \`src/interfaces/\` changing shape, redaction weakened or
reordered, or a byte-faithful proxy path losing that guarantee is CRITICAL
regardless of what the diff's author intended.

## Anti-patterns to avoid
"LGTM" with nothing found; cosmetic-only findings sitting next to an unflagged
null dereference; restating the diff instead of saying what's wrong with it;
reviewing only the changed lines; letting a missing test pass silently — new
code with no test is always at least a NOTE.

This skill writes nothing — it reports and verdicts, never edits. Findings
become code fixes via \`/golem-develop\` (or the \`coder\` MCP tool for something
small), and durable process/security findings worth tracking go through
\`/golem-plan\`. It is the hostile-perspective complement to \`/code-review\`
(single-pass bug hunting) and \`/golem-fresh-eyes\` (code-vs-docs drift) — reach
for this one, or direct the \`golem-reviewer\` persona to it, when a review keeps
coming back "looks good" and that answer isn't trusted.
`;

/** Skill name -> SKILL.md content, keyed as `/golem-<name>`. */
export const REVIEW_SKILLS: Readonly<Record<string, string>> = {
  "adversarial-review": adversarialReview,
};
