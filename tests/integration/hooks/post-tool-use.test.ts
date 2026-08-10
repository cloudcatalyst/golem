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
  buildDigest,
  DEFAULT_MAX_INLINE_CHARS,
  findTextSlot,
  type HookIo,
  identityRedact,
  REDACTED_PEM_PLACEHOLDER,
  REDACTED_SK_ANT_PLACEHOLDER,
  type RedactFn,
  runPostToolUseHook,
  servedFetchLabel,
  stripReadLineNumbers,
} from "../../../src/hooks/index.js";
import { rmTemp } from "../../helpers/tmp.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-hook-"));
});

afterEach(async () => {
  await rm(projectDir, rmTemp);
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

/**
 * R8.12 — do not destroy another compactor's recovery pointer.
 *
 * RTK (spec Decision 53 tier-3a peer) tees full output to a file on failure and
 * points at it inline. Golem swapping that output for a head/tail excerpt can drop
 * the pointer into the elided middle, so a compaction-of-a-compaction would lose
 * the other tool's only way back to the original.
 */
describe("buildDigest — external compactor interop (R8.12)", () => {
  const teeLine = "[full output: ~/.local/share/rtk/tee/1707753600_cargo_test.log]";

  /** Marker in the middle, far from both the head and the tail excerpt. */
  function bigWith(marker: string): string {
    return `${"a".repeat(6000)}
${marker}
${"b".repeat(6000)}`;
  }

  it("preserves an RTK tee pointer that would otherwise be elided", () => {
    const digest = buildDigest("Bash", bigWith(teeLine), "f".repeat(64));
    expect(digest).toContain(teeLine);
    expect(digest).toContain("preserved pointer from an external compactor");
  });

  it("does not duplicate a pointer that already survives in the head", () => {
    const digest = buildDigest(
      "Bash",
      `${teeLine}
${"a".repeat(12000)}`,
      "f".repeat(64),
    );
    expect(digest.split(teeLine).length - 1).toBe(1);
    expect(digest).not.toContain("preserved pointer from an external compactor");
  });

  it("adds no section when there is no external pointer", () => {
    expect(buildDigest("Bash", "x".repeat(12000), "f".repeat(64))).not.toContain(
      "preserved pointer",
    );
  });

  it("keeps Golem's own CCR marker alongside the preserved pointer", () => {
    const refId = "e".repeat(64);
    const digest = buildDigest("Bash", bigWith(teeLine), refId);
    expect(digest).toContain(`hash=${refId}`);
    expect(digest).toContain(teeLine);
  });
});

describe("runPostToolUseHook — oversized Read gets a symbol skeleton (R8.5)", () => {
  /** A Read output as Claude Code renders it: `<line>\t<text>`, 1-based. */
  function numbered(lines: readonly string[], firstLine = 1): string {
    return lines.map((l, i) => `${String(firstLine + i).padStart(6)}\t${l}`).join("\n");
  }

  /** A file big enough to be swapped, with real declarations spread through it. */
  function bigTsFile(): string {
    const lines: string[] = ["export function headSymbol(a: string): string {", "  return a;", "}"];
    while (lines.length < 700) lines.push(`// filler comment line ${lines.length}`);
    lines.push("export class MiddleThing {", "  poke(): void {}", "}");
    while (lines.length < 1400) lines.push(`// more filler ${lines.length}`);
    lines.push("export const TAIL_CONST = 1;");
    return numbered(lines);
  }

  function readPayload(filePath: string, output: string): string {
    return JSON.stringify({
      session_id: "s1",
      cwd: projectDir,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: filePath },
      tool_response: output,
    });
  }

  it("lists definitions the head/tail excerpt elides, with their real line numbers", async () => {
    const io = fakeIo(readPayload("/repo/src/thing.ts", bigTsFile()));
    expect(await runPostToolUseHook(io, { projectDir })).toBe(0);
    const digest = parseStdout(io).hookSpecificOutput.updatedToolOutput as string;

    expect(digest).toContain("symbol skeleton");
    // `MiddleThing` sits ~700 lines in — elided from both excerpts, present here.
    expect(digest).toContain("MiddleThing");
    expect(digest).toContain("TAIL_CONST");
    expect(digest).toMatch(/70[0-9] {2}export class MiddleThing/);
    // The recovery line points at the skeleton before it mentions expanding.
    expect(digest.indexOf("symbol skeleton")).toBeLessThan(digest.indexOf("expand MCP tool"));
    expect(digest).toContain("the skeleton above names every definition and its line");
  });

  it("offsets line numbers by a Read's own offset", async () => {
    const lines = ["export function offsetSymbol(): void {", "  return;", "}"];
    while (lines.length < 900) lines.push(`// filler ${lines.length}`);
    const io = fakeIo(readPayload("/repo/src/thing.ts", numbered(lines, 500)));
    expect(await runPostToolUseHook(io, { projectDir })).toBe(0);
    const digest = parseStdout(io).hookSpecificOutput.updatedToolOutput as string;
    expect(digest).toMatch(/ 500 {2}export function offsetSymbol/);
  });

  it("adds nothing for a file type with no grammar", async () => {
    const lines = ["def f():", "    return 1"];
    while (lines.length < 900) lines.push(`# filler ${lines.length}`);
    const io = fakeIo(readPayload("/repo/thing.py", numbered(lines)));
    expect(await runPostToolUseHook(io, { projectDir })).toBe(0);
    const digest = parseStdout(io).hookSpecificOutput.updatedToolOutput as string;
    expect(digest).not.toContain("symbol skeleton");
  });

  it("adds nothing for a Bash output, however large", async () => {
    const io = fakeIo(payload("Bash", "export function notReallyCode() {}\n".repeat(600)));
    expect(await runPostToolUseHook(io, { projectDir })).toBe(0);
    const digest = parseStdout(io).hookSpecificOutput.updatedToolOutput as string;
    expect(digest).not.toContain("symbol skeleton");
  });

  it("honours the per-project gate", async () => {
    const io = fakeIo(readPayload("/repo/src/thing.ts", bigTsFile()));
    expect(await runPostToolUseHook(io, { projectDir, skeletonEnabled: async () => false })).toBe(
      0,
    );
    const digest = parseStdout(io).hookSpecificOutput.updatedToolOutput as string;
    expect(digest).not.toContain("symbol skeleton");
  });

  it("still swaps, and stays lossless, when the skeleton is added", async () => {
    const source = bigTsFile();
    const io = fakeIo(readPayload("/repo/src/thing.ts", source));
    expect(await runPostToolUseHook(io, { projectDir })).toBe(0);
    const digest = parseStdout(io).hookSpecificOutput.updatedToolOutput as string;
    const refId = (CCR_MARKER_RE.exec(digest) as RegExpExecArray | null)?.[1] as string;
    expect(await retrieveOriginal(refId)).toBe(source);
    expect(digest.length).toBeLessThan(source.length);
  });

  it("extracts from the REDACTED text — a skeleton can never reveal a stripped secret", async () => {
    const secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const lines = [`export const TOKEN = "${secret}";`];
    while (lines.length < 900) lines.push(`// filler ${lines.length}`);
    const io = fakeIo(readPayload("/repo/src/thing.ts", numbered(lines)));
    expect(await runPostToolUseHook(io, { projectDir })).toBe(0);
    const digest = parseStdout(io).hookSpecificOutput.updatedToolOutput as string;
    expect(digest).not.toContain(secret);
  });
});

describe("stripReadLineNumbers", () => {
  it("strips the prefix and reports the first line number", () => {
    const stripped = stripReadLineNumbers("   41\tconst a = 1;\n   42\tconst b = 2;");
    expect(stripped?.content).toBe("const a = 1;\nconst b = 2;");
    expect(stripped?.firstLine).toBe(41);
  });

  it("returns null for text that is not a numbered read", () => {
    expect(stripReadLineNumbers("just some output\nwith no numbers")).toBeNull();
  });
});

describe("R9.12 — served-WebFetch provenance label", () => {
  /** WebFetch's real response shape, measured: the text lives in `result`. */
  const webFetchResponse = (result: string) => ({
    bytes: 552,
    code: 200,
    codeText: "OK",
    result,
    durationMs: 10,
    url: "https://127.0.0.1:5555/w?n=x&s=hit&u=x",
  });

  const stubUrl = (source: "hit" | "miss", target: string, age?: string) =>
    `https://127.0.0.1:5555/w?n=nonce&s=${source}${age === undefined ? "" : `&a=${encodeURIComponent(age)}`}&u=${encodeURIComponent(target)}`;

  it("recognises WebFetch's `result` field as the text slot", () => {
    // It did not until R9.12, so the oversized-output swap never fired for
    // WebFetch at all — a silent gap, since a missed swap looks like a small page.
    const slot = findTextSlot(webFetchResponse("hello"));
    expect(slot?.text).toBe("hello");
  });

  it("labels a cache hit with the real URL and the age", () => {
    const label = servedFetchLabel("WebFetch", {
      url: stubUrl("hit", "https://example.com/", "14h ago"),
      prompt: "x",
    });
    expect(label?.detail).toContain("Served from cache (stored 14h ago)");
    expect(label?.detail).toContain("https://example.com/");
    // The user-visible line must be ONE line: it renders as a systemMessage.
    expect(label?.line).toBe("Golem: served from cache (stored 14h ago) — https://example.com/");
    expect(label?.line.includes("\n")).toBe(false);
    expect(label?.detail).not.toContain("127.0.0.1"); // stub URL is an implementation detail
  });

  it("labels a miss as a live fetch that is now cached", () => {
    const label = servedFetchLabel("WebFetch", {
      url: stubUrl("miss", "https://example.net/"),
      prompt: "x",
    });
    expect(label?.detail).toContain("Fetched live from https://example.net/");
    expect(label?.detail).toContain("now cached");
    expect(label?.line).toBe("Golem: fetched live and cached — https://example.net/");
  });

  it("leaves a genuine fetch alone", () => {
    expect(servedFetchLabel("WebFetch", { url: "https://example.com/", prompt: "x" })).toBeNull();
    expect(servedFetchLabel("Bash", { url: stubUrl("hit", "https://example.com/") })).toBeNull();
    expect(servedFetchLabel("WebFetch", { prompt: "no url" })).toBeNull();
  });

  it("substitutes the tool output, replacing only the text field", async () => {
    const io = fakeIo(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "WebFetch",
        tool_input: { url: stubUrl("hit", "https://example.com/", "2d ago"), prompt: "x" },
        tool_response: webFetchResponse("a summariser paraphrase of the stub"),
      }),
    );

    expect(await runPostToolUseHook(io)).toBe(0);
    const emitted = JSON.parse(io.out.join("")) as {
      systemMessage?: string;
      hookSpecificOutput: { updatedToolOutput: Record<string, unknown> };
    };
    // The user only ever sees `systemMessage` for a WebFetch row — assert it.
    expect(emitted.systemMessage).toBe(
      "Golem: served from cache (stored 2d ago) — https://example.com/",
    );
    const out = emitted.hookSpecificOutput.updatedToolOutput;
    expect(out.result).toContain("**Golem** Served from cache (stored 2d ago)");
    // The envelope must survive intact — only the text changes.
    expect(out.code).toBe(200);
    expect(out.bytes).toBe(552);
  });

  it("passes a real WebFetch through untouched when it is small", async () => {
    const io = fakeIo(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "WebFetch",
        tool_input: { url: "https://example.com/", prompt: "x" },
        tool_response: webFetchResponse("a genuine short answer"),
      }),
    );
    expect(await runPostToolUseHook(io)).toBe(0);
    expect(io.out.join("")).toBe("");
  });
});
