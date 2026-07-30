---
title: Tool Search
type: concept
tags: [tools, tokens, prompt-caching, proxy-fidelity]
sources: ["https://docs.claude.com/en/docs/agents-and-tools/tool-use/tool-search-tool", "docs/plan/verification-notes.md (§89, §100)", "src/cli/init.ts", "src/proxy/context-ledger.ts", "tests/integration/proxy-tool-search.test.ts"]
created: 2026-07-30
updated: 2026-07-30
---

# Tool Search

Anthropic's mechanism for loading tool definitions **on demand** instead of
sending them all into the model's context every turn. It matters to Golem for two
reasons: it is the one token saving that works on cached Anthropic traffic where
[[Compression]] cannot (Decision 23), and Golem sits on the request path, so
Golem can *break* it.

Verified GA against live docs on 2026-07-30 (verification-notes §89) — not beta,
no beta header.

## How it works

Two variants, both `_20251119`:

| variant | how Claude queries | limit |
|---|---|---|
| `tool_search_tool_regex_20251119` | writes Python `re.search` patterns | 200 chars |
| `tool_search_tool_bm25_20251119` | natural-language queries | 500 chars |

The flow: you put a search tool in `tools` and mark the rest
`defer_loading: true`. Claude sees only the search tool plus whatever you left
non-deferred; when it needs more it searches, the API returns up to 5 matches as
`tool_reference` blocks and expands them into full definitions itself.

Supported on Opus 5, Opus 4.6–4.8, Sonnet 4.5–4.6, Haiku 4.5. Opus 4.1 and
earlier do not support it.

## The three facts that surprise people

1. **`defer_loading` does not make the request smaller.** Every definition is
   still transmitted in full on every request — the API needs them server-side to
   run the search. The flag controls what enters the *context window*, not the
   wire. So the saving shows up in billed input tokens, never in request bytes.
2. **It does not bust the prompt cache.** Deferred tools are excluded from the
   system-prompt prefix, and discovered ones are appended *inline in the
   conversation* as references. The prefix is untouched. This is the opposite of
   what an in-proxy pruning scheme would do — see [[Compression]] on why the
   cached prefix is sacred.
3. **A deferred tool may not carry `cache_control`** (the API 400s). Put the
   breakpoint on a non-deferred tool. Likewise at least one tool must stay
   non-deferred, and it should be the search tool.

Anthropic's own threshold: worth enabling at **≥10 tools or >10k tokens** of
definitions; standard calling is better under 10 tools. Golem's own 11 tools are
~902 description tokens and ~1,128 of input schemas, which puts Golem alone under
the threshold — the aggregate with Claude Code's built-ins is what crosses it, and
per §100 that aggregate is **93.9% built-ins**.

### What Claude Code does is not this (observed, undocumented)

Fact 1 above describes the **API feature**. Claude Code's own MCP deferral looks
different on the wire (§100): the forwarded array carries an entry literally named
`DeferredToolPlaceholder` (51 tokens) plus a client tool `ToolSearch`, and **no**
`tool_search_tool_*` server tool at all. Only the tools already discovered in the
session appear as full definitions — 6 of Golem's 11, in the measured capture.

So Claude Code's deferral **does** shrink the wire, and an unused Golem tool costs
approximately nothing. Recorded as an observation, not a contract: it is the
client's internal behaviour, it is undocumented, and it may change. Golem's
obligation is unchanged either way — relay it faithfully.

## Who actually owns the tools block

Measured with the [[Context Ledger]] on a real 139,327-token request (§100):

| owner | tokens | share | tools |
|---|--:|--:|--:|
| client built-ins | 17,473 | **93.9%** | 18 |
| Golem MCP tools | 1,130 | 6.1% | 6 |

Within the block, **descriptions ~12,146 · input schemas ~5,947 · everything else
~510** — so on the wire prose outweighs schemas 2:1. The biggest single definition
is a client built-in, `Workflow`, at **5,264 tokens** (4,753 of them prose): 4.7×
Golem's entire contribution.

That `other keys` figure averages ~21 tokens per tool — just `name` and `type` —
which means **Claude Code forwards none of the MCP metadata** (`outputSchema`,
`title`, `annotations`, `_meta`) to the API. Golem's `listTools` output carries
~1,522 tokens of `outputSchema`; none of it is ever billed.

## Why Golem does not shrink the tools block itself

Measured and rejected twice, not merely deferred. `golem bench tools` A/Bs a
candidate transform against 27 labelled selection cases and reports the token
saving beside the accuracy delta.

**Descriptions (§89).** Whitespace normalisation saves **exactly zero** tokens (the
descriptions have no redundant whitespace); trimming each to its first sentence
saves 56% of them and **triples false positives** — the model starts calling tools
when none applies, because the trimmed text loses the "use it when…" qualifiers.

**Input schemas (§100).** §89 closed by naming the schemas as the remaining
headroom, on a figure (~2900) that turned out to be `outputSchema` plus MCP
metadata rather than input schemas. Three cumulative transforms were then scored
properly — with the schema *actually shown* to the chooser, and with a second gate
on **argument construction**, graded against the *original* schemas so a transform
cannot pass by relaxing the rules it is judged on:

| transform | schema tokens | selection | args valid | fields correct |
|---|--:|--:|--:|--:|
| `schema-meta` (drop `$schema`) | 1128 → 998 | 92.0% → 88.5% | 92.9% → 92.9% | 92.9% → 92.9% |
| `schema-validation` (+ bounds, `additionalProperties`) | 1128 → 854 | 92.0% → 92.3% | 92.9% → 92.9% | 92.9% → 92.9% |
| `schema-descriptions` (+ every property description) | 1128 → **357** | 92.0% → 92.3% | 92.9% → 92.9% | 92.9% → 92.9% |

The flat argument columns are **an instrument limit, not a clean pass**: they are
byte-identical in every mode, and the one failing case fails in both arms — the
model passes `k: 100` while `maximum: 50` sits in the schema it was shown. A 7B
coder model at temperature 0 answers from the prompt and the tool name, not from
schema annotations, so removing them changes nothing it does. That is evidence
about the chooser, not about the transform.

**Rejected on the arithmetic instead.** Even `schema-meta`, which drops a
JSON-Schema dialect URI and is provably invisible to any model, is worth **~72
tokens on the wire** across Golem's 6 forwarded tools — 0.05% of a 139k request, in
exchange for mutating a cached prefix. Not a trade worth making.

## Golem's job: relay it faithfully

`golem init` writes `ENABLE_TOOL_SEARCH=true` into `.claude/settings.json`,
because Claude Code **disables tool search by default behind a non-first-party
`ANTHROPIC_BASE_URL`** and re-enables it only if the proxy relays
`tool_reference` blocks correctly (verification-notes §12). So Golem opting you
in carries the obligation to not corrupt the flow — see [[Architecture]] §2 for
where in the pipeline this sits, and [[Slider Levels]] for what each level is
allowed to touch.

Guarded by `tests/integration/proxy-tool-search.test.ts`: byte-faithful
forwarding at levels 0/1, and preservation of `defer_loading`, the search-tool
`type`, `tools` ordering, and `cache_control` placement at every level. Fidelity
already held when the tests were written — nothing was broken — but it is now an
asserted invariant rather than an assumption.

Related: [[Compression]] · [[Slider Levels]] · [[Architecture]] ·
[[Context Ledger]] · [[Cache Observability]] · [[Web Cache]] (how the doc page
behind this note was fetched and cached).
