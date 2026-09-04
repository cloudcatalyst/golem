/**
 * Keeping the context and the codebase honest: cache health, context hygiene, the
 * fresh-eyes code-versus-docs review, and the first-pancake release review.
 *
 * All four are read-and-report skills — they judge and propose, they do not write.
 */

const cacheHealth = `---
description: Report prompt-cache health — hit rate and likely cache-busting — so you can see savings you're silently losing
invocationMode: user
---

The user wants to know how well Anthropic prompt-caching is working. Caching is
where the real savings are on Anthropic traffic (compression is ~0% there,
Decision 23), and one changed byte in the cached prefix — an injected timestamp,
a reordered tool-definition block — silently turns a cache read into a full
re-bill.

1. **Read the current signal.** Call the \`stats\` MCP tool and run
   \`golem status\` via Bash, and surface whatever cache fields are present:
   cached-read vs cache-creation vs uncached input tokens, and a hit rate if
   available.
2. **Flag cache-busting.** If the hit rate is low or dropping, call it out and
   name the usual culprits to check: a timestamp/nonce in the system prompt or a
   tool arg, a reordered or newly-added tool/MCP-definition block (these sit in
   the cached prefix), or a mid-history rewrite.
3. **Be honest about coverage.** Full per-request cache-bust detection is a proxy
   feature still on the backlog (2026-07-24, "cache-hit observability") — if the
   telemetry doesn't yet expose a field, say so plainly. Never present a guess as
   a measured number.
`;

const contextHygiene = `---
description: Keep the working context clean — prefer narrow re-runs and CCR references over re-reading, and expand only what's actually needed
invocationMode: user
---

The user wants to reduce context bloat from accumulated tool output (logs, large
file reads, dead-end retries) — the "keep context clean" technique, which both
cuts tokens and tends to improve results.

Golem already does most of this automatically: a PostToolUse hook swaps oversized
Bash/Read/Grep/Glob/WebFetch outputs for a compact digest carrying a
\`hash=<id>\` marker, storing the original losslessly under \`.golem/ccr\` (the
CCR-refs rule). Your job is to use that discipline deliberately:

1. **Prefer narrow over expand.** When you only need part of a swapped output,
   re-run a tighter command (grep the file, limit the line range) instead of
   expanding the whole thing back into context.
2. **Expand only on demand.** When you genuinely need the full original, call the
   \`expand\` MCP tool with the \`ref_id\` from the marker (or \`/golem-expand <id>\`)
   — and only then. Each expand re-spends the tokens the swap saved.
3. **Don't re-read.** If a file/page is already in context or in the KB, use
   \`search\`/\`fetch\` for the relevant chunk rather than re-reading the whole
   thing.

This is a working habit, not a one-off command — Golem retains the originals, so
nothing is lost when you keep the live context lean.
`;

const freshEyes = `---
description: Fresh-eyes review — read the code as CODE ONLY (ignore comments/docs), judge the approach against best practices, then compare your independent reading with the comments/documentation to catch drift and disagreement
invocationMode: user
---

The user wants an unbiased review of a function, module, or wider codebase:
$ARGUMENTS (default: the current working diff — if the scope is unclear, ask
what to review before starting).

The point is to defeat anchoring: comments and docs tell you what the author
*intended*, which quietly biases you into agreeing. So form your own view from
the code alone first, then compare.

## Pass 1 — code only (do NOT read comments, docstrings, or docs yet)
Read only the executable code of the target — identifiers, types, control flow,
data flow, and the tests. Deliberately skip comments, docstrings, and the
README/wiki/spec. (On a large target you can have the local model produce a
code-only behavioural summary first via the \`coder\` MCP tool or \`golem task
run\` — cheap, and it keeps you honest — but do the judging yourself.)
From the code alone, write down:
1. **What it does** — the behaviour you infer, in your own words.
2. **The approach** — the design/pattern you see, rated against best practices:
   correctness, edge cases, error handling, complexity, naming, clarity,
   testability. Note anything you would do differently.
3. **Open questions** — what the code alone can't tell you (why a constant, why
   this ordering, an apparent foot-gun).

## Pass 2 — reveal comments + documentation, then compare
Now read the comments, docstrings, and related docs (use \`/golem-research\` for
the module: its wiki page, a spec Decision, a CLAUDE.md rule, a frozen-interface
contract). Diff your Pass-1 reading against what they claim, and sort every gap
into one of three buckets:

- **Code should change** — your fresh reading found a real problem (bug, missing
  edge case, a guarantee weaker than stated, needless complexity) the docs don't
  excuse. Cite file:line and the concrete failure scenario.
- **Comment/doc should change** — the code is fine but the prose is wrong, stale,
  or misleading: it claims a behaviour/guarantee the code doesn't provide, names
  renamed/removed things, or over/under-states. Flag this drift even when the
  code is correct — a wrong comment is a latent bug.
- **Agree / confirmed** — your independent reading matches the intent and the
  approach is sound. Say so briefly; a confirmation from fresh eyes is a result.

## Report
Group findings by those three buckets, most-important first, each with file:line,
what you independently concluded, what the docs claim, and the concrete change
you'd make. Be explicit about coverage: on a large target, say what you actually
read versus sampled — never imply whole-codebase coverage you didn't do (this
repo forbids silent caps). Respect the hard rules while judging: frozen
interfaces (\`src/interfaces/\`), redaction-first, byte-fidelity — a
"simplification" that breaks one of those is not an improvement.

This skill writes nothing. To act on findings: code fixes via \`/golem-develop\`,
doc/comment fixes inline, and durable drift worth tracking via \`/golem-plan\`
into the backlog. It complements \`/code-review\` (bug hunting) and \`/simplify\`
(cleanup) — fresh-eyes is specifically about whether the code and its
documentation agree.
`;

const firstPancake = `---
description: "First pancake" release review — assume release 1 was the throwaway pancake; keep the recipe (ingredients + method) that is proven, discard what was scaffolding, and shape the codebase for the first REAL release
invocationMode: user
---

The user wants to prepare a project for its first real release, using the
"first pancake" lens: the first pancake of any batch is never great, no matter
the ingredients, the recipe, or the pan temperature — but every pancake after it
is perfect. So the first release of a project is expected to be the throwaway
pancake. The ingredients are good and the method is valid; what's wrong is
execution, not fundamentals. Nobody needs to see or "eat" the first release, so
don't polish it — clean the pan and build pancake #2 (the first real
release) right.

Scope: $ARGUMENTS (default: the whole working tree / repo). If it's unclear
what "the project" is, confirm the target before starting.

This skill writes nothing by itself. Its job is a decision-edged review: sort
everything it examines into "keep" vs "scrap", and propose concrete actions. To
act on the fixes, use \`/golem-develop\`; to record durable follow-ups use
\`/golem-plan\`.

## Pass 1 — settle what the recipe actually is (the keep list)
Decide what belongs to a good pancake and will carry forward UNCHANGED. These are
the "ingredients" and "method": framework/stack and the core dependencies, the
architecture and its invariants, the data model / source of truth, the project's
identified strengths and any git history or docs that are genuinely good. For
each, say why it's proven rather than assumed, and name the guardrails that must
survive the cleanup (frozen interfaces, redaction-first, byte-fidelity, the hard
rules in CLAUDE.md). This list is the contract for everything below — nothing in
it gets "cleaned".

## Pass 2 — eat the first pancake critically (the discard list)
Assume release 1 is the burnt first pancake and look for the throwaway residue —
the code that was written to validate the approach, not to ship it. Examples to
hunt for, explicitly:
- Dead code, stale modules, and features that shipped "to see if it works" and
  were never used.
- Scaffolding, boilerplate, and proof-of-concept hacks (a hardcoded path, a
  TODO like "fix this later", a provisional API) that were enablers, not product.
- Half-integrated or abandoned seams (a half-wired integration, an API surface
  nobody calls, a config knob with no consumer).
- Code that over-folds on the first-pancake assumption itself: built to be torn
  out later, or brittle because it was thrown together to get a result.
Label each hit: KEEP, SCRAP, or REFACTOR, with file:line and the concrete reason
under the pancake lens. Be specific and honest about coverage — say what you
actually read versus sampled; never imply whole-repo coverage you didn't do.

## Pass 3 — clean the pan, then reset for pancake #2
Turn the SCRAP list into a concrete "prepare for first real release" plan, again
distinguishing what changes now versus what is held for later:
- What to delete (dead code, scaffolding, the throwaway prototype's residue).
- What to consolidate (two paths that do the same thing, an API that grew.
  organically and should be narrowed before it's a public contract).
- What to harden for the real release (error handling, edge cases, tests for the
  core invariants, docs that describe what actually exists) — because pancake #2
  is the one people will see.
- What NOT to touch in this pass (the requirement is "clean the pan", not
  "re-season it beyond recognition") — over-refactoring the good parts is how the
  second pancake burns. Each over-reach is itself a finding.

## Report
Present findings grouped by the three labels above (KEEP / SCRAP / REFACTOR),
most important first, each with file:line, your independent reason, and the
concrete action you'd take. End with a short "pan reset" summary: the delete /
consolidate / harden moves for pancake #2, and explicit holds for what stays. If
nothing of the first release should change, say so plainly rather than inventing
churn — a first release that is already buildable is a result.

This complements \`/code-review\` (bug hunting), \`/simplify\` (cleanup), and
\`/golem-fresh-eyes\` (code-vs-docs drift). First pancake is the strategic pass:
what to keep, what to scrap, and what to harden before the first RELEASE, rather
than a line-level audit. Respect the hard rules while judging — a "cleanup" that
breaks a frozen interface or weakens redaction is not an improvement.
`;

/** Skill name -> SKILL.md content, keyed as `/golem-<name>`. */
export const HYGIENE_SKILLS: Readonly<Record<string, string>> = {
  "cache-health": cacheHealth,
  "context-hygiene": contextHygiene,
  "fresh-eyes": freshEyes,
  "first-pancake": firstPancake,
};
