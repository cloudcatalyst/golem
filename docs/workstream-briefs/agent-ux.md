# Workstream brief — agent-ux (WS-E: CLI, config, dashboard, P0)

Read `CLAUDE.md` first; it binds. Spec: `docs/edge-offload-spec.md` §5, §5.1,
Decisions 14, 16; plan §5 (you own most of the P0 DoD).
Live-doc facts you must honor: `docs/verification-notes.md` §5, §9, §11, §12, §13.
Work on branch `ws-e`; claim tasks by ID in PR titles (e.g. "E1: ...").

## Mission
The developer-facing shell: `npx eol init` one-command adoption, the settings
hierarchy, the CLI, and the savings dashboard.

## Task list (in order)
- **E1 — Config loader.** `src/config/`: user → project → local → env →
  per-request precedence, mirroring Claude Code's verified hierarchy (notes §13).
  Files: `~/.eol/settings.json` (via `env-paths` for the platform-correct base),
  `<project>/.eol/settings.json` (committable), `<project>/.eol/settings.local.json`
  (gitignored). Keys `snake_case`; env overrides `EOL_<SECTION>_<KEY>`; zod-validated
  with helpful errors. Typed accessors for other workstreams.
- **E2 — `eol init` / `eol uninit`.** Idempotent, all 3 OSes:
  1. Detect Claude Code; write `ANTHROPIC_BASE_URL=http://localhost:<port>` into
     the chosen settings scope (`env` block — notes §12) and set
     `ENABLE_TOOL_SEARCH=true` (tool search is off by default behind a
     non-first-party base URL — notes §12; document the Remote Control / voice
     dictation limitations).
  2. **Conflict detection (notes §5): refuse to init if a Headroom wrap/proxy owns
     the base URL** (localhost base URL answering Headroom's `/admin/runtime-env`
     or `~/.headroom` wrap state) — clear message telling the user to
     `headroom unwrap` first. Never double-wrap.
  3. Register the MCP server: `claude mcp add eol -- eol mcp serve` (or write
     `.mcp.json` at project scope — notes §9).
  4. Install WS-B's skills from `src/mcp/claude-assets/` into
     `.claude/skills/eol/<cmd>/SKILL.md` (→ `/eol/<cmd>`; colon names invalid —
     notes §11) and the PostToolUse hook config (schema in notes §8).
  5. Append guidance to CLAUDE.md via WS-B's writer.
  `eol uninit` reverses every step exactly.
- **E3 — CLI + dashboard v0.** `eol status|slider|stats|index|devices` (commander;
  the program object in `src/cli/main.ts` is the fixed entry). Dashboard v0: local
  web page — tokens saved/spent, cache hit rates, per-stage attribution from
  `src/telemetry/`; keep deps light (no heavy UI framework in the default install;
  a static page + small runtime is fine).

## Interfaces
- **Provides:** `src/config/` typed settings (every workstream consumes it — treat
  its public API as semi-frozen: coordinate changes through the integrator);
  the CLI surface; the dashboard.
- **Consumes:** `src/telemetry/` (read), WS-B's claude-assets + hook CLI, WS-A's
  proxy lifecycle (start/stop/port), `SliderPolicy` for `eol slider`.

## Files owned
`src/cli/`, `src/config/`, `src/dashboard/`, `tests/e2e/`.

## Dependencies
E1 can start now. E2 needs WS-B's B1 assets to exist for steps 3–4 (stub-install
behind a flag until then); the base-URL and conflict-detection parts have no
blockers. E3's stats need WS-A's A4 telemetry events flowing.

## P0 definition-of-done slice (you own the headline)
1. `npx eol init` on Win/macOS/Linux configures Claude Code (base URL + MCP +
   skills + hook) idempotently; `eol uninit` cleanly reverses it (DoD #1).
2. T-C2 e2e smoke in `tests/e2e/`: init → Claude Code round-trip with savings > 0
   at level 1 (with WS-A).
3. `eol stats` + dashboard show real per-stage savings attribution (DoD #3).
4. Headroom-wrap conflict detection proven by a test.
