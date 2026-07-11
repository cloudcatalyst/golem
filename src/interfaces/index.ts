/**
 * FROZEN CONTRACTS — workstream boundaries (IMPLEMENTATION_PLAN §2).
 *
 * Changing anything in this package requires updating the corresponding
 * contract tests in tests/contract/ and flagging all dependent workstreams
 * in the PR description (CLAUDE.md hard rule).
 */

export type {
  CCRRef,
  CompressionService,
  CompressionStats,
  CompressResult,
  Message,
  Original,
  TokenDelta,
} from "./compression.js";
export { tokensSaved, UnknownRefError } from "./compression.js";

export type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  InferenceService,
  Role,
  Vector,
} from "./inference.js";
export { ALL_ROLES, CapabilityUnavailableError, HardwareTier } from "./inference.js";

export type {
  Chunk,
  FederatedSearch,
  Hit,
  IngestReport,
  KnowledgeBase,
  Scope,
} from "./knowledge.js";
export { DEFAULT_SCOPES, UnknownChunkError } from "./knowledge.js";

export type {
  SemanticCache,
  SemanticCompression,
  SliderPolicy,
  StageConfig,
} from "./policy.js";
export {
  MAX_SLIDER_LEVEL,
  migrateSliderLevel,
  SliderLevel,
  sliderPolicyForLevel,
} from "./policy.js";

export type { BlobStore } from "./storage.js";
export { BlobNotFoundError } from "./storage.js";

export type {
  WikiFrontmatter,
  WikiPage,
  WikiPageType,
  WikiReader,
  WikiStore,
  WikiUpsertInput,
} from "./wiki.js";
export { UnknownWikiPageError, WikiWriteConflictError } from "./wiki.js";
