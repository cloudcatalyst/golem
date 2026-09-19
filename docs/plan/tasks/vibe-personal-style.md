---
task: vibe-personal-style
title: "`vibe` — a personal style reference guide Golem learns, gated to Golem projects, consulted by coder/scribe/reviewer"
state: done
owner: agent
size: L
discipline: code
design: "This document is the design. Store layout and the gating invariant are pinned here; the seeding mechanism is the existing `src/cli/init-skills.ts` + `src/cli/managed-files.ts` provenance system, unchanged in kind. User scope is `~/.golem/` per spec Decision 19 / verification-notes §17, resolved by `defaultUserDir()` in `src/config/paths.ts`."
gate: "Four named tests. (1) GATING: a directory that is not a Golem project performs ZERO reads of `~/.golem/vibe/` — no stat, no open — even with the skill file present on disk. (2) BUDGET: a coder/scribe/reviewer turn loads `VIBE.md` only; `guidelines/` and `snippets/` are reached on demand and the always-on cost is asserted under a byte ceiling. (3) CAPTURE: a correction (agent writes X, user's own edit makes it Y) produces exactly one candidate carrying both sides, and a re-run over the same edit produces no duplicate. (4) REDACTION: a snippet captured from a file containing a secret lands redacted in `~/.golem/vibe/`, asserted on the stored bytes."
touches: [src/cli/skills/, src/cli/init-skills.ts, src/cli/managed-files.ts, src/hooks/, src/knowledge/file-watcher.ts, src/vibe/, .claude/agents/]
created: 2026-09-13
updated: 2026-09-13
---

## Status — BOTH SLICES LANDED 2026-09-13

All four gate tests are satisfied. Slice 1 was the store, seeding and the read
path; slice 2 is capture, and the loop now closes end to end through the real
hooks:

- [x] PostToolUse records a hash + style reading of what the agent wrote
- [x] UserPromptSubmit re-reads them; a moved hash is a HUMAN correction
- [x] `candidates.jsonl` with de-duplication, counts, and tombstones
- [x] `golem vibe candidates | confirm | reject | sweep`, and the `/vibe quiz`
      flow that drives them
- [x] Confirmed preferences written to `guidelines/preferences.md` and to a
      SEPARATE brief block, above the measured one so the cap cannot eat them
- [x] The generated persona bodies (`src/cli/agents.ts`) tell every coder,
      scribe and reviewer to run `golem vibe show` and that the project outranks
      the guide

**No file watcher was needed.** UserPromptSubmit is a better boundary than a
watcher: the human has stopped typing, so they have probably stopped editing, and
it is naturally rate-limited to once per message instead of once per keystroke.

Deferred to `vibe-authored-history` — the two remaining seed signals
(`git log --author`, and prompt text as a prose-voice source). Neither is in this
task's gate.

Debrief: `docs/wiki/debriefs/2026-09-13-vibe-personal-style.md`.
Design: `docs/wiki/concepts/Personal Vibe Guide.md`.

## What this is

A **personal** style reference — the user's programming style, formatting
preferences and comment/prose voice. Personal, not the project's and not the
team's: a project has its own committed SOPs and a team has its synced standards
(Decision 64), and both **outrank** this. Vibe fills the gaps those leave.

It is seeded from examples the user points at, grows by observation, and is read
back during **coder**, **scribe** and **review** work without being invoked.

## The store — `~/.golem/vibe/`

| path | role | when it reaches context |
|---|---|---|
| `VIBE.md` | prose brief, hard-capped (~40 lines) | ALWAYS, on coding/writing/review turns |
| `guidelines/<topic>.md` | formatting, naming, comments, tests, prose voice | on demand, by path or KB `search` |
| `snippets/<lang>/<id>.md` | exemplar excerpts + provenance (repo, path, commit) | on demand |
| `candidates.jsonl` | observed, unconfirmed signals awaiting a quiz | NEVER |
| `sources.json` | the projects/files pointed at for seeding | NEVER |

That split is the whole anti-bloat design: one small brief is always on, and
everything else is retrievable. `guidelines/` and `snippets/` are indexed into
the KB so `search`/`fetch` find them the same way wiki pages are found.

## Gating — the invariant

**Only a Golem-initialised project may read the guide.** Enforced twice, because
one of them is only a convention:

1. The skill is on disk only where `golem init` put it.
2. Every surface that opens `~/.golem/vibe/` refuses when
   `findProjectDir() === null`. This is the one that actually holds — a skill
   file copied into an unrelated repo must still read nothing.

Test (1) of the gate asserts the absence of the syscall, not the absence of a
log line.

## Passive inclusion

Skills are invoked; rules are always in context. So the always-on half is a
seeded rule `.claude/rules/golem-vibe.md` carrying the pointer and the `VIBE.md`
digest, plus one line in each of `.claude/agents/golem-coder.md`,
`golem-scribe.md` and `golem-reviewer.md`. The `/vibe` skill carries the active
verbs: seed, quiz, promote, show, forget.

## Capture — hook-backed (USER, 2026-09-13)

Four signals, in descending value:

1. **Corrections.** The agent writes X; the user's own edit makes it Y. The
   delta between those two is an explicit preference, and the strongest signal
   in the system. PostToolUse records what the agent wrote;
   `src/knowledge/file-watcher.ts` sees the out-of-band edit that follows. A
   hook alone cannot see this — the user's own edits are not tool calls.
2. **Seeded exemplars.** `/vibe seed <path>` over files or whole projects the
   user names as good. `sources.json` remembers them so a re-seed is a diff.
3. **Authored history.** `git log --author=<user>` over a seeded repo — code the
   user provably wrote, as opposed to code merely present in their checkout.
4. **Prose voice.** The user's own prompt text, for the comment/commit/doc voice
   the scribe needs. Signal only — never quoted back verbatim.

Every capture passes `src/hooks/redact.ts` BEFORE it is written. Source files
contain secrets; a style guide is not an excuse to copy one into `~/`.

## Quiz

Mid-session, at a natural pause, and cheaply: a candidate that recurs is worth
one question; a candidate seen once is not. Confirmed → promoted into
`guidelines/` or `snippets/` with provenance. Rejected → tombstoned, so the same
question is never asked twice. The quiz must be skippable and must never block a
turn.

## Precedence

`project SOP > team standard > personal vibe`. Where a project's committed
convention contradicts the guide, the project wins and the conflict is surfaced
to the user, never auto-resolved — the same rule the wiki already follows.

## Naming

The user asked for `vibe`, so the skill installs to `.claude/skills/vibe/` and
surfaces as `/vibe`. `ourSkillDirs()` in `src/cli/init-skills.ts` currently
matches `golem-*` only, so install, refresh, prune and uninstall must learn this
one non-prefixed managed name. Do NOT widen the glob — an allowlist entry, or
the skill becomes uninstallable and unversioned.

## Out of scope

- Team or project style. Those layers exist and are not this.
- Auto-rewriting existing code to match the vibe. It informs new work; it is not
  a formatter and never edits on its own.
- Sharing or syncing the guide anywhere. It is local, personal, and stays in `~/`.
- Any dependency that is not already in the default install (no ML, no GPU).

## Verification bar

The standing one: `npx tsc --noEmit`, `npm run lint`, `npm run format:check`,
`npx vitest run`, plus `golem wiki check` if a wiki page changed, and the
`CLAUDE.md` batch close-out.
