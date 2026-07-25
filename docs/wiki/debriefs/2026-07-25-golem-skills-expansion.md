---
title: 2026-07-25 — Golem skills expansion
type: debrief
tags: [skills, guidance, close-out, tokens, review]
sources: [src/cli/skills.ts, tests/unit/cli/skills.test.ts]
created: 2026-07-25
updated: 2026-07-25
---

# 2026-07-25 — Golem skills expansion

## What shipped
Grew the `/golem/*` skill surface from 8 to 18 (all in `src/cli/skills.ts`'s
`P0_SKILLS`, installed by `golem init`), turning repeated team practices and the
token-efficiency findings into invocable playbooks:

- **Close-out anchors:** `/golem/verify` (the green-check gate judged by **exit
  code**, targeting the recorded 3× CI-break pattern) and `/golem/ship` (the full
  CLAUDE.md batch close-out in order).
- **Wrap existing flows:** `/golem/promote` (the missing capture→distill→**promote**
  leg), `/golem/upstream` (account switch the correct way — not the model picker),
  `/golem/debrief` (author the dated debrief — used to write this page).
- **Co-developer practice:** `/golem/park` (document-and-park, manual counterpart
  to the enforced snooze gate) and `/golem/triage` (local-first routing before
  paid tokens).
- **Token-article-driven:** `/golem/cache-health` (prompt-cache hit-rate +
  cache-busting, honest about the pending backlog tool) and
  `/golem/context-hygiene` (narrow-over-expand, CCR refs, don't re-read).
- **`/golem/fresh-eyes`** — a two-pass anti-anchoring review: read code-only
  first, form an independent best-practices judgment, then diff it against the
  comments/docs and sort gaps into *code should change* / *comment-doc should
  change* / *agree*. Complements `/code-review` (bugs) and `/simplify` (cleanup)
  by testing whether code and its documentation actually agree — high-value in a
  repo where frozen-interface contracts and hard rules live in comments/docs.

## Decisions / notes
- The **coder-first PreToolUse gate** fired on the `skills.ts` edit; proceeded
  under the rule's explicit **config/JSON/Markdown exemption** — the payload is
  Markdown skill-playbook prose in template literals, not program logic, and
  drafting playbook text through a local model would degrade it. See
  [[Guidance Rules]].
- The two token *tools* (lazy tool-def loading, cache-hit observability) stay
  BACKLOG proxy work; `/golem/cache-health` is the thin reader over the latter.

## Verification
`tsc --noEmit`, Biome lint, `format:check`, `npm run build` → all exit 0; full
vitest **1324/1324** (3 apparent failures were 5s-timeout flakes under parallel
load — all pass with a realistic timeout). Added 6 unit tests: verify exit-code
framing, ship checklist order, upstream/park guards, fresh-eyes two-pass, and a
registry check. The `cli-init` test iterates `P0_SKILLS`, so new skills install
and verify automatically.

## Follow-up
New skills are compiled to `dist` but not yet live in this repo — a global
reinstall + `golem init` (or the deploy-local flow) installs them into
`.claude/skills/golem/`. Prune/rework the set as it's exercised.

See also [[Architecture]] and [[Wiki-First Knowledge]].
