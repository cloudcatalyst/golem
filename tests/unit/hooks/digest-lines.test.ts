/**
 * R8.3 — line-aware digests that name their ranges.
 *
 * The point is to make the CHEAP recovery obvious. §95 measured one `expand` call
 * at ~6.4k tokens, and `Read` results at 27k across 18 — the surface an external
 * Bash compactor structurally cannot reach (§90). A digest that says which lines it
 * holds lets the model re-read a narrow range instead of pulling the whole original
 * back into context, which is what `.claude/rules/golem-ccr-refs.md` already asks
 * for.
 */

import { describe, expect, it } from "vitest";
import { buildDigest } from "../../../src/hooks/index.js";

const REF = "a".repeat(64);

/** `count` numbered lines, each long enough that only some fit the budget. */
function numbered(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}: ${"x".repeat(200)}`).join("\n");
}

describe("buildDigest — line-aware excerpts", () => {
  it("labels the head and tail with their line ranges and the total", () => {
    const digest = buildDigest("Read", numbered(400), REF);
    expect(digest).toMatch(/--- head: lines 1-\d+ of 400 ---/);
    expect(digest).toMatch(/--- tail: lines \d+-400 of 400 ---/);
  });

  it("names the elided line range and its size", () => {
    expect(buildDigest("Read", numbered(400), REF)).toMatch(
      /\d+ line\(s\) elided \(lines \d+-\d+\)/,
    );
  });

  it("recommends a narrower re-read BEFORE offering expand", () => {
    const digest = buildDigest("Read", numbered(400), REF);
    const prefer = digest.indexOf("PREFER a narrower re-read");
    const expand = digest.indexOf("To expand anyway");
    expect(prefer).toBeGreaterThan(-1);
    expect(expand).toBeGreaterThan(prefer);
    expect(digest).toContain("costs back the tokens this swap saved");
  });

  it("keeps Golem's CCR marker so expand still works", () => {
    expect(buildDigest("Read", numbered(400), REF)).toContain(`hash=${REF}`);
  });

  it("cuts on line boundaries, not mid-line", () => {
    const digest = buildDigest("Read", numbered(400), REF);
    const headBlock = digest.split("--- head: ")[1]?.split("--- tail:")[0] ?? "";
    for (const line of headBlock.split("\n").filter((l) => l.startsWith("line "))) {
      expect(line).toMatch(/^line \d+: x+$/);
    }
  });

  it("still truncates a single enormous line, and marks it partial", () => {
    // A minified bundle is one line. Line alignment must not let it through whole —
    // the first draft of this change did exactly that, and two existing tests
    // caught it.
    const digest = buildDigest("Read", "q".repeat(50_000), REF);
    expect(digest.length).toBeLessThan(10_000);
    expect(digest).toContain("partial");
    expect(digest).not.toContain("--- lines 1-1 of 1 ---");
  });

  it("emits the content once, and says so, when nothing needed eliding", () => {
    const small = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join("\n");
    const digest = buildDigest("Read", small, REF);
    expect(digest).toContain("--- lines 1-5 of 5 ---");
    expect(digest).not.toContain("--- head:");
    expect(digest).toContain("full output above");
  });

  it("is deterministic — prefix stability depends on it (§14)", () => {
    const text = numbered(400);
    expect(buildDigest("Read", text, REF)).toBe(buildDigest("Read", text, REF));
  });

  it("reports the byte, line and token counts of the original", () => {
    const digest = buildDigest("Grep", numbered(400), REF);
    expect(digest).toContain("oversized Grep output");
    expect(digest).toMatch(/\d+ bytes, 400 lines, ~\d+ tokens/);
  });
});
