/**
 * WS-A: compression stage implementing interfaces/compression (owned by agent-proxy).
 *
 * P0: EOL-native TS lossless stage (dedup, compaction, cache alignment, CCR).
 * P2+: optional Headroom Python sidecar behind the same adapter (spec Decision 18).
 * Any Headroom client imports live ONLY in `headroom-adapter.ts` in this
 * directory (CLAUDE.md hard rule).
 */

/**
 * Exact PyPI version of `headroom-ai` the OPTIONAL P2 sidecar is pinned to
 * (verified 2026-07-03; re-verify via the T-C4 playbook when the sidecar
 * integration lands — 0.29.0 was releasing that same day).
 */
export const HEADROOM_SIDECAR_PYPI_PIN = "0.28.0";

/**
 * Exact npm version of the `headroom-ai` client (thin HTTP transport to the
 * sidecar — contains no compression logic; verification-notes.md §16). Not a
 * default dependency; pinned here for when the P2 sidecar work adds it.
 */
export const HEADROOM_CLIENT_NPM_PIN = "0.22.4";
