# Shipped

What has actually landed, newest first. One row per batch, with the outcome in a
line — the detail lives in the task doc and the wiki debrief it links to.

This table is written at close-out, per the checklist in `CLAUDE.md`.

| date | tasks | what shipped | outcome |
|---|---|---|---|
| 2026-08-14 | R10.14, R10.15 | Vision-aware image translation for OpenAI-schema upstreams, and a local answer for `/v1/messages/count_tokens` | A duoop session that had answered nothing since 2026-08-13 answers again: 468k → 31k tokens (93.4%), 130s of silence → 4.4s. `count_tokens` returns `{"input_tokens":N}` instead of a billed completion. |
