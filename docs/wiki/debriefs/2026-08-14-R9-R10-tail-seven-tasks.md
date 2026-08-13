---
title: R9/R10 tail — seven tasks, and the four bugs the fixes found on the way
type: debrief
tags: [vscode-extension, contract-tests, ccr, dedup, snooze, skills, mcp-tools, telemetry, dpapi, credentials, webfetch, tls, latch, r9-batch, r10-batch]
sources: ["docs/plan/tasks/R10.11.md", "docs/plan/tasks/R9.23.md", "docs/plan/tasks/R9.11.md", "docs/plan/tasks/R10.9.md", "docs/plan/tasks/R9.20.md", "docs/plan/tasks/R9.21.md", "docs/plan/tasks/R9.19.md", "docs/plan/tasks/R10.12.md", "vscode-extension/render.js", "src/compression/native-lossless.ts", "src/hooks/pre-tool-use.ts", "src/inference/target-dispatcher.ts", "src/credentials/backends.ts", "src/hooks/web-fetch.ts", "src/proxy/loopback-reach.ts"]
created: 2026-08-14
updated: 2026-08-14
---

# R9/R10 tail — seven tasks, and the four bugs the fixes found on the way

Related: [[R10.7–R10.10 — the default that was never a default, and a status bar lying about a healthy proxy]],
[[R10.1 (part 1) — the first pancake was not burnt, it was just big]],
[[R10.2 — the flaky suite was paying for a delete per test, and hiding a real corruption bug]]

**Date:** 2026-08-14
**Tasks:** R10.11, R9.23, R9.11, R10.9, R9.20, R9.21, R9.19 (all done). Filed on the way: R10.12.
**Outcome:** full suite green — 2687 passed / 2 skipped / 216 files, exit 0. `tsc`, `biome check`, `format:check`, `verify:deps` all clean.

Every one of these was the whole remaining agent-owned backlog for R9 and R10.
What is worth recording is not the seven fixes — those are in SHIPPED.md — but
that **four of the seven produced a finding nobody had asked for**, and in three
cases the finding was worse than the task.

## The lesson: a test that nobody runs is worse than no test

R10.11's brief was "make this suite run". The suite existed, was thorough, and had
been **4 tests red on `main` for four releases**. Nothing executed it:
`vitest.config.ts` includes only `tests/**/*.test.ts`, and the file is `.js`
outside `tests/`.

The cost was not the red tests. It was that the extension drifted behind the CLI
**five separate times** and every symptom was user-visible, because the only thing
that would have caught any of them was the suite nobody ran:

1. `golem account list` / `account use` — removed by R9.23, so every poll returned
   null and the "Switch upstream" picker was empty (fixed in R10.10).
2. `local_model.coder_model` — a field the CLI never had; it is `local_model.model`
   (fixed in R10.10).
3. The test names themselves: `m.localCoderEnabled` / `localCoderModel` against a
   `buildModel` returning `coderEnabled` / `coderModel`. They would have failed
   against a *correct* implementation, which is how you can tell nobody had run
   them in a long time.
4. **New:** `extension.js`'s `pickAccount` cold path still read `.accounts`, the key
   R9.23 renamed to `gateways`. `buildModel` had been taught both spellings; this
   call site never was. So the FIRST open of the upstream picker in a fresh window
   reported "no upstream accounts configured" on a project with several.
5. **New:** `proxy.bypass` is read by the panel and emitted by nothing.

Findings 4 and 5 came from the *shape contract*, not from the tests. That is the
transferable part: `render.js` consumes `status --json` as an untyped blob, so the
fix for the class is to make the extension **declare** the paths it reads and
resolve them against a real `collectStatus` report. Three drifts had already
shipped; the declaration found two more in the hour it took to write.

Classifying the declarations mattered more than listing them. `required`,
`stateful`, `legacy` and `unemitted` are four different claims, and the contract
asserts the negatives too — a `legacy` path that starts being emitted, or an
`unemitted` gap that closes, both mean the declaration is now lying. A stale
contract is worse than none.

## Finding 5 was a regression, not a gap — R10.12

Chasing why nothing emits `proxy.bypass` produced the worst finding of the batch.
Decision 56 specifies that `golem proxy stop` keeps the port served by a
**redaction-only shim** so Claude Code never sees a dead socket, with a third
`ProxyDesired` state and `golem proxy wire`/`unwire` as the explicit way out.
R8.31 shipped it and is `state: done`.

In the current tree `stopProxy` reads the pidfile, deletes it, and kills the
process. That is all. `ProxyDesired` does not exist anywhere in `src/`;
`src/cli/proxy-state.ts` — named in R8.31's own `touches` — is not in the tree;
`SessionStateReport.proxy.bypass` is declared and zod-validated but never
assigned. The `wire`/`unwire` half survived; the shim and the lifecycle did not.

So the exact defect R8.31 closed is open again, and the user's original words on it
were "that needs to be much more robust". The likely mechanism is R10.1, the
first-pancake rewrite, which deleted and split modules wholesale and carried half
of Decision 56 forward.

Filed as R10.12 rather than fixed here — it is an M-sized task with a
load-bearing constraint (56(c): the shim must serve at level-1 semantics, because
the cheap implementation via `x-golem-bypass` would make the redaction-off path
reachable from a click that says nothing about redaction). **The contract test
asserts the gap stays open**, so it fails the day R10.12 lands and forces the
declaration to be updated. A tripwire beats a TODO.

## Two numbers that were the same number

R9.21 and R9.20 were both, underneath, the same shape of bug: a value duplicated
where it should have been derived.

- **R9.21.** `golem init` writes the WebFetch pre hook's `timeout: 15`, and
  `DEFAULT_RAW_FETCH_TIMEOUT_MS` was also `15_000`. So the self-fetch was entitled
  to the hook's entire budget, and everything that has to happen after the bytes
  arrive — extraction, redaction, the cache write, the KB ingest, the serve — ran
  past the platform's kill deadline. The page was downloaded, cached, and then the
  hook was killed before its stdout could be read, so WebFetch fetched it again.
  One constant now, with a test asserting it reaches `.claude/settings.json`.
- **R9.20.** The proxy resolved credentials twice per restart: the parent to build
  the child's env, the child again on startup — even though the child's injection
  is `??=`, so the second result was *discarded every time*. At the measured
  6668ms that was most of an ~18s restart spent finding the same secrets twice.

R9.21 also had an ordering bug worth naming on its own: the KB **ingest** ran
before the serve. Serving is what prevents the second fetch; indexing is a bonus.
Doing the bonus first, on the critical path of a hook the platform kills, is how a
successful fetch still ended up paid for twice.

## When the instrument is the deliverable

R9.11 asked whether any MCP tool should be demoted to skill-only, and insisted the
answer come from call counts rather than taste. Telemetry said: `coder` 45,
`search` 44, `wiki_read` 1, `ingest` 1, and **zero for everything else**.

The zeros were an instrument gap. `expand`, `stats`, `level` and `devices` never
called `instrumented()` — so three of the four demotion candidates the task named
could not be measured at all, and `stats` was cheerfully reporting per-tool counts
for the instrumented tools while omitting the rest. Five tools read as "never
used" when they were only never measured.

So R9.11 cut nothing and fixed the instrument. This is the §102 lesson arriving
through a different door: a null result from a blind instrument is not evidence of
absence, and "honest observability" makes the distinction load-bearing rather than
pedantic. `tel` is now built before those registrations; the question is
answerable next time, on numbers.

One detail was worth getting right: `stats` reads the counts **before** recording
its own call, so it never reports itself in the same breath as reporting it.

## Two fixes for one deadlock, on purpose

R9.23's deadlock — under snooze enforcement the only permitted tool is `snooze`,
which is deferred, so it needs `ToolSearch`, whose response was elided by the
dedup, and `expand` (the way back) is also deferred and also denied — got two
independent fixes.

That was deliberate. Exempting tool schemas from the dedup fixes the instance;
letting `ToolSearch`/`expand` through the enforcement gate fixes the **class**,
because any deferred tool needed for parking has the same shape. Either alone
leaves a hole.

The second live reproduction also settled a question the first left open: the
elision hash is identical across four different query spellings within a session
and differs between sessions, so the dedup keys on the **response body**. That is
why no rephrasing escaped it, and it is why the exemption matches on
`tool_use_id` → tool name from the message prefix rather than sniffing the body —
the conversation already carries the authoritative name, and a content heuristic
in a byte-stability-critical stage would be a guess where a fact is available.

Worth recording honestly: the 2026-08-13 session escaped the deadlock only because
it happened to know `until`/`note` from a project rule file. That is a workaround
that works solely for projects shipping that rule, which is why the deny reason
now carries the parameters and the escape hatch itself.

## Splitting a predicate that answered two questions

R10.9 is the cleanest fix in the batch and the most reusable idea.
`permitsUnredactedDispatch(target)` was being used to decide **both** "may this go
unredacted?" and "where do the bytes go?" — so `trust === "local"` meant "send it
to Ollama" regardless of what the target actually named. A loopback `llamacpp`
target on `:8080` drafted on Ollama at `:11434`.

The predicate's condition was correct and stayed untouched. What changed is that it
now answers only its own question; the transport is chosen by the target's provider
like every other target. R10.8 had reserved widening the unredacted branch as a
deliberate act, and the argument that satisfies it is that this is **the existing
local class generalised from one hard-coded endpoint to any endpoint that passed
the same loopback check** — the `InferenceService` path has always POSTed an
unredacted prompt to a loopback port. Not a new class of egress.

One pre-existing test had to be rewritten, and per the R10.8 precedent it is called
out rather than quietly adjusted: `target-dispatcher.test.ts`'s "takes the
unredacted direct path for a LOOPBACK llama.cpp server" asserted `sent.length === 0`
and arrival at `inference.calls[0]` — it pinned the defect as the contract and could
only pass while the bug was present.

## Proving a gate you cannot reproduce

R9.19's brief said plainly that the failure cannot be reproduced from a terminal
session: it only appears where Claude Code's TLS stack ignores the settings `env`
(cloud and Desktop-app-managed sessions, §121-A), while the hook's own environment
says everything is fine (§125).

The simulation is faithful because it reproduces *what actually differs*. Signals
1–3 of `greenServeState` all read this process's environment, so they are made to
pass for real — a real loopback endpoint, the real CA on disk,
`NODE_EXTRA_CA_CERTS` naming it, a real passing TLS probe. The only thing changed
is whether the rewritten fetch ever lands on `/w`. Leaving it un-hit *is* the
mismatch.

The design constraint worth remembering: **a latch that requires evidence before
its first rewrite can never obtain any**, because the only way to learn that a
rewrite works is to rewrite. Hence optimistic-once. And the verdict is keyed on the
endpoint's `startedAt`, not the session id, because R9.17 records that the session
id rotates per tool call — a per-session latch would be a fresh latch every time.

A real Desktop-app-managed session remains unverified. Said plainly rather than
implied by silence.

## Method notes

- **The exit-code trap bit again.** `npm run lint | tail` reports `tail`'s exit
  code, not biome's — the miss that failed CI three times before. Checked with
  `$?` on the command itself this time, and it was hiding three real format errors.
- **`hookTimeout` is not `testTimeout`.** `vitest.config.ts` raises `testTimeout`
  to 20s; `beforeAll` is governed by `hookTimeout`, still 10s. A new contract test
  doing a real `golemInit` plus `collectStatus` takes ~1s alone and timed out at 10s
  under full parallel load — the R10.2 contention class, in a place the R10.2 fix
  did not reach.
- **`node --test <dir>` is not directory discovery.** Handed a directory, Node
  resolves it through that directory's `package.json` `main`. For
  `vscode-extension/` that is `extension.js`, which fails on `require("vscode")`.
  Discovery is a `readdir` plus explicit file arguments.
- **Mutation-test the tripwires.** Both new contract tests were verified by
  deliberately breaking what they guard (renaming a declared field; reintroducing
  the `golem stats` shell-out) and confirming the failure message names the fix. A
  guard that has never been seen to fire is not known to work.
