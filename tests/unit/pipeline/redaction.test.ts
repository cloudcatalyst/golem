/**
 * WS-A A3 — redaction corpus. Doubles as the T-C3 security-review audit set:
 * every rule gets a positive (must redact) and a negative (must NOT redact)
 * case. Extend this file whenever a rule is added to redaction-rules.ts.
 */

import { describe, expect, it } from "vitest";
import { redactRequestBody } from "../../../src/pipeline/index.js";

/** Redact a bare string (fresh table each call). */
function redact(text: string): string {
  // Go through the body path for a table-per-call and pull the string back out.
  const result = redactRequestBody({ s: text });
  return (result.value as { s: string }).s;
}

interface Case {
  readonly rule: string;
  readonly positive: string;
  readonly negative: string;
}

const CASES: readonly Case[] = [
  {
    rule: "private-key",
    positive:
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdef\n-----END RSA PRIVATE KEY-----",
    negative: "public key: -----BEGIN PUBLIC KEY-----\nMIIBIjANBg\n-----END PUBLIC KEY-----",
  },
  {
    rule: "aws-key",
    positive: "AKIAIOSFODNN7EXAMPLE",
    negative: "AKIA123", // too short
  },
  {
    rule: "github-token",
    positive: `ghp_${"a".repeat(36)}`,
    negative: "ghp_short",
  },
  {
    rule: "anthropic-key",
    positive: "sk-ant-api03-abcdefghijklmnop1234",
    negative: "sk-ant-", // no body
  },
  {
    rule: "openai-key",
    positive: `sk-${"A1b2".repeat(9)}`,
    negative: "sk-tooshort",
  },
  {
    rule: "slack-token",
    positive: "xoxb-1234567890-abcdefghij",
    negative: "xoxb-short",
  },
  {
    rule: "jwt",
    positive:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
    negative: "eyJonly.onepart",
  },
  {
    rule: "connection-password",
    positive: "postgres://admin:sup3rs3cr3t@db.example.com:5432/app",
    negative: "postgres://db.example.com:5432/app", // no credentials
  },
  {
    rule: "credit-card",
    positive: "4111 1111 1111 1111", // passes Luhn
    negative: "1234 5678 9012 3456", // fails Luhn
  },
  {
    rule: "email",
    positive: "someone@example.com",
    negative: "not-an-email-just-text",
  },
];

describe("redaction rule corpus (T-C3 audit surface)", () => {
  for (const c of CASES) {
    it(`${c.rule}: redacts the positive case`, () => {
      const out = redact(c.positive);
      expect(out).toContain("[REDACTED:");
      // The raw secret material must not survive verbatim.
      expect(out).not.toBe(c.positive);
    });

    it(`${c.rule}: leaves the negative case intact`, () => {
      const out = redact(c.negative);
      // Negatives may still be caught by the high-entropy sweep only if they
      // genuinely look like secrets; these are chosen not to.
      expect(out).toBe(c.negative);
    });
  }
});

describe("high-entropy heuristic", () => {
  it("redacts an unlabeled high-entropy secret", () => {
    const secret = "Xq7Zk2Lp9Rw4Tv8Nb3Md6Yh1Gj5Fs0Ac2Ee4";
    expect(redact(`token=${secret}`)).toContain("[REDACTED:high-entropy:");
  });

  it("does not flag a git SHA (hex) or a normal identifier", () => {
    expect(redact("commit 9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e")).toContain("9f8e7d6c");
    expect(redact("const getUserAuthenticationTokenFromSessionStore = 1")).toContain(
      "getUserAuthenticationTokenFromSessionStore",
    );
  });
});

describe("determinism & prefix stability", () => {
  it("is idempotent — redacting redacted text changes nothing", () => {
    const once = redact("key AKIAIOSFODNN7EXAMPLE here");
    expect(redact(once)).toBe(once);
  });

  it("gives the same secret the same placeholder across a request", () => {
    const body = redactRequestBody({
      a: "AKIAIOSFODNN7EXAMPLE",
      b: "AKIAIOSFODNN7EXAMPLE",
    });
    const v = body.value as { a: string; b: string };
    expect(v.a).toBe(v.b);
    expect(v.a).toBe("[REDACTED:aws-key:1]");
  });

  it("preserves object identity when nothing matches (byte-faithful)", () => {
    const input = { messages: [{ role: "user", content: "hello world" }] };
    const out = redactRequestBody(input);
    expect(out.count).toBe(0);
    expect(out.value).toBe(input);
  });
});
