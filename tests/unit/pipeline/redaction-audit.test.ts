/**
 * T-C3 — redaction security-review corpus (adversarial).
 *
 * Distinct from redaction.test.ts (per-rule positive/negative smoke): this is
 * the ATTACKER'S view. Each case is a way a secret could slip through
 * unredacted, or legitimate content could be corrupted. A failure here is a
 * security finding. All "secrets" below are synthetic and non-functional.
 *
 * Invariant: after redaction, no raw secret value survives verbatim anywhere in
 * the output, at any nesting depth.
 */

import { describe, expect, it } from "vitest";
import { redactRequestBody } from "../../../src/pipeline/index.js";

/** Redact a bare string via the body path (fresh placeholder table per call). */
function redact(text: string): string {
  return (redactRequestBody({ s: text }).value as { s: string }).s;
}

describe("T-C3: connection-string credential handling", () => {
  it("redacts the password even when it equals the username (first-occurrence hazard)", () => {
    // The naive `match.replace(password, placeholder)` replaces the FIRST
    // occurrence — which is the username — leaving the real password exposed.
    const out = redact("postgres://ab:ab@db.example.com/app");
    // Password position (…:<pw>@) must be redacted; the raw `ab@` must be gone.
    expect(out).not.toContain(":ab@");
    // Username and host must both survive (only the password span is redacted).
    expect(out).toMatch(/^postgres:\/\/ab:\[REDACTED:connection-password:\d+\]@db\.example\.com/);
  });

  it("does not leak the password when host has no dot (localhost)", () => {
    // The email rule can't rescue this (no dotted host), so the connection rule
    // MUST redact the real password span, not the username.
    const out = redact("postgres://ab:ab@localhost/app");
    expect(out).toBe("postgres://ab:[REDACTED:connection-password:1]@localhost/app");
  });

  it("redacts a username-less connection URL (redis style)", () => {
    const pw = "s3cr3tCACHEpw";
    const out = redact(`redis://:${pw}@cache.example.com:6379`);
    expect(out).not.toContain(pw);
  });

  it("preserves the username when redacting a distinct password", () => {
    const out = redact("postgres://appuser:DbP4ssw0rdValue@db.example.com/app");
    expect(out).toContain("appuser");
    expect(out).not.toContain("DbP4ssw0rdValue");
  });
});

describe("T-C3: provider key coverage", () => {
  const cases: ReadonlyArray<{ label: string; secret: string; ctx: (s: string) => string }> = [
    {
      label: "anthropic key adjacent to quotes",
      secret: "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx",
      ctx: (s) => `key="${s}"`,
    },
    {
      label: "github pat",
      secret: `ghp_${"A1b2C3d4".repeat(5)}`,
      ctx: (s) => `token ${s} here`,
    },
    {
      label: "aws access key id in a sentence",
      secret: "AKIAIOSFODNN7EXAMPLE",
      ctx: (s) => `the key is ${s}.`,
    },
    {
      label: "jwt",
      secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV",
      ctx: (s) => `Authorization: Bearer ${s}`,
    },
  ];
  for (const c of cases) {
    it(`redacts ${c.label}`, () => {
      const out = redact(c.ctx(c.secret));
      expect(out).not.toContain(c.secret);
      expect(out).toContain("[REDACTED:");
    });
  }
});

describe("T-C3: entropy backstop for uncontexted secrets", () => {
  it("catches a high-entropy token with no provider prefix", () => {
    // Mixed-case + digits, 32+ chars, not pure hex → should trip the sweep.
    const secret = "Xq9Zk2Lp7Vn4Rt8Wm3Yb6Jd1Fh5Gc0As";
    const out = redact(`value=${secret}`);
    expect(out).not.toContain(secret);
  });

  it("does NOT redact legitimate high-entropy-looking dev strings (false-positive guard)", () => {
    // git SHA (pure hex) and a UUID must survive — they are not secrets and
    // saturate real developer traffic.
    const sha = "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e";
    const uuid = "1cbd630f-4612-4288-9f2c-a14c1d60d4c8";
    expect(redact(`commit ${sha}`)).toContain(sha);
    expect(redact(`id ${uuid}`)).toContain(uuid);
  });

  it("does NOT redact npm integrity / SRI content hashes (§31 lockfile false-positive)", () => {
    // `sha512-<base64>` integrity values saturate package-lock.json; the entropy
    // sweep was eating every one — content hashes, not secrets. Redacting them
    // inflated the savings metric and mislabeled non-secrets as REDACTED.
    const integrity = "sha512-Ap0AB3vJt6JsBJj0K8t9YtY6Rf0oQ3m6QN0m7l2K1jZ8qWn5rXcVvBnM3pLdG4hT7";
    const out = redact(`"integrity": "${integrity}"`);
    expect(out).toContain(integrity);
    expect(out).not.toContain("[REDACTED:high-entropy");
  });

  it("does NOT redact large data blobs — entropy sweep is length-bounded (§37)", () => {
    // A base64 image / minified blob is DATA, not a credential. The unbounded
    // entropy candidate regex used to wholesale-redact runs of thousands of
    // chars (avg 3.5k, max 22k on real traffic), silently inflating savings and
    // stripping content Claude needs. Candidates are now capped at 128 chars, so
    // a long blob is left completely intact (not sliced).
    const blob = "A1b2C3d4".repeat(600); // 4,800 chars of base64-ish data
    const out = redact(`data:image/png;base64,${blob}`);
    expect(out).toContain(blob);
    expect(out).not.toContain("[REDACTED:high-entropy");
  });

  it("still redacts a genuine credential-length high-entropy token (no under-redaction)", () => {
    // The ceiling must not let real secrets through: a 44-char random token
    // (mixed case + digits, not hex) is well within 32–128 and must be redacted.
    const secret = "aB3xZ9qWmK7pLr2T".repeat(3); // 48 chars, high-entropy, not hex
    const out = redact(`token=${secret}`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED:high-entropy");
  });
});

describe("T-C3: depth and idempotence", () => {
  it("redacts a secret nested deep in the request body", () => {
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "k AKIAIOSFODNN7EXAMPLE z" }] }],
    };
    expect(JSON.stringify(redactRequestBody(body).value)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("is idempotent — re-redacting redacted text is a no-op (prefix-cache safe)", () => {
    const once = redact("key AKIAIOSFODNN7EXAMPLE and a@b.com");
    expect(redact(once)).toBe(once);
  });
});
