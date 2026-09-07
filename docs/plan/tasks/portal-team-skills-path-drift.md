---
task: portal-team-skills-path-drift
title: "The portal documents a nested team-skills path that Claude Code cannot discover — the harness ships flat, the docs say nested"
state: queued
owner: user
size: S
discipline: docs
design: "Found while building `project-team-binding` and recorded in `docs/plan/verification-notes.md` §159. The harness side is already correct — `src/cli/init-skills.ts` writes flat `.claude/skills/golem-team-<name>/`. The stale prose is the portal repo's team-config doc, this repo's §149 item 6 (now corrected) and `docs/wiki/concepts/Team Layer.md` (now corrected). Portal repo lives at D:/Personal/Projects/Golem, not beside this one."
gate: "The portal's own team-config documentation names the FLAT path `.claude/skills/golem-team-<name>/`, matching what the harness writes and what Claude Code can actually discover. Closing this needs no code in this repo — the harness is already right."
blocked: "Outward, cross-repo: the fix belongs in a repository this task's repo does not contain, and only the user works there. Recorded here so the drift is not rediscovered a third time."
depends_on: []
touches: [docs/plan/verification-notes.md]
created: 2026-09-07
updated: 2026-09-07
---

## The drift

Three documents described team skills as living at a **nested** path. The
harness has always written them **flat**:

```
.claude/skills/golem-team-<name>/SKILL.md
```

That is not a preference. **Claude Code discovers one level** of skill
directory, so a nested layout would produce skills that sync correctly and are
never loaded — the worst shape of bug, because everything reports success.

`src/cli/init-skills.ts` already implemented flat, so no harness code was ever
wrong. Only the prose was, in three places: this repo's verification-notes §149
item 6 and `docs/wiki/concepts/Team Layer.md` (both corrected by
`project-team-binding`, see §159), and **the portal repo's team-config doc,
which is still wrong.**

## Why it is worth a task rather than a shrug

`team-skills-sync` is built against the flat path. If the portal's documentation
keeps saying nested, the next person to implement the portal half — or to review
the harness half against "the contract" — will read the wrong thing and conclude
the harness is broken. That is the same failure the release-webhook body
mismatch produced (`portal-success-body-replaced`): two halves of a contract,
each internally consistent, disagreeing on paper.

## Exact locations, confirmed 2026-09-07

`team-skills-sync` read the contract while building against it and reported the
two lines still showing the nested path:

- `api-contract.md` **line 243**
- `team-config.md` **line 457**

It did **not** follow them — it built flat and said so. That is the right
outcome, and it is also the evidence: an implementer read the contract, found it
wrong, and had to override it. The next one may not.

## What to do

Correct the portal repo's team-config documentation to the flat path, and note
why it is flat (single-level discovery) so it is not "tidied" back into a
hierarchy later.

## Out of scope

- Anything in this repo. The harness is already correct and the local docs are
  already fixed.
- The other open portal contract item, `portal-success-body-replaced` — a
  separate divergence, same cross-repo shape.
