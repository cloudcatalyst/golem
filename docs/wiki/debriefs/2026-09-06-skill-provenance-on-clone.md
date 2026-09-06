---
title: The Record Has to Reach the Machines the Files Reach
type: debrief
tags: [provenance, init, skills, managed-files, clone, privacy, r9.5]
sources: [docs/plan/tasks/skill-provenance-on-clone.md, src/cli/managed-files.ts, src/cli/init-skills.ts, "docs/wiki/debriefs/2026-08-09-r9.5-managed-file-refresh.md", "docs/wiki/concepts/Team Layer.md"]
created: 2026-09-06
updated: 2026-09-07
---

# The record has to reach the machines the files reach

R9.5 gave managed files provenance: Golem records the hash of what it last
wrote, so a file that drifted can be sorted into **stale** (Golem's text moved
on — refresh) or **owned** (the user edited it — report and stand aside). The
mechanism was right. Its *address* was wrong.

The record lived at `.golem/state/managed-files.json`, and `.golem/state/` is
gitignored. Every file it accounts for — `.claude/skills/golem-<cmd>/SKILL.md`,
`.claude/rules/golem-<name>.md`, `.golem/personas/<name>.md`, the agents — is
**committed**. So the files travelled and the hashes did not.

## Why nobody noticed for a month

Because on a clone running the *same* Golem version, `classifyManaged` returns
`current` before it ever consults the record: `onDisk === shipped` short-circuits
first. The bug is invisible until Golem's skill text moves on, and then it fires
on **every machine except the one that originally ran `golem init`** — each one
told, by `ownedDetail`, to delete a version-controlled file and re-run init.
"Maintained per project" was true only for the machine that created them.

## Which of the two candidate shapes, and why

The task offered two, and asked for the reason to be recorded.

**Rejected — recognise historical shipped text.** Keep a generated table of every
hash Golem has ever shipped for a skill; a file matching any of them was written
by *some* Golem. It is the only shape that fixes projects retroactively, with
nothing new committed. It is also **not buildable here**: the skill bodies are
TypeScript string constants in `src/cli/skills/*.ts`, so reconstructing what an
older Golem *shipped* means evaluating old TypeScript out of git history. The
task's own constraint — the table "must be generated, never hand-kept" — is
exactly what cannot be honoured, and a hand-kept table of hashes is a fiction
nobody would maintain.

**Chosen — commit the provenance.** The record moves to
`.golem/managed-files.json`: committed, beside the project's `.golem/settings.json`
and deliberately outside the gitignored `.golem/state/`. It becomes as portable
as `managedKey`'s doc comment always claimed it was, and the hash travels with
the file it describes.

Three details make that safe rather than merely different:

- **Both records are read as one set of hashes.** Matching *either* is proof
  Golem wrote the bytes, so nothing that classified as `stale` yesterday becomes
  `owned` today. `rememberManaged` folds the machine-local entries into the
  portable record as it writes, so a project migrates by being used.
- **Keys are sorted and an unchanged record is not rewritten.** A committed file
  that churns on every `golem init` is a diff nobody asked for, and two machines
  recording the same facts must produce the same bytes.
- **`no record → owned` is untouched.** That is R9.5's data-loss guard, not the
  defect. What changed is only *which files Golem can account for*, never what it
  does with a file it cannot.

## The half that makes it real: identical bytes are proof of authorship

A committed record fixes every project initialized from here on — and does
nothing at all for the projects that already exist, including this one, whose
20 skills were committed with no record anywhere. The fix would have shipped
inert.

So `installSkills` now records a skill it finds **byte-identical to what Golem
ships**, even though it writes nothing. That is not a guess: identical bytes are
Golem's own text whoever put them there, so the claim "Golem wrote this" is
provable at that instant. It cannot cause data loss — a later edit stops matching
the hash and classifies as `owned` exactly as before — and it is the only honest
route by which a pre-existing project acquires provenance. One `golem init` on
any machine, and the teammates are covered.

## Running it on a real machine found a leak the tests could not

Generating this repo's own record surfaced 22 keys shaped like
`C:/Users/<name>/.claude/skills/golem/skills/ship/SKILL.md`. Managed files
outside the project directory — user-scope installs — make `path.relative`
return a `../..` key or, across Windows drives, a fully absolute one. Folding
those into a **committed** file would have published the user's home directory,
and their username, to everyone with access to the repo.

`travelsWithTheProject()` now keeps them in the machine-local record, which is
where a machine-local fact belongs, and the legacy migration copies only keys a
clone could use. The lesson is the ordinary one and it keeps being true: a
mechanism that changes *where data goes* has to be run against real data before
it is trusted, because a temp-directory fixture has no home directory in it.

## Rules, personas and agents ride along

The task scoped the fix to skills and asked whether the same clone path bites the
others. It does — identically, and for the same reason: they are committed files
classified against a gitignored record. They are fixed for free, because the
record is shared; this repo's committed record has entries for all four kinds.
They were never the *reported* symptom only because guidance rules are seeded
once and are usually still current, which is the same luck that hid the skill bug.

Deliberately left alone: `.claude/skills/golem-step/SKILL.md` is absent from this
repo, so `golem init` reports it as a `create`. That is a pre-existing gap in a
different direction and not this task's business.

## Evidence

- `tests/integration/skill-provenance-clone.test.ts` — the gate, both halves in
  one run: a stale committed skill refreshes, a hand-edited one in the same
  project is kept and reported, and a skill Golem has no record of is still
  nobody's to overwrite.
- `tests/unit/managed-files.test.ts` — the portable/machine-local split, the
  legacy fold-in, the home-path guard.
- `.golem/managed-files.json` — this repo's own record, 29 entries, committed so
  the fix is live for the next person who clones it.

[[Team Layer]] depends on this directly: team skills sync from the portal into a
second managed namespace, and every member's copy arrives via git or via a sync
rather than via the local write that used to be the only thing provenance
believed in.
