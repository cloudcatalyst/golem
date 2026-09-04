---
title: Context Ledger
type: concept
tags: [tokens, observability, proxy, context]
sources: ["src/proxy/context-ledger.ts", "src/cli/context.ts", "docs/plan/verification-notes.md (§93, §95, §100)", "docs/wiki/debriefs/2026-07-30-r8.4-context-ledger.md"]
created: 2026-07-30
updated: 2026-07-30
---

# Context Ledger

`golem stats --context` — what the outgoing request is actually **made of**, bucket
by bucket, with the biggest blocks named and every `tool_result` attributed back to
the tool that produced it.

Shipped as R8.4; extended by R8.S1 with a per-definition decomposition of the
`tools` block.

## Why it exists

[[Cache Observability]] (R8.1) measured this project's real prompt-cache hit rate at
**98.4%**, with uncached input at 0.06% of billed input (§93). Weighted by rate,
**~83% of input cost is re-reading an already-cached context** — so the useful
question stopped being "did the cache hit?" and became "*what* am I paying to
re-read, turn after turn?"

Nothing could answer that. The client sees its own tool calls; the API sees tokens.
Only the proxy sees the whole `messages` array on every request. So the ledger is
the one thing in the stack positioned to say "61k of your context is one `Read` of
`dist/`" instead of "182k tokens in context" — the difference between aimed pruning
and guessing. It is what the `/golem-context-hygiene` skill reasons from; before it,
that skill reasoned blind.

## What it reports

- **Buckets**, exhaustive by construction: `tools`, `system`, `userText`,
  `assistantText` (which includes `tool_use` blocks — the assistant's own output),
  `thinking`, `toolResult`, `image`, `other`.
- **The biggest single blocks** (top 8), each labelled request-level or by message
  index.
- **`tool_result` tokens grouped by producing tool**, resolved by mapping
  `tool_use_id` back through the assistant turns in the same request. Without that
  pass the largest consumer of an agentic context is an anonymous blob.
- **The `tools` block decomposed** per definition: owner, description tokens, input
  schema tokens, everything-else tokens, and whether it carries `defer_loading`.
  Owner comes off Claude Code's `mcp__<server>__<tool>` namespacing — `golem`,
  another `mcp` server, or a client `builtin`.

## Design constraints worth knowing

- **No prompt content, ever.** Same standard as `cache-prefix.ts`: token counts,
  roles, block types, and tool *names* only. A tool name is a schema identifier, not
  user data. Tests assert that description and schema text never reach the state
  file.
- **Clock-free pipeline.** `ContextLedgerCore` is pure; the CLI layer stamps
  `capturedAt`. Same convention as `recordPipelineEvent` and for the same reason —
  the pipeline is under a standing obligation not to read the wall clock.
- **Latest-only, fail-open.** One atomic temp+rename write per request to
  `.golem/state/context-ledger.json`, no history: per-request history is already
  covered by the savings/usage events, and a durable write per request for a
  value only the newest copy of which is useful is a bad trade. Errors are ignored,
  exactly like `writeLimitState`.
- **Estimates, not a tokenizer.** `estimateTokens` (4 chars/token). Good enough to
  rank buckets; never quoted as a bill. The billed numbers come from the R1.1 usage
  sniffer.
- **Never written at level 0** — passthrough is a full bypass, so there is nothing
  to record.

## What it has already changed

The instrument has redirected its own roadmap three times, which is the point of
building it rather than reasoning about context bloat from first principles.

| capture | finding | consequence |
|---|---|---|
| §95 | `tools` block measured **18,827 tokens** — the largest single block, ~5× the hand-count in §88 | promoted tool-schema shrinking (R8.S1) |
| §95 | **`Bash`** is the biggest tool consumer (36,968 tokens / 132 results) | quantified the [[Managed Tools]] tier-3a case for RTK; confirmed R8.3's descoping |
| §95 | one `expand` cost **6,356 tokens** | the `golem-ccr-refs` rule's "expanding costs the tokens the swap saved" is now measured, not asserted |
| §100 | of the block, **93.9% is client built-ins**; Golem's own share is 1,130 tokens (0.8% of the request) | **closed R8.S1 as rejected** — see [[Tool Search]] |

Also notable and not yet actionable: thinking blocks were 54,074 tokens (17.6%) in
the §95 capture — a bucket nothing in Golem touches, and one that *cannot* be
touched at levels ≤1, since [[Compression Levels]] requires thinking blocks to pass
through byte-faithful. Anyone proposing to drop old thinking is proposing a
fidelity-rule change, not a tuning knob.

## Reading it honestly

It is **one capture of one conversation** — latest-only by design, so a snapshot
rather than a distribution. Sample `golem stats --context --json` over time if you
want a distribution. And a big number is not automatically a target: §100's lesson
is that a **ceiling is not a lever**, because most of the biggest block belonged to
somebody Golem may not rewrite.

Related: [[Cache Observability]] · [[Compression]] · [[Tool Search]] ·
[[Architecture]] · [[Compression Levels]] · [[Managed Tools]]
