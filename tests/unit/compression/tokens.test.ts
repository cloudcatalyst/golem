/**
 * A2 — estimateTokens must stay a pure, deterministic function of its input
 * (dedup markers embed the estimated count; see tokens.ts docstring and
 * verification-notes.md §14). Direct unit coverage for the ~4 chars/token
 * heuristic, which was previously only exercised indirectly via other
 * modules' tests.
 */

import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../../src/compression/tokens.js";

describe("estimateTokens", () => {
  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("floors at 1 for a non-empty string shorter than 4 chars", () => {
    expect(estimateTokens("a")).toBe(1);
  });

  it("returns 1 for a string of exactly 4 chars", () => {
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("rounds up (ceil) rather than truncating for 5 chars", () => {
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("matches Math.ceil(length / 4) for a longer string of known length", () => {
    const text = "x".repeat(100);
    expect(estimateTokens(text)).toBe(Math.ceil(100 / 4));
    expect(estimateTokens(text)).toBe(25);
  });

  it("is deterministic across repeated calls on the same input", () => {
    const text = "some deterministic input text for cache prefix stability";
    expect(estimateTokens(text)).toBe(estimateTokens(text));
  });
});
