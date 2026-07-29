/**
 * WS-A: Anthropic-compatible proxy — HTTP + byte-faithful SSE passthrough
 * (owned by agent-proxy).
 */

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
