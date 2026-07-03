/** A2 unit tests for the pure lossless compaction transform. */

import { describe, expect, it } from "vitest";
import { compactText } from "../../../src/compression/index.js";

describe("compactText", () => {
  it("strips trailing spaces and tabs at line ends", () => {
    expect(compactText("a  \nb\t\nc")).toBe("a\nb\nc");
  });

  it("preserves CRLF line endings", () => {
    expect(compactText("a  \r\nb\t\r\nc")).toBe("a\r\nb\r\nc");
  });

  it("collapses runs of 3+ newlines to one blank line", () => {
    expect(compactText("a\n\n\n\n\nb")).toBe("a\n\nb");
    expect(compactText("a\r\n\r\n\r\n\r\nb")).toBe("a\r\n\r\nb");
  });

  it("keeps single blank lines untouched", () => {
    expect(compactText("a\n\nb")).toBe("a\n\nb");
  });

  it("strips trailing whitespace at the very end", () => {
    expect(compactText("a\n\n  \t")).toBe("a");
  });

  it("is the identity on already-compact text", () => {
    const text = "line 1\nline 2\n\nline 3";
    expect(compactText(text)).toBe(text);
  });

  it("is idempotent", () => {
    const messy = "  a  \n\n\n\n\tb\t\r\n\r\n\r\n\r\nc   \n\n\n";
    const once = compactText(messy);
    expect(compactText(once)).toBe(once);
  });

  it("never touches non-whitespace bytes", () => {
    const messy = "err  \n\n\n\nmore";
    expect(compactText(messy).replace(/\s+/g, "")).toBe(messy.replace(/\s+/g, ""));
  });
});
