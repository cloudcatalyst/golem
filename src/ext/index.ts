/**
 * `src/ext/` — the managed-tool registry (spec Decision 53).
 *
 * External tools are **spawned or detected, never shipped**. This barrel is the
 * public face of that policy: the manifest data, spawn-free detection, and the
 * resolved per-row status behind `golem ext`.
 *
 * Not to be confused with `src/tools/`, which is the tool-selection *benchmark*
 * harness behind `golem bench tools` (Workstream B, §89).
 */

export { commandOnPath, moduleOnDisk } from "./detect.js";
export {
  DEFAULT_LSP_DIAGNOSTICS_WAIT_MS,
  DEFAULT_LSP_IDLE_TIMEOUT_MS,
  DEFAULT_LSP_INITIALIZE_TIMEOUT_MS,
  DEFAULT_LSP_REQUEST_TIMEOUT_MS,
  DEFAULT_LSP_SERVERS,
  LSP_MODES,
  LspBridge,
  type LspBridgeOptions,
  type LspDiagnostic,
  type LspLocation,
  type LspMode,
  type LspQueryInput,
  type LspQueryResult,
  type LspServerSpec,
  resolveLspServers,
  serverForFile,
  TYPESCRIPT_LSP,
} from "./lsp/index.js";
export {
  EXT_MANIFESTS,
  type ExtDetect,
  type ExtManifest,
  type ExtShape,
  type ExtTier,
  extManifest,
} from "./manifest.js";
export {
  type ExtProbes,
  type ExtState,
  type ExtStatus,
  type ResolveExtOptions,
  resolveExtStatuses,
} from "./status.js";
