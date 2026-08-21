/**
 * WS-A / R1.1 — read-only response-body usage sniffer (verification-notes
 * §30-37: gross forwarded tokens are not a valid savings metric on a caching
 * upstream; the billed `usage` block is). Sits between the upstream body and
 * the client response, forwarding every chunk unmodified with zero added
 * latency (CLAUDE.md proxy-fidelity hard rule — no seam, only observation),
 * while opportunistically extracting the Anthropic Messages API `usage`
 * block for telemetry.
 *
 * Real upstream responses are almost always `content-encoding: gzip` (or
 * br/deflate) — the client's `accept-encoding` is forwarded transparently —
 * so the bytes flowing through this stream are compressed, not JSON/SSE
 * text. Sniffing decompresses a SEPARATE copy of each chunk through a side
 * `zlib` stream; the bytes pushed downstream to the client are always the
 * original (possibly compressed) chunk, untouched. An unsupported or absent
 * `content-encoding` skips the decompression step and sniffs raw bytes
 * directly (the case for local test fixtures, which are never encoded).
 *
 * Non-streaming JSON: the whole (decompressed) body is one object with a
 * top-level `usage` field, only parseable once complete — buffered in a side
 * array (never the array pushed downstream) up to a bounded cap; over the
 * cap, sniffing is abandoned but forwarding is unaffected.
 *
 * SSE streaming: `usage` first appears in `message_start` (input + cache
 * tokens), then `message_delta` carries the final cumulative `output_tokens`
 * only. Parsed with an O(1)-memory line scan (a trailing partial-line buffer,
 * decoded incrementally via `StringDecoder` so a chunk boundary mid
 * multi-byte codepoint never corrupts the scan) — the multi-KB content
 * deltas between those two events are never retained.
 *
 * Fail-open throughout: any parse/decompression error leaves `usage` at
 * whatever was captured so far (or null); it can never throw out of the
 * stream, and never delays or alters what reaches the client.
 *
 * R11.7 — it also records HOW an SSE stream ended, because it is already the
 * one thing reading the event names. An Anthropic Messages stream that
 * finishes properly ends with `message_stop`; one that stops without it was
 * TRUNCATED, and the proxy — holding both sockets — is the only party that can
 * say so. That is the signal behind Claude Code's "Connection lost
 * mid-response", which until now left no trace anywhere in Golem.
 *
 * Observed here rather than in a second `Transform` on purpose: this is the
 * only stream hop in the byte pipe, and adding another for one boolean would
 * cost every streaming response a copy to answer a question this scan already
 * has the answer to.
 */

import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { isRecord } from "../shared/json.js";
import type { ResponseUsage } from "./types.js";

/** Cap on buffered bytes while sniffing a non-streaming JSON body. */
const MAX_JSON_SNIFF_BYTES = 4_000_000;

/**
 * A side decompression stream for sniffing, or null when the body isn't
 * (recognizably) compressed — callers then sniff raw bytes directly.
 */
function sniffDecompressorFor(contentEncoding: string | undefined): Transform | null {
  const enc = (contentEncoding ?? "").toLowerCase().trim();
  if (enc === "gzip" || enc === "x-gzip") return createGunzip();
  if (enc === "br") return createBrotliDecompress();
  if (enc === "deflate") return createInflate();
  return null;
}

interface PartialUsage {
  readonly inputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly outputTokens?: number;
}

function parseUsageBlock(value: unknown): PartialUsage | null {
  if (!isRecord(value)) return null;
  const out: { -readonly [K in keyof PartialUsage]?: number } = {};
  if (typeof value.input_tokens === "number") out.inputTokens = value.input_tokens;
  if (typeof value.cache_creation_input_tokens === "number")
    out.cacheCreationInputTokens = value.cache_creation_input_tokens;
  if (typeof value.cache_read_input_tokens === "number")
    out.cacheReadInputTokens = value.cache_read_input_tokens;
  if (typeof value.output_tokens === "number") out.outputTokens = value.output_tokens;
  return out;
}

/**
 * How an SSE response ended (R11.7). `streaming` false means the body was not
 * an event stream, so the other fields say nothing about it.
 */
export interface StreamTermination {
  /** The body was `text/event-stream`. */
  readonly streaming: boolean;
  /** An Anthropic `message_stop` event was seen — the stream ended properly. */
  readonly sawMessageStop: boolean;
  /** An `error` event was seen (R10.23's case: the upstream said why). */
  readonly sawErrorEvent: boolean;
  /** The last `event:` name seen, for a truncation report that names where it stopped. */
  readonly lastEvent: string | null;
  /** How many events went past, so "truncated at 0 events" reads differently from "at 400". */
  readonly events: number;
}

/** A `Transform` that passes bytes through untouched while sniffing `usage`. */
export class UsageSniffer extends Transform {
  readonly #streaming: boolean;
  readonly #decoder = new StringDecoder("utf8");
  readonly #decompressor: Transform | null;
  #decompressFailed = false;
  #lineTail = "";
  #pendingEvent: string | null = null;
  #usage: {
    inputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    outputTokens: number;
  } | null = null;
  #jsonChunks: Buffer[] = [];
  #jsonBytes = 0;
  #jsonOverflowed = false;
  // R11.7 — how the stream ended, and how much went through.
  #bytes = 0;
  #sawMessageStop = false;
  #sawErrorEvent = false;
  #lastEvent: string | null = null;
  #events = 0;

  constructor(contentType: string | undefined, contentEncoding: string | undefined = undefined) {
    super();
    this.#streaming = (contentType ?? "").toLowerCase().includes("event-stream");
    this.#decompressor = sniffDecompressorFor(contentEncoding);
    if (this.#decompressor !== null) {
      this.#decompressor.on("data", (chunk: Buffer) => {
        try {
          this.#onSniffChunk(chunk);
        } catch {
          // Fail-open: sniffing is best-effort observability only.
        }
      });
      // Without this listener, a malformed/truncated compressed body would
      // throw an unhandled 'error' and crash the process — fail open instead.
      this.#decompressor.on("error", () => {
        this.#decompressFailed = true;
      });
    }
  }

  /**
   * R11.7 — how the stream ended, once the response finished.
   *
   * `streaming && !sawMessageStop && !sawErrorEvent` is a truncated Anthropic
   * stream: the socket ended mid-response with neither a proper terminator nor
   * an explanation.
   */
  get termination(): StreamTermination {
    return {
      streaming: this.#streaming,
      sawMessageStop: this.#sawMessageStop,
      sawErrorEvent: this.#sawErrorEvent,
      lastEvent: this.#lastEvent,
      events: this.#events,
    };
  }

  /** Response bytes forwarded to the client (R11.7). Counted, never retained. */
  get bytes(): number {
    return this.#bytes;
  }

  /** Usage captured once the response finished, or null if none was found. */
  get usage(): ResponseUsage | null {
    if (this.#usage === null) return null;
    return { ...this.#usage };
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    // Forward first and unconditionally — sniffing must never add latency
    // or be able to affect what the client receives.
    this.push(chunk);
    this.#bytes += chunk.length;
    try {
      if (this.#decompressor !== null) {
        if (!this.#decompressFailed) this.#decompressor.write(chunk);
      } else {
        this.#onSniffChunk(chunk);
      }
    } catch {
      // Fail-open: sniffing is best-effort observability only.
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    let finished = false;
    const finish = (): void => {
      if (finished) return; // 'end' and 'error' are mutually exclusive, but stay idempotent
      finished = true;
      try {
        if (!this.#streaming) this.#parseBufferedJson();
      } catch {
        // Fail-open.
      }
      callback();
    };
    if (this.#decompressor === null || this.#decompressFailed) {
      finish();
      return;
    }
    this.#decompressor.once("end", finish);
    this.#decompressor.once("error", finish);
    try {
      this.#decompressor.end();
    } catch {
      finish();
    }
  }

  #onSniffChunk(chunk: Buffer): void {
    if (this.#streaming) {
      this.#sniffSseChunk(chunk);
    } else {
      this.#bufferJsonChunk(chunk);
    }
  }

  #sniffSseChunk(chunk: Buffer): void {
    this.#lineTail += this.#decoder.write(chunk);
    const lines = this.#lineTail.split("\n");
    this.#lineTail = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith("event:")) {
        this.#pendingEvent = line.slice("event:".length).trim();
        // R11.7: the terminal events, recorded as they pass. `message_stop` is
        // the proper end of an Anthropic Messages stream; `error` is the
        // upstream saying why it stopped (R10.23). Anything else and the stream
        // simply ran out.
        this.#lastEvent = this.#pendingEvent;
        this.#events += 1;
        if (this.#pendingEvent === "message_stop") this.#sawMessageStop = true;
        else if (this.#pendingEvent === "error") this.#sawErrorEvent = true;
      } else if (line.startsWith("data:")) {
        this.#handleSseData(this.#pendingEvent, line.slice("data:".length).trim());
      } else if (line === "") {
        this.#pendingEvent = null;
      }
    }
  }

  #handleSseData(event: string | null, data: string): void {
    if (event !== "message_start" && event !== "message_delta") return;
    if (data === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;

    if (event === "message_start") {
      const message = parsed.message;
      const usage = isRecord(message) ? parseUsageBlock(message.usage) : null;
      if (usage === null) return;
      this.#usage = {
        inputTokens: usage.inputTokens ?? 0,
        cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
        // message_start's own output_tokens (nearly always ~0-2) is kept
        // only as a placeholder until message_delta supplies the final count.
        outputTokens: usage.outputTokens ?? this.#usage?.outputTokens ?? 0,
      };
      return;
    }

    // message_delta: only output_tokens is present, and it is the final
    // cumulative count — overwrite, never add.
    const usage = parseUsageBlock(parsed.usage);
    if (usage === null || usage.outputTokens === undefined) return;
    this.#usage = {
      inputTokens: this.#usage?.inputTokens ?? 0,
      cacheCreationInputTokens: this.#usage?.cacheCreationInputTokens ?? 0,
      cacheReadInputTokens: this.#usage?.cacheReadInputTokens ?? 0,
      outputTokens: usage.outputTokens,
    };
  }

  #bufferJsonChunk(chunk: Buffer): void {
    if (this.#jsonOverflowed) return;
    this.#jsonBytes += chunk.length;
    if (this.#jsonBytes > MAX_JSON_SNIFF_BYTES) {
      this.#jsonOverflowed = true;
      this.#jsonChunks = [];
      return;
    }
    this.#jsonChunks.push(chunk);
  }

  #parseBufferedJson(): void {
    if (this.#jsonOverflowed || this.#jsonChunks.length === 0) return;
    const parsed: unknown = JSON.parse(Buffer.concat(this.#jsonChunks).toString("utf8"));
    if (!isRecord(parsed)) return;
    const usage = parseUsageBlock(parsed.usage);
    if (usage === null) return;
    this.#usage = {
      inputTokens: usage.inputTokens ?? 0,
      cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
      cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    };
  }
}
