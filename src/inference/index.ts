/**
 * WS-D — tiered local inference: capability detection (D1), Ollama client +
 * model catalog (D2), and the role-routing InferenceService with graceful
 * fallback (D3).
 */

export type { CapabilityFacts, ProbeCommand, ProbeResult, ProbeRunner } from "./capability.js";
export { detectCapability, tierForMemoryMiB } from "./capability.js";
export type { TierCatalogEntry } from "./catalog.js";
export {
  catalogForTier,
  chatModelFor,
  embedModelFor,
  modelsForTier,
} from "./catalog.js";
export type { OllamaClientOptions } from "./ollama-client.js";
export {
  DEFAULT_OLLAMA_BASE_URL,
  InferenceEndpointError,
  ModelNotAvailableError,
  OllamaClient,
} from "./ollama-client.js";
export {
  createProbeRunner,
  DEFAULT_PROBE_TIMEOUT_MS,
} from "./probe.js";
export type { FallbackPolicy, OllamaInferenceOptions } from "./service.js";
export {
  HaikuFallbackRequired,
  OllamaInferenceService,
} from "./service.js";
