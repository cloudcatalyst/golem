---
title: Model ids display verbatim — the friendly-label prettifiers are gone
type: debrief
tags: [r6, cli, statusline, vscode, providers, honesty]
sources: [src/providers/model-display.ts, src/cli/statusline.ts, src/cli/status.ts, vscode-extension/render.js, docs/golem-spec.md]
created: 2026-07-29
updated: 2026-07-29
---

# 2026-07-29 — one line, two naming schemes

R6.2 gave the compact surfaces a set of *friendly* model labels: a raw id folded
into a marketing family + version. `claude-opus-4-8[1m]` rendered as `Opus 4.8`,
`qwen2.5-coder:7b` as `Qwen 2.5`. Fixed under [spec Decision 49] (USER
decision).

Related: [[Architecture]] (the status/statusline surfaces), [[Slider Levels]]
(the destination one-liner those surfaces render).

## The defect

The prettifier only ever worked for one vendor. Claude ids have a family and a
version to fold into; nothing else does — so a translating account's `kimi-k3`,
an OpenRouter `poolside/laguna-s-2.1:free`
([[OpenRouter reclassified to case (b) — five stacked defects]]),
and every Ollama drafter fell through the helper unchanged. The result was a
single line carrying two naming schemes at once:

```
⬢ Golem · Lossless → local (Qwen 2.5) + anthropic (claude-opus-5)
```

The `claude-opus-5` generation is what made it obvious. Earlier the upstream
side happened to be a Claude id, so both segments *looked* prettified and the
asymmetry hid; as soon as one segment showed a raw id the other read as a
different kind of thing entirely.

## The fix

Every surface prints the model id as configured or as served — statusline
destination, `golem status`'s Upstream line, the VS Code status bar, hover
summary and panel:

```
Upstream: anthropic · model claude-opus-5
⬢ Golem · Aggressive → anthropic (claude-opus-5)
```

Three helpers were **deleted, not deprecated** — `friendlyModelLabel`,
`friendlyModelVersionLabel`, `localModelVersionLabel`, plus the four mirrors in
`vscode-extension/render.js` (two of which were already dead code, exported only
to be tested). A prettifier covering one vendor out of many is worse than none:
left in the tree it invites the inconsistency straight back. `model-display.ts`
now carries the *reason* there is no prettifier, so the next person reaches for
it deliberately or not at all.

One consequence worth noting: `renderUpstream` had a comparison arm reading
`friendlyModelLabel(served) !== dflt && served !== dflt`, which existed only to
stop the label itself from registering as a divergence between the configured
default and the served model. With verbatim ids on both sides it collapses to a
plain `served !== dflt`.

## Why verbatim is the honest default

The raw id is the string the user typed into config — `golem account add
--model`, the `src/inference/catalog.ts` tier entries — so it is the label they
can act on. It also matches what Golem already does with telemetry: stored data
keeps the raw id (honest observability), and the friendly form only ever existed
at render time. Removing it makes the rendered line agree with the stored record.

## Verification

`npx tsc --noEmit`, `npm run lint`, `npm run format:check` clean; `npx vitest
run` 1428 passed; `node --test` in `vscode-extension/` 32 passed. Confirmed live
after `npm run build` + `golem proxy restart` (output above). CI cannot gate
this — Actions are still blocked on account billing — so the gate was local.
