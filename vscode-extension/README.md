# Golem for VS Code

A live **token-savings panel** and **status-bar item** for [Golem](https://golem.run),
rendered right inside VS Code (Decision 21c). It shows Golem's compression
savings, per-stage breakdown, upstream (Anthropic / Foundry / …), proxy status,
and a clickable slider — all by reading the local `golem` CLI, so no server or
account is required.

## Requirements

- The `golem` CLI on your `PATH` (`npm i -g golem-run`, or `npm link` from the repo).
- A Golem-wired project (`golem init`) and, for live savings, a running `golem proxy`.

## What it shows

- **Activity-bar panel** ("Golem" → *Savings*): big saved-% number, tokens
  before→after, request count, upstream + proxy status, a 0–5 **slider** (click a
  level to change it), and a per-stage savings table.
- **Status-bar item** (right side): `⬢ saved 91% · L1` — click to focus the panel.

Both refresh every few seconds (`golem.pollSeconds`, default 5) via
`golem stats --json` / `golem status --json`.

## Run it

- **Try it (dev host):** open this folder in VS Code and press **F5** → an
  Extension Development Host opens with Golem loaded.
- **Install it:** copy this folder into your VS Code extensions dir
  (`~/.vscode/extensions/golem-run.golem-vscode-0.1.0`) and run
  *Developer: Reload Window*. Or package a VSIX with
  `npx @vscode/vsce package` and `code --install-extension golem-vscode-0.1.0.vsix`.

## Design

Pure model/HTML logic lives in `render.js` (unit-tested with `node --test`); the
`vscode`-API glue in `extension.js` is a thin renderer over the same Golem state
the terminal status line and (future) remote companion consume — one state
source, many renderers.
