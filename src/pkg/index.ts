/**
 * `src/pkg/` — the managed-package registry (spec Decision 53).
 *
 * External packages are **spawned or detected, never shipped**. This barrel is the
 * public face of that policy: the manifest data, spawn-free detection, and the
 * resolved per-row status behind `golem pkg`.
 */

export { commandOnPath, moduleOnDisk, pluginOnDisk } from "./detect.js";
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
  PKG_MANIFESTS,
  type PkgDetect,
  type PkgManifest,
  type PkgShape,
  type PkgTier,
  pkgManifest,
} from "./manifest.js";
export {
  type PkgProbes,
  type PkgState,
  type PkgStatus,
  type ResolvePkgOptions,
  resolvePkgStatuses,
} from "./status.js";
