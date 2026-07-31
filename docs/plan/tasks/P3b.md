---
task: P3b
title: Point golem bench tools at caveman-shrink rather than rebuilding it
state: done
owner: agent
size: S
design: docs/plan/proposals/r8-context-economy.md (Workstream P, P3b); verification-notes §89, §100
gate: The existing harness decides. Either it clears the bar and becomes a managed ext they maintain, or Golem publishes a reproducible negative.
depends_on: []
touches: [src/tools/]
created: 2026-07-30
updated: 2026-07-31T04:22:05.071Z
---

## Goal

Caveman ships `caveman-shrink`, MCP middleware that compresses tool descriptions. That
is the same job Workstream B measured and **rejected**. Rather than rebuild it, point
the harness at their implementation and publish the number.

## Why this is cheap and worth doing anyway

The gate already exists: `golem bench tools` with 27 labelled selection cases, plus
(since R8.S1) a schema-aware render and an argument-construction harness that grades
against the original schemas and can veto.

## Read §100 before starting — it changes the expected value

R8.S1 measured that **93.9% of the tools block is the client's own built-ins**, and
Golem's whole share is **1,130 tokens — 0.8% of a 139k request**. So even a perfect
tool-description shrinker has ~1.1k tokens to work with, and §89 already showed that
first-sentence trimming triples false positives. **The honest prior is that this
fails**, and the deliverable is a reproducible negative that closes the question.

Expect the instrument limit §100 hit, too: a 7B local chooser at temperature 0 ignores
schema annotations, so a flat result is evidence about the chooser rather than a pass.

## Practical note

§87 warns that `caveman-shrink`'s install and config are **undocumented on the
README** — fetch the npm page before designing against it. A previously-fetched page is
served from the webcache free and offline (Decision 42).

## Out of scope

Rebuilding the shrinker. Reopening R8.S1 (§100 closed it). Vendoring any of their code.

## Outcome

Reproducible negative published (§107): caveman-shrink saves 53 of 1,089 description tokens (4.9%) with no accuracy change on 27x3 cases. Not adopted, not vendored — the harness gained --shrink ext-caveman-shrink, resolved from the user's own install.
