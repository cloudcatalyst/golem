/**
 * WS-A A3 — request pipeline barrel: redaction → compression → forward.
 *
 * Hard rule: the redaction stage runs FIRST and is never weakened or reordered
 * after compression (CLAUDE.md). The redaction rule table in
 * `redaction-rules.ts` is the T-C3 security-review audit surface.
 */

export type { GolemPipelineOptions, PipelineEvent } from "./pipeline.js";
export { createGolemPipeline } from "./pipeline.js";
export type { RedactBodyResult } from "./redaction.js";
export { redactRequestBody, redactStandaloneText } from "./redaction.js";
export type { RedactionRule } from "./redaction-rules.js";
export {
  ENTROPY_THRESHOLD_BITS,
  isHighEntropyToken,
  luhnValid,
  REDACTION_RULES,
  shannonEntropy,
} from "./redaction-rules.js";
