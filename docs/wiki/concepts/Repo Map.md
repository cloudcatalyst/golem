---
title: Repo Map
type: concept
tags: [tokens, knowledge, tree-sitter, tools, context]
sources: ["src/knowledge/repo-map.ts", "src/knowledge/tree-sitter-chunker.ts", "src/knowledge/repo-map-bench.ts", "src/hooks/post-tool-use.ts", "docs/plan/verification-notes.md (§101, §93, §95)", "docs/wiki/debriefs/2026-07-30-r8.5-repo-map.md"]
created: 2026-07-30
updated: 2026-07-30
---

# Repo Map

A whole-repo **signature skeleton**, ranked by an import/reference graph and
rendered to a token budget: the files that matter for a question, each with its key
definitions and their line numbers. Reached two ways — the `code` MCP tool
(`mode: "map"`), and the symbol skeleton attached to an oversized `Read` that the
PostToolUse digest swaps out.

Shipped as R8.5. Measured, not asserted: **+21.4 accuracy points for +57 tokens**
against a plain path list (§101).

## Why it exists

[[Context Ledger]] measured `Read` as the second-biggest tool consumer, and §93
established that ~83% of input cost is re-reading an already-cached context — so a
read avoided pays on every later turn, not once. `Read` is also the surface an
external Bash-output compactor structurally cannot reach (§90), which makes it a
bucket Golem owns rather than one it shares.

The claim a map makes is narrow and testable: *the model can name the right file
without opening three wrong ones.*

## How it is built

1. **Symbols.** `extractFileFacts` (in `src/knowledge/tree-sitter-chunker.ts`, the
   one module that touches `web-tree-sitter`) returns each file's definitions with
   one-line signatures, its reference identifiers, and its import specifiers.
2. **A graph.** An import edge per resolved specifier — `./x.js` resolves to `x.ts`,
   this repo's ESM convention — plus a reference edge for every identifier a file
   uses that **another file exports**, weighted `sqrt(occurrences)`. Only *exported,
   non-member* definitions are edge targets: a file-local `const body` cannot be
   referenced from another module, and counting the repo's hundreds of `body`
   identifiers as references to it floated test files above `src/interfaces/`.
3. **A rank.** Personalized PageRank by power iteration, deterministic. With a
   query the rank also drops its damping factor (more mass stays on the query) and
   is scaled by the file's own query affinity — a teleport vector alone lost to hub
   modules. Affinity matches **word parts**, not substrings (`runPostToolUseHook` →
   run, post, tool, use, hook), weighted by rarity, so a question's function words
   earn nothing.
4. **A budget.** Files in rank order, best symbols per file, capped per file so one
   hub cannot eat the whole budget; what is dropped is stated in the footer.

## Byte stability is a hard constraint

The map renders into a cached prefix's neighbourhood, so an unstable rendering
re-prefills and is **strictly worse than no map at all** (§14). Everything in the
render path is a pure function of `(file contents, options)`: no clock, no
randomness, no scores printed, and every ordering carries a total tie-break (rank
then path; line then name). Same repo + same query ⇒ byte-identical map.

## The oversized-`Read` skeleton

When the digest replaces a huge `Read`, it prepends every definition in that file
with its **real** line number — offset-aware, so a `Read` starting at line 500
reports file lines, not excerpt lines. That is what makes the digest's advice
actionable: recovery becomes a `Read` of forty lines instead of an `expand` that
re-enters the whole original (§95 measured one `expand` at 6,356 tokens).

Per-file signatures are *not* a product surface of their own — RTK's
`read -l aggressive` covers that, and the R8 memo puts it out of scope. The
differentiated part is the whole-repo graph-ranked map.

## Modes, not tools

`code` is **one** tool with a `mode` parameter. §88/§100 measured tool definitions
as a permanent per-request bill (Golem's whole share is ~1,130 forwarded tokens),
so R8.6's LSP surfaces will be modes of this same tool rather than four new ones.
`code` itself costs ~262 forwarded tokens (~101 description + ~161 schema).

## Degradation and control

tree-sitter is a tier-2 optional dependency ([[Managed Tools]], Decision 53).
Absent, the tool answers "no repo map available: …" and a swapped `Read` keeps its
plain head/tail digest — a no-op, never an error path. Both halves are opt-out:

| setting | default | what it gates |
|---|---|---|
| `knowledge.repo_map_enabled` | on | registering the `code` tool at all |
| `knowledge.read_skeleton_enabled` | on | the skeleton on an oversized `Read` |

## The gate

`golem bench map` — cost census always, and with `--score` an A/B of the map
against the plain path list on 22 hand-labelled retrieval cases. It reports token
cost **beside** accuracy (Decision 52's rule), names the cases each arm won, counts
a model failure as an excluded error rather than a wrong answer, and refuses a
verdict when excluded errors could flip the sign. It also reports labelled paths
that no longer resolve, so the case set fails loudly when it rots.

**Still open:** whether a map *displaces* reads or the model reads the file anyway
(the R8 memo's open question 3). The harness measures naming, not displacement;
that needs live traffic.

## Related

[[LSP Bridge]] — the other half of the same tool: the map says what exists, the
language server says what refers to what.

[[Context Ledger]] · [[Knowledge Base]] · [[Compression]] · [[Tool Search]] ·
[[Managed Tools]] · [[Architecture]]
