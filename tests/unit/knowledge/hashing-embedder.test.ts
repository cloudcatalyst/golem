/**
 * Pure-TS hashing embedder — the zero-setup default. Asserts the properties the
 * KB relies on: fixed dimension, unit-normalized, deterministic across calls, and
 * that lexical overlap actually drives cosine similarity (so code search works).
 */

import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  DEFAULT_HASH_DIM,
  hashEmbed,
  hashingEmbedFn,
  tokenize,
} from "../../../src/knowledge/index.js";

describe("hashing embedder", () => {
  it("tokenizes code identifiers (splits camelCase, drops punctuation/short)", () => {
    expect(tokenize("verifyPassword(user, secret)")).toStrictEqual([
      "verify",
      "password",
      "user",
      "secret",
    ]);
    expect(tokenize("fooBar_baz-qux")).toStrictEqual(["foo", "bar", "baz", "qux"]);
  });

  it("produces a fixed-dim, unit-length vector", () => {
    const v = hashEmbed("some indexable text here");
    expect(v).toHaveLength(DEFAULT_HASH_DIM);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("is deterministic across calls (persisted index stays queryable)", () => {
    expect(hashEmbed("stable text")).toStrictEqual(hashEmbed("stable text"));
  });

  it("ranks lexically-overlapping text higher by cosine", async () => {
    const embed = hashingEmbedFn();
    const [query, related, unrelated] = await embed(
      [
        "verify password argon2 hash",
        "function verifyPassword checks the argon2 hash",
        "render the dashboard chart legend colors",
      ],
      "text",
    );
    const relatedScore = cosineSimilarity(query ?? [], related ?? []);
    const unrelatedScore = cosineSimilarity(query ?? [], unrelated ?? []);
    expect(relatedScore).toBeGreaterThan(unrelatedScore);
    expect(relatedScore).toBeGreaterThan(0);
  });

  it("empty text yields a zero vector (cosine 0, never NaN)", () => {
    const v = hashEmbed("   ");
    expect(v.every((x) => x === 0)).toBe(true);
    expect(cosineSimilarity(v, hashEmbed("anything"))).toBe(0);
  });
});
