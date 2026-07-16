---
title: Guidance Rules
type: concept
tags: [guidance, init, claude-code, rules, toggle]
sources: [src/hooks/guidance.ts, src/cli/main.ts, https://code.claude.com/docs/en/memory]
created: 2026-07-16
updated: 2026-07-16
---

# Guidance Rules

How Golem tells Claude how to work in a project: as **Claude Code project
rules**, not as content inside `CLAUDE.md`. (User decision, 2026-07-16; this
supersedes the earlier CLAUDE.md marker-section and CLAUDE.local.md approaches —
see debriefs/2026-07-16-R5.5.md.)

## The model

Each working practice is a named **guidance feature**. Enabling one writes a
rule file that Claude Code auto-loads every session
(verified: https://code.claude.com/docs/en/memory — `.claude/rules/*.md` load at
launch); disabling removes it. **Golem never edits the user's `CLAUDE.md`.**

| Scope | File | Committed? |
|---|---|---|
| project (team-wide) | `.claude/rules/golem-<name>.md` | yes |
| user (personal, this project) | `.claude/rules/golem-<name>.local.md` | no (gitignored) |

**Presence of the rule file is the toggle.** There is no config flag.

### Features (`GUIDANCE_FEATURES` in `src/hooks/guidance.ts`)

Seeded by `golem init` (on by default):
- **ccr-refs** — the oversized-output → CCR-ref swap + how to `expand`.
- **wiki-kb-first** — the wiki → local KB → web ladder ([[Wiki-First Knowledge]]),
  framed as a proactive default.
- **local-coder** — draft non-trivial code with the local `coder` model first.

Opt-in (not seeded; enable when wanted):
- **prompt-translation** — sharpen rough prompts via the local model
  (`golem prompt translate`, show-first, never silent).
- **durable-tasks** — queue interruptible work as durable tasks + explicit
  escalation (`golem task add/run/escalate`).

## Seed-once (so opt-outs stick)

`golem init` seeds the default features **once**, guarded by a
`.golem/state/guidance.json` sentinel. After that, the rules are user-owned: a
later `golem init` does not re-create a feature you disabled. `golem uninit`
removes all `golem-*` rules (both scopes) and the sentinel.

## Managing guidance

```
golem guidance list                      # features + on/off (project|user)
golem guidance show <name>               # print a rule body
golem guidance enable  <name> [--user]   # write the rule file (default: project)
golem guidance disable <name> [--user]   # remove it (default: both scopes)
```

Wiring lives in `src/cli/main.ts` (the `guidance` command group) and
`src/hooks/guidance.ts` (`seedDefaultGuidance`, `writeGuidanceRule`,
`removeGuidanceRule`, `removeAllGuidanceRules`). Rule bodies carry a stripped
`<!-- Managed by Golem … -->` banner so they're recognizable in-editor without
costing context tokens.

See also [[Dogfooding Golem]].
