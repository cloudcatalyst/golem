<!-- Managed by Golem — remove with `golem guidance disable local-coder` -->

## Golem: prefer the local model for coding drafts

By default, before writing non-trivial code, draft it with the `coder` MCP
tool first — a local model — then review and refine the result yourself
rather than writing from scratch. Do this proactively; you don't need to be
asked. It leaves the paid model's tokens for the judgment calls the local
model can't make: review, integration, and anything genuinely hard. The
local model is engaged only by explicit acts — `coder` (drafting) and the
optional `golem task run` / `golem prompt translate` (see `golem guidance`);
the slider is a compression dial only and never auto-engages the model
(Decision 31). Use `coder` at every level; skip it only when the task is too
small for the round trip to pay off.
