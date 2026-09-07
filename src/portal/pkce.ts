/**
 * PKCE (RFC 7636) and the single-use `state`.
 *
 * The harness is a PUBLIC client — it ships as source, so it cannot hold a
 * client secret, and PKCE is the only thing standing between an intercepted
 * authorization code and a usable token. Two properties matter here and both are
 * easy to lose by accident:
 *
 * 1. **`S256`, never `plain`.** The portal's authorization server advertises
 *    `code_challenge_methods_supported: ["S256"]` and refuses `plain`, so this
 *    module has no `plain` path to fall into.
 * 2. **The `state` comparison is timing-safe.** It is a short string compared
 *    once per flow, so the timing channel is thin — but `===` on secrets is the
 *    habit that eventually gets applied to something wider, and
 *    `timingSafeEqual` costs nothing here.
 *
 * base64url output is drawn from `A-Za-z0-9-_`, every character of which is
 * `unreserved` per RFC 3986 §2.3, so a verifier needs no further escaping in the
 * form body. 64 random bytes encode to 86 characters, inside RFC 7636's 43–128.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Bytes of entropy behind a `code_verifier` (86 base64url chars). */
const VERIFIER_BYTES = 64;
/** Bytes of entropy behind a `state` (43 base64url chars). */
const STATE_BYTES = 32;

/** Injectable randomness, so a test can pin the verifier and challenge. */
export type RandomBytes = (size: number) => Buffer;

export interface PkcePair {
  /** Sent to the token endpoint, never to the authorization endpoint. */
  readonly verifier: string;
  /** Sent to the authorization endpoint, never to the token endpoint. */
  readonly challenge: string;
  /** Always `S256`. The server refuses `plain`. */
  readonly method: "S256";
}

/** `BASE64URL(SHA256(verifier))`, per RFC 7636 §4.2. */
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** A fresh verifier/challenge pair for one authorization attempt. */
export function createPkcePair(random: RandomBytes = randomBytes): PkcePair {
  const verifier = random(VERIFIER_BYTES).toString("base64url");
  return { verifier, challenge: challengeFor(verifier), method: "S256" };
}

/** A fresh single-use `state` for one authorization attempt. */
export function createState(random: RandomBytes = randomBytes): string {
  return random(STATE_BYTES).toString("base64url");
}

/**
 * Constant-time `state` comparison.
 *
 * Length is compared first and in the clear — `timingSafeEqual` throws on a
 * length mismatch, and a length is not the secret.
 */
export function statesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
