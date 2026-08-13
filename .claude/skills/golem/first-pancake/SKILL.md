---
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
act on the fixes, use `/golem/develop`; to record durable follow-ups use
`/golem/plan`.

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

This complements `/code-review` (bug hunting), `/simplify` (cleanup), and
`/golem/fresh-eyes` (code-vs-docs drift). First pancake is the strategic pass:
what to keep, what to scrap, and what to harden before the first RELEASE, rather
than a line-level audit. Respect the hard rules while judging — a "cleanup" that
breaks a frozen interface or weakens redaction is not an improvement.
