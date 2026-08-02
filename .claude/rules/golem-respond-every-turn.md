## Always produce a visible response at the end of every turn

Even when you've launched background agents and the results arrive via
task-notification, do not leave the user waiting — either acknowledge the
launch immediately, or synthesise the results as soon as they land. A turn
with tool calls but zero user-facing text is a bug.

This matters more on lower-grade models (Sonnet, Haiku) — Opus is better at
remembering to end turns with output. The rule is the same regardless: the
user should never have to poke the conversation to get a response.