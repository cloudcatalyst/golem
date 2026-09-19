/**
 * What the style analyzer is allowed to claim.
 *
 * It has no parser, so its whole defence is that it only counts things it can
 * actually see, and that the guideline it renders carries the evidence for each
 * row. The risk is not a wrong number — it is a number that looks authoritative
 * while measuring the wrong lines. That is what these tests pin.
 */

import { describe, expect, it } from "vitest";
import {
  dominantIndentWidth,
  emptyObservation,
  mergeObservations,
  observeSource,
  renderFormattingGuideline,
} from "../../src/vibe/index.js";

describe("observeSource", () => {
  it("reads the indent width from code lines, not from JSDoc continuations", () => {
    // Every ` * ` line is indented ONE space to align its asterisk. Counting
    // those made Golem's own 2-space source report no agreed width at all
    // (smoke test, 2026-09-13) — the majority of lines in a well-commented
    // file are comment lines, so they decided the vote.
    const text = [
      "/**",
      " * A documented function.",
      " * With a second line.",
      " */",
      "function f() {",
      "  const a = 1;",
      "  if (a) {",
      "    return a;",
      "  }",
      "}",
    ].join("\n");

    const o = observeSource(text);

    expect(dominantIndentWidth(o)).toBe(2);
    expect(o.commentBlock).toBe(4);
  });

  it("tells 4-space apart from 2-space, which the largest-agreed-width rule exists for", () => {
    const four = ["function f() {", "    const a = 1;", "    return a;", "}"].join("\n");

    expect(dominantIndentWidth(observeSource(four))).toBe(4);
  });

  it("counts tabs as tabs", () => {
    const o = observeSource(["function f() {", "\tconst a = 1;", "}"].join("\n"));

    expect(o.indentTabs).toBe(1);
    expect(o.indentSpaces).toBe(0);
  });

  it("does not let prose inside comments vote on quote style", () => {
    const o = observeSource(
      ["// it's a comment with apostrophes, isn't it", 'const a = "x";'].join("\n"),
    );

    expect(o.quoteSingle).toBe(0);
    expect(o.quoteDouble).toBe(2);
  });

  it("counts a semicolon only where ending in one was a real choice", () => {
    // A line ending in `{` or `,`, or one that is nothing but a closing brace,
    // could not have taken a semicolon either way. Counting those as candidates
    // dragged every file toward 50% — caught by this test, 2026-09-13.
    const o = observeSource(["function f() {", "  const a = 1;", "  return a", "}"].join("\n"));

    expect(o.terminatorCandidates).toBe(2);
    expect(o.semicolonLines).toBe(1);
  });
});

describe("mergeObservations", () => {
  it("sums counters and keeps the longest line", () => {
    const a = observeSource("const a = 1;\n");
    const b = observeSource(`const b = "${"x".repeat(200)}";\n`);

    const merged = mergeObservations(a, b);

    expect(merged.files).toBe(2);
    expect(merged.widthMax).toBe(b.widthMax);
    expect(merged.lines).toBe(a.lines + b.lines);
  });
});

describe("renderFormattingGuideline", () => {
  it("carries the evidence for every claim, so weak signals are visible as weak", () => {
    const page = renderFormattingGuideline(observeSource("const a = 1;\n"), "2026-09-13");

    expect(page).toContain("Counted from 1 file(s) and 1 non-blank lines, on 2026-09-13.");
    expect(page).toContain("not a parse");
  });

  it("says so rather than dividing by zero when there is nothing to measure", () => {
    const page = renderFormattingGuideline(emptyObservation(), "2026-09-13");

    expect(page).toContain("no comments seen");
    expect(page).not.toContain("NaN");
  });
});
