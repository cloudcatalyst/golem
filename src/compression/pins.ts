/**
 * The Headroom version pins, in a module of their own.
 *
 * These live here rather than in `compression/index.ts` so that consumers which
 * need only the pin string — `src/pkg/manifest.ts`, the contract tests — can
 * import it without pulling the compression barrel (and through it the CCR
 * store and the sidecar adapter) into their module graph. `index.ts` re-exports
 * both constants, so existing importers are unaffected.
 *
 * Before R10.1 the sidecar pin was written out a second time as a bare string
 * literal in two `manifest.ts` rows, and the two copies agreed only by
 * convention. `pins.contract.test.ts` now asserts they agree.
 */

/**
 * Exact PyPI version of `headroom-ai` the OPTIONAL sidecar is pinned to. The
 * `HeadroomSidecar` (headroom-adapter.ts) launches this exact version via
 * `uv run --with headroom-ai==<this>`. Bump ONLY via the T-C4 upgrade playbook.
 *
 * Set to 0.30.0 (measured/integrated 2026-07-05, verification-notes §34/§35):
 * bare `headroom-ai` (no `[ml]`) provides `headroom.compress()` with the
 * `read_lifecycle` + structural transforms — heuristic-only, no torch.
 */
export const HEADROOM_SIDECAR_PYPI_PIN = "0.30.0";

/**
 * Exact npm version of the `headroom-ai` client — a thin HTTP transport to the
 * proxy (verification-notes §16/§34). Golem does NOT use it: the sidecar calls
 * `headroom.compress()` in-process, so there is no client↔server handshake to
 * manage. Retained only to document the pinned client if ever needed.
 */
export const HEADROOM_CLIENT_NPM_PIN = "0.22.4";
