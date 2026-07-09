/**
 * WS-B task B2 — PostToolUse hook handler against recorded stdin payloads.
 *
 * Verifies: small output => no modification, silent exit 0; large output =>
 * updatedToolOutput JSON with a head/tail digest + CCR marker, original
 * retrievable byte-identical from the CCR store via expand's code path;
 * a PEM / sk-ant secret in the output is stripped from the stored original.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CCR_MARKER_RE,
  CcrStore,
  LocalDirBlobStore,
  NativeLosslessCompression,
} from "../../../src/compression/index.js";
import {
  DEFAULT_MAX_INLINE_CHARS,
  type HookIo,
  identityRedact,
  REDACTED_PEM_PLACEHOLDER,
  REDACTED_SK_ANT_PLACEHOLDER,
  type RedactFn,
  runPostToolUseHook,
} from "../../../src/hooks/index.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-hook-"));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

/** A HookIo backed by a fixed input string and capture buffers. */
function fakeIo(input: string): HookIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdin: (async function* () {
      yield input;
    })(),
    stdout: { write: (t: string) => out.push(t) },
    stderr: { write: (t: string) => err.push(t) },
    out,
    err,
  };
}

function payload(toolName: string, toolResponse: unknown): string {
  return JSON.stringify({
    session_id: "s1",
    cwd: projectDir,
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: { command: "echo hi" },
    tool_response: toolResponse,
  });
}

interface UpdatedOutputEnvelope {
  hookSpecificOutput: { hookEventName: string; updatedToolOutput: unknown };
}

function parseStdout(io: { out: string[] }): UpdatedOutputEnvelope {
  expect(io.out).toHaveLength(1);
  return JSON.parse(io.out[0] as string) as UpdatedOutputEnvelope;
}

/** Retrieve exactly as expand's tool handler does. */
async function retrieveOriginal(refId: string): Promise<string> {
  const service = new NativeLosslessCompression(
    new LocalDirBlobStore(path.join(projectDir, ".golem", "ccr")),
  );
  const original = await service.retrieve({ refId, contentType: "text/plain", originalTokens: 0 });
  return original.content;
}

describe("runPostToolUseHook — threshold", () => {
  it("passes small string output through untouched (silent exit 0)", async () => {
    const io = fakeIo(payload("Bash", "small output"));
    const code = await runPostToolUseHook(io, { projectDir });
    expect(code).toBe(0);
    expect(io.out).toHaveLength(0);
  });

  it("passes an unrecognized tool_response shape through untouched", async () => {
    const io = fakeIo(payload("Bash", { exitCode: 0, weird: [1, 2, 3] }));
    const code = await runPostToolUseHook(io, { projectDir });
    expect(code).toBe(0);
    expect(io.out).toHaveLength(0);
  });

  it("ignores a malformed payload without throwing (exit 0)", async () => {
    const io = fakeIo("not json at all {");
    const code = await runPostToolUseHook(io, { projectDir });
    expect(code).toBe(0);
    expect(io.out).toHaveLength(0);
    expect(io.err.join("")).toMatch(/passing through/);
  });
});

describe("runPostToolUseHook — oversized string output", () => {
  const big = "LINE-of-tool-output\n".repeat(2_000); // ~40k chars

  it("emits updatedToolOutput with a CCR marker and stores the original byte-identically", async () => {
    const io = fakeIo(payload("Bash", big));
    const code = await runPostToolUseHook(io, { projectDir });
    expect(code).toBe(0);

    const env = parseStdout(io);
    expect(env.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    const digest = env.hookSpecificOutput.updatedToolOutput;
    expect(typeof digest).toBe("string");
    const digestText = digest as string;

    // Digest is smaller than the original and mentions the expand tool.
    expect(digestText.length).toBeLessThan(big.length);
    expect(digestText).toContain("expand");
    expect(digestText).toContain("bytes");

    // Marker uses A2's hash= grammar → expand can parse it.
    const match = CCR_MARKER_RE.exec(digestText);
    expect(match).not.toBeNull();
    const refId = (match as RegExpExecArray)[1] as string;

    // Original retrievable byte-identical via the expand code path.
    expect(await retrieveOriginal(refId)).toBe(big);
  });

  it("swaps oversized output nested under a `.output` field, preserving other fields", async () => {
    const io = fakeIo(payload("Bash", { output: big, exitCode: 0, durationMs: 42 }));
    await runPostToolUseHook(io, { projectDir });

    const env = parseStdout(io);
    const updated = env.hookSpecificOutput.updatedToolOutput as Record<string, unknown>;
    expect(updated.exitCode).toBe(0);
    expect(updated.durationMs).toBe(42);
    expect(typeof updated.output).toBe("string");
    expect((updated.output as string).length).toBeLessThan(big.length);

    const match = CCR_MARKER_RE.exec(updated.output as string);
    expect(match).not.toBeNull();
    expect(await retrieveOriginal((match as RegExpExecArray)[1] as string)).toBe(big);
  });

  it("respects a custom maxInlineChars threshold", async () => {
    const medium = "x".repeat(500);
    const under = fakeIo(payload("Read", medium));
    await runPostToolUseHook(under, { projectDir, maxInlineChars: 1_000 });
    expect(under.out).toHaveLength(0);

    const over = fakeIo(payload("Read", "y".repeat(5_000)));
    await runPostToolUseHook(over, { projectDir, maxInlineChars: 1_000 });
    expect(over.out).toHaveLength(1);
  });

  it("uses the documented default threshold band", () => {
    expect(DEFAULT_MAX_INLINE_CHARS).toBeGreaterThanOrEqual(8_000);
    expect(DEFAULT_MAX_INLINE_CHARS).toBeLessThanOrEqual(16_000);
  });
});

describe("runPostToolUseHook — redaction before storage", () => {
  it("strips a PEM private key from the stored original", async () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0examplekeymaterialexamplekeymaterialexamplekeymat",
      "erialexamplekeymaterialexamplekeymaterialexamplekeymaterialexample",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const output = `deploying...\n${pem}\n${"log line\n".repeat(2_000)}`;

    const io = fakeIo(payload("Bash", output));
    await runPostToolUseHook(io, { projectDir });
    const env = parseStdout(io);
    const refId = (
      CCR_MARKER_RE.exec(
        env.hookSpecificOutput.updatedToolOutput as string,
      ) as RegExpExecArray | null
    )?.[1] as string;

    const stored = await retrieveOriginal(refId);
    expect(stored).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(stored).not.toContain("examplekeymaterial");
    // Default redact is now pipelineRedact (T-C3): the pipeline's private-key
    // rule catches the PEM block before the built-in floor gets a chance, so
    // the stored text carries the pipeline's placeholder, not the floor's.
    expect(stored).toMatch(/\[REDACTED:private-key:\d+\]/);
    expect(stored).not.toContain(REDACTED_PEM_PLACEHOLDER);
  });

  it("strips an sk-ant- API key from the stored original", async () => {
    const secret = "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF0000111122223333";
    const output = `token=${secret}\n${"more output\n".repeat(2_000)}`;

    const io = fakeIo(payload("Bash", output));
    await runPostToolUseHook(io, { projectDir });
    const env = parseStdout(io);
    const refId = (
      CCR_MARKER_RE.exec(
        env.hookSpecificOutput.updatedToolOutput as string,
      ) as RegExpExecArray | null
    )?.[1] as string;

    const stored = await retrieveOriginal(refId);
    expect(stored).not.toContain(secret);
    // Default redact is now pipelineRedact (T-C3): the pipeline's
    // anthropic-key rule catches sk-ant- before the built-in floor does.
    expect(stored).toMatch(/\[REDACTED:anthropic-key:\d+\]/);
    expect(stored).not.toContain(REDACTED_SK_ANT_PLACEHOLDER);
  });

  it("applies an injected RedactFn before the built-in strip", async () => {
    const output = `USER=alice PASSWORD=hunter2\n${"line\n".repeat(4_000)}`;
    const redact: RedactFn = (t) => t.replace(/PASSWORD=\S+/g, "PASSWORD=[redacted]");

    const io = fakeIo(payload("Bash", output));
    await runPostToolUseHook(io, { projectDir, redact });
    const env = parseStdout(io);
    const refId = (
      CCR_MARKER_RE.exec(
        env.hookSpecificOutput.updatedToolOutput as string,
      ) as RegExpExecArray | null
    )?.[1] as string;

    const stored = await retrieveOriginal(refId);
    expect(stored).not.toContain("hunter2");
    expect(stored).toContain("PASSWORD=[redacted]");
  });

  it("still applies the built-in secret-strip floor when the injected RedactFn is identity", async () => {
    // Fake fixtures only — not real key material.
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "FAKEKEYMATERIALFAKEKEYMATERIALFAKE",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const skAnt = "sk-ant-FAKE0123456789ABCDEFGHIJ";
    const output = `${pem}\n${skAnt}\n${"line\n".repeat(4_000)}`;

    const io = fakeIo(payload("Bash", output));
    // Bypass the pipeline stage entirely — the floor must still fire on its own.
    await runPostToolUseHook(io, { projectDir, redact: identityRedact });
    const env = parseStdout(io);
    const refId = (
      CCR_MARKER_RE.exec(
        env.hookSpecificOutput.updatedToolOutput as string,
      ) as RegExpExecArray | null
    )?.[1] as string;

    const stored = await retrieveOriginal(refId);
    expect(stored).not.toContain("FAKEKEYMATERIALFAKEKEYMATERIALFAKE");
    expect(stored).not.toContain(skAnt);
    expect(stored).toContain(REDACTED_PEM_PLACEHOLDER);
    expect(stored).toContain(REDACTED_SK_ANT_PLACEHOLDER);
  });
});

describe("runPostToolUseHook — CCR store shape", () => {
  it("stores the original as a v1 text/plain envelope under .golem/ccr", async () => {
    const big = "z".repeat(30_000);
    const io = fakeIo(payload("Read", big));
    await runPostToolUseHook(io, { projectDir });
    const env = parseStdout(io);
    const refId = (
      CCR_MARKER_RE.exec(
        env.hookSpecificOutput.updatedToolOutput as string,
      ) as RegExpExecArray | null
    )?.[1] as string;

    const store = new CcrStore(new LocalDirBlobStore(path.join(projectDir, ".golem", "ccr")));
    const envelope = await store.getEnvelope(refId);
    expect(envelope.v).toBe(1);
    expect(envelope.contentType).toBe("text/plain");
    expect(envelope.content).toBe(big);
  });
});
