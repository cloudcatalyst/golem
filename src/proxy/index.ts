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
  appendLimitHit,
  buildLimitCapture,
  captureTaskId,
  DEFAULT_MIN_CAPTURE_SECONDS,
  type LimitCaptureDeps,
  limitHitsLogPath,
} from "./limit-capture.js";
export { detectUsageLimit, LIMIT_STATUS, type UsageLimitSignal } from "./limit-detector.js";
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
} from "./types.js";
export { UsageSniffer } from "./usage-sniffer.js";
