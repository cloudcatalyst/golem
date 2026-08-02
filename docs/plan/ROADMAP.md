# Golem Roadmap

> **Restructured 2026-07-30 (spec Decision 55, USER-requested).** This file is now
> **an index, not a container**. Every open item is a **committed Golem task** under
> [`tasks/`](tasks/) — one document per unit of work, self-contained enough to hand to
> a fresh agent or a separate conversation. Shipped history moved to
> [`SHIPPED.md`](SHIPPED.md). The table below is **generated** by
> `golem task index --write`; edit the task documents, never the table.

## How to work this roadmap

```
golem task index --summary     # one screen: what's ready, what's blocked
golem task show R8.5           # the full brief for one item
golem task list                # plan tasks + this machine's parked ones
golem task done R8.5 --note …  # close it, then re-run `task index --write`
```

Plan tasks are the same `Task` concept — and the same `golem task` CLI — that parks a
session at a usage limit (R5.1, Decision 38). They differ only in scope: **local**
tasks live in `.golem/tasks/*.json` (uncommitted machine state), **plan** tasks live in
`docs/plan/tasks/*.md` (committed, reviewable, shared). See
[`tasks/README.md`](tasks/README.md) for the frontmatter and the house style for a
brief.

**To hand an item to an agent or a new conversation:** point it at the task file. It
carries the goal, the design source, the files, the gate, and the out-of-scope list —
no roadmap reading required.

## The organising intent (Decision 36, extended by Decision 56)

Everything is sorted by one criterion: does it serve the working pattern that inspired
the wiki-first pivot (Decision 28 — the "LLM Wiki / developer's second brain" article)?

1. **Plan together.** A place where the user and Claude collaborate on planning:
   reading captured notes and ideas, and turning them into tasks.
2. **Distill everything.** The project and its research distilled into the committed
   wiki; the knowledge base collects raw articles; web fetches are cached and served
   offline.
3. **A local co-developer.** A robust, token-friendly local coder that drafts so the
   paid model can judge.

Goal 2 is largely shipped (WS-W W1–W4); goals 1 and 3 landed in R4; R5 followed. See
[`SHIPPED.md`](SHIPPED.md).

**Decision 56 (2026-08-01) sharpened goal 3 into the current spine.** "A local
co-developer" was scoped as one `coder` tool on one tier-chosen model. It is now a
**model fabric**: two nameable lanes (the *thinker* a conversation plans with, the
*coder harness* that executes), no default model, llama.cpp first-class, and operating
with **no upstream at all** a supported, visible end state. The extensibility seams are
therefore the roadmap rather than decoration — the provider table (R8.15), the plugin
seams (R8.11/ADR-0004), exts (Decision 53), and the routing fabric (R8.19).

## Priorities (set 2026-08-01, Decision 56)

The open work has one ordering, and it is not "by task number":

| # | line | what it unlocks | items |
|---|---|---|---|
| **1** | **A local path worth using** | larger MoE models on ordinary hardware, so local output is a substitute rather than a consolation | **R8.18** (shipped this batch), **R8.17** (small-model robustness) |
| **2** | **The decision that gates the fabric** | ADR-0005 is drafted and **PROPOSED**; accepting it is a user act and it unblocks two L-size tasks at once | **ADR-0005** → **R8.19**, **R8.16** |
| **3** | **Lanes, then the no-upstream mode** | naming any model for either lane per request, then pinning both locally with a guarantee | **R8.19** → **R8.20** |
| **4** | **Everything else already queued** | independent of the above; pick by size | R8.14, R8.S3, P3a |

Blocked-on-hardware and blocked-on-credentials items (R1.6, R2.6, R6.1-live, R7.3,
R7.5, R7.6-infra, R6.3, R5.5-scoring) are **owner: user** and stay visible below rather
than being reordered — an agent cannot advance them.

## Where we are (validated 2026-08-01)

- **Baseline green locally:** `tsc --noEmit`, `biome check`, `npm run format:check` and
  `vitest run` pass, and `golem wiki check` reports 0 issues. **CI is billing-blocked**
  (GitHub Actions refuses to start jobs) — recent PRs merged on green *local* runs;
  unblocking it is a USER account step.
- **R8a (context economy) shipped, and its own instruments redirected it four times** —
  §93 (98.4% cache hit rate → bust prevention is a guard rail, not a lever), §94 (R8.2
  already existed), §95 (the `tools` block is 18.8k), §97 (Grep/Glob have no measured
  traffic), §100 (**93.9% of the tools block is not Golem's** → R8.S1 rejected).
- **The local-model line is where the work is.** R8.15 shipped the provider table;
  R8.18 shipped `golem llamacpp` and put a real 35B-A3B MoE on this machine (§114);
  R8.11 shipped the three plugin seams under ADR-0004. What remains in that line is
  robustness (R8.17), the ADR (0005) and the two tasks behind it.
- **R8.5 / R8.6 / R8.7 shipped with their gates honoured** — repo map **28.6% → 50.0%**
  retrieval for +57 tokens (§101); the LSP bridge as four *modes* of `code` at +333
  definition tokens only when enabled (§109); the local editor **whole-file only**,
  opt-in, because the harness measured search/replace at 33.3% and overturned the design
  it was given (§110). All three inherit one open question: **displacement** — whether
  the model then skips the read — which needs live traffic.
- **R8.13 closed (§104).** The cache-prefix verdict was wrong ~98% of the time because
  `cache_control` — a breakpoint *marker*, not content — was in the fingerprint;
  0% → 73% append after the fix.
- **P0/P1 + the wiki knowledge loop** are live and dogfooded daily; compression is
  honestly scoped as situational (Decision 23); positioning is the universal pre-LLM
  processor (Decision 32).

---

## Open work

<!-- golem:task-index:begin -->

_Generated by `golem task index` from `docs/plan/tasks/` — 5 ready, 13 blocked, 13 done. Edit the task documents, not this table._

### Ready to pick up

| task | goal | owner | size | depends on | gate / blocker |
|---|---|---|---|---|---|
| [P3a](tasks/P3a.md) | CLAUDE.md compaction actuator — the write half of R6.4's leanness check | agent | M | — | Report the saving AND its cost together (Decision 52's rule). Code, URLs and paths byte-preserved; the human reviews the rewrite before it lands. |
| [R8.14](tasks/R8.14.md) | golem ext install/upgrade — the write half of the managed-tool registry | agent | M | — | Golem ships none of the tool's bytes — install invokes the upstream's own installer at a pinned version, with consent. Absence still degrades to a no-op. |
| [R8.15](tasks/R8.15.md) | Provider table — user-chosen local models, and llama.cpp/LM Studio as real backends | agent | M | — | Point Golem at a llama.cpp server hosting a model of the user's choosing, with no Ollama running, and `golem devices` / `golem local status` / the `coder` tool all report the truth — the right model name, an honest availability state, and no `ollama pull` advice that cannot help. |
| [R8.17](tasks/R8.17.md) | Small-model robustness in the local path — repair, degeneracy detection, thinking budget | agent | M | — | A drafter response that today returns unusable text (a fenced pseudo-tool-call, an empty completion, a repeated loop) must instead be repaired or reported as such — measured on real `coder` output, not on synthetic strings. |
| [R8.S3](tasks/R8.S3.md) | Spike — session tree: record the conversation as a tree, view it, do not actuate | agent | M | — | Recording + `golem session tree` only. Relaunch stays with `claude -p --resume` — Decision 37's actuation limit stands. |

### Blocked or waiting (visible, not lost)

| task | goal | owner | size | depends on | gate / blocker |
|---|---|---|---|---|---|
| [21e](tasks/21e.md) | Per-request capability/availability routing (and route-on-exhaustion) — needs a decision first | user | L | — | needs a product/ToS decision, not an implementation |
| [R1.6](tasks/R1.6.md) | macOS / Linux Ollama setup checklist — manual verification | user | S | — | needs non-Windows hardware (unchanged since 2026-07-11) |
| [R2.6](tasks/R2.6.md) | Live semantic-forced A/B on real traffic | agent | M | — | only meaningful on a non-caching upstream — needs real provider credentials (R6.1 case (a)/(b) is built but live-unverified) |
| [R5.5-scoring](tasks/R5.5-scoring.md) | Prompt-translation scoring loop — demand-gated, deliberately unbuilt | user | M | — | demand-gated by its own debrief — not unfinished work |
| [R6.1-live](tasks/R6.1-live.md) | Live-verify the cloud provider adapters (Anthropic-native gateways and Gemini) | user | S | — | needs real provider credentials |
| [R6.3](tasks/R6.3.md) | Remote steering / companion app — threat-model ADR first, then decide | user | L | — | user-deferred; highest-severity item on the roadmap and it needs its own ADR, not just a memo |
| [R7.3](tasks/R7.3.md) | Smoke-test the Bun standalone binaries on each OS | user | S | — | needs Bun plus macOS and Linux hardware; CI is billing-blocked so it cannot run there either |
| [R7.5](tasks/R7.5.md) | First npm publish + VS Code Marketplace publish + tag | user | M | R7.3 | outward, credentialed act — only the user can publish |
| [R7.6-infra](tasks/R7.6-infra.md) | Stand up the golem.run host and confirm the UA-sniffing install map | user | S | — | outward infra act — DNS, TLS and a server the user controls |
| [R8.16](tasks/R8.16.md) | little-coder as a spawned sub-agent harness — coder's agent mode (ADR first) | agent | L | R8.15 | needs ADR-0005 accepted (drafted 2026-08-01, PROPOSED) before any spawn code |
| [R8.18](tasks/R8.18.md) | golem llamacpp — install the server, fetch a curated GGUF, wire it into the provider table | agent | L | R8.15 | On a clean machine, `golem llamacpp setup` gets from nothing to a running llama-server with a curated model, an `inference.providers` entry that resolves, and `golem devices` reporting the live `/props` window — with every byte fetched from upstream at a pinned version, under explicit consent, and resumable. |
| [R8.19](tasks/R8.19.md) | The routing fabric — name any model, local or upstream, for either lane, per request | agent | L | R8.15 | needs ADR-0005 ACCEPTED (drafted 2026-08-01, status PROPOSED — user acceptance is the only remaining blocker) |
| [R8.20](tasks/R8.20.md) | Local-only operation — no upstream, visibly, with the trade stated | agent | M | R8.19 | With local-only on, no request leaves the machine — provable by a proxy that refuses rather than forwards — and every surface that could answer "am I spending money right now?" says so without being asked. Turning it on states what it costs (slower, pre-planning) instead of implying parity. |

### Closed

| task | goal | outcome |
|---|---|---|
| [hook-precedence](tasks/hook-precedence.md) | Assert PreToolUse precedence between a rewriting hook and a denying hook (§91, still open) | done |
| [local-models](tasks/local-models.md) | golem devices reports the tier CATALOG, not what Ollama has actually pulled | done |
| [P3b](tasks/P3b.md) | Point golem bench tools at caveman-shrink rather than rebuilding it | done |
| [R8.11](tasks/R8.11.md) | Plugin surface — third-party pipeline stages, MCP tools and redaction rules without forking | done |
| [R8.13](tasks/R8.13.md) | Fix the cache-prefix verdict — it is wrong ~98% of the time (§99 problem 2) | done |
| [R8.5](tasks/R8.5.md) | Repo map — tree-sitter symbols → graph rank → budgeted skeleton, and the oversized-Read swap | done |
| [R8.6](tasks/R8.6.md) | LSP bridge — diagnostics / definition / references / hover as a tier-2 spawn target | done |
| [R8.7](tasks/R8.7.md) | Local editor model — validated search/replace diff edits (harness-gated, may be rejected) | done |
| [R8.8](tasks/R8.8.md) | Model catalog — price and context limits as Golem's own cached data | done |
| [R8.9](tasks/R8.9.md) | Change ledger — opt-in checkpoint / revert via shadow git refs | done |
| [R8.M1](tasks/R8.M1.md) | Upstream-switch UI defects — stale status URL, dead setting toggles, 3s quick-pick | done |
| [R8.S2](tasks/R8.S2.md) | Spike — system-prompt slimming (expect NO; measure, then decline) | done |
| [snooze-taskadd](tasks/snooze-taskadd.md) | Snooze enforcement denies the `golem task add` its own guidance rule asks for first | done |

<!-- golem:task-index:end -->

---

## Deferred / not scheduled

The **hosted workspace/org knowledge tier** (WS-F5's upper tiers — P4+, candidate paid)
remains the only work off the roadmap entirely. It has no task file on purpose.

Also deliberately out of scope for R8 and beyond (memo `proposals/r8-context-economy.md`):
TUI / desktop / IDE agent clients · sub-agent orchestration · plan mode · session
sharing and gists · themes and keybinds · a competing edit-apply harness · a curated
model marketplace · **rebuilding RTK's Bash filters**. Golem's scope discipline is its
differentiator — all four projects reviewed in that memo compete to *be* the harness,
and Golem is the only one that sits under one and can see the actual bytes.

## Where the rest of the planning context lives

| document | what it holds |
|---|---|
| [`tasks/`](tasks/) | one committed task document per open item — the actionable layer |
| [`SHIPPED.md`](SHIPPED.md) | one line per landed release/task, linking its debrief |
| [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) | workstreams, frozen interfaces, the WS-F ↔ ROADMAP crosswalk (§6) |
| [`BACKLOG.md`](BACKLOG.md) | ideas inbox — pre-task, one line per idea |
| [`proposals/`](proposals/) | design memos (R6 multi-provider, R8 context economy, brevity, snooze, webfetch cache) |
| [`verification-notes.md`](verification-notes.md) | dated live-doc findings and measurements, §1–§100 |
| `../golem-spec.md` | architecture + the authoritative Decisions Log |
| `../decisions/` | ADRs (threat models), stricter human-driven rule |
| `../wiki/debriefs/` | dated per-batch retrospectives |
