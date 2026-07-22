<!-- Managed by Golem — remove with `golem guidance disable local-coder` -->

## Golem: prefer the local model for coding drafts

By default, before writing non-trivial code, draft it with the `coder` MCP
tool first — a local model — then review and refine the result yourself
rather than writing from scratch. Do this proactively; you don't need to be
asked. It leaves the paid model's tokens for the judgment calls the local
model can't make: review, integration, and anything genuinely hard.

**What counts as non-trivial (draft it):** any new function, class, or module,
or a change adding more than a few lines of logic (rule of thumb: ≳240 chars of
new code in a `.ts`/`.js`/etc. file). **Skip `coder` for:** one-line edits,
renames, config/JSON/Markdown, type-only `.d.ts` changes, and mechanical fixes
(lint/format) — the round trip won't pay off. When in doubt, draft it.

**Self-check:** before a substantial code Write/Edit, if you did NOT draft it
with `coder`, either do so now or state why you're skipping (too small, or the
local model is unavailable — see `golem devices`). Don't skip silently.

The local model is engaged only by explicit acts — `coder` (drafting) and the
optional `golem task run` / `golem prompt translate` (see `golem guidance`);
the slider is a compression dial only and never auto-engages the model
(Decision 31). Use `coder` at every level.

This project ENFORCES the practice while this rule is active: the PreToolUse
gate denies the first non-trivial hand-written code Write/Edit of a session and
redirects you here (a one-shot reminder — if you already drafted with `coder`,
say so and proceed). Disable with `golem guidance disable local-coder`.
