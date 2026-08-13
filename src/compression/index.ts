/**
 * WS-A: compression stage implementing interfaces/compression (owned by agent-proxy).
 *
 * P0: Golem-native TS lossless stage (dedup, compaction, cache alignment, CCR).
 * P2+: optional Headroom Python sidecar behind the same adapter (spec Decision 18).
 * Any Headroom client imports live ONLY in `headroom-adapter.ts` in this
 * directory (CLAUDE.md hard rule).
 */

export type { CcrEnvelope } from "./ccr-store.js";
export { CcrStore } from "./ccr-store.js";
export { COMPACTION_VERSION, compactText } from "./compaction.js";
export type { ContextSubstitutionResult, KnownContentLookup } from "./context-substitution.js";
export {
  contextSubstitutionMarker,
  DEFAULT_MIN_SUBSTITUTION_CHARS,
  substituteKnownContent,
} from "./context-substitution.js";
export { backfillHeadroomCcrRefs } from "./headroom-ccr-bridge.js";
export { LocalDirBlobStore } from "./local-blob-store.js";
// The neutral MEMORY-scope federated-search seam (R3.6). HeadroomMemorySidecar
// is imported directly from ./headroom-adapter.js by the CLI, never re-exported
// here — same discipline as SemanticCompressor below.
export type { MemoryFact, MemorySearchProvider } from "./memory-search.js";
export type { NativeLosslessOptions } from "./native-lossless.js";
export {
  CCR_MARKER_RE,
  ccrMarker,
  DEFAULT_MIN_DEDUP_CHARS,
  NativeLosslessCompression,
  STAGE_COMPACTION,
  STAGE_DEDUP,
} from "./native-lossless.js";
/**
 * The Headroom pins live in `pins.ts` so that `src/pkg/manifest.ts` and the
 * contract tests can read them without importing this barrel. Re-exported here
 * because every existing consumer imports them from `compression/index.js`.
 */
export { HEADROOM_CLIENT_NPM_PIN, HEADROOM_SIDECAR_PYPI_PIN } from "./pins.js";
// The neutral semantic-compression seam (slider ≥3). The Headroom implementation
// (HeadroomSidecar) is imported directly from ./headroom-adapter.js by the CLI —
// deliberately NOT re-exported here, to keep Headroom imports isolated to that
// file and avoid an index↔adapter import cycle.
export type { SemanticCompressor, SemanticMode, SemanticResult } from "./semantic.js";
export { estimateTokens } from "./tokens.js";
