---
description: Fresh-eyes review — read the code as CODE ONLY (ignore comments/docs), judge the approach against best practices, then compare your independent reading with the comments/documentation to catch drift and disagreement
invocationMode: user
---

The user wants an unbiased review of a function, module, or wider codebase:
$ARGUMENTS (default: the current working diff — if the scope is unclear, ask
what to review before starting).

The point is to defeat anchoring: comments and docs tell you what the author
*intended*, which quietly biases you into agreeing. So form your own view from
the code alone first, then compare.

## Pass 1 — code only (do NOT read comments, docstrings, or docs yet)
Read only the executable code of the target — identifiers, types, control flow,
data flow, and the tests. Deliberately skip comments, docstrings, and the
README/wiki/spec. (On a large target you can have the local model produce a
code-only behavioural summary first via the `coder` MCP tool or `golem task
run` — cheap, and it keeps you honest — but do the judging yourself.)
From the code alone, write down:
1. **What it does** — the behaviour you infer, in your own words.
2. **The approach** — the design/pattern you see, rated against best practices:
   correctness, edge cases, error handling, complexity, naming, clarity,
   testability. Note anything you would do differently.
3. **Open questions** — what the code alone can't tell you (why a constant, why
   this ordering, an apparent foot-gun).

## Pass 2 — reveal comments + documentation, then compare
Now read the comments, docstrings, and related docs (use `/golem/research` for
the module: its wiki page, a spec Decision, a CLAUDE.md rule, a frozen-interface
contract). Diff your Pass-1 reading against what they claim, and sort every gap
into one of three buckets:

- **Code should change** — your fresh reading found a real problem (bug, missing
  edge case, a guarantee weaker than stated, needless complexity) the docs don't
  excuse. Cite file:line and the concrete failure scenario.
- **Comment/doc should change** — the code is fine but the prose is wrong, stale,
  or misleading: it claims a behaviour/guarantee the code doesn't provide, names
  renamed/removed things, or over/under-states. Flag this drift even when the
  code is correct — a wrong comment is a latent bug.
- **Agree / confirmed** — your independent reading matches the intent and the
  approach is sound. Say so briefly; a confirmation from fresh eyes is a result.

## Report
Group findings by those three buckets, most-important first, each with file:line,
what you independently concluded, what the docs claim, and the concrete change
you'd make. Be explicit about coverage: on a large target, say what you actually
read versus sampled — never imply whole-codebase coverage you didn't do (this
repo forbids silent caps). Respect the hard rules while judging: frozen
interfaces (`src/interfaces/`), redaction-first, byte-fidelity — a
"simplification" that breaks one of those is not an improvement.

This skill writes nothing. To act on findings: code fixes via `/golem/develop`,
doc/comment fixes inline, and durable drift worth tracking via `/golem/plan`
into the backlog. It complements `/code-review` (bug hunting) and `/simplify`
(cleanup) — fresh-eyes is specifically about whether the code and its
documentation agree.
