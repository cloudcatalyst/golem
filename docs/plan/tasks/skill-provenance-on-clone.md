---
task: skill-provenance-on-clone
title: "A cloned project can never refresh its Golem skills — the provenance record is gitignored, so every teammate sees a permanent conflict"
state: queued
owner: agent
size: S
discipline: code
design: "R9.5 provenance, documented in the header of `src/cli/managed-files.ts`. The rule that produces the bug is deliberate and must survive the fix: no record means `owned`, because Golem cannot prove it wrote content it has no hash for."
gate: "Clone-shaped test: a project whose `.claude/skills/golem/<cmd>/SKILL.md` files are committed, whose `.golem/state/managed-files.json` is ABSENT, and whose skill text is an OLDER Golem's shipped text, refreshes on `golem init` instead of reporting a conflict — while a genuinely hand-edited skill in the same project still reports `owned` and is kept."
depends_on: []
touches: [src/cli/managed-files.ts, src/cli/init-skills.ts, src/cli/]
created: 2026-09-04
updated: 2026-09-04
---

## The bug

Golem's skills are project-scoped and committed
(`.claude/skills/golem/<cmd>/SKILL.md`, 20 files in this repo). The provenance
record that decides whether a skill may be refreshed is **not**: it lives at
`.golem/state/managed-files.json`, and `.golem/state/` is gitignored.

So on a fresh clone:

| situation | `classifyManaged` | outcome |
|---|---|---|
| clone, same Golem version | `onDisk === shipped` → `current` | fine, by luck |
| clone, **newer Golem** | no record → `owned` | **conflict, forever** |

The second row is the whole failure. It fires the first time Golem's skill text
moves on — i.e. on every teammate's machine except the one that originally ran
`golem init`. `ownedDetail` then tells each of them to *delete the file and
re-run init*, which is advice to delete a committed, version-controlled file. The
skills are "maintained per project" only for the machine that created them.

## Constraint the fix must respect

`no record → owned` is not the defect; it is the guard that stopped R9.5's
data-loss bug and it must still hold for a file Golem genuinely cannot account
for. What the fix needs is a way to account for a file that arrived **via git**
rather than via a local write.

Two candidate shapes — pick one, record why in the debrief:

1. **Commit the provenance.** Move the hashes for committed managed files out of
   gitignored `.golem/state/` into a committed record, so the hash travels with
   the file it describes. Cleanest reading: the record becomes as portable as the
   `managedKey` comment already claims it is.
2. **Recognise historical shipped text.** Keep a table of hashes of every version
   Golem has ever shipped for a skill; a file matching any of them was written by
   *some* Golem and is safe to refresh. No record needed, nothing new committed,
   but the table grows forever and must be generated, never hand-kept.

## Out of scope

- Rules (`.claude/rules/golem-*.md`) and other managed files — check whether the
  same clone path bites them, and say so in the debrief, but fix skills first.
- Any automatic refresh. This task makes `golem init` able to do the right thing;
  it does not add a nag, a session-start sync, or a staleness check.
