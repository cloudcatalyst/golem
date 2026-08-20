---
title: ADR-0004 — Retire the slider; compression and brevity are the only dials
type: adr
tags: [r11, config, slider, compression, brevity, redaction, honesty]
sources: [src/interfaces/policy.ts, src/config/schema.ts, docs/golem-spec.md, docs/plan/tasks/R11.1.md, docs/plan/verification-notes.md]
created: 2026-08-20
updated: 2026-08-20
---

# ADR-0004 — Retire the slider; compression and brevity are the only dials

**Status: ACCEPTED (2026-08-20).** Supersedes the *slider* half of spec Decision
30 (the 0–3 scale) and Decision 52 (the slider as a preset over two dials). It
does **not** touch Decision 31 (semantic gating on caching upstreams) or
Decision 23 (the compression economics), both of which survive unchanged.

## Context

The user, reading their own status surfaces on 2026-08-20:

> I'm confused about what the slider means vs compression. I feel we don't need
> the slider any more.

They are right, and the confusion is designed in. Decision 52 made the slider a
**preset over two dials** — compression and brevity — each of which can be
pinned. So two controls describe one thing, and every surface must render both or
mislead. Worse, Decision 31 gates the lossy stages OFF on a prompt-caching
upstream, which is the default, so **levels 2 and 3 are inert there**. Live, on
the reporter's own machine:

```
Slider: level 3 (aggressive) → effectively 1 (lossless)
Dials:  brevity full (pinned) · compression 3→1 (auto — follows slider 3)
  ⚠ level 3 (aggressive) is inert here: the lossy semantic and context-substitution
    stages are off on a prompt-caching upstream (Decision 31 …), so this behaves
    as level 1 (lossless)
```

Three rows and a warning to say *the number you set does nothing*. The surfaces
are being scrupulously honest (R10.24 made the status LINE honest about the same
gap); the **control** is what is wrong. A number that needs a paragraph is not a
control, it is a quiz.

## Decision

**One control per thing.** `slider.level` is deleted. Two dials remain, each set
directly, with no `auto`/preset state:

| control | values | what it governs |
| --- | --- | --- |
| `compression.level` | `off` · `1` · `2` · `3` | how much of the request pipeline runs |
| `brevity.level` | `off` · `lite` · `full` · `ultra` | how terse the model's own output is |

`compression.level: off` is a **new, nameable state**: redaction runs, nothing
else does. It existed before only as an accident of the Decision 56 bypass shim,
reachable by stopping the proxy rather than by asking for it.

### Where level 0 goes — and why not into a dial

Old level 0 was "Golem does NOTHING, not even redaction": the single exception to
the redaction hard rule (CLAUDE.md; Decision 30, a USER decision). It must not
become `compression: off`. Compression and redaction are different guarantees,
and folding them into one word is exactly how a user turns off **redaction**
while believing they turned off **compression**.

It also must not become the existing `golem on`/`golem off` toggle, which was the
tempting answer: that toggle is *in-process only* (`#pipelineEnabled`, flipped by
a POST to `/__golem/pipeline/<enabled>`), so it silently reverts to ON at every
proxy restart — and the proxy restarts on project open (the SessionStart hook)
and on every `gateway use`. A durable bypass cannot live in a flag that forgets.
(That the toggle forgets is its own honesty bug; noted, not fixed here.)

So it gets its own persisted setting, `proxy.bypass_all` (default `false`),
carrying forward every rail level 0 had: never the default, surfaced loudly
wherever it is active, and **CLI-only** — a tool call must not be able to switch
redaction off (R8.33).

### The invariant this buys

After this change **no value of any dial can disable redaction.** The stage
table's rows all have `redaction: true`; the only redaction-free path is the
explicit `bypass_all` short-circuit, which never consults the table. Today the
opposite is true: a stored `slider.level: 0` — one integer in a settings file —
turns redaction off, and `MIN_ACTIVE_COMPRESSION_LEVEL` exists solely to stop a
*pinned* dial doing the same by accident. That clamp disappears along with the
scale it was defending.

This is the part of the change that is not merely tidier: **a safety property
moves from "defended by a clamp" to "unrepresentable".**

## Consequences

- **Migration, not reinterpretation.** `slider.level` is resolved through today's
  own `resolveCompressionLevel`/`resolveBrevity` and written out as the two
  explicit values it currently produces, so no project changes behaviour by
  upgrading. A pinned dial already won over the preset; running the real
  resolvers is what guarantees the pin keeps winning.
- **`0 → bypass_all`.** A project sitting at level 0 migrates to
  `proxy.bypass_all: true` with both dials `off`, and every surface says so
  loudly. Nothing about that install gets quieter.
- **Surfaces lose a control**: `golem slider`, the `level` MCP tool,
  `golem.setSlider` in VS Code, the `slider` block in `status --json`, and
  `level` in telemetry events.
- **"Set" vs "ran" survives.** `resolveEffectiveCompression` (§103) stays: a
  caching upstream still degrades 2/3 to lossless, and both status surfaces must
  keep saying which is which. Retiring the slider removes a *needless*
  discrepancy, not the real one.
- **Old telemetry keeps its meaning.** Historical `level` values describe what
  actually ran and are not rewritten; the rollup reports the compression level
  going forward. No row is reinterpreted in place.
- **A clean break, no deprecation window.** The first npm publish (R7.5) has not
  happened, so there are no installs outside this machine to keep compatible. If
  that changes before this lands, revisit.

## Alternatives rejected

1. **Keep the slider, improve the reporting.** Cheapest, and it was offered. It
   leaves two controls for one thing and keeps every surface explaining why the
   headline number is inert. Rejected by the user, correctly: the explanation was
   already good and the confusion survived it.
2. **Keep `slider.level` internally as a one-shot preset** (`golem slider 2`
   writes both dials and forgets). Hides the duality instead of removing it, and
   leaves a schema leaf whose only purpose is to be applied and ignored.
3. **Fold level 0 into `compression: off`.** Rejected above — it makes
   redaction-off reachable by a word that does not mention redaction.
