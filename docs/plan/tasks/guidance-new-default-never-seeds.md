---
task: guidance-new-default-never-seeds
title: "A guidance rule added after a project's first `golem init` is never seeded there — the sentinel cannot tell 'disabled' from 'did not exist yet'"
state: done
owner: agent
size: S
discipline: code
design: "`src/hooks/guidance.ts` — `seedDefaultGuidance` and the `.golem/state/guidance.json` sentinel. The mechanism and its intent are documented in the comment above the `seeded && !exists` branch; this is a gap in that reasoning, not a disagreement with it."
gate: "A project initialised BEFORE a new `seededByDefault` feature exists receives that feature's rule on the next `golem init`, while a feature the user actually ran `golem guidance disable` on stays absent across any number of re-inits. Both as named tests, because one mechanism has to serve both and today it collapses them into one another."
depends_on: []
touches: [src/hooks/guidance.ts, tests/unit/hooks/]
created: 2026-09-13
updated: 2026-09-13T03:32:06.498Z
---

## What happens

`seedDefaultGuidance` seeds the default rules ONCE, guarded by
`.golem/state/guidance.json`. After that sentinel is set, a default whose rule
file is absent is treated as deliberately disabled:

```
if (seeded && !(await guidanceRuleExists(projectDir, f.name, "project"))) {
  // "<name> is disabled — not re-seeded"
```

That is right for a rule the user removed with `golem guidance disable`. It is
wrong for a rule that **did not exist when the project was first initialised** —
and the two are indistinguishable from disk, because both are "sentinel set,
file absent".

The consequence: every guidance rule Golem ships from now on reaches new
projects and silently never reaches existing ones. The author sees it work
(their fresh test project gets it) and every established project quietly does
not.

## How it was found

Shipping the `vibe` rule, 2026-09-13. `golem init` in Golem's own repo:

```
create   .claude/skills/vibe/SKILL.md — /vibe skill
skip     .claude/rules/golem-vibe.md — vibe is disabled — not re-seeded
```

Nobody had ever disabled it; it had existed for about an hour.
`golem guidance enable vibe` is the workaround, but it requires knowing the rule
exists, which is exactly what the rule was supposed to tell you.

This is not specific to `vibe` — check whether `parallel-agent-isolation`,
`subagent-headroom` and `long-run-visibility` reached the projects that predate
them, or whether they have been missing in the field since they shipped.

## The fix, probably

Record WHICH features were seeded, not merely THAT seeding happened —
`{ seeded: true, features: ["ccr-refs", ...] }`. Then:

- name absent from the record, file absent → **never offered here; seed it**
- name present in the record, file absent → **the user removed it; leave it**

An existing sentinel with no `features` array is the migration case. Treat every
feature that existed at that time as recorded... except the list of "features
that existed then" is not knowable from the file. Simplest honest migration: on
first upgrade, treat an old-format sentinel as recording the features whose rule
files are currently PRESENT, and seed the rest once. That re-offers a rule
somebody had genuinely disabled, once, which is a far smaller harm than never
delivering new guidance at all — but say so in the init output rather than doing
it quietly.

## Out of scope

The `--user` scope, the `guidance enable/disable` verbs, and the rule bodies.
Only the seed-once decision changes.

## Verification bar

The standing one: `npx tsc --noEmit`, `npm run lint`, `npm run format:check`,
`npx vitest run`.

## Outcome

shipped — PR #197, merged ac40827
