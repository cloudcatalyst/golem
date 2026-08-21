/**
 * R1.1 — UsageSniffer: byte-faithful passthrough + best-effort `usage`
 * extraction for both non-streaming JSON and SSE streaming bodies
 * (verification-notes §30-37).
 */

import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { brotliCompressSync, gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { ResponseUsage } from "../../../src/proxy/types.js";
import { type StreamTermination, UsageSniffer } from "../../../src/proxy/usage-sniffer.js";
import {
  chunkify,
  NON_STREAMING_TOOL_USE_RESPONSE,
  SSE_ERROR_STREAM_FIXTURE,
  SSE_STREAM_FIXTURE,
} from "../../integration/helpers/anthropic-fixtures.js";

const HOSTILE_CHUNK_SIZES = [7, 1, 3, 2, 11, 5, 64, 1, 129];

async function run(
  contentType: string | undefined,
  body: string,
  sizes: readonly number[] = HOSTILE_CHUNK_SIZES,
): Promise<{ readonly forwarded: Buffer; readonly usage: ResponseUsage | null }> {
  const sniffer = new UsageSniffer(contentType);
  const chunks: Buffer[] = [];
  const src = chunkify(Buffer.from(body, "utf8"), sizes);
  const readable = Readable.from(src);
  const writable = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk as Buffer);
      cb();
    },
  });
  await pipeline(readable, sniffer, writable);
  return { forwarded: Buffer.concat(chunks), usage: sniffer.usage };
}

/**
 * R11.7 — the same pipe, returning how the stream ENDED and how much went
 * through, which is what the request-outcome record is built from.
 */
async function runTermination(
  contentType: string,
  body: string,
  sizes: readonly number[] = HOSTILE_CHUNK_SIZES,
): Promise<{
  readonly forwarded: Buffer;
  readonly termination: StreamTermination;
  readonly bytes: number;
}> {
  const sniffer = new UsageSniffer(contentType);
  const chunks: Buffer[] = [];
  const readable = Readable.from(chunkify(Buffer.from(body, "utf8"), sizes));
  const writable = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk as Buffer);
      cb();
    },
  });
  await pipeline(readable, sniffer, writable);
  return {
    forwarded: Buffer.concat(chunks),
    termination: sniffer.termination,
    bytes: sniffer.bytes,
  };
}

async function runEncoded(
  contentType: string,
  contentEncoding: string,
  rawBody: string,
  encode: (buf: Buffer) => Buffer,
  sizes: readonly number[] = HOSTILE_CHUNK_SIZES,
): Promise<{ readonly forwarded: Buffer; readonly usage: ResponseUsage | null }> {
  const encoded = encode(Buffer.from(rawBody, "utf8"));
  const sniffer = new UsageSniffer(contentType, contentEncoding);
  const chunks: Buffer[] = [];
  const src = chunkify(encoded, sizes);
  const readable = Readable.from(src);
  const writable = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk as Buffer);
      cb();
    },
  });
  await pipeline(readable, sniffer, writable);
  return { forwarded: Buffer.concat(chunks), usage: sniffer.usage };
}

describe("UsageSniffer — non-streaming JSON", () => {
  it("extracts the top-level usage block and forwards bytes unchanged", async () => {
    const { forwarded, usage } = await run("application/json", NON_STREAMING_TOOL_USE_RESPONSE);
    expect(forwarded.toString("utf8")).toBe(NON_STREAMING_TOOL_USE_RESPONSE);
    expect(usage).toStrictEqual({
      inputTokens: 2095,
      cacheCreationInputTokens: 1024,
      cacheReadInputTokens: 1024,
      outputTokens: 89,
    });
  });

  it("is unaffected by hostile chunk boundaries mid-JSON-escape/UTF-8", async () => {
    const { forwarded, usage } = await run(
      "application/json",
      NON_STREAMING_TOOL_USE_RESPONSE,
      [1, 2, 3],
    );
    expect(forwarded.toString("utf8")).toBe(NON_STREAMING_TOOL_USE_RESPONSE);
    expect(usage?.outputTokens).toBe(89);
  });

  it("fails open (usage null) on malformed JSON without throwing", async () => {
    const body = "{not valid json";
    const { forwarded, usage } = await run("application/json", body);
    expect(forwarded.toString("utf8")).toBe(body);
    expect(usage).toBeNull();
  });

  it("fails open (usage null) when usage is absent", async () => {
    const body = JSON.stringify({ id: "msg_1", type: "message" });
    const { forwarded, usage } = await run("application/json", body);
    expect(forwarded.toString("utf8")).toBe(body);
    expect(usage).toBeNull();
  });

  it("abandons sniffing but still forwards every byte past the overflow cap", async () => {
    // 4_000_001 bytes of padding is enough to cross MAX_JSON_SNIFF_BYTES.
    const padding = "x".repeat(4_000_001);
    const body = `{"padding":"${padding}","usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}`;
    const { forwarded, usage } = await run("application/json", body, [65536]);
    expect(forwarded.toString("utf8")).toBe(body);
    expect(usage).toBeNull();
  });
});

describe("UsageSniffer — SSE streaming", () => {
  it("extracts message_start usage then overwrites output_tokens from message_delta", async () => {
    const { forwarded, usage } = await run("text/event-stream", SSE_STREAM_FIXTURE);
    expect(forwarded.toString("utf8")).toBe(SSE_STREAM_FIXTURE);
    expect(usage).toStrictEqual({
      inputTokens: 472,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 448,
      outputTokens: 189, // overwritten by message_delta, not summed with message_start's 2
    });
  });

  it("survives hostile chunking that splits mid-line and mid-multibyte-codepoint", async () => {
    const { forwarded, usage } = await run(
      "text/event-stream; charset=utf-8",
      SSE_STREAM_FIXTURE,
      [1, 1, 1, 2, 3, 5],
    );
    expect(forwarded.toString("utf8")).toBe(SSE_STREAM_FIXTURE);
    expect(usage).toStrictEqual({
      inputTokens: 472,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 448,
      outputTokens: 189,
    });
  });

  it("captures only message_start usage when the stream dies before message_delta", async () => {
    const { forwarded, usage } = await run("text/event-stream", SSE_ERROR_STREAM_FIXTURE);
    expect(forwarded.toString("utf8")).toBe(SSE_ERROR_STREAM_FIXTURE);
    expect(usage).toStrictEqual({
      inputTokens: 12,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 1,
    });
  });

  it("is content-type-detected case-insensitively with parameters present", async () => {
    const { usage } = await run("Text/Event-Stream; charset=utf-8", SSE_STREAM_FIXTURE);
    expect(usage?.inputTokens).toBe(472);
  });

  it("stays null when content-type is undefined and body is non-JSON SSE-shaped text", async () => {
    // No content-type -> treated as non-streaming JSON path; SSE text is not
    // valid JSON, so sniffing fails open without throwing.
    const { forwarded, usage } = await run(undefined, SSE_STREAM_FIXTURE);
    expect(forwarded.toString("utf8")).toBe(SSE_STREAM_FIXTURE);
    expect(usage).toBeNull();
  });
});

describe("UsageSniffer — compressed bodies (real upstream traffic is gzip-encoded)", () => {
  it("sniffs usage from a gzip non-streaming JSON body while forwarding the COMPRESSED bytes untouched", async () => {
    const { forwarded, usage } = await runEncoded(
      "application/json",
      "gzip",
      NON_STREAMING_TOOL_USE_RESPONSE,
      gzipSync,
    );
    // The client must receive the exact compressed bytes — decompression is
    // a side channel, never a transform of what's forwarded.
    expect(forwarded.toString("hex").startsWith("1f8b")).toBe(true); // gzip magic bytes
    expect(gunzipSync(forwarded).toString("utf8")).toBe(NON_STREAMING_TOOL_USE_RESPONSE);
    expect(usage).toStrictEqual({
      inputTokens: 2095,
      cacheCreationInputTokens: 1024,
      cacheReadInputTokens: 1024,
      outputTokens: 89,
    });
  });

  it("sniffs usage from a gzip SSE stream under hostile chunking", async () => {
    const { usage } = await runEncoded(
      "text/event-stream",
      "gzip",
      SSE_STREAM_FIXTURE,
      gzipSync,
      [3, 5, 7, 11],
    );
    expect(usage).toStrictEqual({
      inputTokens: 472,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 448,
      outputTokens: 189,
    });
  });

  it("sniffs usage from a brotli-encoded (br) non-streaming JSON body", async () => {
    const { usage } = await runEncoded(
      "application/json",
      "br",
      NON_STREAMING_TOOL_USE_RESPONSE,
      brotliCompressSync,
    );
    expect(usage).toStrictEqual({
      inputTokens: 2095,
      cacheCreationInputTokens: 1024,
      cacheReadInputTokens: 1024,
      outputTokens: 89,
    });
  });

  it("forwards raw bytes untouched and fails open (usage null) when content-encoding is unsupported", async () => {
    // Genuinely compressed (gzip) body, but labeled with a codec our sniffer
    // doesn't decode — falls back to sniffing the raw (still-compressed,
    // binary) bytes as JSON text, which cannot possibly parse.
    const body = gzipSync(Buffer.from(NON_STREAMING_TOOL_USE_RESPONSE, "utf8"));
    const sniffer = new UsageSniffer("application/json", "compress");
    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk as Buffer);
        cb();
      },
    });
    await pipeline(Readable.from(chunkify(body, HOSTILE_CHUNK_SIZES)), sniffer, writable);
    expect(Buffer.concat(chunks).equals(body)).toBe(true);
    expect(sniffer.usage).toBeNull();
  });

  it("fails open without throwing on a truncated/corrupt gzip body", async () => {
    const full = gzipSync(Buffer.from(NON_STREAMING_TOOL_USE_RESPONSE, "utf8"));
    const truncated = full.subarray(0, Math.floor(full.length / 2));
    const sniffer = new UsageSniffer("application/json", "gzip");
    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk as Buffer);
        cb();
      },
    });
    await pipeline(Readable.from(chunkify(truncated, [16])), sniffer, writable);
    // Fidelity holds even though sniffing gave up.
    expect(Buffer.concat(chunks).equals(truncated)).toBe(true);
    expect(sniffer.usage).toBeNull();
  });
});

describe("UsageSniffer — how the stream ended (R11.7)", () => {
  it("sees message_stop on a complete stream, and counts what it forwarded", async () => {
    const { forwarded, termination, bytes } = await runTermination(
      "text/event-stream",
      SSE_STREAM_FIXTURE,
    );

    expect(forwarded.toString("utf8")).toBe(SSE_STREAM_FIXTURE);
    expect(termination.streaming).toBe(true);
    expect(termination.sawMessageStop).toBe(true);
    expect(termination.lastEvent).toBe("message_stop");
    expect(termination.events).toBeGreaterThan(1);
    expect(bytes).toBe(Buffer.byteLength(SSE_STREAM_FIXTURE));
  });

  it("reports NO message_stop when the stream is cut short — even mid-event", async () => {
    // Cut inside the last content delta, the way a dropped socket does it.
    const cut = SSE_STREAM_FIXTURE.slice(0, SSE_STREAM_FIXTURE.indexOf("event: message_stop"));
    const { forwarded, termination } = await runTermination("text/event-stream", cut, [1, 3, 7]);

    // Fidelity first: a truncated stream is still relayed exactly as received.
    expect(forwarded.toString("utf8")).toBe(cut);
    expect(termination.streaming).toBe(true);
    expect(termination.sawMessageStop).toBe(false);
    expect(termination.sawErrorEvent).toBe(false);
    expect(termination.lastEvent).not.toBe("message_stop");
  });

  it("distinguishes an upstream `error` event from a silent truncation (R10.23)", async () => {
    const { termination } = await runTermination("text/event-stream", SSE_ERROR_STREAM_FIXTURE);

    expect(termination.sawErrorEvent).toBe(true);
    // Not a truncation: the upstream said why it stopped.
    expect(termination.sawMessageStop).toBe(false);
  });

  it("says nothing about termination for a non-streaming body", async () => {
    const { termination } = await runTermination(
      "application/json",
      '{"usage":{"input_tokens":1}}',
    );

    expect(termination.streaming).toBe(false);
    expect(termination.sawMessageStop).toBe(false);
    expect(termination.events).toBe(0);
  });
});
