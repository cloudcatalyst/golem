/**
 * R8.7's gate — **the harness, and it comes before the feature.**
 *
 * The task document says HARNESS BEFORE CODE, non-negotiable, and names the
 * precedent: the tools-block shrinker was rejected on its own harness (§89) and
 * R8.S1 was rejected on arithmetic (§100). So this module answers the question
 * that decides whether an `edit` mode exists at all:
 *
 *   Can the LOCAL model turn a ~50-token instruction into an edit that Golem's
 *   validator accepts AND that a human would recognise as the right edit?
 *
 * Three things make that measurable rather than rhetorical:
 *
 *  - **The format is an independent variable.** Every case is run through all
 *    three formats (`search-replace`, `udiff`, `whole`) against the same model
 *    in the same run, the way Aider treats format as measured rather than
 *    assumed. `whole` is the control: it always applies, so any gap between it
 *    and the other two is the *format's* cost, not the model's.
 *  - **Two accuracy numbers, never one.** `apply-success` is what Golem's
 *    validator can enforce; **semantic correctness** is what it cannot, and it is
 *    the binding metric — a validated edit that does the wrong thing is the only
 *    failure mode that reaches the user's code. The strict `exact` rate against
 *    the hand-written edit is reported beside it, because "matched the human
 *    byte for byte" and "did something defensible" are different claims.
 *  - **The bar is pre-registered** ({@link EDIT_BAR}) and printed in the report,
 *    so the verdict cannot be chosen after seeing the numbers.
 *
 * Honest scoping, in the report and here:
 *  - A model error (endpoint down, role unavailable) is an `error`, excluded from
 *    every rate — "the drafter was down" is not "the drafter edited badly" — and
 *    the verdict refuses to stand when scoring those errors adversarially could
 *    flip it, the guard `benchRepoMap` already uses.
 *  - §100's failure mode is checked explicitly: if all three formats produce
 *    *identical per-case outcomes*, the instrument cannot see the variable it
 *    was built to measure, and a flat result is reported as insensitive rather
 *    than as "format doesn't matter".
 *  - Nothing here writes to disk. The fixtures are strings; the validator
 *    returns proposed content. Whether an `edit` mode may ever write is a
 *    separate, gated decision (ADR-0002).
 */

import { caseResolution, pct, worstCaseRate } from "../bench/stats.js";
import { estimateTokens } from "../compression/tokens.js";
import type { InferenceService, Role } from "../interfaces/index.js";
import type { EditStatus, MatchStrategy } from "./edit-apply.js";
import { validateEdits } from "./edit-apply.js";
import type { EditCase } from "./edit-cases.js";
import {
  EDIT_FORMATS,
  type EditFormat,
  editFormatInstructions,
  parseEditReply,
} from "./edit-format.js";

/**
 * The bar, fixed BEFORE the first run (R8.7's "be willing to publish a
 * negative"). Semantic correctness dominates because it is the failure Golem's
 * validator cannot catch; apply-success is a floor, not a goal — a model that
 * applies 100% of the time and means the wrong thing is worse than one that
 * fails loudly.
 */
export const EDIT_BAR = {
  /** Ship the `edit` mode only above BOTH of these, for at least one format. */
  shipSemantic: 0.8,
  shipApply: 0.7,
  /** Below `shipSemantic` but above this → the block is shown, never applied. */
  advisorySemantic: 0.5,
} as const;

export type EditVerdict = "ship" | "advisory-only" | "reject" | "inconclusive";

export interface EditOutcome {
  readonly id: string;
  readonly format: EditFormat;
  /** Validator status, or `unparsed` when no edit could be read from the reply. */
  readonly status: EditStatus | "unparsed";
  readonly applied: boolean;
  /** Byte-equal (modulo trailing whitespace) to the hand-written edit. */
  readonly exact: boolean;
  /** Every hand-written assertion held on the applied result. */
  readonly semantic: boolean;
  readonly matchedBy: MatchStrategy | "whole-file" | null;
  /** Local model output tokens — free in money, not in latency. */
  readonly replyTokens: number;
  /** Which assertion failed, or why the reply was unusable. */
  readonly reason: string | null;
  /** Set only when the model itself could not be reached. */
  readonly error?: string;
}

export interface EditRun {
  readonly format: EditFormat;
  /** The concrete local model — an edit rate is model-specific, so it is named. */
  readonly model: string | null;
  readonly repeats: number;
  readonly attempts: number;
  /** Attempts excluding model errors — the denominator of every rate below. */
  readonly scored: number;
  readonly errors: number;
  /**
   * Replies that were in the requested format at all. Separated from `applied`
   * because the two failures have different fixes: non-compliance is a prompt /
   * model-choice problem, while a compliant reply that will not apply is a
   * copying-accuracy problem. §100's lesson is that an aggregate hides which.
   */
  readonly compliant: number;
  readonly complianceRate: number | null;
  readonly applied: number;
  readonly exact: number;
  readonly semantic: number;
  readonly applyRate: number | null;
  readonly exactRate: number | null;
  readonly semanticRate: number | null;
  /** Applied only because trailing whitespace was ignored — fragility, counted. */
  readonly lenientMatches: number;
  /** Applies where tree-sitter could not check syntax (grammars absent). */
  readonly parseUnavailable: number;
  /**
   * True when every repeat pass produced identical per-case outcomes.
   *
   * At `temperature: 0` this is the expected result, and it is worth stating
   * because it bounds what `--repeats` can buy: reproducibility evidence, NOT
   * statistical power. More passes over a deterministic model do not shrink the
   * case set's resolution — only more cases do.
   */
  readonly deterministic: boolean | null;
  readonly meanReplyTokens: number;
  readonly outcomes: readonly EditOutcome[];
}

export interface EditBenchReport {
  readonly cases: number;
  readonly role: Role;
  readonly matchStrategy: MatchStrategy;
  readonly repeats: number;
  /** Mean tokens of the instruction — what the frontier model WOULD emit. */
  readonly meanInstructionTokens: number;
  /** Mean tokens of the hand-written edit — what it emits today. */
  readonly meanExpectedEditTokens: number;
  /** Mean tokens of a fixture — what re-emitting the whole file would cost. */
  readonly meanFixtureTokens: number;
  readonly runs: readonly EditRun[];
  readonly best: EditFormat | null;
  readonly verdict: EditVerdict;
  readonly notes: readonly string[];
  readonly bar: typeof EDIT_BAR;
}

const ROLE_LINE =
  "You are a code editor. You are given one file and one instruction. Change " +
  "ONLY what the instruction asks for; leave every other line exactly as it is.";

/** Trailing whitespace and final-newline differences are not edits. */
function normalizeForCompare(text: string): string {
  return text
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n+$/u, "\n");
}

function assertionsHold(testCase: EditCase, after: string): string | null {
  for (const assertion of testCase.assertions) {
    if (assertion.contains !== undefined && !after.includes(assertion.contains)) {
      return `missing ${JSON.stringify(assertion.contains)}`;
    }
    if (assertion.absent !== undefined && after.includes(assertion.absent)) {
      return `still contains ${JSON.stringify(assertion.absent)}`;
    }
  }
  return null;
}

function extensionOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot === -1 ? "" : filePath.slice(dot);
}

export interface EditArmOptions {
  readonly inference: InferenceService;
  readonly cases: readonly EditCase[];
  readonly format: EditFormat;
  readonly repeats?: number;
  readonly role?: Role;
  readonly matchStrategy?: MatchStrategy;
  readonly parseCheck?: (ext: string, content: string) => Promise<boolean | null>;
  /** Definition-loss guard — measured WITH the harness, since it would ship on. */
  readonly symbolCheck?: (ext: string, content: string) => Promise<readonly string[] | null>;
}

/** Score one format against the whole case set. Never throws. */
export async function runEditArm(opts: EditArmOptions): Promise<EditRun> {
  const repeats = Math.max(1, opts.repeats ?? 1);
  const role: Role = opts.role ?? "drafter";
  const matchStrategy = opts.matchStrategy ?? "exact-then-trimmed";
  const system = `${ROLE_LINE}\n\n${editFormatInstructions(opts.format)}`;
  const outcomes: EditOutcome[] = [];
  let model: string | null = null;

  for (let pass = 0; pass < repeats; pass += 1) {
    for (const testCase of opts.cases) {
      const user = [
        testCase.path,
        "```",
        testCase.before.replace(/\n$/u, ""),
        "```",
        "",
        `Task: ${testCase.instruction}`,
      ].join("\n");

      let reply: string;
      try {
        const result = await opts.inference.chat(
          role,
          [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          { temperature: 0 },
        );
        reply = result.text;
        model = result.model;
      } catch (err) {
        outcomes.push({
          id: testCase.id,
          format: opts.format,
          status: "unparsed",
          applied: false,
          exact: false,
          semantic: false,
          matchedBy: null,
          replyTokens: 0,
          reason: null,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const replyTokens = estimateTokens(reply);
      const parsed = parseEditReply(opts.format, reply);
      if (parsed.edits.length === 0) {
        outcomes.push({
          id: testCase.id,
          format: opts.format,
          status: "unparsed",
          applied: false,
          exact: false,
          semantic: false,
          matchedBy: null,
          replyTokens,
          reason: parsed.problems[0] ?? "no edit in the reply",
        });
        continue;
      }

      const validated = await validateEdits({
        before: testCase.before,
        edits: parsed.edits,
        ext: extensionOf(testCase.path),
        matchStrategy,
        ...(opts.parseCheck === undefined ? {} : { parseCheck: opts.parseCheck }),
        ...(opts.symbolCheck === undefined ? {} : { symbolCheck: opts.symbolCheck }),
      });
      const after = validated.status === "valid" ? validated.after : null;
      const assertionFailure = after === null ? null : assertionsHold(testCase, after);
      outcomes.push({
        id: testCase.id,
        format: opts.format,
        status: validated.status,
        applied: after !== null,
        exact:
          after !== null && normalizeForCompare(after) === normalizeForCompare(testCase.expected),
        semantic: after !== null && assertionFailure === null,
        matchedBy: validated.matchedBy,
        replyTokens,
        reason: after === null ? validated.reason : assertionFailure,
      });
    }
  }

  // Did the passes agree? Compare each pass's per-case outcome signature.
  let deterministic: boolean | null = null;
  if (repeats > 1 && opts.cases.length > 0) {
    const passSignature = (pass: number): string =>
      outcomes
        .slice(pass * opts.cases.length, (pass + 1) * opts.cases.length)
        .map((o) => `${o.id}:${o.status}:${o.applied ? 1 : 0}${o.semantic ? 1 : 0}`)
        .join("|");
    const first = passSignature(0);
    deterministic = true;
    for (let pass = 1; pass < repeats; pass += 1) {
      if (passSignature(pass) !== first) {
        deterministic = false;
        break;
      }
    }
  }

  const scored = outcomes.filter((o) => o.error === undefined);
  const compliant = scored.filter((o) => o.status !== "unparsed").length;
  const applied = scored.filter((o) => o.applied).length;
  const exact = scored.filter((o) => o.exact).length;
  const semantic = scored.filter((o) => o.semantic).length;
  const replyTokenTotal = scored.reduce((sum, o) => sum + o.replyTokens, 0);
  const rate = (n: number): number | null => (scored.length === 0 ? null : n / scored.length);

  return {
    format: opts.format,
    model,
    repeats,
    attempts: outcomes.length,
    scored: scored.length,
    errors: outcomes.length - scored.length,
    compliant,
    complianceRate: rate(compliant),
    applied,
    exact,
    semantic,
    applyRate: rate(applied),
    exactRate: rate(exact),
    semanticRate: rate(semantic),
    deterministic,
    lenientMatches: scored.filter((o) => o.matchedBy === "exact-then-trimmed").length,
    parseUnavailable: scored.filter(
      (o) => o.applied && o.reason?.includes("syntax check was unavailable"),
    ).length,
    meanReplyTokens: scored.length === 0 ? 0 : Math.round(replyTokenTotal / scored.length),
    outcomes,
  };
}

export interface EditBenchOptions {
  readonly inference: InferenceService;
  readonly cases: readonly EditCase[];
  readonly formats?: readonly EditFormat[];
  readonly repeats?: number;
  readonly role?: Role;
  readonly matchStrategy?: MatchStrategy;
  readonly parseCheck?: (ext: string, content: string) => Promise<boolean | null>;
  /** Definition-loss guard — measured WITH the harness, since it would ship on. */
  readonly symbolCheck?: (ext: string, content: string) => Promise<readonly string[] | null>;
}

/**
 * Run every format arm and apply the pre-registered bar.
 *
 * The winner is the format with the highest semantic rate — not the highest
 * apply rate, which `whole` wins by construction and which says nothing about
 * whether the edit was right.
 */
export async function benchEdits(options: EditBenchOptions): Promise<EditBenchReport> {
  const formats = options.formats ?? EDIT_FORMATS;
  const cases = options.cases;
  const runs: EditRun[] = [];
  for (const format of formats) {
    runs.push(
      await runEditArm({
        inference: options.inference,
        cases,
        format,
        ...(options.repeats === undefined ? {} : { repeats: options.repeats }),
        ...(options.role === undefined ? {} : { role: options.role }),
        ...(options.matchStrategy === undefined ? {} : { matchStrategy: options.matchStrategy }),
        ...(options.parseCheck === undefined ? {} : { parseCheck: options.parseCheck }),
        ...(options.symbolCheck === undefined ? {} : { symbolCheck: options.symbolCheck }),
      }),
    );
  }

  const meanOf = (values: readonly number[]): number =>
    values.length === 0 ? 0 : Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  const notes: string[] = [];

  const scorable = runs.filter((r) => r.semanticRate !== null);
  const best =
    scorable.length === 0
      ? null
      : scorable.reduce((a, b) => ((b.semanticRate ?? 0) > (a.semanticRate ?? 0) ? b : a));

  let verdict: EditVerdict;
  if (best === null) {
    verdict = "inconclusive";
    notes.push("nothing scored in any arm — is the local model reachable? (`golem local status`)");
  } else {
    const semanticRate = best.semanticRate ?? 0;
    const applyRate = best.applyRate ?? 0;
    if (semanticRate >= EDIT_BAR.shipSemantic && applyRate >= EDIT_BAR.shipApply) {
      verdict = "ship";
    } else if (semanticRate >= EDIT_BAR.advisorySemantic) {
      verdict = "advisory-only";
    } else {
      verdict = "reject";
    }

    /**
     * Adverse-case guard (the `benchRepoMap` rule): score every excluded model
     * error the way that hurts the candidate most and see whether the verdict
     * survives. A bar cleared only because three attempts errored out was never
     * cleared.
     *
     * The re-scoring is `src/bench/stats.ts`'s {@link worstCaseRate}, shared
     * with `benchRepoMap`. What follows it is NOT shared: this gate asks
     * whether an adverse rate still clears a pre-registered bar, while
     * `benchRepoMap` asks whether an adverse delta keeps its sign. Same guard,
     * different question.
     */
    if (best.errors > 0) {
      const adverseSemantic = worstCaseRate(best.semantic, best.scored, best.errors) ?? 0;
      const adverseApply = worstCaseRate(best.applied, best.scored, best.errors) ?? 0;
      const adverseVerdict: EditVerdict =
        adverseSemantic >= EDIT_BAR.shipSemantic && adverseApply >= EDIT_BAR.shipApply
          ? "ship"
          : adverseSemantic >= EDIT_BAR.advisorySemantic
            ? "advisory-only"
            : "reject";
      if (adverseVerdict !== verdict) {
        notes.push(
          `${best.errors} model error(s) were excluded from ${best.format}'s rates; scoring them ` +
            `the worst possible way gives "${adverseVerdict}" instead of "${verdict}" — re-run ` +
            "before believing either",
        );
        verdict = "inconclusive";
      } else {
        notes.push(
          `${best.errors} model error(s) excluded; scoring them the worst way still gives ` +
            `"${adverseVerdict}", so they cannot flip this`,
        );
      }
    }
  }

  /**
   * §100's insensitivity check. If the arms agree case for case, the harness is
   * not measuring the format — it is measuring the model, and a flat comparison
   * is a limit of the instrument, not a finding about formats.
   */
  if (runs.length > 1) {
    const signature = (run: EditRun): string =>
      run.outcomes.map((o) => `${o.id}:${o.applied ? 1 : 0}${o.semantic ? 1 : 0}`).join("|");
    const first = runs[0];
    if (first !== undefined && runs.every((r) => signature(r) === signature(first))) {
      notes.push(
        "every format produced IDENTICAL per-case outcomes — the instrument cannot see the " +
          "variable it was built to measure; treat the format comparison as insensitive (§100)",
      );
    }
  }

  const resolution = caseResolution(cases.length);
  if (best !== null && best.semanticRate !== null) {
    const margin = Math.abs(best.semanticRate - EDIT_BAR.shipSemantic);
    if (margin < resolution) {
      notes.push(
        `the winning semantic rate sits within one case (${(resolution * 100).toFixed(1)}%) of the ` +
          "ship bar — this case set cannot resolve that difference; add CASES (see the " +
          "determinism note: repeats will not help)",
      );
    }
  }
  if (runs.some((r) => r.deterministic === true)) {
    notes.push(
      "every repeat pass produced identical outcomes — at temperature 0 the editor is " +
        "deterministic, so --repeats buys reproducibility, NOT statistical power; only more " +
        "cases sharpen this instrument",
    );
  }
  for (const run of runs) {
    if (run.complianceRate !== null && run.complianceRate < 1) {
      notes.push(
        `${run.format}: ${run.scored - run.compliant}/${run.scored} replies were NOT in the ` +
          "requested format — the model answered in some other shape, which is a compliance " +
          "failure, not an editing failure",
      );
    }
  }
  if (best !== null && best.lenientMatches > 0) {
    notes.push(
      `${best.lenientMatches}/${best.scored} of ${best.format}'s applies needed the ` +
        "trailing-whitespace leniency — exact copying is not something this model does reliably",
    );
  }
  if (best !== null && best.parseUnavailable > 0) {
    notes.push(
      `${best.parseUnavailable} applied result(s) could NOT be syntax-checked (tree-sitter ` +
        "grammars absent) — those are unvalidated on the axis that matters most",
    );
  }
  notes.push(
    "semantic correctness is scored against HAND-WRITTEN assertions, not a judge model, and " +
      "the editor is a LOCAL 7B-class model — this measures that model on ~1-file edits, and " +
      "says nothing about the 300-line multi-file edit the memo's arithmetic is about",
  );

  return {
    cases: cases.length,
    role: options.role ?? "drafter",
    matchStrategy: options.matchStrategy ?? "exact-then-trimmed",
    repeats: Math.max(1, options.repeats ?? 1),
    meanInstructionTokens: meanOf(cases.map((c) => estimateTokens(c.instruction))),
    meanExpectedEditTokens: meanOf(cases.map((c) => estimateTokens(c.expected))),
    meanFixtureTokens: meanOf(cases.map((c) => estimateTokens(c.before))),
    runs,
    best: best?.format ?? null,
    verdict,
    notes,
    bar: EDIT_BAR,
  };
}

/** Render the report: cost and accuracy in one view, never one without the other. */
export function renderEditBench(report: EditBenchReport): string {
  const lines: string[] = [];
  lines.push("Golem local editor — R8.7 gate");
  lines.push("");
  lines.push(`  cases x repeats       ${report.cases} x ${report.repeats}`);
  lines.push(
    `  editor model          ${report.runs.find((r) => r.model !== null)?.model ?? "unavailable"}` +
      ` (role: ${report.role})`,
  );
  lines.push(`  match strategy        ${report.matchStrategy}`);
  lines.push("");
  lines.push("  What the frontier model would emit, per edit:");
  lines.push(`    the instruction     ~${report.meanInstructionTokens} output tokens`);
  lines.push(`    the edit by hand    ~${report.meanExpectedEditTokens} output tokens`);
  lines.push(`    the whole file      ~${report.meanFixtureTokens} output tokens`);
  const saved = report.meanExpectedEditTokens - report.meanInstructionTokens;
  lines.push(
    `    so delegating saves ~${saved} output tokens per edit IF the local edit is right, and ` +
      "costs a re-read of the diff to check it",
  );
  lines.push("");
  lines.push("  Format arms (the independent variable):");
  lines.push("");
  lines.push("    format          in-format   apply   exact   semantic   reply tok   errors");
  for (const run of report.runs) {
    lines.push(
      `    ${run.format.padEnd(15)} ${pct(run.complianceRate).padStart(9)}  ` +
        `${pct(run.applyRate).padStart(6)}  ${pct(run.exactRate).padStart(6)}  ` +
        `${pct(run.semanticRate).padStart(8)}   ${String(run.meanReplyTokens).padStart(9)}   ` +
        `${String(run.errors).padStart(6)}`,
    );
  }
  lines.push("");
  lines.push(
    `  pre-registered bar    ship: semantic >= ${pct(report.bar.shipSemantic)} AND apply >= ` +
      `${pct(report.bar.shipApply)}; advisory-only: semantic >= ${pct(report.bar.advisorySemantic)}`,
  );
  lines.push(`  best format           ${report.best ?? "none"}`);
  lines.push(`  verdict               ${report.verdict.toUpperCase()}`);
  for (const note of report.notes) lines.push(`    ! ${note}`);

  const failures = report.runs.flatMap((run) =>
    run.outcomes
      .filter((o) => !o.semantic)
      .map(
        (o) =>
          `    ${run.format}/${o.id}: ${o.error !== undefined ? `model error — ${o.error}` : `${o.status}${o.reason === null ? "" : ` — ${o.reason}`}`}`,
      ),
  );
  if (failures.length > 0) {
    lines.push("");
    lines.push("  Every failure, verbatim (a rate without its failures is not a measurement):");
    for (const failure of failures.slice(0, 40)) lines.push(failure);
    if (failures.length > 40) lines.push(`    … ${failures.length - 40} more`);
  }
  return `${lines.join("\n")}\n`;
}
