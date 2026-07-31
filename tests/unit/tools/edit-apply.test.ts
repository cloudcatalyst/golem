/**
 * R8.7 — the validator, which is the only thing standing between a local
 * model's guess and the user's source file.
 *
 * The task document's hard constraint is that validation is Golem's, not the
 * model's, so these tests pin the refusals rather than the applies:
 *
 *  - a search text that matches twice must NOT pick one ("ambiguous");
 *  - a search text that matches zero times must not be "helpfully" fuzzy-matched;
 *  - an edit that changes nothing is a failure, not a success;
 *  - "tree-sitter could not check" must never be reported as "parsed clean" —
 *    the three-way probe return is load-bearing;
 *  - bytes outside the matched span, and the file's newline style, survive.
 */

import { describe, expect, it } from "vitest";
import {
  countOccurrences,
  findTrimmedSpan,
  type ProposedEdit,
  validateEdits,
} from "../../../src/tools/index.js";

const FILE = ["export function f(a: number): number {", "  return a + 1;", "}", ""].join("\n");

function edit(search: string | null, replace: string): ProposedEdit {
  return { path: "src/f.ts", search, replace };
}

describe("countOccurrences", () => {
  it("counts non-overlapping hits and treats the empty needle as no match", () => {
    expect(countOccurrences("aXbXc", "X")).toBe(2);
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("abc", "")).toBe(0);
  });
});

describe("findTrimmedSpan", () => {
  it("locates a span whose only difference is trailing whitespace", () => {
    expect(findTrimmedSpan(["a  ", "b"], ["a", "b"])).toEqual({ start: 0, end: 2 });
  });

  it('returns "ambiguous" rather than the first of two matches', () => {
    expect(findTrimmedSpan(["a", "a"], ["a"])).toBe("ambiguous");
  });

  it("returns null when the needle is longer than the haystack", () => {
    expect(findTrimmedSpan(["a"], ["a", "b"])).toBeNull();
  });
});

describe("validateEdits", () => {
  it("applies a unique exact match and preserves every other byte", async () => {
    const result = await validateEdits({
      before: FILE,
      edits: [edit("  return a + 1;", "  return a + 2;")],
    });
    expect(result.status).toBe("valid");
    expect(result.matchedBy).toBe("exact");
    expect(result.after).toBe(FILE.replace("a + 1", "a + 2"));
    expect(result.hunks).toBe(1);
  });

  it("refuses an ambiguous search instead of editing the first hit", async () => {
    const before = "const a = 1;\nconst a = 1;\n";
    const result = await validateEdits({ before, edits: [edit("const a = 1;", "const a = 2;")] });
    expect(result.status).toBe("ambiguous");
    expect(result.after).toBeNull();
    expect(result.reason).toContain("occurs 2 times");
  });

  it("refuses a search text that is not in the file", async () => {
    const result = await validateEdits({ before: FILE, edits: [edit("return b + 1;", "x")] });
    expect(result.status).toBe("no-match");
    expect(result.after).toBeNull();
  });

  it("does not fuzz trailing whitespace unless asked to", async () => {
    const strict = await validateEdits({
      before: FILE,
      edits: [edit("  return a + 1;   ", "  return a + 2;")],
      matchStrategy: "exact",
    });
    expect(strict.status).toBe("no-match");

    const lenient = await validateEdits({
      before: FILE,
      edits: [edit("  return a + 1;   ", "  return a + 2;")],
      matchStrategy: "exact-then-trimmed",
    });
    expect(lenient.status).toBe("valid");
    expect(lenient.matchedBy).toBe("exact-then-trimmed");
    expect(lenient.after).toBe(FILE.replace("a + 1", "a + 2"));
  });

  it("still refuses an ambiguous match under the lenient strategy", async () => {
    const result = await validateEdits({
      before: "x  \nx\n",
      edits: [edit("x", "y")],
      matchStrategy: "exact-then-trimmed",
    });
    expect(result.status).toBe("ambiguous");
  });

  it("calls an edit that changes nothing a failure", async () => {
    const result = await validateEdits({
      before: FILE,
      edits: [edit("  return a + 1;", "  return a + 1;")],
    });
    expect(result.status).toBe("no-change");
  });

  it("reports no edits as empty-reply", async () => {
    const result = await validateEdits({ before: FILE, edits: [] });
    expect(result.status).toBe("empty-reply");
    expect(result.hunks).toBe(0);
  });

  it("applies hunks in order and stops at the first that cannot be applied", async () => {
    const result = await validateEdits({
      before: FILE,
      edits: [edit("a + 1", "a + 2"), edit("nowhere", "x")],
    });
    expect(result.status).toBe("no-match");
    expect(result.hunks).toBe(1);
    expect(result.reason).toContain("hunk 2");
  });

  it("replaces the whole file when search is null", async () => {
    const result = await validateEdits({
      before: FILE,
      edits: [edit(null, "export const a = 1;\n")],
    });
    expect(result.status).toBe("valid");
    expect(result.matchedBy).toBe("whole-file");
    expect(result.after).toBe("export const a = 1;\n");
  });

  it("keeps the file's CRLF style rather than rewriting every line ending", async () => {
    const crlf = FILE.replace(/\n/g, "\r\n");
    const result = await validateEdits({
      before: crlf,
      edits: [edit("  return a + 1;", "  return a + 2;")],
    });
    expect(result.status).toBe("valid");
    expect(result.after).toBe(crlf.replace("a + 1", "a + 2"));
    expect(result.after?.includes("\n\n")).toBe(false);
  });

  it("rejects a result that no longer parses", async () => {
    const result = await validateEdits({
      before: FILE,
      edits: [edit("  return a + 1;", "  return a + ;")],
      ext: ".ts",
      parseCheck: async () => true,
    });
    expect(result.status).toBe("parse-error");
    expect(result.parseChecked).toBe(true);
    // Returned for reporting, but the status is what a caller must key on.
    expect(result.after).not.toBeNull();
  });

  it("never reports an unavailable syntax check as clean", async () => {
    const result = await validateEdits({
      before: FILE,
      edits: [edit("a + 1", "a + 2")],
      ext: ".ts",
      parseCheck: async () => null,
    });
    expect(result.status).toBe("valid");
    expect(result.parseChecked).toBe(false);
    expect(result.reason).toContain("syntax check was unavailable");
  });

  it("treats a throwing probe as unavailable, not as clean", async () => {
    const result = await validateEdits({
      before: FILE,
      edits: [edit("a + 1", "a + 2")],
      ext: ".ts",
      parseCheck: async () => {
        throw new Error("wasm blew up");
      },
    });
    expect(result.status).toBe("valid");
    expect(result.parseChecked).toBe(false);
  });

  it("marks a clean parse as checked, with no caveat", async () => {
    const result = await validateEdits({
      before: FILE,
      edits: [edit("a + 1", "a + 2")],
      ext: ".ts",
      parseCheck: async () => false,
    });
    expect(result.status).toBe("valid");
    expect(result.parseChecked).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("refuses a rewrite that silently drops an unrelated definition", async () => {
    // The "// ...rest of the file unchanged" failure: parses fine, deletes code.
    const result = await validateEdits({
      before: FILE,
      edits: [edit(null, "export function g(): void {}\n")],
      ext: ".ts",
      parseCheck: async () => false,
      symbolCheck: async (_ext, content) => (content.includes("function f") ? ["f"] : ["g"]),
    });
    expect(result.status).toBe("symbols-lost");
    expect(result.reason).toContain("no longer defines f");
  });

  it("permits symbol loss only when the caller explicitly asks for it", async () => {
    const result = await validateEdits({
      before: FILE,
      edits: [edit(null, "export function g(): void {}\n")],
      ext: ".ts",
      parseCheck: async () => false,
      symbolCheck: async (_ext, content) => (content.includes("function f") ? ["f"] : ["g"]),
      allowSymbolLoss: true,
    });
    expect(result.status).toBe("valid");
  });

  it("does not accuse an edit of losing symbols when the lister is unavailable", async () => {
    const result = await validateEdits({
      before: FILE,
      edits: [edit(null, "export function g(): void {}\n")],
      ext: ".ts",
      symbolCheck: async () => null,
    });
    expect(result.status).toBe("valid");
  });

  it("allows an edit that only ADDS a definition", async () => {
    const result = await validateEdits({
      before: FILE,
      edits: [edit("export function f", "const K = 1;\nexport function f")],
      ext: ".ts",
      symbolCheck: async (_ext, content) => (content.includes("const K") ? ["K", "f"] : ["f"]),
    });
    expect(result.status).toBe("valid");
  });

  it("never throws and never touches the filesystem for a regex-shaped search", async () => {
    const before = "const re = /a$/u;\n";
    const result = await validateEdits({ before, edits: [edit("/a$/u", "/b$/u")] });
    expect(result.status).toBe("valid");
    expect(result.after).toBe("const re = /b$/u;\n");
  });
});
