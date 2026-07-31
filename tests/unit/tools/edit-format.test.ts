/**
 * R8.7 — the reply parsers, pinned against the ways a small model actually
 * fails.
 *
 * These are the parsers that stand between an untrusted 7B-class reply and a
 * file on disk, so the tests here are about *refusal*, not about happy paths:
 * a truncated block, a hunk whose `@@` header lies, a fence that never closes.
 * Each must land in `problems` and produce no edit — a parser that silently
 * yields nothing reads to the harness as "the model chose to change nothing",
 * which would score a failure as a pass.
 */

import { describe, expect, it } from "vitest";
import { EDIT_FORMATS, isEditFormat, parseEditReply } from "../../../src/tools/index.js";

describe("edit format registry", () => {
  it("names exactly the three measured formats", () => {
    expect([...EDIT_FORMATS]).toEqual(["search-replace", "udiff", "whole"]);
  });

  it("rejects an unknown format name", () => {
    expect(isEditFormat("search-replace")).toBe(true);
    expect(isEditFormat("diff-fenced")).toBe(false);
  });
});

describe("parseEditReply — search-replace", () => {
  it("reads one block, keeping the search text byte for byte", () => {
    const reply = [
      "src/a.ts",
      "<<<<<<< SEARCH",
      "  const t = 1;",
      "=======",
      "  const tokens = 1;",
      ">>>>>>> REPLACE",
    ].join("\n");
    const parsed = parseEditReply("search-replace", reply);
    expect(parsed.problems).toEqual([]);
    expect(parsed.edits).toEqual([
      { path: "src/a.ts", search: "  const t = 1;", replace: "  const tokens = 1;" },
    ]);
  });

  it("tolerates prose around the block and a ./ prefixed path", () => {
    const reply = [
      "Sure! Here is the change:",
      "./src/a.ts",
      "<<<<<<< SEARCH",
      "a",
      "=======",
      "b",
      ">>>>>>> REPLACE",
      "Let me know if you want anything else.",
    ].join("\n");
    const parsed = parseEditReply("search-replace", reply);
    expect(parsed.edits).toHaveLength(1);
    expect(parsed.edits[0]?.path).toBe("src/a.ts");
  });

  it("reads several blocks in order", () => {
    const reply = [
      "src/a.ts",
      "<<<<<<< SEARCH",
      "one",
      "=======",
      "1",
      ">>>>>>> REPLACE",
      "src/a.ts",
      "<<<<<<< SEARCH",
      "two",
      "=======",
      "2",
      ">>>>>>> REPLACE",
    ].join("\n");
    const parsed = parseEditReply("search-replace", reply);
    expect(parsed.edits.map((e) => e.search)).toEqual(["one", "two"]);
  });

  it("refuses a truncated block instead of guessing the missing half", () => {
    const reply = ["src/a.ts", "<<<<<<< SEARCH", "one", "=======", "1"].join("\n");
    const parsed = parseEditReply("search-replace", reply);
    expect(parsed.edits).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("truncated");
  });

  it("refuses an empty SEARCH — it would match everywhere", () => {
    const reply = ["src/a.ts", "<<<<<<< SEARCH", "", "=======", "added", ">>>>>>> REPLACE"].join(
      "\n",
    );
    const parsed = parseEditReply("search-replace", reply);
    expect(parsed.edits).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("empty SEARCH");
  });

  it("reports a block with no file path rather than inventing one", () => {
    const reply = ["<<<<<<< SEARCH", "one", "=======", "1", ">>>>>>> REPLACE"].join("\n");
    const parsed = parseEditReply("search-replace", reply);
    expect(parsed.edits).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("no file path");
  });

  it("says so when the reply is in some other shape entirely", () => {
    // The measured failure mode: qwen2.5-coder:7b answers with a whole file.
    const parsed = parseEditReply("search-replace", "src/a.ts\n```\nwhole file\n```\n");
    expect(parsed.edits).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("<<<<<<< SEARCH");
  });
});

describe("parseEditReply — udiff", () => {
  it("reconstructs search/replace from the hunk body, ignoring the @@ header", () => {
    const reply = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -900,9 +900,9 @@", // deliberately nonsense line numbers
      " function f() {",
      "-  return 1;",
      "+  return 2;",
      " }",
    ].join("\n");
    const parsed = parseEditReply("udiff", reply);
    expect(parsed.problems).toEqual([]);
    expect(parsed.edits).toEqual([
      {
        path: "src/a.ts",
        search: "function f() {\n  return 1;\n}",
        replace: "function f() {\n  return 2;\n}",
      },
    ]);
  });

  it("splits multiple hunks in one file", () => {
    const reply = [
      "--- src/a.ts",
      "+++ src/a.ts",
      "@@ ... @@",
      "-one",
      "+1",
      "@@ ... @@",
      "-two",
      "+2",
    ].join("\n");
    const parsed = parseEditReply("udiff", reply);
    expect(parsed.edits.map((e) => e.replace)).toEqual(["1", "2"]);
  });

  it("refuses a hunk that is all additions — nothing locates it", () => {
    const reply = ["--- src/a.ts", "+++ src/a.ts", "@@ ... @@", "+added", "+more"].join("\n");
    const parsed = parseEditReply("udiff", reply);
    expect(parsed.edits).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("no context or removed lines");
  });

  it("reports a line inside a hunk with no diff marker", () => {
    const reply = ["--- src/a.ts", "+++ src/a.ts", "@@ ... @@", "-one", "oops no marker"].join(
      "\n",
    );
    const parsed = parseEditReply("udiff", reply);
    expect(parsed.problems.join(" ")).toContain("neither space");
  });

  it("says so when there is no hunk at all", () => {
    const parsed = parseEditReply("udiff", "I would change line 4.");
    expect(parsed.edits).toEqual([]);
    expect(parsed.problems).toEqual(["no diff hunk in the reply"]);
  });
});

describe("parseEditReply — whole", () => {
  it("takes the fenced body as the new file and normalizes the final newline", () => {
    const parsed = parseEditReply("whole", "src/a.ts\n```ts\nexport const a = 1;\n```\n");
    expect(parsed.edits).toEqual([
      { path: "src/a.ts", search: null, replace: "export const a = 1;\n" },
    ]);
  });

  it("refuses an unterminated fence — writing a truncated reply truncates the file", () => {
    const parsed = parseEditReply("whole", "src/a.ts\n```ts\nexport const a = 1;");
    expect(parsed.edits).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("truncated");
  });

  it("refuses a fenced body with no path before it", () => {
    const parsed = parseEditReply("whole", "```\nexport const a = 1;\n```");
    expect(parsed.edits).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("no file path");
  });

  it("accepts a bare (unfenced) file when a path is present", () => {
    const parsed = parseEditReply("whole", "src/a.ts\nexport const a = 1;\n");
    expect(parsed.edits[0]?.replace).toBe("export const a = 1;\n");
  });

  it("refuses prose with no path and no fence", () => {
    const parsed = parseEditReply("whole", "I have updated the file for you.");
    expect(parsed.edits).toEqual([]);
    expect(parsed.problems).toHaveLength(1);
  });
});
