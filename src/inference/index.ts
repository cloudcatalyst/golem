/**
 * WS-D — tiered local inference: capability detection (D1), Ollama client +
 * model catalog (D2), and the role-routing InferenceService with graceful
 * fallback (D3).
 */

export type {
  EndpointLister,
  EndpointPropsReader,
  EndpointRef,
  ModelAvailability,
  ProviderAvailability,
  PulledState,
  ResolvedAvailability,
  ResolvedSlotAvailability,
  TierAvailability,
} from "./availability.js";
export {
  availabilityWarning,
  CHAT_ROLE_SLOTS,
  listedState,
  matchesPulledName,
  resolveAvailability,
  resolvedAvailabilityWarning,
  resolveTierAvailability,
  roleState,
  roleWarning,
} from "./availability.js";
export type { CapabilityFacts, ProbeCommand, ProbeResult, ProbeRunner } from "./capability.js";
export { detectCapability, tierForMemoryMiB } from "./capability.js";
export type { TierCatalogEntry } from "./catalog.js";
export {
  catalogForTier,
  chatModelFor,
  embedModelFor,
  modelsForTier,
} from "./catalog.js";
export type {
  GgufFile,
  GgufModel,
  ModelChoice,
  ModelPreference,
  SelectionRequest,
} from "./gguf-catalog.js";
export {
  effectiveParamsB,
  estimatedKvBytes,
  estimatedResidentBytes,
  FLOOR_GGUF_MODEL_ID,
  GGUF_CATALOG,
  ggufModel,
  huggingFaceUrl,
  modelBytes,
  rankModels,
  selectModel,
} from "./gguf-catalog.js";
export type {
  FitVerdict,
  LlamacppAsset,
  LlamacppBackend,
  MachineFacts,
  ServerPlan,
  ServerPlanOptions,
} from "./llamacpp-plan.js";
export {
  assetUrl,
  checkDiskSpace,
  checkFit,
  contextForVram,
  LLAMACPP_RELEASE_TAG,
  LLAMACPP_RELEASES_URL,
  planServer,
  resolveAsset,
} from "./llamacpp-plan.js";
export type {
  InstallEnvironment,
  InstallMethodKind,
  InstallPlan,
  InstallResult,
  OllamaBootstrapDeps,
  PullResult,
} from "./ollama-bootstrap.js";
export {
  createOllamaBootstrapDeps,
  detectInstallEnvironment,
  installOllama,
  isOllamaInstalled,
  OLLAMA_DOWNLOAD_URL,
  OLLAMA_LINUX_INSTALL_SCRIPT_URL,
  OllamaNotReadyError,
  pullDrafterModel,
  resolveInstallPlan,
  smokeTestModel,
} from "./ollama-bootstrap.js";
export type { OllamaClientOptions } from "./ollama-client.js";
export {
  DEFAULT_OLLAMA_BASE_URL,
  InferenceEndpointError,
  InferenceTimeoutError,
  ModelNotAvailableError,
  OllamaClient,
} from "./ollama-client.js";
export type { PulledModel, PullProgressEvent } from "./ollama-native.js";
export {
  OllamaNativeClient,
  OllamaPullError,
  OllamaUnreachableError,
  parsePullProgressLine,
} from "./ollama-native.js";
export type { OpenAiModelsClientOptions, ServerProps } from "./openai-models.js";
export {
  DEFAULT_MODELS_TIMEOUT_MS,
  modelsUrl,
  OpenAiModelsClient,
  parseModelsResponse,
  parsePropsResponse,
  propsUrl,
} from "./openai-models.js";
export {
  createProbeRunner,
  DEFAULT_PROBE_TIMEOUT_MS,
} from "./probe.js";
export type {
  EmbedKind,
  ModelSource,
  ProviderApi,
  ProviderEntry,
  ProviderModelEntry,
  ResolutionContext,
  ResolvedModel,
} from "./providers.js";
export {
  CATALOG_PROVIDER_ID,
  providerEndpoints,
  resolveChatModel,
  resolveEmbedModel,
  validateProviders,
} from "./providers.js";
export type { FallbackPolicy, OllamaInferenceOptions } from "./service.js";
export {
  HaikuFallbackRequired,
  OllamaInferenceService,
} from "./service.js";
