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

describe("T-C3: path-like false-positive guard (§49)", () => {
  it("does not redact a multi-segment repo path (mixed case, digits, ADR-style)", () => {
    const path = "docs/decisions/ADR-0012-file-watcher";
    const out = redact(`write the memo as ${path} and get it reviewed`);
    expect(out).toContain(path);
    expect(out).not.toContain("[REDACTED:high-entropy");
  });

  it("does not redact a versioned/slugged filename with no slash at all", () => {
    const name = "notes-2026-07-10-W3-summary-review";
    const out = redact(`draft saved to ${name}`);
    expect(out).toContain(name);
    expect(out).not.toContain("[REDACTED:high-entropy");
  });

  it("still redacts a dash-delimited secret whose chunks mix letters and digits", () => {
    // Unlike a real path/slug, no chunk here is purely alphabetic or purely
    // numeric — the fix must not treat this as path-like.
    const secret = "aB3xZ9-qWmK7p-Lr2Tk3-nP9qWmK";
    const out = redact(`token=${secret}`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED:high-entropy");
  });
});

describe("T-C3: path-with-embedded-UUID false-positive guard (§137)", () => {
  // All fixtures below are built at RUNTIME (crypto.randomUUID(), shuffled
  // character pools) rather than typed as literals: a literal secret in this
  // file is itself redacted out from under a later read of this same file
  // (verified live while writing this task — see verification-notes §137),
  // and a literal placeholder pasted back in its place would make the
  // assertion pass vacuously without testing anything.

  /** Fisher-Yates shuffle — used to build fixtures with a known, distinct
   * character set so the entropy math is a deterministic guarantee rather
   * than something that has to get lucky on every CI run. */
  function shuffled<T>(items: readonly T[]): T[] {
    const arr = items.slice();
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i] as T;
      arr[i] = arr[j] as T;
      arr[j] = tmp;
    }
    return arr;
  }

  /** `len` pairwise-distinct uppercase letters (a "word" chunk, pure alpha). */
  function randomWordChunk(len: number): string {
    return shuffled("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")).slice(0, len).join("");
  }

  /** `len` pairwise-distinct hex characters (0-9a-f) — a UUID/SHA-shaped chunk.
   * len <= 16 guarantees no repeats, and len > 10 forces at least one letter
   * (only 10 digits exist) while len > 6 forces at least one digit (only 6
   * hex letters exist) — so at len=14 it is unconditionally a MIX of both,
   * never accidentally pure-numeric or pure-alpha. */
  function randomHexChunk(len: number): string {
    return shuffled("0123456789abcdef".split("")).slice(0, len).join("");
  }

  it("scratchpad path with an embedded UUID survives in BOTH separator spellings, and they agree", () => {
    // Reproduces the exact shape from the task brief: a session scratchpad
    // path under AppData/Local/Temp/claude/<workspace>/<uuid>/scratchpad.
    // heredoc addendum: `\` was never broken (backslash isn't in the entropy
    // charset) — the bug is POSIX-only, so both spellings must be asserted,
    // not just the one that happens to already work.
    const uuid = crypto.randomUUID();
    const posixPath = `/home/dev/AppData/Local/Temp/claude/golem-workspace/${uuid}/scratchpad`;
    const windowsPath = `C:\\Users\\dev\\AppData\\Local\\Temp\\claude\\golem-workspace\\${uuid}\\scratchpad`;

    const outPosix = redact(`Save the log at ${posixPath} before continuing.`);
    const outWindows = redact(`Save the log at ${windowsPath} before continuing.`);

    // Each spelling survives byte-for-byte.
    expect(outPosix).toContain(posixPath);
    expect(outWindows).toContain(windowsPath);
    // They agree: neither spelling of the same path is redacted.
    expect(outPosix).not.toContain("[REDACTED");
    expect(outWindows).not.toContain("[REDACTED");
  });

  it("does not redact a .claude/worktrees/agent-<uuid> path", () => {
    const uuid = crypto.randomUUID();
    const path = `.claude/worktrees/agent-${uuid}`;
    const out = redact(`cd ${path} && git status`);
    expect(out).toContain(path);
    expect(out).not.toContain("[REDACTED:high-entropy");
  });

  it("still does not redact a bare UUID or a bare hex SHA standing alone (no regression)", () => {
    const uuid = crypto.randomUUID();
    const sha = randomHexChunk(16).repeat(3).slice(0, 40);
    expect(redact(`id ${uuid} seen`)).toContain(uuid);
    expect(redact(`commit ${sha} pushed`)).toContain(sha);
  });

  it("still does not redact the §49 repo-path and versioned-filename cases", () => {
    const path = "docs/decisions/ADR-0012-file-watcher";
    const name = "notes-2026-07-10-W3-summary-review";
    expect(redact(`write the memo as ${path} and get it reviewed`)).toContain(path);
    expect(redact(`draft saved to ${name}`)).toContain(name);
  });

  it("adversarial: a short word-hex pair does NOT qualify as path-like (chunk-count guard)", () => {
    // Only 2 chunks total — one plain word, one mixed hex-digit chunk. A real
    // path carrying an embedded UUID/hash runs to many more segments than
    // this; a short pair like this is exactly the shape a hyphenated secret
    // could take, so the guard must still hand it to the entropy check.
    const word = randomWordChunk(20);
    const hex = randomHexChunk(14);
    const secret = `${word}-${hex}`;
    const out = redact(`id ${secret} seen`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED:high-entropy");
  });

  it("adversarial: a hyphen-delimited secret with no clean chunk at all still redacts", () => {
    // Every chunk mixes a digit with a letter drawn from OUTSIDE a-f (g-z /
    // G-Z), so no chunk is purely alphabetic, purely numeric, or purely hex --
    // the pre-existing "every chunk must be clean" rule already rejects this,
    // unaffected by the hex-chunk addition. The letter pool is built from
    // character codes, never a literal run of letters, so this source file
    // does not itself contain a string the entropy sweep would flag on a
    // later read (a mixed-case 32+ char run is exactly the shape that trips
    // it -- reproduced live while drafting this test).
    const nonHexLetters: string[] = [];
    for (let code = "g".charCodeAt(0); code <= "z".charCodeAt(0); code += 1) {
      nonHexLetters.push(String.fromCharCode(code), String.fromCharCode(code).toUpperCase());
    }
    const lettersPool = shuffled(nonHexLetters).slice(0, 20); // 5 per chunk
    const digitsPool = shuffled("0123456789".split("")).slice(0, 16); // 4 per chunk
    const chunks: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const letters = lettersPool.slice(i * 5, i * 5 + 5);
      const nums = digitsPool.slice(i * 4, i * 4 + 4);
      chunks.push(shuffled([...letters, ...nums]).join(""));
    }
    const secret = chunks.join("-");
    const out = redact(`id ${secret} seen`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED:high-entropy");
  });

  it("a hex chunk at exactly the chunk-count floor (3) IS accepted as path-like", () => {
    // Boundary check on MIN_CHUNKS_FOR_HEX_ALLOWANCE: three segments, one of
    // them a mixed hex chunk, mirrors a short real path (e.g. a two-directory
    // prefix plus a UUID/hash leaf) and must survive.
    const a = randomWordChunk(6);
    const b = randomWordChunk(6);
    const hex = randomHexChunk(14);
    const path = `${a}/${b}/${hex}`;
    const out = redact(`resolved to ${path} on disk`);
    expect(out).toContain(path);
    expect(out).not.toContain("[REDACTED:high-entropy");
  });
});

describe("T-C3: credit-card separator-format guard (§50)", () => {
  it("does not redact a space-separated ASCII byte dump that is Luhn-valid by chance", () => {
    // Decimal byte values (0-255) joined by a single space, as a raw byte/debug
    // dump would appear in a log. Group widths are irregular (1-3 digits per
    // value) — unlike a real card's regular grouping — but the concatenated
    // digit run happens to pass the bare Luhn checksum (verified independently
    // via computation, not visual inspection, per verification-notes §50). This
    // is the exact false positive the separator-format check exists to reject.
    const bytes = [87, 9, 167, 32, 121, 216, 75, 77];
    const dump = bytes.join(" ");
    const out = redact(dump);
    expect(out).toBe(dump);
    expect(out).not.toContain("[REDACTED:credit-card");
  });

  it("still redacts a contiguous Luhn-valid card number (no separators)", () => {
    const card = "4111111111111111"; // well-known Luhn-valid test card number
    const out = redact(`card: ${card}`);
    expect(out).not.toContain(card);
    expect(out).toContain("[REDACTED:credit-card");
  });

  it("still redacts a uniformly space-grouped Luhn-valid card number", () => {
    const card = "5500 0055 5555 5559"; // well-known Luhn-valid test card, grouped 4-4-4-4
    const out = redact(`card: ${card}`);
    expect(out).not.toContain("5500005555555559");
    expect(out).toContain("[REDACTED:credit-card");
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
