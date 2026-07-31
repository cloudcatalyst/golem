/**
 * Workstream B (Decision 52 follow-up) / R8.S1 — the tools-block measurement seam.
 *
 * Non-frozen (`src/tools/`, not `src/interfaces/`) on purpose: this is
 * measurement scaffolding that should be free to change as the case set grows.
 */

export type { ArgumentCase, ArgumentOutcome, SchemaViolation } from "./arguments.js";
export { scoreArguments, validateAgainstSchema } from "./arguments.js";
export type { SelectionCase } from "./cases.js";
export { ARGUMENT_CASES, SELECTION_CASES } from "./cases.js";
export type { CatalogTool, ToolCensus } from "./catalog.js";
export { golemToolCensus } from "./catalog.js";
export type {
  EditStatus,
  MatchStrategy,
  ValidatedEdit,
  ValidateOptions,
} from "./edit-apply.js";
export { countOccurrences, findTrimmedSpan, validateEdits } from "./edit-apply.js";
export type {
  EditBenchReport,
  EditOutcome,
  EditRun,
  EditVerdict,
} from "./edit-bench.js";
export { benchEdits, EDIT_BAR, renderEditBench, runEditArm } from "./edit-bench.js";
export type { EditAssertion, EditCase } from "./edit-cases.js";
export { EDIT_CASES } from "./edit-cases.js";
export type { DiffOptions, DiffStat } from "./edit-diff.js";
export { diffLines, renderDiff } from "./edit-diff.js";
export type { EditFormat, ParsedEditReply, ProposedEdit } from "./edit-format.js";
export {
  EDIT_FORMATS,
  editFormatInstructions,
  isEditFormat,
  parseEditReply,
} from "./edit-format.js";
export type { ExternalShrinker } from "./ext-shrink.js";
export { resolveCavemanShrink } from "./ext-shrink.js";
export type { ToolBenchReport } from "./report.js";
export { renderToolBench } from "./report.js";
export type {
  ArgumentComparison,
  ArgumentRun,
  ArgumentRunOptions,
  CaseOutcome,
  CatalogComparison,
  CatalogRender,
  CompareVerdict,
  RunOptions,
  SelectionRun,
} from "./selection.js";
export {
  compareCatalogs,
  parseArguments,
  parseChoice,
  runArgumentHarness,
  runSelectionHarness,
} from "./selection.js";
export type { ShrinkMode } from "./shrink.js";
export {
  EXTERNAL_MODES,
  isExternalMode,
  isSchemaMode,
  SCHEMA_MODES,
  SHRINK_MODES,
  shrinkCatalog,
} from "./shrink.js";
