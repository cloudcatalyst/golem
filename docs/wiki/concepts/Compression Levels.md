---
title: Compression Levels
type: concept
tags: [pipeline, compression, brevity, redaction, adr-0004, decision-31]
sources: [src/interfaces/policy.ts, docs/decisions/ADR-0004-retire-the-slider.md, docs/plan/verification-notes.md]
created: 2026-08-20
updated: 2026-08-20
---

# Compression Levels

Golem has **two dials**, set directly, and nothing above them:

| dial | values | what it changes |
| --- | --- | --- |
| `compression.level` | `off` · `1` · `2` · `3` | how much of the request pipeline runs |
| `brevity.level` | `off` · `lite` · `full` · `ultra` | how terse the model's own replies are |

```
golem compression 1     # lossless — byte-faithful
golem brevity full      # telegraphic replies
```

Both take effect **within a second**, on the next request — the proxy re-reads
them live. Neither needs a restart.

## What each compression level runs

| level | redaction | lossless | semantic | notes |
| --- | --- | --- | --- | --- |
| `off` | ✅ | — | — | redaction ONLY. Not a bypass. |
| `1` | ✅ | ✅ | — | byte-faithful; meaning preserved exactly. The default. |
| `2` | ✅ | ✅ | stale-turn drop | lossy; gated off on a caching upstream. |
| `3` | ✅ | ✅ | max | lossy; gated off on a caching upstream. |

**Every level redacts.** That is a property of the type, not a rule someone
remembered to enforce: no row of the stage table has `redaction: false`, so "a
dial turned redaction off" is not something the code can express. See
[[Redaction Stage]].

## The one exception: proxy.bypass_all

```
golem config set proxy.bypass_all true
```

Forwards every request byte-faithfully — **redaction included in what is
skipped**. It is never the default, it is settable only from the CLI (a tool
call must not be able to switch redaction off), and every surface says so loudly
while it is on.

It is deliberately NOT a value of `compression.level`. Compression and redaction
are different guarantees, and folding them into one word is how someone turns
off redaction believing they turned off compression.

## Set vs ran — the gap that is real

On a **prompt-caching upstream** (Anthropic, the default) Decision 31 gates the
lossy stages off, because rewriting mid-history content forfeits the cached
prefix — measured at ~9× more expensive if forced (verification-notes §103). So
levels 2 and 3 behave as lossless there, and every surface says which:

```
Compression: 3 (aggressive) → effectively 1 (lossless) — set by local
  ⚠ level 3 (aggressive) is inert here: the lossy semantic and context-substitution
    stages are off on a prompt-caching upstream (Decision 31)
```

## What happened to the slider

Until R11.1, `slider.level` (0–3) was a **preset over these two dials**
(Decision 52). Two controls described one thing, so every surface had to render
both or mislead — and on the default upstream the slider's top half was inert,
so its headline number needed a paragraph of explanation. A number that needs a
paragraph is not a control.

[ADR-0004] retired it. Existing projects migrate once, automatically: the stored
slider level is resolved through the retired resolvers' own logic and written out
as the two explicit values it was already producing, so **no project changes
behaviour by upgrading**. A pinned dial still wins; `slider.level: 0` becomes
`proxy.bypass_all: true`.

Also retired with it: the `level` MCP tool, `golem slider`, the `auto` state on
both dials, and R8.33's special case for refusing level 0 from a tool call —
there is no longer a level that could disable redaction, so there is nothing to
refuse.

Related: [[Compression]] · [[Redaction Stage]] · [[Configuration Surfaces]] ·
[[Architecture]]

[ADR-0004]: ../../decisions/ADR-0004-retire-the-slider.md
