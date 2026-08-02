<!-- Managed by Golem — remove with `golem guidance disable local-answer` -->

## Golem: proxy may answer simple questions locally (Decision 33)

When `knowledge.local_answer_enabled` is on (default), Golem's proxy can answer
retrieval-shaped questions from the project KB — extractive quotes from wiki/spec,
never generated — prefixed with "**Golem** Answered locally...". Single-turn only,
confidence-gated. Coverage is what you control: a topic with no wiki page declines.
Set `knowledge.local_answer_enabled` false to turn off.
