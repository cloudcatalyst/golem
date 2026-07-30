/**
 * WS-A: Anthropic-compatible proxy — HTTP + byte-faithful SSE passthrough
 * (owned by agent-proxy).
 */

export {
  type CacheBustComponent,
  type CachePrefixFingerprint,
  type CachePrefixObservation,
  CachePrefixObserver,
  type CachePrefixVerdict,
  cachePrefixFingerprint,
  classifyPrefixChange,
} from "./cache-prefix.js";
export {
  buildContextLedger,
  type ContextBucket,
  type ContextLargestBlock,
  type ContextLedger,
  type ContextLedgerCore,
  type ContextPerTool,
  contextLedgerPath,
  contextLedgerSchema,
  readContextLedger,
  writeContextLedger,
} from "./context-ledger.js";
export { mapUpstreamError, PROXY_ERROR_HEADER } from "./errors.js";
export {
  forwardableRequestHeaders,
  forwardableResponseHeaders,
  isBypassRequest,
} from "./headers.js";
export {
  type LimitPrediction,
  type LimitWindow,
  limitStatePath,
  parseLimitPrediction,
  readLimitState,
  writeLimitState,
} from "./limit-prediction.js";
export {
  clearServedModel,
  readServedModel,
  type ServedModel,
  servedModelFor,
  servedModelPath,
  writeServedModel,
} from "./served-model.js";
export { GolemProxy } from "./server.js";
export {
  BYPASS_HEADER,
  DEFAULT_UPSTREAM_BASE_URL,
  identityPipeline,
  type ProxyConfig,
  type ProxyRequest,
  type ProxyServerOptions,
  type RequestPipeline,
  type ResponseUsage,
  resolveProxyConfig,
  type UpstreamTranslator,
} from "./types.js";
export { UsageSniffer } from "./usage-sniffer.js";
