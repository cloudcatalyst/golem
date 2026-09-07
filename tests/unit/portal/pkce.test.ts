/**
 * PKCE primitives — the parts an intercepted authorization code depends on.
 *
 * The S256 vector is RFC 7636 Appendix B's, which is the only way to be sure the
 * challenge is `BASE64URL(SHA256(ASCII(verifier)))` and not one of the several
 * near-misses (hex digest, base64 with padding, UTF-16 input) that all produce a
 * plausible-looking string and a server-side rejection.
 */

import { describe, expect, it } from "vitest";
import {
  challengeFor,
  createPkcePair,
  createState,
  statesMatch,
} from "../../../src/portal/index.js";

describe("PKCE", () => {
  it("matches RFC 7636 Appendix B's S256 test vector", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(challengeFor(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates a verifier inside RFC 7636's length range, from unreserved chars", () => {
    const { verifier, method } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    // base64url's alphabet is a strict subset of RFC 3986 `unreserved`, so the
    // verifier needs no further escaping in the token request body.
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(method).toBe("S256");
  });

  it("derives the challenge from the verifier it returns", () => {
    const pair = createPkcePair();
    expect(pair.challenge).toBe(challengeFor(pair.verifier));
    // The challenge must not BE the verifier: sending the verifier to the
    // authorization endpoint would hand an interceptor the secret directly.
    expect(pair.challenge).not.toBe(pair.verifier);
  });

  it("never repeats a verifier or a state across calls", () => {
    const verifiers = new Set(Array.from({ length: 50 }, () => createPkcePair().verifier));
    expect(verifiers.size).toBe(50);
    const states = new Set(Array.from({ length: 50 }, () => createState()));
    expect(states.size).toBe(50);
  });

  it("accepts an injected randomness source, so a flow can be pinned in a test", () => {
    const fixed = (size: number) => Buffer.alloc(size, 7);
    expect(createPkcePair(fixed).verifier).toBe(createPkcePair(fixed).verifier);
  });

  describe("statesMatch", () => {
    it("accepts an identical state", () => {
      const state = createState();
      expect(statesMatch(state, state)).toBe(true);
    });

    it("rejects a different state, a truncated one, and an extended one", () => {
      const state = createState();
      expect(statesMatch(state, createState())).toBe(false);
      expect(statesMatch(state, state.slice(0, -1))).toBe(false);
      expect(statesMatch(state, `${state}x`)).toBe(false);
      expect(statesMatch(state, "")).toBe(false);
    });

    it("rejects a length mismatch without throwing", () => {
      // timingSafeEqual throws on unequal lengths; the wrapper must not.
      expect(() => statesMatch("short", "a-much-longer-value")).not.toThrow();
      expect(statesMatch("short", "a-much-longer-value")).toBe(false);
    });
  });
});
