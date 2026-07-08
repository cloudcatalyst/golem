/**
 * T-C3 — unit tests for the hook-side redaction seam (src/hooks/redact.ts).
 *
 * `pipelineRedact` adapts src/pipeline/redaction.ts's REDACTION_RULES + the
 * high-entropy sweep to the text-level RedactFn shape used by the PostToolUse
 * (and WebFetch) hooks. These tests pin down the properties the hook wiring
 * depends on: it catches secrets the built-in `stripKnownSecrets` floor does
 * NOT know about, it is idempotent, and it is deterministic / stateless
 * across calls (required for prompt-cache prefix stability).
 *
 * All secrets below are synthetic fixtures built to match a rule's pattern —
 * none are real credentials.
 */

import { describe, expect, it } from "vitest";
import { identityRedact, pipelineRedact, stripKnownSecrets } from "../../../src/hooks/redact.js";

// Synthetic AWS-access-key-shaped fixtures: "AKIA" prefix + 16 uppercase
// alphanumeric chars (20 chars total) — matches the aws-key rule, but not
// anything the built-in stripKnownSecrets floor (PEM + sk-ant only) knows.
const AWS_PREFIX = "AKIA";
const FAKE_AWS_KEY_A = `${AWS_PREFIX}QRSTUVWXYZ012345`;
const FAKE_AWS_KEY_B = `${AWS_PREFIX}MNBVCXZLKJHGFDSA`;

// Synthetic Anthropic-key-shaped fixture: "sk-ant-" + 16+ chars — matches
// both the pipeline's anthropic-key rule and the floor's own sk-ant- regex.
const FAKE_ANTHROPIC_KEY = "sk-ant-" + "zz1122334455667788990011";

describe("pipelineRedact", () => {
  it("redacts an AWS access key — a secret only the pipeline rules catch", () => {
    const text = `export AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY_A}`;

    // The built-in floor alone (PEM + sk-ant only) does not know this shape.
    expect(stripKnownSecrets(text)).toContain(FAKE_AWS_KEY_A);

    const redacted = pipelineRedact(text);
    expect(redacted).not.toContain(FAKE_AWS_KEY_A);
    expect(redacted).toMatch(/\[REDACTED:aws-key:\d+\]/);
  });

  it("is idempotent: redacting already-redacted text is a no-op", () => {
    const once = pipelineRedact(`token=${FAKE_AWS_KEY_A}`);
    const twice = pipelineRedact(once);
    expect(twice).toBe(once);
  });

  it("is deterministic: the same input always produces the same output", () => {
    const text = `a=${FAKE_AWS_KEY_A} b=${FAKE_AWS_KEY_A}`;
    const first = pipelineRedact(text);
    const second = pipelineRedact(text);
    expect(second).toBe(first);
    // Same secret repeated within one pass reuses the same placeholder index.
    expect(first).toBe("a=[REDACTED:aws-key:1] b=[REDACTED:aws-key:1]");
  });

  it("allocates a fresh placeholder table per call (no state leaks across calls)", () => {
    // If a table were shared across calls, the second call's key would be
    // numbered 2 (since it's a distinct value from the first call's key).
    expect(pipelineRedact(`x=${FAKE_AWS_KEY_A}`)).toBe("x=[REDACTED:aws-key:1]");
    expect(pipelineRedact(`x=${FAKE_AWS_KEY_B}`)).toBe("x=[REDACTED:aws-key:1]");
  });

  it("leaves ordinary text untouched", () => {
    const text = "npm run build && npm test -- all green";
    expect(pipelineRedact(text)).toBe(text);
  });
});

describe("identityRedact + stripKnownSecrets composition (the always-on floor)", () => {
  it("identityRedact is a true no-op", () => {
    const text = `anything at all, including ${FAKE_AWS_KEY_A}`;
    expect(identityRedact(text)).toBe(text);
  });

  it("the floor alone still strips its known shapes even with identity upstream", () => {
    const stored = stripKnownSecrets(identityRedact(`ANTHROPIC_API_KEY=${FAKE_ANTHROPIC_KEY}`));
    expect(stored).not.toContain(FAKE_ANTHROPIC_KEY);
  });
});
