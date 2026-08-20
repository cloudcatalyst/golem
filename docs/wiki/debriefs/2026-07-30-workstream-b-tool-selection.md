---
title: 2026-07-30 — Workstream B: the tools-block gate, and housekeeping
type: debrief
tags: [tokens, tools, prompt-caching, testing, diagrams]
sources: ["docs/plan/verification-notes.md (§88, §89)", "docs/plan/BACKLOG.md", "src/tools/", "tests/integration/proxy-tool-search.test.ts"]
created: 2026-07-30
updated: 2026-07-30
---

# Workstream B: the tools-block gate, and housekeeping

Closed the two unblocked streams left on the board after Decision 52: Workstream
B (the ~900-token tools block, parked by §88 for want of a harness) and the
housekeeping backlog rows. Everything else outstanding is blocked on hardware, a
credentialed act, or a user deferral — see [[Architecture]] and the ROADMAP.

## The headline: the gate says no, and that is the deliverable

§88 parked the tools-block shrinker honestly: "every candidate transform is
either near-zero gain or a change to instructions the model reads, which is a
correctness question with no harness to measure it." The point of this batch was
to build the harness and let it decide. It decided **against**.

| transform | tokens | accuracy | false positives | verdict |
|---|---|---|---|---|
| `whitespace` (control) | 902 → 902 (**0 saved**) | 88.9% → 88.9% | 2 → 2 | no-material-change |
| `first-sentence` | 902 → 397 (56% saved) | 88.9% → **81.5%** | 2 → **6** | **REGRESSED** |

Two findings worth more than the verdict itself:

- **The control saves nothing — not "almost nothing".** §88 estimated whitespace
  normalisation as low-value. It is *zero*-value: these descriptions are built
  from concatenated string literals with single spaces, so there is no redundant
  whitespace in them to collapse. A whole transform class evaporated on contact
  with measurement.
- **The failure mode is over-triggering, not mis-selection.** Trimming
  descriptions did not confuse the model about *which* tool to pick; it made it
  pick a tool when it should have picked none (false positives tripled,
  abstentions went to zero). The trimmed text loses the "use it when…" qualifiers.
  A harness that only scored "right tool for the right prompt" would have passed
  this transform. The `expected: null` cases — 19% of the set — are what caught it.

Reproducible at 4 repeats with identical accuracy figures, because the chooser
runs at temperature 0.

## The bigger finding: we were measuring the wrong half

The census reads the live MCP server rather than a transcription, and it reports
what §88's hand count did not: **full definitions are ~3847 tokens, 4.3× the ~902
of descriptions.** The input schemas are most of the tools block. Prose
shortening was attacking the smaller half the whole time.

## And the risk that was actually urgent

Verifying native tool search against live docs (§89a) turned up something more
pressing than any shrinker. `golem init` writes `ENABLE_TOOL_SEARCH=true`, and
Claude Code disables tool search behind a non-first-party base URL, re-enabling it
only if the proxy relays `tool_reference` blocks correctly (§12). So Golem opts
users into a mechanism whose correctness depends on Golem — and **nothing asserted
it worked**. `defer_loading` appeared nowhere in the repo.

`tests/integration/proxy-tool-search.test.ts` now covers it. Fidelity already
held: no bug, no fix, just an assumption converted into a guarded invariant. That
is the boring, correct outcome, and it was worth going to look.

Three live-doc facts that corrected our assumptions (full detail in §89a):
`defer_loading` does **not** shrink the request (every definition is still
transmitted; the flag governs the context window); it does **not** bust the
prompt cache (deferred tools are excluded from the prefix, discovered ones append
inline); and a deferred tool may not carry `cache_control`. The §88 worry that
lazy loading must invalidate the cached prefix simply does not apply to
Anthropic's implementation — see [[Tool Search]].

## Housekeeping

- **Windows test flake (BACKLOG 2026-07-29) — fixed.** The 5s-timeout half was
  already gone (the global 20s `testTimeout`, §86c). The remaining half was the
  `ENOTEMPTY` race in `afterEach` cleanup. Node's `rm` defaults to
  `maxRetries: 0`, which is not survivable on Windows, so all **85** temp-tree
  deletes across **72** test files now share one retry-hardened options constant
  (`tests/helpers/tmp.ts`) rather than only the file that happened to be reported.
  Three consecutive full-suite runs green.
- **Two Mermaid diagrams (BACKLOG 2026-07-25) — added.** The two-proxy dogfooding
  split now leads [[Dogfooding Golem]]; task multiplexing and prompt translation
  are [[Architecture]] §6a/§6b, drawn from `src/tasks/multiplex.ts` and
  `src/prompt/translate.ts` rather than from memory. Both stick to the shape
  vocabulary the existing diagrams already render with — Mermaid is not
  machine-validated in this repo, so unusual syntax is an unnecessary risk.

## Lessons

1. **Build the instrument before the thing it measures, and test the instrument.**
   The harness's first real run reported 5 chooser "errors" that were actually
   correct abstentions — `JSON.parse('""')` returns a bare string, and the
   object-only branch dropped it. An untested instrument would have quietly
   discarded the abstention cases, which are the ones that caught the regression.
   Same shape as the 2026-07-17 judge bug: the measurement, not the feature, was
   broken.
2. **A fixture with invented numbers invents results.** The unit test's
   hand-written `descriptionTokens` disagreed with `estimateTokens`, making the
   lossless transform appear to save 3 tokens. Compute fixture values from the
   same function under test.
3. **"Blocked on a harness" is a fine place to stop, and a bad place to stay.**
   §88 was right to refuse to ship on the assumption that shorter means the same.
   But the gap between "we can't measure this" and "so we won't" is one batch of
   work, and crossing it turned a deferral into a decision.
4. **Fix the class, not the instance.** The flake was reported in one file and
   lived in 72.

## Follow-ups

- Input schemas (~2900 tokens) are the untouched majority of the tools block. The
  harness is already the gate if it is ever worth attacking.
- The tier-2 `classifier` model (`qwen2.5:7b`) is not pulled on this machine, so
  the run substituted `--role drafter`. `golem devices` lists a tier's *catalog*,
  not what Ollama has downloaded — a genuinely misleading surface, and the same
  trap as the 2026-07-17 judge bug.
- A Claude-tier chooser would make a clean verdict meaningful. Today a REGRESSED
  verdict is credible and a clean one is weak.

Related: [[Tool Search]] · [[Compression]] · [[Compression Levels]] · [[Architecture]]
