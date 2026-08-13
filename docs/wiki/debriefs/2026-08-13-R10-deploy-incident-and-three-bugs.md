---
title: The deploy that broke the session, and the three bugs it exposed
type: debrief
tags: [proxy, daemon, deploy, staleness, orphaned-processes, embedder, incident, r10-batch]
sources: ["docs/plan/tasks/R10.3.md", "docs/plan/tasks/R10.4.md", "docs/plan/tasks/R10.5.md", "docs/plan/tasks/R10.6.md", "src/cli/proxy-daemon.ts", "src/cli/commands/proxy.ts", "src/compression/headroom-adapter.ts", "src/cli/auto-index.ts"]
created: 2026-08-13
updated: 2026-08-13
---

# The deploy that broke the session, and the three bugs it exposed

Related: [[R10.1 (part 1) — the first pancake was not burnt, it was just big]],
[[R10.2 — the flaky suite was paying for a delete per test, and hiding a real corruption bug]]

**Date:** 2026-08-13
**Tasks:** R10.3, R10.4 (done); R10.5, R10.6 (queued)

## The incident

A routine local deploy — build, `golem init`, re-wire the proxy — left the user
with **no response at all** from their session. They recovered by deleting
`ANTHROPIC_BASE_URL` by hand.

Cause: `golem init` printed `golem proxy: started (pid 81488)`, and that was
taken at face value. The log showed it had actually found one **already
running** — a daemon started 18 hours and several rebuilds earlier, holding
config that routed every request to an OpenRouter DeepSeek target the current
config no longer named. Freshly-wired traffic went straight into it.

**The lesson is about trusting a success message.** `startDetached` genuinely
cannot tell "I started it" from "something was already listening": its child
exits on a port clash, the port probe then succeeds against the OLD daemon, and
the pid it reads back is that daemon's. The message was not lying so much as
reporting a question it could not answer. Every deploy step after that was
correct and it did not matter.

## Bug 1 — "running" never meant "current"

Nothing recorded WHICH BUILD was answering, so nothing could compare. A daemon
serves the code AND the config it read at startup; `npm run build` changes what
the NEXT one will do, not what the live one does.

Fixed by stamping the version into `proxy.pid` at listen time and having
`proxyStatus` report `{version, stale}`. Every "is the proxy running" check
already routed through `proxyStatus`, so they all gained the second answer for
free. `golem status` now says it on the proxy line; `golem init` stops claiming
it started a daemon it merely found, and **restarts a stale one** — a reinit that
leaves an hours-old daemon serving fresh wiring has not finished the job.

Two design choices worth keeping: a daemon with no stamp is treated as stale (it
predates the stamp, so it is older by definition), and a port-probe hit with no
pid file is also stale — **unknowable, not assumed-good**.

## Bug 2 — a command that was specified, advertised, and never registered

`golem status` had been telling people to run `golem proxy wire` for releases. It
answered `error: too many arguments for 'status'` — commander falling through.

This was not bad advice. A test pinned that status should name
"`golem proxy wire`, not the far heavier `golem init`", and the engine
(`wireProxyEnv`/`unwireProxyEnv`) was written and unit-tested the whole time.
**Only the registration was missing**, so three comments, four test assertions and
two user-facing remedies all described something that did not exist.

Building it was right; downgrading all that advice to `golem init` would have
thrown away a lightweight path someone had deliberately designed. Same class as
the `golem account` -> `golem gateway` fix earlier in this batch, where 55
strings across 26 files pointed at an unregistered command — including a skill
body instructing Claude itself.

**Generalisable: when the docs and the tests agree on a command, check the
registration before you assume the docs are stale.**

## Bug 3 — the orphans, and a diagnosis that was necessary but not sufficient

Verifying the restarted proxy turned up 24 orphaned Python processes, the oldest
alive five days, burning minutes of CPU. They are why a full test run had
stretched from ~125s to 214s.

Three causes were traced up front: the SIGTERM handler never runs under Windows'
`TerminateProcess`; the handler stopped only the semantic sidecar, never the
memory one; and no process-tree kill existed.

**A fourth cause invalidated part of that.** The live orphans are python ->
python PAIRS whose launching `uv.exe` was already gone. The worker is a
*grandchild* whose parent link points at a dead pid — so `child.kill()` on the
pid Node holds **could never have reached it**, even if the handler had run.
Fixing only the handler would have left the leak in place and looked like a fix.

That reshaped the solution away from chasing pids: **the worker now exits on
stdin EOF.** The parent holds a pipe write-end it never writes to, and the OS
closes it however the parent dies. Nothing in the dying parent has to run — which
is precisely the property `TerminateProcess` destroys — and it reaches the real
worker through any number of intermediate launchers.

Two approaches were rejected with reasons worth keeping: recording sidecar pids
beside `proxy.pid` is useless because the pid Golem holds is the launcher's,
which exits (the record is dead while the worker lives, and a later kill could
hit a recycled pid); job objects need native code the no-heavyweight-deps rule
forbids.

**The verification is the part to copy.** The obvious gate — restart the proxy,
count processes — turned out to be *vacuous*: the semantic stage is gated off on
caching upstreams (Decision 31), so a proxy fronting Anthropic never spawns a
worker under normal traffic. Passing it would have proved nothing. The defect was
instead reproduced against the BUILT adapter with real `uv`+Python and killed
with `taskkill /F` and no `/T` — the exact equivalent of `stopProxy`'s kill.

## Bug 4 — the guard that asked the wrong question

Every retrieval-shaped request was logging `query embedding is 768-dim but the
index was built with 1024-dim vectors`. It failed open, so nothing broke — the
local-answer feature was simply dead weight, embedding and discarding on every
query while `golem status` reported knowledge enabled.

The embedder was chosen by DETECTED HARDWARE TIER (tier 1 -> nomic-embed-text/768,
tiers 2-4 -> bge-m3/1024), so the vector WIDTH was a function of a runtime probe.
`detectCapability` never throws and degrades to the CPU tier — right for chat,
wrong here.

The existing guard suppressed local-answer when the CURRENT tier's model was
unavailable. It asked *"can I run an embedder?"*, never *"is this the SAME
embedder the index was built with?"* — so the tier-1 model was present, the guard
passed, and every query failed anyway.

**A guard can be present, correct-looking, and asking the wrong question.** The
fix records the index's embedder and compares identity, not availability.

Two things worth copying from how it was proven:
- **A counterfactual, not just an absence.** Showing the error was gone proves
  little; the same on-disk index was deliberately embedded the old way to
  reproduce `EmbedderMismatchError`, confirming the repro was genuine and that
  the change is what altered the outcome.
- **Back-compat needed no assumption.** Pre-fix indexes turned out to be fully
  checkable — the model was always recoverable from `manifest.signature`, the
  true width always in the driver's `meta.json` — so the chain prefers the width
  STORED ON DISK over anything recorded about it. No rebuild prompt, nothing
  assumed to match.

## What this batch says about verification generally

Every one of these was found by *using the thing*, not by reading it. The stale
daemon, the unregistered command, the orphans and the dead local-answer stage all
survived a green test suite. The tests were not wrong — none of them was in a
position to ask "is the proxy answering the build I just made?"

The counterweight that worked, repeatedly: after fixing something, **prove the
fix by breaking it again**. The byte-fidelity test, the settings-clobber test,
the stale-build warning and the embedder counterfactual were all verified to FAIL
when the property is violated. A guard nobody has tried to break is worth very
little.
