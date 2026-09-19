<!-- Managed by Golem — remove with `golem guidance disable local-answer` -->

## Golem: the proxy may answer simple questions locally (Decision 33)

With `knowledge.local_answer_enabled` on (default), the proxy can answer a
retrieval-shaped question from the project KB without calling the model —
**extractive prose quoted from the wiki/spec/docs, never generated**. Replies
carry the visible prefix "**Golem** Answered locally from the project knowledge
base — verify independently."; treat them like any cited source. Single-turn
only (never mid-conversation, never on tool-use turns) and confidence-gated, so
it declines rather than guess.

Coverage is the lever you control: a topic with no durable wiki/spec page
declines and reaches the model normally — so a good local answer is made by
writing a good page: keep the wiki current (see the wiki-first rule). A proxy
behaviour, not something you invoke; set `knowledge.local_answer_enabled` false
to turn it off.

This rule is generated from Golem's own guidance registry (`src/hooks/guidance.ts`) and distributed by `golem init` / `golem guidance enable` — every Golem-managed project can receive this identical text. This repository, golem.run's own source, runs under the same unedited rule; Golem does not keep a separate house style for itself.
