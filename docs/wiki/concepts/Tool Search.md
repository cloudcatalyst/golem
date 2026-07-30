---
title: Tool Search
type: concept
tags: [tools, tokens, prompt-caching, proxy-fidelity]
sources: ["https://docs.claude.com/en/docs/agents-and-tools/tool-use/tool-search-tool", "docs/plan/verification-notes.md (§89)", "src/cli/init.ts", "tests/integration/proxy-tool-search.test.ts"]
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
~902 description tokens (~3847 including input schemas), so Golem alone sits on
the boundary — the aggregate with Claude Code's built-ins and other MCP servers is
what crosses it.

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

## Why Golem does not shrink the tools block itself

Measured and rejected, not merely deferred. `golem bench tools` A/Bs a candidate
transform against 27 labelled selection cases:

- whitespace normalisation saves **exactly zero** tokens (the descriptions have no
  redundant whitespace);
- trimming each description to its first sentence saves 56% of them and **triples
  false positives** — the model starts calling tools when none applies, because
  the trimmed text loses the "use it when…" qualifiers.

Full reasoning and the caveats on the local chooser: verification-notes §89. The
remaining headroom is the input schemas (~2900 tokens), not the prose.

Related: [[Compression]] · [[Slider Levels]] · [[Architecture]] · [[Web Cache]]
(how the doc page behind this note was fetched and cached).
