/**
 * WS-A: compression stage implementing interfaces/compression (owned by agent-proxy).
 *
 * P0: Golem-native TS lossless stage (dedup, compaction, cache alignment, CCR).
 * P2+: optional Headroom Python sidecar behind the same adapter (spec Decision 18).
 * Any Headroom client imports live ONLY in `headroom-adapter.ts` in this
 * directory (CLAUDE.md hard rule).
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

export type { CcrEnvelope } from "./ccr-store.js";
export { CcrStore } from "./ccr-store.js";
export { COMPACTION_VERSION, compactText } from "./compaction.js";
export { LocalDirBlobStore } from "./local-blob-store.js";
export type { NativeLosslessOptions } from "./native-lossless.js";
export {
  CCR_MARKER_RE,
  ccrMarker,
  DEFAULT_MIN_DEDUP_CHARS,
  NativeLosslessCompression,
  STAGE_COMPACTION,
  STAGE_DEDUP,
} from "./native-lossless.js";
// The neutral semantic-compression seam (slider ≥3). The Headroom implementation
// (HeadroomSidecar) is imported directly from ./headroom-adapter.js by the CLI —
// deliberately NOT re-exported here, to keep Headroom imports isolated to that
// file and avoid an index↔adapter import cycle.
export type { SemanticCompressor, SemanticMode, SemanticResult } from "./semantic.js";
export { estimateTokens } from "./tokens.js";
