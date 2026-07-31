---
title: 2026-07-31 — Three small honesty fixes: an unreachable park step, a catalog posing as availability, and a precedence we finally proved
type: debrief
tags: [snooze, hooks, inference, ollama, observability, tasks, shipped]
sources: ["docs/plan/tasks/snooze-taskadd.md", "docs/plan/tasks/local-models.md", "docs/plan/tasks/hook-precedence.md", "docs/plan/verification-notes.md (§105, §91, §96, §89, §100)", "src/mcp/snooze-note.ts", "src/inference/availability.ts", "src/cli/devices.ts", "tests/e2e/hook-precedence.live.test.ts"]
created: 2026-07-31
updated: 2026-07-31
---

# Three small honesty fixes

Three `S` tasks, one theme: **each was a surface telling the reader something that
was not true.** A park procedure whose first step could not run. A device report
that presented a catalog as an inventory. A safety guarantee nobody had ever
checked. None needed new capability; all three needed the output to match reality.

## 1. `snooze-taskadd` — the procedure denied its own first step

`.claude/rules/golem-snooze-hold.md` prescribed three steps at a usage limit:
`golem task add "<note>"` first, then the `snooze` MCP tool, then stop. Decision 45
made enforcement the default, and enforcement **denies every non-`snooze` tool
call**. `golem task add` runs through `Bash`. So step 1 was denied by step 2's own
mechanism.

Reproduced before touching anything — a scratch project with a 95%-utilization
`limit-state.json`, the real hook, the real payload:

```
$ GOLEM_SNOOZE_ENFORCE=true golem hook pre-tool-use < payload.json
{"hookSpecificOutput":{"permissionDecision":"deny", … "The ONLY permitted action now
is the `mcp__golem__snooze` tool …"}}
```

The task offered two fixes and said the choice *was* the task:

- **A — exempt `golem task add`.** Keeps the safety net, but re-opens the hole
  enforcement exists to close, matched on a command string.
- **B — drop step 1.** Simpler and honest, but removes the stated protection for
  the exact case the rule calls out: the session ending *before* the reset.

**Neither was taken.** `snooze` now files the note itself — a new `note` parameter,
persisted as an ordinary local task under `.golem/tasks/` **before** the wait
begins. That makes the ordering problem *structurally impossible* rather than
exempted: the one permitted tool is the one that writes the safety net. No
exemption to get wrong, no protection dropped.

Verified end-to-end through a real `golem mcp serve` over stdio:

```
text: **Golem** Snoozed ~0 min — the usage window should have reset; continuing here.
      Your note is filed as local task `15831754` (`golem task list`).
$ golem task list --dir <proj>
  15831754  queued    R8 batch: snooze-taskadd done
```

And `golem task add` is **still denied** under enforcement — the enforce message now
says so explicitly and points at `note=` instead. Fail-closed was never weakened.

Two smaller things fell out of it. `projectRootDir` was only wired into the MCP
server when the knowledge base was enabled, so with the KB off the note would have
had nowhere to go; it is unconditional now. And a note that *cannot* be filed
(unwritable state dir, no project root) never blocks the park — the wait happens
anyway, `note_error` says why, and the note is echoed back into the transcript so
it is never silently dropped.

Surfaces updated together, so nothing still teaches the old two-step: the guidance
rule and its generator, the `/golem/park` skill, `CLAUDE.md`, both deny reasons, and
the snooze proposal's design record.

## 2. `local-models` — a catalog is not an inventory

`golem devices` printed `models for this tier: qwen2.5:7b, qwen2.5-coder:7b,
qwen2.5:14b, bge-m3`. Every one of those is what the *catalog* would pick. Four of
seven slots were not downloaded. The same gap had already cost three
investigations: the LE2 judge bug (a never-pulled `qwen2.5:14b` failing into a
silent `catch`, fixed at the symptom), then §89 and §100, which both had to
substitute `--role drafter` and record it as a hand-written caveat afterwards.

Now every surface asks `/api/tags` and reports per slot:

```
  models for this tier (endpoint http://localhost:11434):
    summarizer  qwen2.5:7b — NOT pulled
    extractor   qwen2.5:7b — NOT pulled
    classifier  qwen2.5:7b — NOT pulled
    drafter     qwen2.5-coder:7b — pulled
    judge       qwen2.5:14b — NOT pulled
    text-embed  bge-m3 — pulled
    code-embed  bge-m3 — pulled
  3/7 of this tier's slots are runnable.
```

Three design points worth keeping:

- **Three states, not two.** An unreachable endpoint gives `unknown`, never
  `not-pulled`. Claiming a model is missing when you could not look is the
  fabricated-zero failure the R4.4 lesson is about.
- **A stricter matcher.** `OllamaNativeClient.hasModel` uses `startsWith`, which
  would let `qwen2.5:32b` "satisfy" `qwen2.5:3b` — a different model on a different
  tier. `matchesPulledName` requires an exact match for a *tagged* id and only
  allows tag-wildcarding for untagged catalog entries like `bge-m3`.
- **The warning moved before the run.** `golem bench tools` / `bench repo-map`
  now print the role's availability to **stderr before scoring**, which is exactly
  the sentence §89 and §100 each wrote by hand afterwards:

```
golem bench: Role "classifier" would use qwen2.5:7b, which is NOT pulled on
http://localhost:11434. The service will step down a tier (or fail) rather than run it…
```

Nothing auto-pulls: a multi-GB download stays the user's decision, and
`golem ollama setup` remains the only place that asks.

An incidental catch: `local-config.test.ts` would have started hitting a real
Ollama once the lookup existed, making a unit suite depend on what the CI box
happens to have downloaded. `listModels` is injected throughout instead.

## 3. `hook-precedence` — the guarantee nobody had checked

§91 (2026-07-30) established that PreToolUse hooks run in parallel and that
`updatedInput` "replaces a tool's arguments before it runs", but found **no
statement of precedence** when hooks disagree — the live case being a peer (RTK)
rewriting a Bash command while Golem's hook returns `deny` for snooze, coder-first
or autonomy. Golem registers its hook with no matcher, so it fires on every Bash
call; anyone running both was exercising undefined behaviour.

**Half one: the docs caught up.** The reference now says it outright —
*"When multiple PreToolUse hooks return different decisions, precedence is
deny > defer > ask > allow"* — plus *"Deny and ask rules are still evaluated
regardless of what the hook returns"*.

**Half two: the case the docs still omit, asserted.** RTK's shape is *not* a
conflicting decision — it returns **no `permissionDecision` at all**, only
`updatedInput`. Nothing documents what happens to that rewrite when another hook
denies, and §91's instruction was "assert it; do not trust it". So
`tests/e2e/hook-precedence.live.test.ts` wires two competing project-scope hooks on
`matcher: "Bash"` — one rewriting the command to create a marker file, one denying
— and runs a real `claude -p` turn.

**Result against Claude Code 2.1.220: both hooks fired, and the marker was never
created.** The deny won; the rewrite was discarded. The test also refuses to pass
vacuously — it fails if neither hook fired, which would mean Bash was never
attempted.

It spends a model turn, so it is gated behind `GOLEM_LIVE_CLAUDE=1` and never runs
in the default suite. **Re-run it after any Claude Code upgrade touching hooks** —
this is vendor behaviour pinned by observation, not by contract, and the docs were
silent on it three days earlier.

## What generalises

- **When a documented procedure is unreachable, prefer removing the ordering over
  exempting it.** An exemption is a new hole with a matcher; folding the step into
  the permitted call is neither.
- **A defaults table rendered without a liveness check reads as an inventory.**
  Every "here is what we would use" surface should say whether it *can*.
- **A caveat written after the fact is a warning that arrived too late.** If it was
  knowable before the run, print it before the run.
- **An undocumented vendor guarantee your safety story depends on is unverified,
  not fine.** One 30-second live test replaced three days of "treat as unverified".

## See also

- [[Guidance Rules]] — where the `snooze-hold` rule lives and how it is seeded
- [[Architecture]] — §5, the PreToolUse guardrail stack the deny paths belong to
