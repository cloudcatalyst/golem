/**
 * Workstream B — the `golem bench tools` report shape and renderer.
 *
 * Reports the census and, when a candidate transform was scored, the token saving
 * and the accuracy delta **in the same view**. Decision 52 established that rule
 * for brevity: a savings number printed without its cost is the kind of dishonest
 * observability this project exists to avoid.
 */

import type { ToolCensus } from "./catalog.js";
import type { CatalogComparison } from "./selection.js";
import type { ShrinkMode } from "./shrink.js";

export interface ToolBenchReport {
  readonly census: ToolCensus;
  /** Present only when a transform was scored (`--shrink`). */
  readonly comparison?: {
    readonly mode: ShrinkMode;
    readonly cases: number;
    /** Local role that chose — a substitute for  is a caveat, so it is printed. */
    readonly role?: string;
    readonly result: CatalogComparison;
  };
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function signedPct(value: number | null): string {
  if (value === null) return "n/a";
  const s = (value * 100).toFixed(1);
  return value > 0 ? `+${s}%` : `${s}%`;
}

export function renderToolBench(report: ToolBenchReport): string {
  const lines: string[] = [];
  const { census } = report;
  lines.push("Golem tools block — token census");
  lines.push("");
  lines.push(`  tools registered      ${census.tools.length}`);
  lines.push(`  description tokens    ~${census.descriptionTokens}`);
  lines.push(`  full definitions      ~${census.definitionTokens} (incl. input schemas)`);
  lines.push("");
  lines.push("  per tool (descending by description size):");
  for (const tool of census.tools) {
    lines.push(
      `    ${tool.name.padEnd(14)} ~${String(tool.descriptionTokens).padStart(4)} desc` +
        `  ~${String(tool.definitionTokens).padStart(4)} full`,
    );
  }
  lines.push("");
  lines.push("  This block renders FIRST in the cached prefix, so it bills at ~0.1x after the");
  lines.push("  first turn — and an unstable transform invalidates the whole prefix every");
  lines.push("  request, which is strictly worse than doing nothing.");

  if (report.comparison === undefined) {
    lines.push("");
    lines.push("No transform scored. Re-run with --shrink <whitespace|first-sentence> to");
    lines.push("A/B a candidate against the tool-selection case set.");
    return `${lines.join("\n")}\n`;
  }

  const { mode, cases, result } = report.comparison;
  lines.push("");
  lines.push(`Tool-selection A/B — transform "${mode}"`);
  lines.push("");
  lines.push(
    `  chooser model         ${result.candidate.model ?? "unavailable"} (role: ${report.comparison.role ?? "classifier"})`,
  );
  lines.push(`  cases x repeats       ${cases} x ${result.candidate.repeats}`);
  lines.push(
    `  tokens               ~${result.baselineTokens} -> ~${result.candidateTokens}` +
      `  (saved ~${result.tokensSaved})`,
  );
  lines.push(
    `  accuracy             ${pct(result.baseline.accuracy)} -> ${pct(result.candidate.accuracy)}` +
      `  (${signedPct(result.accuracyDelta)})`,
  );
  lines.push(
    `  false positives      ${result.baseline.falsePositives} -> ${result.candidate.falsePositives}` +
      "   (tool chosen where none applies)",
  );
  lines.push(
    `  abstentions          ${result.baseline.abstentions} -> ${result.candidate.abstentions}` +
      "   (no tool chosen where one applies)",
  );
  if (result.baseline.errors > 0 || result.candidate.errors > 0) {
    lines.push(
      `  chooser errors       ${result.baseline.errors} baseline, ${result.candidate.errors} candidate` +
        "   (excluded, never scored as wrong)",
    );
  }
  lines.push(`  verdict              ${result.verdict.toUpperCase()}`);
  for (const note of result.notes) {
    lines.push(`    ! ${note}`);
  }
  lines.push("");
  lines.push("  The chooser is a LOCAL model, not the model that reads these descriptions");
  lines.push("  in production, and the expected answers are hand-labelled. Treat a null");
  lines.push("  result as weak evidence of safety, not proof.");
  return `${lines.join("\n")}\n`;
}
