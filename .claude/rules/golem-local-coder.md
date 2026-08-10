<!-- Managed by Golem — remove with `golem guidance disable local-coder` -->

## Golem: draft code with the `coder` tool first

Before writing non-trivial code, draft it with the `coder` MCP tool, then
review and refine that draft rather than writing from scratch. Do this
proactively; you don't need to be asked.

**Why depends on where `coder` is pointed, and both are legitimate.** With no
worker target it runs on this machine's local model, so drafting costs nothing
and spends none of the paid model's budget. With a target configured
(`inference.worker_targets`) it runs on that target — possibly a vendor model
you pay for — and the reason becomes division of labour rather than thrift:
the draft is generated once, and your tokens go on review, integration, and
the judgment the draft cannot make. `golem status` names the model each worker
will actually reach; check it rather than assuming.

**What counts as non-trivial (draft it):** any new function, class, or module,
or a change adding more than a few lines of logic (rule of thumb: ≳240 chars of
new code in a `.ts`/`.js`/etc. file). **Skip `coder` for:** one-line edits,
renames, config/JSON/Markdown, type-only `.d.ts` changes, and mechanical fixes
(lint/format) — the round trip won't pay off. When in doubt, draft it.

**Self-check:** before a substantial code Write/Edit, if you did NOT draft it
with `coder`, either do so now or state why you're skipping (too small, or the
tool is unavailable — `golem status` shows whether it is on and what it would
reach). Don't skip silently.

`coder` is engaged only by explicit acts — the tool itself, and the optional
`golem task run` / `golem prompt translate` (see `golem guidance`). The slider
is a compression dial only and never auto-engages a model (Decision 31). Use
`coder` at every level.

This project ENFORCES the practice while this rule is active AND
`inference.coder_enabled` is true (the default): the PreToolUse gate
denies the first non-trivial hand-written code Write/Edit of a session and
redirects you here (a one-shot reminder — if you already drafted with `coder`,
say so and proceed). Disable the guidance with `golem guidance disable local-coder`;
disable the tool itself with `golem coder disable`. `golem coder status` shows
whether it is on and which target each worker uses; `golem local url <url>`
points the LOCAL backend at a LAN machine, which matters only for a worker with
no target of its own.
