---
title: A Sentinel That Answers the Wrong Question — Every New Guidance Rule Missed Every Existing Project
type: debrief
tags: [guidance, init, seeding, state, dogfooding, silent-failure]
sources: [docs/plan/tasks/guidance-new-default-never-seeds.md, src/hooks/guidance.ts, docs/wiki/concepts/Guidance Rules.md]
created: 2026-09-13
updated: 2026-09-13
---

# A sentinel that answers the wrong question

`golem init`, run in Golem's own repo an hour after the `vibe` guidance rule was
written and merged:

```
create   .claude/skills/vibe/SKILL.md — /vibe skill
skip     .claude/rules/golem-vibe.md — vibe is disabled — not re-seeded
```

Nobody had disabled it. It had never existed here before.

Pages touched: [[Guidance Rules]] · [[Personal Vibe Guide]].

## The bug

`seedDefaultGuidance` seeded the defaults once, guarded by
`.golem/state/guidance.json`:

```json
{ "seeded": true }
```

After that, a default whose rule file was absent was read as "the user ran
`golem guidance disable`". That is right for a rule someone removed. It is wrong
for a rule that did not exist when the project was first initialised — and **the
two are indistinguishable on disk**, because both are "sentinel set, file
absent".

So the real behaviour was: a guidance rule reaches projects initialised *after*
it shipped, and silently never reaches any project initialised before. Every
default added since this repo's own first init — plausibly
`parallel-agent-isolation`, `subagent-headroom`, `long-run-visibility` — had
been missing in the field the whole time.

## Why it survived so long

Nothing about it looks broken from the author's side. You add a rule, you test
it in a fresh project, it appears. The projects where it does not appear are the
old ones, and their init output says `is disabled — not re-seeded`, which reads
like a decision somebody made rather than a bug.

It took dogfooding on a mature checkout, one hour after writing the rule, for the
sentence to be obviously false.

## The general shape

**A sentinel that answers "did this happen?" cannot answer "did this happen to
X?"** — and the second question arrives the moment the set of X can grow. The
fix is always the same: record the members, not the event.

```json
{ "seeded": true, "features": ["ccr-refs", "coder-first", "vibe", "..."] }
```

Absent file + name in the record → disabled; leave it.
Absent file + name NOT in the record → never offered; seed it.

## The migration, and its stated cost

An old record has no `features`, and the names are not recoverable from it. So
they are inferred from the rules currently on disk and the rest are seeded once.

That **re-offers a rule somebody genuinely disabled, exactly once**. It is worth
being plain about the trade rather than pretending it is free: it is the wrong
answer for that one user and the right answer for everybody who has simply never
been given the newer rules. The second group is far larger, a missing rule is
silent while a re-offered one is visible, and one `golem guidance disable` ends
it permanently — because after the upgrade the name IS in the record.

The upgrade announces itself in the init output rather than happening quietly.

It was exercised immediately on this repo: `coder-first` is deliberately off
here, the migration re-offered it, and it was disabled again in the same
sitting. The record now names all nine defaults, so that choice is permanent.

## Break-proof

The pair of behaviours is the whole point, so a fix that delivered new rules by
simply re-seeding everything would have passed half the test file and undone
every user's opt-out. Restoring the old logic in `offeredFeatures` fails 3 of
the 7 tests; the fix passes all 7.
