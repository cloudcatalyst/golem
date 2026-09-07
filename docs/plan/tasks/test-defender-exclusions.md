---
task: test-defender-exclusions
title: Measure whether Windows Defender real-time scanning is taxing the local test suite — then exclude if it is
state: queued
owner: user
size: S
design: Split out of R13.17 (see its "Out of scope"). The suspicion is already written into `vitest.config.ts` and `tests/helpers/tmp.ts`, both of which blame a virus scanner for real, observed flakiness — but nobody has ever measured it.
gate: A before/after `npx vitest run` wall time on an idle machine, recorded in `docs/plan/verification-notes.md` with the date. REGRESSED or NO EFFECT is an acceptable answer and must be written down either way, so nobody re-opens this on suspicion again.
blocked: Requires an elevated shell — `Get-MpPreference`/`Add-MpPreference` refuse to list or set exclusions as a non-admin, so an agent cannot do this.
depends_on: []
touches: [docs/plan/verification-notes.md]
---

## Why this is worth one measurement

Real-time protection is **on** (confirmed 2026-08-29: `RealTimeProtectionEnabled: True`,
16 logical cores). The suite is close to a worst case for it:

- `golemInit` writes ~20 files, and one file alone makes 36 `golemInit` calls
- the ledger tests drive real `git` through many subprocess spawns
- every temp tree is created and deleted under `%TEMP%`
  (`C:\Users\paulc\AppData\Local\Temp`)

Every one of those is a scanner event. Two committed comments already blame it:

- `vitest.config.ts` — the 5s→20s `testTimeout` bump, "with files running in
  parallel and a virus scanner in the path"
- `tests/helpers/tmp.ts` — `rm` retries exist because "a tree that was just
  written is often still held by the indexer, a virus scanner, or a lingering
  handle"

So the cost is either real and large, or it is folklore that has been shaping
this suite's design for months. Both answers are worth having.

## The work

In an **elevated** PowerShell:

```powershell
Get-MpPreference | Select-Object -ExpandProperty ExclusionPath     # record what's there first
Add-MpPreference -ExclusionPath 'D:\Personar\Source\repos\golem'
Add-MpPreference -ExclusionPath 'C:\Users\paulc\AppData\Local\Temp'
Add-MpPreference -ExclusionProcess 'node.exe'
Add-MpPreference -ExclusionProcess 'git.exe'
```

Time `npx vitest run` on an idle machine before and after (three runs each — the
suite's own variance is a few seconds). Record both in verification-notes.

## Judgement call this needs from a human, not an agent

Excluding a whole source tree and `%TEMP%` from real-time scanning is a standing
security trade, not a test-tuning knob — `%TEMP%` in particular is where a lot of
real malware lands first. If the win turns out to be small, **revert the
exclusions**; if it is large, decide deliberately whether to keep the repo-only
exclusion and drop the `%TEMP%` one. `Remove-MpPreference -ExclusionPath …`
undoes them.

## Out of scope

- Disabling real-time protection outright. Not on the table.
- Anything in `vitest.config.ts` (R10.1 measured that dead end).

## Fresh evidence 2026-09-06 — the suspicion now has numbers, and they point at fs

Closing `test-timing-flakes` produced exactly the data this task wanted, and it
implicates I/O rather than CPU:

- Three tests fail on a saturated machine as **20s `testTimeout` timeouts**, and
  all three are I/O-heavy. `join-queue`'s cap test does ~200 fs operations
  (O(n²) in directory scans) and runs in **~0.5s idle** — a 40× slowdown.
- Two consecutive full-parallelism runs of the *same commit* failed 2 tests, then
  4, with a **different set each time**.
- The same commit, run sequentially: **3437 passed, zero failures**, ~7m40s
  against ~3m45s.

A 40× slowdown concentrated on fs syscalls is what real-time scanning looks like.
This stays `owner: user` — `Get-MpPreference`/`Add-MpPreference` need an elevated
shell — but the measurement is now cheap: `npm test` and `npm run test:serial`
before and after excluding the repo and the vitest temp directories.

**REGRESSED or NO EFFECT is still an acceptable answer** and must be written down
either way. If it is NO EFFECT, the honest conclusion is that the suite simply
oversubscribes this machine, and `test:serial` is the permanent answer rather
than a workaround.
