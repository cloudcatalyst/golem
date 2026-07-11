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
import { UsageSniffer } from "../../../src/proxy/usage-sniffer.js";
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
