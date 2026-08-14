# Shipped

What has actually landed, newest first. One row per batch, with the outcome in a
line — the detail lives in the task doc and the wiki debrief it links to.

This table is written at close-out, per the checklist in `CLAUDE.md`.

| date | tasks | what shipped | outcome |
|---|---|---|---|
| 2026-08-14 | R10.21, R10.22 | Claude Code's wiring moves to `.claude/settings.local.json`, `golem config set` defaults to the local scope, and the seeded guidance loses a third of its bulk | `golem init` no longer commits machine-local wiring (per-project port, hooks needing `golem` on PATH) into a file every clone receives — `claude.settings_scope` picks the file, default `local`, and init MOVES the wiring rather than duplicating it. Surfaced and fixed a second override path the two-file split creates: a user's `statusLine`/`defaultMode` in the committed file was left intact but inert. The seeded guidance rules, which load into every session, went 8,322B → 5,684B with four load-bearing facts restored. |
| 2026-08-14 | R10.12, R10.13 | The bypass shim is back, and daemon staleness sees code changes, not just versions | `golem proxy stop` no longer exists-and-kills: the port stays served by a redaction-only shim, so a stopped proxy answers 401 from upstream instead of connection-refused. `golem status` now reports a daemon that predates the last `npm run build`, which version-only comparison could never see. |
| 2026-08-14 | R10.16, R10.19, R10.20 | Stream keepalive, headroom_config reported where it is read, and synthesized thinking blocks labelled | A translated stream now pings during a long prefill instead of sending nothing for ~2 minutes (3 pings observed live). `golem status` names a `headroom_config` key that cannot reach Headroom even when the stage never runs. A thinking block Golem builds from `reasoning_content` now says so, after an unlabelled one was mistaken for cross-project contamination. |
| 2026-08-14 | R10.17, R10.18 | The CCR offload swap reaches `Read`, and an empty upstream completion surfaces as an error | `Read` output is offloadable for the first time (its text is nested at `file.content`; 62 unswapped in one project). An upstream that produces nothing now says so on both paths instead of returning a well-formed empty answer. |
| 2026-08-14 | R10.14, R10.15 | Vision-aware image translation for OpenAI-schema upstreams, and a local answer for `/v1/messages/count_tokens` | A duoop session that had answered nothing since 2026-08-13 answers again: 468k → 31k tokens (93.4%), 130s of silence → 4.4s. `count_tokens` returns `{"input_tokens":N}` instead of a billed completion. |
