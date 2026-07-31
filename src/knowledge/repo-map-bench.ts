/**
 * R8.5's gate — the retrieval-accuracy harness, in the shape of
 * `golem bench tools` (Workstream B, §89).
 *
 * The question the task actually asks is not "can we render a map" but **"does
 * the map let the model find the right file WITHOUT reading it?"** — and the memo's
 * open question 3 warns the honest answer may be "partially": the model may read
 * the file anyway. So this is an **A/B**, not an absolute score:
 *
 *  - **baseline arm `paths`** — the plain file list, which the model can already
 *    get for almost nothing (`Glob`, `ls`). This is the real alternative; scoring
 *    the map against no context at all would flatter it.
 *  - **candidate arm `map`** — the repo map, rebuilt per case with that case's
 *    question as its query, because that is how the `code` tool is called.
 *
 * Both arms are shown to the same model, on the same cases, in the same run, and
 * the report prints the token cost of each **beside** the accuracy delta —
 * Decision 52's rule that a saving without its cost is the dishonest
 * observability this project exists to avoid. It also prints what a full `Read`
 * of each labelled file would have cost, since that is the thing the map claims
 * to displace.
 *
 * Honest scoping (same caveats as `src/tools/selection.ts`):
 *  - the chooser is a LOCAL model, not the frontier model that reads maps in
 *    production, so its name is in every report;
 *  - a model failure is counted as an `error` and excluded, never scored as a
 *    wrong answer ("the judge was down" ≠ "the model chose badly");
 *  - the verdict refuses to call anything a pass when the delta sits inside the
 *    case set's own resolution.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { estimateTokens } from "../compression/tokens.js";
import type { InferenceService, Role } from "../interfaces/index.js";
import {
  buildGraph,
  DEFAULT_MAP_BUDGET_TOKENS,
  type RepoFile,
  rankFiles,
  renderRepoMap,
  scanRepoFiles,
} from "./repo-map.js";
import type { RetrievalCase } from "./repo-map-cases.js";

/** Which context the chooser was given. */
export type BenchArm = "paths" | "map";

export interface RetrievalOutcome {
  readonly id: string;
  readonly expected: readonly string[];
  readonly chosen: string | null;
  readonly correct: boolean;
  /** Set when the chooser could not be reached or returned unusable output. */
  readonly error?: string;
}

export interface RetrievalRun {
  readonly arm: BenchArm;
  /** Concrete model that chose — accuracy is model-specific. */
  readonly model: string | null;
  readonly repeats: number;
  readonly scored: number;
  readonly correct: number;
  readonly errors: number;
  /** correct / scored, or null when nothing could be scored. */
  readonly accuracy: number | null;
  /** Mean tokens of context this arm spent per case. */
  readonly contextTokens: number;
  readonly outcomes: readonly RetrievalOutcome[];
}

export type BenchVerdict = "map-helps" | "map-hurts" | "no-material-change" | "inconclusive";

export interface RepoMapBenchReport {
  readonly root: string;
  readonly filesScanned: number;
  readonly symbolsTotal: number;
  readonly cases: number;
  /** Labelled paths that no longer exist — a rotted case set, reported not hidden. */
  readonly missingExpectations: readonly string[];
  /** Mean tokens a FULL read of one labelled file costs — what a map displaces. */
  readonly meanLabelledReadTokens: number;
  /** The map's own cost at the configured budget, with no query. */
  readonly mapTokens: number;
  readonly budgetTokens: number;
  /** Present only when the local model actually scored the arms. */
  readonly comparison?: {
    readonly role: Role;
    readonly baseline: RetrievalRun;
    readonly candidate: RetrievalRun;
    readonly accuracyDelta: number | null;
    /** One case's worth of accuracy — the finest delta this set can resolve. */
    readonly resolution: number;
    readonly verdict: BenchVerdict;
    readonly notes: readonly string[];
  };
}

const SYSTEM =
  "You are told what a repository contains and asked one question about it. Reply " +
  "with the single repo-relative path of the ONE file to open — nothing else. Copy " +
  "the path exactly as it appears in the context. If none fits, reply with an empty " +
  "string. Never invent a path.";

const CHOICE_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Exact repo-relative path of the single best file, or the empty string.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

/** Parse the chooser's reply into a known path, null for none, undefined if unusable. */
export function parsePathChoice(
  text: string,
  known: ReadonlySet<string>,
): string | null | undefined {
  const trimmed = text
    .trim()
    .replace(/^```[a-zA-Z]*\s*/u, "")
    .replace(/```$/u, "")
    .trim();
  if (trimmed.length === 0) return null;

  let raw: string | undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") raw = parsed;
    else if (typeof parsed === "object" && parsed !== null && "path" in parsed) {
      const value = (parsed as { path: unknown }).path;
      if (typeof value === "string") raw = value;
    }
  } catch {
    raw = trimmed;
  }
  if (raw === undefined) return undefined;

  const cleaned = raw
    .trim()
    .replace(/^["'`]+|["'`;,.]+$/gu, "")
    .replace(/^\.\//u, "")
    .trim();
  if (cleaned.length === 0) return null;
  if (known.has(cleaned)) return cleaned;
  // A small model often answers in a sentence. Accept the first known path that
  // appears anywhere in the reply — a formatting slip is not a wrong choice.
  for (const candidate of known) {
    if (trimmed.includes(candidate)) return candidate;
  }
  return undefined;
}

/** The cheap baseline context: just the paths, capped to the map's own budget. */
export function renderPathList(files: readonly RepoFile[], budgetTokens: number): string {
  const header = `[Repository file list — ${files.length} file(s)]`;
  const lines: string[] = [];
  let used = estimateTokens(`${header}\n`);
  let shown = 0;
  for (const file of files) {
    const row = file.sourcePath;
    const cost = estimateTokens(`${row}\n`);
    if (used + cost > budgetTokens) break;
    lines.push(row);
    used += cost;
    shown += 1;
  }
  const omitted = files.length - shown;
  const footer = omitted > 0 ? `\n${omitted} more file(s) not listed.` : "";
  return `${header}\n${lines.join("\n")}${footer}\n`;
}

async function chooseOnce(
  inference: InferenceService,
  role: Role,
  context: string,
  question: string,
  known: ReadonlySet<string>,
): Promise<{ chosen: string | null; model: string | null; error?: string }> {
  try {
    const result = await inference.chat(
      role,
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: `${context}\nQuestion: ${question}` },
      ],
      { temperature: 0, jsonSchema: CHOICE_SCHEMA },
    );
    const chosen = parsePathChoice(result.text, known);
    if (chosen === undefined) {
      return {
        chosen: null,
        model: result.model,
        error: `unusable choice: ${result.text.slice(0, 80)}`,
      };
    }
    return { chosen, model: result.model };
  } catch (err) {
    return { chosen: null, model: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface BenchRunOptions {
  readonly inference: InferenceService;
  readonly files: readonly RepoFile[];
  readonly cases: readonly RetrievalCase[];
  readonly arm: BenchArm;
  /** Context for a case — the map (query-personalized) or the flat path list. */
  readonly contextFor: (testCase: RetrievalCase) => string;
  readonly repeats?: number;
  readonly role?: Role;
}

/** Score one arm against the case set. */
export async function runRetrievalArm(opts: BenchRunOptions): Promise<RetrievalRun> {
  const repeats = Math.max(1, opts.repeats ?? 1);
  const role = opts.role ?? "classifier";
  const known = new Set(opts.files.map((f) => f.sourcePath));
  const outcomes: RetrievalOutcome[] = [];
  let model: string | null = null;
  let contextTokens = 0;
  let contexts = 0;

  for (let pass = 0; pass < repeats; pass += 1) {
    for (const testCase of opts.cases) {
      const context = opts.contextFor(testCase);
      contextTokens += estimateTokens(context);
      contexts += 1;
      const res = await chooseOnce(opts.inference, role, context, testCase.query, known);
      if (res.model !== null) model = res.model;
      outcomes.push(
        res.error === undefined
          ? {
              id: testCase.id,
              expected: testCase.expected,
              chosen: res.chosen,
              correct: res.chosen !== null && testCase.expected.includes(res.chosen),
            }
          : {
              id: testCase.id,
              expected: testCase.expected,
              chosen: null,
              correct: false,
              error: res.error,
            },
      );
    }
  }

  const scored = outcomes.filter((o) => o.error === undefined);
  const correct = scored.filter((o) => o.correct).length;
  return {
    arm: opts.arm,
    model,
    repeats,
    scored: scored.length,
    correct,
    errors: outcomes.length - scored.length,
    accuracy: scored.length === 0 ? null : correct / scored.length,
    contextTokens: contexts === 0 ? 0 : Math.round(contextTokens / contexts),
    outcomes,
  };
}

export interface BenchOptions {
  /** Repo root to map and to resolve labelled paths against. */
  readonly root: string;
  readonly cases: readonly RetrievalCase[];
  /** Omit to report cost only (no local model needed) — the census half. */
  readonly inference?: InferenceService;
  readonly repeats?: number;
  readonly role?: Role;
  readonly budgetTokens?: number;
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function signedPct(value: number | null): string {
  if (value === null) return "n/a";
  const s = (value * 100).toFixed(1);
  return value > 0 ? `+${s}%` : `${s}%`;
}

/**
 * Run the gate: cost figures always, and the A/B when an `InferenceService` is
 * supplied. Never throws on a chooser failure — that is an `errors` count.
 */
export async function benchRepoMap(options: BenchOptions): Promise<RepoMapBenchReport> {
  const budgetTokens = options.budgetTokens ?? DEFAULT_MAP_BUDGET_TOKENS;
  const files = await scanRepoFiles(options.root);
  const graph = buildGraph(files);
  const symbolsTotal = files.reduce((n, f) => n + f.facts.defs.length, 0);
  const known = new Set(files.map((f) => f.sourcePath));

  // What the map claims to displace: a full read of the file the question is
  // about. Measured, not assumed — and a label that no longer resolves is
  // reported rather than silently scored wrong.
  const labelled = [...new Set(options.cases.flatMap((c) => c.expected))].sort();
  const missingExpectations = labelled.filter((p) => !known.has(p));
  let readTokens = 0;
  let readFiles = 0;
  for (const rel of labelled) {
    if (!known.has(rel)) continue;
    try {
      const text = await readFile(path.join(options.root, rel), "utf8");
      readTokens += estimateTokens(text);
      readFiles += 1;
    } catch {
      // unreadable — excluded from the mean rather than counted as zero
    }
  }

  const plainMap = renderRepoMap(files, graph, rankFiles(files, graph), { budgetTokens });
  const base: RepoMapBenchReport = {
    root: options.root,
    filesScanned: files.length,
    symbolsTotal,
    cases: options.cases.length,
    missingExpectations,
    meanLabelledReadTokens: readFiles === 0 ? 0 : Math.round(readTokens / readFiles),
    mapTokens: plainMap.tokens,
    budgetTokens,
  };
  if (options.inference === undefined) return base;

  const pathList = renderPathList(files, budgetTokens);
  const baseline = await runRetrievalArm({
    inference: options.inference,
    files,
    cases: options.cases,
    arm: "paths",
    contextFor: () => pathList,
    ...(options.repeats === undefined ? {} : { repeats: options.repeats }),
    ...(options.role === undefined ? {} : { role: options.role }),
  });
  const candidate = await runRetrievalArm({
    inference: options.inference,
    files,
    cases: options.cases,
    arm: "map",
    // Rebuilt per case: the `code` tool is called WITH the question, so scoring a
    // query-less map would measure something nobody uses.
    contextFor: (testCase) =>
      renderRepoMap(files, graph, rankFiles(files, graph, { query: testCase.query }), {
        budgetTokens,
        query: testCase.query,
      }).text,
    ...(options.repeats === undefined ? {} : { repeats: options.repeats }),
    ...(options.role === undefined ? {} : { role: options.role }),
  });

  const resolution = options.cases.length === 0 ? 1 : 1 / options.cases.length;
  const accuracyDelta =
    baseline.accuracy === null || candidate.accuracy === null
      ? null
      : candidate.accuracy - baseline.accuracy;
  const notes: string[] = [];

  /**
   * Excluded chooser errors are only disqualifying if they could have changed the
   * answer. So assume the worst: every error in an arm would have gone the way
   * that hurts the map most — correct for the baseline, wrong for the candidate —
   * and see whether the sign survives. A single unusable reply out of 22 cases
   * must not be able to erase a delta five times the case set's resolution, and a
   * delta that a single reply COULD erase was never a result.
   */
  const adverse = (): number | null => {
    if (accuracyDelta === null) return null;
    const baseTotal = baseline.scored + baseline.errors;
    const candTotal = candidate.scored + candidate.errors;
    if (baseTotal === 0 || candTotal === 0) return null;
    return (candidate.correct / candTotal) * 1 - (baseline.correct + baseline.errors) / baseTotal;
  };
  const adverseDelta = adverse();
  const errorsCouldFlip =
    accuracyDelta !== null &&
    (adverseDelta === null ||
      Math.abs(adverseDelta) < resolution ||
      Math.sign(adverseDelta) !== Math.sign(accuracyDelta));

  let verdict: BenchVerdict;
  if (accuracyDelta === null) {
    verdict = "inconclusive";
    notes.push("at least one arm scored nothing — is the local model reachable?");
  } else if ((baseline.errors > 0 || candidate.errors > 0) && errorsCouldFlip) {
    verdict = "inconclusive";
    notes.push(
      `${baseline.errors + candidate.errors} chooser error(s) excluded from scoring, and ` +
        "scoring them the worst possible way would change the verdict — re-run",
    );
  } else if (Math.abs(accuracyDelta) < resolution) {
    verdict = "no-material-change";
  } else {
    verdict = accuracyDelta > 0 ? "map-helps" : "map-hurts";
  }
  if (verdict !== "inconclusive" && (baseline.errors > 0 || candidate.errors > 0)) {
    notes.push(
      `${baseline.errors + candidate.errors} chooser error(s) excluded; scoring them the worst ` +
        `way still leaves ${signedPct(adverseDelta)}, so they cannot flip this`,
    );
  }
  if (verdict !== "inconclusive" && Math.abs(accuracyDelta ?? 0) < 2 * resolution) {
    notes.push(
      `delta is within ~${Math.ceil(Math.abs(accuracyDelta ?? 0) / resolution)} case(s) on ` +
        `${options.cases.length} cases × ${candidate.repeats} repeat(s) — raise repeats or ` +
        "add cases before treating it as signal",
    );
  }
  if (candidate.contextTokens > baseline.contextTokens) {
    notes.push(
      `the map costs ~${candidate.contextTokens - baseline.contextTokens} more tokens per call ` +
        "than the path list it is being compared against — accuracy must pay for that",
    );
  }
  if (missingExpectations.length > 0) {
    notes.push(
      `${missingExpectations.length} labelled path(s) no longer exist (${missingExpectations
        .slice(0, 3)
        .join(", ")}) — re-label the cases`,
    );
  }
  notes.push(
    "this measures whether the map names the right file, NOT whether the model then " +
      "skips reading it (memo open question 3) — displacement needs live traffic",
  );

  return {
    ...base,
    comparison: {
      role: options.role ?? "classifier",
      baseline,
      candidate,
      accuracyDelta,
      resolution,
      verdict,
      notes,
    },
  };
}

/** Render the report: cost and accuracy in one view, never one without the other. */
export function renderRepoMapBench(report: RepoMapBenchReport): string {
  const lines: string[] = [];
  lines.push("Golem repo map — cost census");
  lines.push("");
  lines.push(`  files with symbols    ${report.filesScanned}`);
  lines.push(`  symbols extracted     ${report.symbolsTotal}`);
  lines.push(
    `  map cost              ~${report.mapTokens} tokens (budget ~${report.budgetTokens})`,
  );
  lines.push(`  a labelled file read  ~${report.meanLabelledReadTokens} tokens (mean, whole file)`);
  const ratio =
    report.meanLabelledReadTokens === 0 ? null : report.mapTokens / report.meanLabelledReadTokens;
  if (ratio !== null) {
    lines.push(
      `  so the map costs      ~${ratio.toFixed(1)}x one whole-file read — it pays only if it ` +
        "avoids that many",
    );
  }
  if (report.missingExpectations.length > 0) {
    lines.push("");
    lines.push("  ! labelled paths that no longer exist (re-label, do not delete):");
    for (const missing of report.missingExpectations) lines.push(`      ${missing}`);
  }

  const cmp = report.comparison;
  if (cmp === undefined) {
    lines.push("");
    lines.push("No retrieval A/B scored — that needs the local model. Re-run with --score.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("");
  lines.push("Retrieval A/B — can the model name the right file WITHOUT reading it?");
  lines.push("");
  lines.push(
    `  chooser model         ${cmp.candidate.model ?? cmp.baseline.model ?? "unavailable"} (role: ${cmp.role})`,
  );
  lines.push(`  cases x repeats       ${report.cases} x ${cmp.candidate.repeats}`);
  lines.push(
    `  context tokens        paths ~${cmp.baseline.contextTokens} -> map ~${cmp.candidate.contextTokens}` +
      " (mean per call)",
  );
  lines.push(
    `  accuracy              ${pct(cmp.baseline.accuracy)} -> ${pct(cmp.candidate.accuracy)}` +
      `  (${signedPct(cmp.accuracyDelta)})`,
  );
  lines.push(
    `  correct / scored      ${cmp.baseline.correct}/${cmp.baseline.scored} -> ` +
      `${cmp.candidate.correct}/${cmp.candidate.scored}`,
  );
  if (cmp.baseline.errors > 0 || cmp.candidate.errors > 0) {
    lines.push(
      `  chooser errors        ${cmp.baseline.errors} paths, ${cmp.candidate.errors} map` +
        "   (excluded, never scored as wrong)",
    );
  }
  lines.push(`  resolution            ${pct(cmp.resolution)} = one case`);
  lines.push("");
  lines.push(`  verdict               ${cmp.verdict.toUpperCase()}`);
  for (const note of cmp.notes) lines.push(`    ! ${note}`);
  lines.push("");
  lines.push("  Cases the map got right and the path list did not:");
  const pathsCorrect = new Set(cmp.baseline.outcomes.filter((o) => o.correct).map((o) => o.id));
  const mapCorrect = new Set(cmp.candidate.outcomes.filter((o) => o.correct).map((o) => o.id));
  const gained = [...mapCorrect].filter((id) => !pathsCorrect.has(id)).sort();
  const lost = [...pathsCorrect].filter((id) => !mapCorrect.has(id)).sort();
  lines.push(`    gained: ${gained.length === 0 ? "none" : gained.join(", ")}`);
  lines.push(`    lost:   ${lost.length === 0 ? "none" : lost.join(", ")}`);
  lines.push("");
  lines.push("  The chooser is a LOCAL model, not the model that reads a map in production,");
  lines.push("  and the expected paths are hand-labelled against this repo. Treat a null");
  lines.push("  result as weak evidence, not proof.");
  return `${lines.join("\n")}\n`;
}
