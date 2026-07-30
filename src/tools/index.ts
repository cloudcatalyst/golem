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
export { isSchemaMode, SCHEMA_MODES, SHRINK_MODES, shrinkCatalog } from "./shrink.js";
