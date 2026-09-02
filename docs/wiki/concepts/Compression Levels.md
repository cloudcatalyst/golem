---
title: Compression Levels
type: concept
tags: [pipeline, compression, brevity, redaction, adr-0004, decision-31]
sources: [src/interfaces/policy.ts, src/pipeline/brevity.ts, docs/decisions/ADR-0004-retire-the-slider.md, docs/plan/verification-notes.md]
created: 2026-08-20
updated: 2026-09-02
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

## What each brevity level does

Brevity is the **output** side and works differently from compression: it makes
no request smaller. It appends a fixed, marker-fenced directive to the request's
`system` block, and the model complies at generation time. Output tokens are
never cached and cost far more than cache-read input, so this is the one axis
prompt caching does not blunt — see [[Cache Observability]].

| level | replies read as |
| --- | --- |
| `off` | unchanged. The default. |
| `lite` | compressed register — no filler, hedging or preamble; full sentences kept |
| `full` | telegraphic — fragments expected, function words dropped |
| `ultra` | maximum compression — fragments only, minimum viable function words |

### What no level may do

Three clauses live in one shared tail, so they cannot be dropped from a single
level or drift between the three profiles:

1. **Verbatim payloads.** Code, commands, file paths, identifiers, URLs, quoted
   output, diffs and error text are reproduced in full, never paraphrased or
   reformatted. The reply's language never changes either.
2. **Prose style ONLY.** The directive may not change what the model does, how
   thoroughly, which tools it calls, or how many steps it takes. Omit words,
   never substance.
3. **Silence is not brevity.** Every profile bans self-narration, which is right
   for prose and wrong for a long agentic turn — it produces turns of pure tool
   calls where the user cannot tell whether anything is happening. So **one short
   progress line before a tool call is carved back out, at every level**: a
   fragment naming what is being done or was just found. It is a signal, not
   licence for the preamble the profiles removed — it may not restate the
   request, recap finished work, or offer further help.

Clause 3 is why `brevity.level full` no longer means a silent session. If you
want narration back in full prose, the dial is `off`; the progress line is kept
whatever the level.

### Setting it vs shipping it

Changing the **dial** takes effect on the next request, live, as above. Changing
the **directive text** is a code change: it needs a rebuild and a proxy restart,
and it invalidates the cached system prefix once — by design, since the prefix
must stay byte-stable at a given level or the cache would flap and cost more
than the stage saves. See [[Configuration Surfaces]] for which layer wins.

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

**docs-slider-drift-remainder (2026-08-22) closed the last known gap**: the
`golem wiki check` retired-identifier scan reached every prose page and
`README.md`, but not `docs/golem-spec.md` §1-8 or
`vscode-extension/README.md`, which still taught the retired slider. Both are
now in the scan's explicit allowlist and both are clean. The spec's own §9
Decisions Log is a dated record like this page's own history section above —
exempted by a heading-scoped rule (any prose at or after a `## … Decisions
Log` heading), not by weakening what counts as drift elsewhere on the page.
Deliberately still open: `src/dashboard/server.ts`'s `slider-level`/
`slider-name` DOM element ids (owned by R12.6) — an implementation detail, not
label text a reader sees, so the checker's job here is done even though the
identifier itself has one more home to lose.

Related: [[Compression]] · [[Redaction Stage]] · [[Configuration Surfaces]] ·
[[Architecture]]

[ADR-0004]: ../../decisions/ADR-0004-retire-the-slider.md
