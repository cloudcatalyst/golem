# Golem — edge offload for Claude

**[golem.run](https://golem.run)** · npm `golem-run` · CLI `golem`

Local-first **TypeScript** proxy + unified MCP server that cuts Claude token
spend (Golem-native lossless compression stage; optional
[Headroom](https://github.com/headroomlabs-ai/headroom) Python sidecar for
ML-heavy stages) and gives Claude local tools — vector knowledge base, tiered
Ollama inference, CCR expansion, telemetry — on developer-grade hardware.
Native Windows, macOS, and Linux.

> Formerly "EOL / Edge Offload Layer" — renamed Golem 2026-07-03 (spec Decision 19).

- **Spec:** [docs/edge-offload-spec.md](docs/edge-offload-spec.md) (source of truth)
- **Plan:** [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)
- **Live-doc findings:** [docs/verification-notes.md](docs/verification-notes.md)
- **Agent guidance:** [CLAUDE.md](CLAUDE.md)
- **Workstream briefs:** [docs/workstream-briefs/](docs/workstream-briefs/)

## Development

Node ≥ 22.

```sh
npm ci
npm run check   # lint (Biome) + typecheck (tsc --strict) + tests (vitest)
```

Interfaces in `src/interfaces/` are frozen contracts — see CLAUDE.md before
changing anything there.
