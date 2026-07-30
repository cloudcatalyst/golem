# Proposal: R8 — Context economy (and a written dependency-tier policy)

> **Status: Workstream P SHIPPED (2026-07-30) as spec Decision 53; P2/P3 partly
> shipped; R8a–R8d still PROPOSED.** The user asked for the architecture piece
> first ("this architecture piece comes before the other external tool
> improvement suggestions"), so the tier ladder, the `golem ext` registry
> (`src/ext/` + `src/cli/ext.ts`, read-only), and both P-audit fixes (`unpdf`
> genuinely optional; `LICENSE` added) landed together with 48 tests. Debrief:
> `docs/wiki/debriefs/2026-07-30-decision-53-managed-tools.md`; concept page
> [[Managed Tools]]; findings §90–§92. **P3 also shipped** (Decision 53(h)): the
> Headroom worker now introspects `CompressConfig` and forwards an opaque
> `compression.headroom_config` bag, so upstream options arrive without a Golem
> release. **Still open in Workstream P:** the `golem ext install/upgrade` path and
> P3a/P3b (the two Caveman components worth adopting).
>
> **R8.S1 REJECTED (§100), and with it the tools-block line of work.** The memo's
> highest-confidence spike is dead, on a finding neither §89 nor §95 could see:
> **93.9% of the 18.8k `tools` block is Claude Code's own built-ins**, Golem's share
> is **1,130 tokens (0.8% of the request)**, and §89's "~2900 tokens of input
> schemas" was an artifact of measuring `listTools` rather than the wire. A ceiling
> is not a lever. The rule this adds to the memo's own discipline: **attribute before
> you optimise.** See the R8.S1 row below and
> `docs/wiki/debriefs/2026-07-30-r8.s1-tool-schema-shrinking.md`.
>
> **R8.1 SHIPPED, and its first measurement re-ranks this memo (§93).** Against
> this repo's own telemetry: **98.4% cache hit rate** over 7,874 responses, with
> uncached input at **0.06%** of billed input. So cache-*bust* prevention is a
> guard rail here, not a savings lever — there is almost nothing to recover.
> Weighted by rate, **~83% of input cost is re-reading an already-cached
> context**. The ranking below is therefore revised: **R8.2 (dedup) and R8.5
> (repo map) are the real levers**, R8.4 (ledger) aims them, and R8.1's bust half
> stays as instrumentation. Recorded rather than silently re-sequenced — the
> instrument arguing against its author's priority is the point of building it.
>
> _Original proposal below._
>
> **Status: PROPOSED (2026-07-30), USER-REQUESTED.** Design-first: no code, no
> frozen-interface change, nothing wired until this is signed off. Nothing here
> supersedes Decision 23 (compression is situational) or Decision 52 (the slider
> is a preset over `compression.level` + `brevity.level`) — R8 opens a *third*
> axis alongside them.
>
> Origin: a review of four external projects (Aider, OpenCode, Pi, RTK) against
> Golem's shape, requested in the 2026-07-30 session. External findings to be
> recorded as `verification-notes.md` §90 (RTK) and §91 (Claude Code hook
> precedence + the dependency-tier audit) when this is picked up.
>
> **Two questions were settled by the user up front** and are treated as settled
> below: a formal RTK A/B is **not required** (dogfood and record the observation
> instead), and external tools are **installed and managed as tools, not wrapped
> into the project** — which this memo turns into an explicit written policy
> (Workstream P).

## Problem

Golem's two shipped token axes are both near their honest ceiling on this
project's primary upstream:

- **Input compression** (Decision 23) — ~0% on Anthropic's cached traffic. The
  lossless/CCR stage pays; the lossy semantic stage is gated off on caching
  upstreams by default.
- **Output brevity** (Decision 52) — real, because output tokens are never
  cached and cost ~5×, but it ships OFF and it only shortens *replies*.

Meanwhile the measured tool-block census (§88/§89) found the remaining
per-request headroom is the tool **schemas** (~2900 of ~3847 tokens), and the
tools-block shrinker was **rejected** on its own accuracy harness. That was the
right call, and it points somewhere else.

The unexploited axis is not "make each request smaller." It is **stop paying to
re-read the same things every turn.** A 1500-line file read costs ~20k input
tokens once, then ~20k *cache-read* tokens on **every subsequent turn** of the
session. Avoided and deduplicated reads compound in a way per-request
compression cannot.

Golem is the only layer positioned to do this: it sees the entire `messages`
array on every request, and its PostToolUse hook already spans
`Bash|Read|Grep|Glob|WebFetch` (`src/hooks/settings-writer.ts:26`).

## What the external review established

| Project | Idea worth taking | Golem's status |
|---|---|---|
| **Aider** | Repo map: tree-sitter symbols → graph rank over the file/symbol graph → rendered to a token budget, personalized on chat state. Architect/editor split: strong model states intent, cheap model emits the diff. Edit format as a *measured* variable. Lint/test loop feeding back only failures. | tree-sitter parse infra already paid for (`src/knowledge/tree-sitter-chunker.ts`, opt-in chunker). No repo map. `coder` drafts code text, not validated diffs. |
| **OpenCode** | LSP servers as first-class tools (diagnostics / definition / references / hover). Change ledger with `/undo`. Model catalog (models.dev). Plugins + custom tools. | No LSP anywhere in `src/`. No git integration. No model catalog. No plugin seam. |
| **Pi** | "Context engineering" as the product: minimal system prompt, customizable compaction, skills as on-demand disclosure without busting the cache. Session tree (rewind/branch). Extensions as packages. Supply-chain hardening (`save-exact`, `min-release-age`, shrinkwrap on the published CLI). | `src/compression/compaction.ts` is whitespace-only — nothing does conversation-level context work. 18 skills seeded. No plugin seam. |
| **RTK** (Apache-2.0, Rust) | PreToolUse Bash-command rewriter, 100+ filters, `<10ms`. Honest about its own numbers ("cuts up to 90% of bash output… not the same as cutting your bill"; token counts are `bytes/4`, no tokenizer). | Directly overlaps the Bash half of R8.3. **Structurally cannot** touch `Read`/`Grep`/`Glob` — its own README says the hook only fires on Bash tool calls. |

**The complementarity is the finding.** RTK compacts shell output. Golem
compacts built-in-tool output, deduplicates across the whole session, and prices
the bill for real (`UsageSniffer`, R1.1) rather than estimating `bytes/4`. These
are not competitors, and R8 should not rebuild RTK.

## Workstream P — the dependency-tier policy (write it down first)

Three independent integrations have already converged on the same pattern; it is
a policy, not a coincidence, and it should be a Decisions Log entry so the next
integration does not relitigate it.

The invariant behind CLAUDE.md's "no heavyweight native deps" rule, read back off
the precedents, is actually four things:

1. `npx golem-run init` works on all 3 OSes with no toolchain.
2. Every external thing is **opt-in, off by default, and degrades to a no-op** on
   absence or failure.
3. **Exact pins, one quarantine adapter file, never in `dependencies`.**
4. **Golem distributes no third-party bytes** — no supply chain to audit, no
   licence to relay.

### The ladder

| Tier | Mechanism | Precedent | Ships third-party bytes? |
|---|---|---|---|
| **0** | Golem's own code, including plain-text worker scripts it authored | `src/**`, `headroom-worker.py` | own only |
| **1** | npm `dependencies` — pure JS, no native build, deliberately tiny | the 6 runtime deps | yes |
| **2** | **Spawn a pinned external tool the user provides; off by default; one quarantine adapter** | Headroom (`uv run --python 3.13 --with headroom-ai==0.30.0`, pin at `src/compression/index.ts:19`, imports quarantined to `headroom-adapter.ts`); Ollama (HTTP) | **no** |
| **3a** | **Detect a convention and interoperate/defer** | Caveman marker detection (`src/pipeline/brevity.ts:109`) | **no** |
| **3b** | **Re-implement the idea as own data/code, cite the source, copy nothing** | Caveman brevity profiles — "No text is copied from it" (`brevity.ts:34`); `wenyan` deliberately absent | **no** |

**Consequences to adopt explicitly:**

- **RTK is Tier 3a by default, Tier 2 optionally.** Never vendored. A binary is
  permissible as a *spawn target*, never as *cargo*.
- **Plugins are Tier 2/3.** Golem defines the seams (pipeline stage, MCP tool,
  redaction rule); a plugin is resolved from the user's **own** install — an npm
  package they installed, or a local path — never vendored, never
  auto-downloaded, each behind its own quarantine adapter, failing to a no-op.
  A plugin registry, if one ever exists, is **a list of names and pins, not a
  store**.

### P2 — a managed-tool surface (USER-REQUESTED 2026-07-30)

The user's ask: *"treat both as tools, so they can be installed within a Golem
installation… use the benefits and the native features they continue to roll out,
rather than reimplementing."* Endorsed, with the taxonomy below — because
"manage" means three different things and only one of them is *wrap*.

| Shape | What management means | Examples |
|---|---|---|
| **Callable service** — Golem invokes it | Full wrap: install, pin, spawn, health check, upgrade playbook. Upstream features flow in **only if the adapter is a passthrough** (see the worker-script finding below). | Headroom, Ollama, language servers (R8.6), `caveman-compress`, `ripgrep` |
| **Peer injector** — acts on the same surface, independently | Detect, coordinate, don't double-apply, attribute honestly. Golem may install it for convenience but never drives it. | Caveman speech skill, RTK |
| **In-process seam** — runs inside Golem | Interface + quarantine adapter, resolved from the user's own install. Different trust model: this runs *inside* the redaction path. | R8.11 plugins |

**Admission bar — all four must hold**, or the registry becomes a support
liability:

1. It does something Golem **shouldn't** reimplement (specialist domain, or
   actively-maintained upstream worth tracking).
2. Stable invocation contract — pinnable, versioned, passthrough-able.
3. **Absence degrades to a no-op**, never an error path.
4. Golem ships **none of its bytes**.

**Naming — avoid a collision.** `src/tools/` is already the tool-selection bench
harness (`cases/catalog/report/selection/shrink`) and `golem bench tools` is
taken, so this surface must **not** be called `golem tools`. Proposed:

- **`golem ext`** — external managed tools: `list` / `install` / `remove` /
  `status` / `upgrade`. Each backed by a manifest: name, tier, pin, detect
  command, install method, health check, adapter path, degrade behaviour.
- **`golem plugin`** — in-process seams (R8.11), kept separate because a plugin
  runs inside the redaction path and an ext runs beside it.

### P3 — what the two existing integrations actually need

Verified on a live machine 2026-07-30 (this project, `.golem/settings.local.json`):
`compression.headroom_sidecar = true`, `uv` present, **no Headroom process
running** — the lossy semantic stage is the only caller and it is gated off on
caching upstreams (`force_semantic_on_caching = false`, upstream `anthropic`).
Caveman is **not installed** at all. So one integration is an idle spawn target
and the other is an absent program — which is exactly what Tiers 2/3 are supposed
to look like, and it is why a `status` surface is the missing piece.

**Headroom — already a tool; what's missing is management, and the coupling point
is not the pin.** `headroom-worker.py` is authored by Golem, so *it* defines which
Headroom APIs are reachable. A version bump does **not** bring new upstream
features; the worker must be edited. If "benefit from what they roll out" is the
goal, the fix is to make the worker a **thin passthrough** — forward an opaque
options bag and version-gate, rather than hand-enumerate an API surface. That is
the concrete work item, alongside surfacing pin/health/running-state under
`golem ext status`.

**Caveman — the speech skill is not wrappable; two adjacent components are.**
`verification-notes.md` §87 is decisive: install "drops a skill file into your
agent", "the skill is a prompt, the hooks are local scripts", nothing intercepts
or rewrites; its own README chart puts **input tokens saved at 0%** and admits the
skill **adds ~1–1.5k input tokens per turn** (net-negative on terse workloads);
its installer targets specific agents' skill directories, whereas Golem injects
from the proxy with zero deps for every client. And `hasExistingBrevityDirective`
(`src/pipeline/brevity.ts:109`) makes Golem **stand down** on any `/caveman/i`
mention — so installing it disables Golem's dial rather than augmenting it.
Decision 52's "bundled data, not a wrapped upstream package" call stands, and §87
is the evidence. It does **not** bind the two components Golem has never
reimplemented:

| # | Component | Why it qualifies |
|---|---|---|
| **P3a** | **`/caveman-compress <file>`** — rewrites `CLAUDE.md` into caveman-speak. Input-side, one-off; claims ~46% input tokens saved every session after, "code, URLs, paths byte-preserved". | **Golem has no equivalent.** R6.4 already ships a CLAUDE.md-leanness *check*; this is the actuator for it. Passes all four admission criteria. |
| **P3b** | **`caveman-shrink`** — MCP middleware wrapping an MCP server to compress tool descriptions. Input-side, per-request. | This *is* Workstream B, which Golem measured and **rejected** (`src/tools/shrink.ts`: whitespace = 0 tokens; sentence-trim = 56% saving but **3× false positives**). Rather than rebuild, **point the existing `golem bench tools` harness (27 labelled cases, saving + accuracy together) at their implementation.** Either it clears the bar and becomes a managed ext they maintain, or Golem publishes a reproducible negative. §87 warns its install/config is **undocumented on the README** — fetch the npm page before designing against it. |

Both are gated the same way as everything else in this memo: the harness decides.

### P-audit — two inconsistencies found while writing this

| Finding | Detail | Fix |
|---|---|---|
| **`unpdf` is Tier 1 pretending to be Tier 2** | Documented as "the optional `unpdf` package" in both `src/knowledge/extractors.ts:5` and the R3.2 debrief, but it is a **static** import listed in `dependencies` — it ships to every `golem-run` user. Pure JS, so no hard rule is broken. | Either make it a real dynamic import with a degrade path (PDF extraction unavailable → skip, don't crash), or stop calling it optional in both places. |
| **No `LICENSE` file** | `package.json` declares `Apache-2.0`; the tree has no `LICENSE`. | Add before R7.5 publishes. |

## The R8 tasks

Ordered by (expected saving × confidence) ÷ effort. Every row names its gate,
because Workstream B's precedent is **the harness decides, and REGRESSED is an
acceptable answer**.

### R8a — instrument, then dedup, then distill, then report

| # | Task | Gate |
|---|---|---|
| **R8.1** | **Cache-hit observability + cache-bust detection.** The proxy already reads `cache_read`/`cache_creation` off every response. Surface hit rate, and **name the turn and the cause** when a cached prefix breaks (tool block reordered, timestamp injected, `system` changed, history rewritten). Builds on the `onResponseHeaders` pattern from limit-prediction. | None — pure observability. Already in `BACKLOG.md` (row 2026-07-24, `raw`); this promotes it. |
| **R8.2** | **Suffix-only tool-result dedup.** When an incoming tool result is byte-identical or near-identical to content **already in the prefix** (repeated `Grep`, re-`Read` after an edit, same page twice), replace *the new copy* with a ~20-token CCR pointer. Rewriting the prefix would bust the cache; rewriting only the newest block **cannot**, so this is positive by construction. Machinery exists: CCR store + `expand`. | Fidelity tests at level ≤1; **assert zero prefix mutation**; measure with R8.1. |
| **R8.3** | **Non-Bash output distiller — descoped.** Do **not** rebuild RTK's 100+ Bash filters. Build only the surfaces a command wrapper structurally cannot reach: `Read`/`Grep`/`Glob`/MCP tool results, replacing today's generic head/tail CCR truncation with structure-aware distillation. | Full original stays CCR-retrievable; redaction still first. |
| **R8.4** | **Context ledger → data-driven `/golem/context-hygiene`.** The skill exists but reasons blind. Have the proxy report what the context is actually *made of*: "182k in context; 61k is one Read of `dist/`, 28k is 14 near-identical Greps." | None — reporting only. |
| **R8.12** | **External-compactor interop (RTK).** Detect RTK at `golem init`/`golem status` and surface it. **Don't double-compact:** recognise already-compacted output and RTK's tee markers (`[full output: ~/.local/share/rtk/tee/…]`) rather than truncating a truncation. **Attribute honestly:** `golem bench cost` reports Golem's and RTK's contributions separately, never as one number. Optional Tier 2 `golem tools install rtk` invoking *their* installer at a pinned version, with consent. | **Coexistence test (the important one):** assert Golem's `deny` paths (snooze / coder-first / autonomy) still win when RTK's rewrite fires on the same Bash call — see the open question below. |

### R8b — the two big context-economy tools

| # | Task | Gate |
|---|---|---|
| **R8.5** | **Repo map.** tree-sitter symbol extraction → dependency/reference graph → personalized graph rank → signature skeleton rendered to a token budget (default 1–1.5k). Two delivery paths: a `code` tool mode, and **the swap target for an oversized `Read`** (skeleton + requested range + CCR ref instead of 2000 lines). Golem's edge over Aider: incrementally refreshed by the existing watcher (ADR-0001), re-ranked against the live query via `assembleHits`, and byte-stable across turns so it is cache-safe. Do **not** rebuild per-file signature extraction — RTK's `read -l aggressive` covers that; the whole-repo graph-ranked map is the differentiated part. | A retrieval-accuracy harness in the shape of `golem bench tools`: does the map let the model find the right file *without* the read? Report saving and accuracy delta **together**. |
| **R8.6** | **LSP bridge.** Spawn configured language servers; expose `diagnostics`/`definition`/`references`/`hover`. Start with `typescript-language-server` + a config map. No native deps; argument-array spawn; cross-platform. **Tier 2** — the user brings the server, it is off by default, absence degrades to a no-op. | Cross-OS spawn/lifecycle tests; server absent → no-op, never an error path. |

**Standing cost to budget for, in both rows:** §88 measured 11 MCP tools at
~3847 tokens of definitions. Adding four new tools is a permanent bill on every
request. **Consolidate: one `code` tool with a `mode` parameter, not four
tools.** Measure the delta with `golem bench tools` before wiring.

### R8c — the output-token lever (gated)

| # | Task | Gate |
|---|---|---|
| **R8.7** | **Local editor model — validated diff edits.** Today `coder` drafts code *text*. Add an `edit` mode: the frontier model writes a ~50-token instruction; the local model emits a search/replace block; **Golem validates it** (search text must match exactly, tree-sitter parse must still succeed, optional formatter pass) and applies it, returning a compact confirmation. This attacks **output** tokens — never cached, ~5× — the axis Decision 52 opened. A 300-line edit written by the frontier model is thousands of output tokens; the instruction is fifty. | **Harness before code, non-negotiable.** Labelled edit tasks; measure apply-success and semantic correctness against hand-written edits; measure the *edit format* variable (search/replace vs udiff vs whole) the way Aider does. If the local tier misses the bar, this ships advisory-only or is **rejected** like the tools-block shrinker. |

### R8d — credibility and cost truth (pre-publish)

| # | Task | Notes |
|---|---|---|
| **R8.10** | **Supply-chain hardening + sandbox story.** From Pi, and overdue with R7.5 imminent: `save-exact=true`, a minimum release age, `npm-shrinkwrap.json` in the published package, a check wired into `npm run check`. Plus a documented container/sandbox pattern beside the existing autonomy gate. Fold in the two P-audit fixes (`unpdf`, `LICENSE`). | Highest credibility per hour in this memo. |
| **R8.8** | **Model catalog** (models.dev-style, fetched + cached, Tier 3b — own data, no runtime dep). Turns `golem bench cost` into real money instead of reference baselines; enables correct context-limit warnings. | Must not fight Decision 49: ids still print **verbatim**. The catalog adds price/context, never a prettified name. |
| **R8.9** | **Change ledger: checkpoint / revert.** Opt-in shadow git refs — **not** real commits (repo rule: commit only when asked). Lets the model *discard* a failed attempt instead of spending context repairing it; gives `/undo` parity. | Opt-in; never touches the user's branch or index without an explicit act. |

### R9 — ecosystem

| # | Task |
|---|---|
| **R8.11** | **Plugin surface**, per Workstream P: third-party **pipeline stages**, **MCP tools**, and **redaction rules** without forking. Redaction rules especially — every org has private key formats. Adoption feature, not a token feature. |

### Spikes (some should be rejected)

| # | Spike | Expectation |
|---|---|---|
| **R8.S1** | ~~**Tool-schema shrinking** — §89's own finding: ~2900 of ~3847 tokens are `input_schema`, not prose. Continue Workstream B with `golem bench tools` already built.~~ — **REJECTED 2026-07-30 (§100).** Two premises failed. (1) §89's ~2900 was an artifact of subtracting descriptions from the `listTools` total; Golem's input schemas are **~1,128**, the remainder being `outputSchema` + MCP metadata that **Claude Code never forwards**. (2) §95's 18.8k ceiling is **93.9% client built-ins** — Golem's whole share is **1,130 tokens, 0.8% of a 139k request**, and one built-in (`Workflow`, 5,264) is 4.7× it. Three transforms were built and gated anyway (schema-aware render + a new **argument-construction** harness that can veto); their flat results are an instrument limit, not a pass. Even the provably-invisible `schema-meta` is worth **~72 tokens** on the wire — 0.05%, for mutating a cached prefix. What shipped is the ledger's per-definition decomposition, so this is not promoted a fourth time on an aggregate. Debrief `2026-07-30-r8.s1-tool-schema-shrinking.md`. | ~~Best odds of the three.~~ Wrong: the accuracy risk was never the binding constraint — **ownership** was. |
| **R8.S2** | **System-prompt slimming** — Pi attributes token efficiency to a minimal system prompt; Golem *can* rewrite `system` (Decision 52 already appends to it). | **Low odds, expect no.** Removing prefix bytes saves cache-*read* (0.1×) but costs one re-prefill; net positive only over long sessions, and behaviour risk is high. Measure, then almost certainly decline. |
| **R8.S3** | **Session tree / branch-and-relaunch** — Pi's `/tree`. Golem sees every request, so it can record the conversation as a tree. | Half-feasible. Decision 37's actuation limit stands: a proxy cannot drive the interactive TUI. Ship the *recording* + a `golem session tree` view; leave relaunch to `claude -p --resume`. |

## Sequencing

```
Workstream P   P: tier policy as a Decision + the two P-audit fixes
               P2: `golem ext` manifest + list/status (read-only first)
               P3: Headroom worker → passthrough; then P3a, P3b (harness-gated)
R8a            R8.1 → R8.2 → R8.3 → R8.4 → R8.12
R8b            R8.5 (repo map) → R8.6 (LSP)      — one `code` tool, modes not tools
R8c            R8.7 harness → decide → wire or reject
R8d            R8.10 → R8.8 → R8.9
R9             R8.11 + spikes S1–S3
```

R8a first because it costs little and it is the only way the rest can claim
numbers instead of hopes. Workstream P before any of it, because it is prose and
it removes an argument from every later row.

## Open questions (for `verification-notes.md`)

1. **Hook precedence between a rewriting hook and a denying hook — UNRESOLVED.**
   Verified 2026-07-30 against `code.claude.com/docs/en/hooks` (301 from
   `docs.claude.com/en/docs/claude-code/hooks`): PreToolUse hooks run **in
   parallel**, entries **merge** across settings levels, `permissionDecision` is
   `allow|deny|ask|defer`, and `updatedInput` under `hookSpecificOutput`
   **replaces a tool's arguments before it runs**. What the docs do **not**
   state is the precedence when parallel hooks return conflicting decisions —
   e.g. RTK returning `updatedInput` for a Bash rewrite while Golem's hook
   returns `deny` for snooze/coder-first/autonomy. Golem's PreToolUse is
   registered with **no matcher** (`src/cli/init.ts:704`), so it fires on every
   Bash call and this interaction is live for any user who installs both.
   **Assert it in a test; do not trust it.**
2. **How much of R8.2's dedup opportunity actually exists in real traffic?**
   Measure before building: count near-identical tool-result blocks per session
   from the proxy's own view.
3. **Does the repo map actually displace reads,** or does the model read the file
   anyway? This is R8.5's gate, and the honest answer may be "partially."
4. **RTK dogfooding observation** (no formal A/B required, per the user): run
   `rtk init -g` for a period, and record in `verification-notes.md` §90 what
   Golem's *real* billed-usage telemetry shows against RTK's `bytes/4`
   estimates. Cheap, and it is the most credible sentence available for the
   public README — it tests the honest-observability claim on a third party's
   numbers rather than Golem's own.

## Deliberately out of scope

TUI / desktop / IDE agent clients · sub-agent orchestration · plan mode ·
session sharing and gists · themes and keybinds · a competing edit-apply harness ·
a curated model marketplace · **rebuilding RTK's Bash filters**. All of these are
the harness's job, or someone else's, and Claude Code already does most of them.

**Golem's scope discipline is its differentiator.** All four reviewed projects
compete to *be* the harness; Golem is the only one that sits under one and can
see the actual bytes. The positioning sentence for R8 is:

> *We see the whole request, so we can deduplicate it, answer it locally, strip
> its secrets, and tell you what it actually cost.*

None of the four can say that.

## Related

- Spec: Decision 22/32 (universal pre-LLM processor), 23 (situational
  compression), 28 (wiki-first), 31 (slider never engages the model), 37 (no TUI
  actuation), 49 (verbatim model ids), 52 (compression + brevity dials).
- `verification-notes.md` §54 (net-of-cache), §88 (tools-block census), §89
  (tool-selection harness — shrinker rejected).
- Wiki: `[[Compression]]`, `[[Slider Levels]]`, `[[Tool Search]]`,
  `[[Knowledge Base]]`, `[[Architecture]]`.
