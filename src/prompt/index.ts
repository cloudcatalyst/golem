/**
 * R5.5 (WS-F7 / spec 20g) — prompt translation spike (local-LLM, inspectable).
 * P3a — the CLAUDE.md compaction actuator, on the same shown-never-sent seam.
 */

export {
  COVERAGE_THRESHOLD,
  type CompactDeps,
  type CompactResult,
  compactDir,
  compactDocument,
  type Directive,
  estimateTokens,
  extractDirectives,
  maskProtected,
  renderCompactReport,
  restoreProtected,
  type Segment,
  type SegmentKind,
  type SegmentOutcome,
  scoreDirectives,
  segmentMarkdown,
} from "./compact.js";
export {
  appendExample,
  readExamples,
  readLastSuggestion,
  type StyleExample,
  styleDir,
  writeLastSuggestion,
} from "./style-store.js";
export { type TranslateDeps, type TranslateResult, translatePrompt } from "./translate.js";
