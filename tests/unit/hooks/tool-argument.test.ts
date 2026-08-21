/**
 * R12.2 — the one argument a human must judge.
 *
 * ADR-0006 §2 requires an `unknown`-class command to reach a remote screen as
 * FULL TEXT, never a summary, so these tests are mostly about verbatimness: the
 * command comes back exactly as it went in, and the only transformation is a
 * visible cap on absurd lengths.
 */

import { describe, expect, it } from "vitest";
import { MAX_ARGUMENT_CHARS, toolArgument } from "../../../src/hooks/index.js";

describe("toolArgument", () => {
  it("returns a Bash command verbatim, not a description of it", () => {
    const command = "curl -X POST https://example.test/a?b=c -d '{\"x\":1}' | jq .";
    expect(toolArgument("Bash", { command })).toBe(command);
  });

  it.each([
    ["Read", { file_path: "/repo/src/x.ts" }, "/repo/src/x.ts"],
    ["Write", { file_path: "/repo/src/x.ts", content: "…" }, "/repo/src/x.ts"],
    ["Edit", { file_path: "/repo/src/x.ts", old_string: "a" }, "/repo/src/x.ts"],
    ["WebFetch", { url: "https://example.test/", prompt: "summarise" }, "https://example.test/"],
    ["Glob", { pattern: "**/*.ts" }, "**/*.ts"],
    ["Grep", { pattern: "TODO", path: "/repo" }, "TODO"],
  ])("picks the judgement-relevant field for %s", (tool, input, expected) => {
    expect(toolArgument(tool, input)).toBe(expected);
  });

  it("falls back to a generic field list for a tool it has never heard of", () => {
    // An MCP tool from another server, or a new built-in: better a recognisable
    // answer than none.
    expect(toolArgument("mcp__other__thing", { url: "https://example.test/" })).toBe(
      "https://example.test/",
    );
  });

  it("serializes an input with no recognised field rather than giving up", () => {
    // "We cannot tell you what this is" is a worse answer for someone holding a
    // permission prompt than an ugly one.
    expect(toolArgument("Weird", { alpha: 1, beta: true })).toBe('{"alpha":1,"beta":true}');
  });

  it("returns undefined for input that carries nothing at all", () => {
    expect(toolArgument("Bash", undefined)).toBeUndefined();
    expect(toolArgument("Bash", "a string")).toBeUndefined();
    expect(toolArgument("Bash", [1, 2])).toBeUndefined();
    expect(toolArgument("Bash", {})).toBeUndefined();
  });

  it("skips an empty string and keeps looking", () => {
    expect(toolArgument("WebFetch", { url: "", query: "golem" })).toBe("golem");
  });

  it("caps an absurd argument VISIBLY rather than silently", () => {
    const long = "x".repeat(MAX_ARGUMENT_CHARS + 500);
    const out = toolArgument("Bash", { command: long });
    expect(out).toContain("…[truncated]");
    expect(out?.startsWith("x".repeat(MAX_ARGUMENT_CHARS))).toBe(true);
    expect(out?.length).toBeLessThan(long.length);
  });

  it("leaves an argument exactly at the cap untouched", () => {
    const exact = "y".repeat(MAX_ARGUMENT_CHARS);
    expect(toolArgument("Bash", { command: exact })).toBe(exact);
  });
});
