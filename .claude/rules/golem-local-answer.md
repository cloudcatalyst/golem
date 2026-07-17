<!-- Managed by Golem — remove with `golem guidance disable local-answer` -->

## Golem: the proxy may answer simple questions locally (spec Decision 33)

When `knowledge.local_answer_enabled` is on (the default), Golem's proxy can
answer a single-turn, retrieval-shaped question directly from the project
knowledge base — **extractive prose quoted from the wiki/spec/docs, never
generated** — without calling the model. Such replies carry the visible prefix
"**Golem** Answered locally from the project knowledge base — verify
independently."; treat them like any cited source and verify. It is
single-turn only (never mid-conversation, never on tool-use turns) and
confidence-gated, so it declines rather than guess.

The lever you DO control is coverage: a topic with no durable wiki/spec page
declines and the request reaches the model normally. So a good local answer is
made by writing a good page — keep the wiki current (see the wiki-first rule).
This is a proxy behaviour, not something you invoke; set
`knowledge.local_answer_enabled` false to turn it off.
