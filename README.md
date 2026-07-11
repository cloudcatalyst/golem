# Golem — a universal pre-LLM processing layer

**[golem.run](https://golem.run)** · npm `golem-run` · CLI `golem`

Local-first **TypeScript** proxy + unified MCP server that sits in front of
your LLM traffic and handles what shouldn't have to hit a model provider
first: **redaction** (secrets/PII stripped before anything leaves the
machine), **local tools** (vector knowledge base, tiered Ollama inference, CCR
expansion), **routing** (Claude, with Foundry/OpenRouter adapters extending
the same pipeline), and **honest observability** (real billed-token telemetry,
not estimates). Compression (Golem-native lossless stage; optional
[Headroom](https://github.com/headroomlabs-ai/headroom) Python sidecar for
ML-heavy stages) is part of the pipeline too, but it's *situational* — it pays
off on non-caching upstreams, not on Anthropic's cached traffic, where the
honest number today is ~0% (see `docs/verification-notes.md` §54).

Claude Code is Golem's flagship, most-verified integration — byte-faithful
proxying, native MCP tools, `/golem/*` skills — with the same pipeline
designed to extend to other gateways. Native Windows, macOS, and Linux.

> Formerly "EOL / Edge Offload Layer" — renamed Golem 2026-07-03 (spec Decision 19).

- **Spec:** [docs/edge-offload-spec.md](docs/edge-offload-spec.md) (source of truth)
- **Plan:** [docs/plan/IMPLEMENTATION_PLAN.md](docs/plan/IMPLEMENTATION_PLAN.md)
- **Live-doc findings:** [docs/verification-notes.md](docs/verification-notes.md)
- **Agent guidance:** [CLAUDE.md](CLAUDE.md)
- **Workstream briefs:** [docs/plan/workstream-briefs/](docs/plan/workstream-briefs/)
- **Project wiki:** [docs/wiki/](docs/wiki/) (knowledge base — see [WIKI.md](docs/wiki/WIKI.md))

## Development

Node ≥ 22.

```sh
npm ci
npm run check   # lint (Biome) + typecheck (tsc --strict) + tests (vitest)
```

Interfaces in `src/interfaces/` are frozen contracts — see CLAUDE.md before
changing anything there.
