/**
 * Workstream B (Decision 52 follow-up) — the tools-block measurement seam.
 *
 * Non-frozen (`src/tools/`, not `src/interfaces/`) on purpose: this is
 * measurement scaffolding that should be free to change as the case set grows.
 */

export type { SelectionCase } from "./cases.js";
export { SELECTION_CASES } from "./cases.js";
export type { CatalogTool, ToolCensus } from "./catalog.js";
export { golemToolCensus } from "./catalog.js";
export type { ToolBenchReport } from "./report.js";
export { renderToolBench } from "./report.js";
export type {
  CaseOutcome,
  CatalogComparison,
  CompareVerdict,
  RunOptions,
  SelectionRun,
} from "./selection.js";
export { compareCatalogs, parseChoice, runSelectionHarness } from "./selection.js";
export type { ShrinkMode } from "./shrink.js";
export { SHRINK_MODES, shrinkCatalog } from "./shrink.js";
