/**
 * `src/ext/lsp/` — the R8.6 language-server bridge.
 *
 * A tier-2 spawn target (Decision 53): the user installs the server, Golem
 * spawns it at need and degrades to a no-op without it. The four questions it
 * answers are **modes of the `code` tool**, not four tools of their own.
 */

export {
  DEFAULT_LSP_DIAGNOSTICS_WAIT_MS,
  DEFAULT_LSP_IDLE_TIMEOUT_MS,
  DEFAULT_LSP_INITIALIZE_TIMEOUT_MS,
  DEFAULT_LSP_REQUEST_TIMEOUT_MS,
  LSP_MODES,
  LspBridge,
  type LspBridgeOptions,
  type LspDiagnostic,
  type LspLocation,
  type LspMode,
  type LspQueryInput,
  type LspQueryResult,
} from "./bridge.js";
export {
  LspClient,
  type LspClientOptions,
  LspExitError,
  LspResponseError,
  LspTimeoutError,
  STOP_GRACE_MS,
} from "./client.js";
export {
  encodeMessage,
  LspProtocolError,
  MAX_HEADER_BYTES,
  MAX_MESSAGE_BYTES,
  MessageBuffer,
} from "./framing.js";
export {
  DEFAULT_LSP_SERVERS,
  type LspServerSpec,
  resolveLspServers,
  serverForFile,
  TYPESCRIPT_LSP,
} from "./servers.js";
