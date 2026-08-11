/**
 * LSP base-protocol wire codec (R8.6).
 *
 * The Language Server Protocol is JSON-RPC 2.0 over a stream, framed with
 * HTTP-style headers: `Content-Length: <n>\r\n\r\n<n bytes of JSON>`. That is
 * the whole wire format, so it lives here as pure, synchronous, dependency-free
 * code — everything testable without spawning a process is tested without
 * spawning one, which is what keeps the cross-OS lifecycle tests small.
 *
 * Two details bite in practice and are handled deliberately:
 *  - `Content-Length` counts **bytes, not characters**. A server that sends a
 *    non-ASCII identifier in a hover string desynchronises the stream forever
 *    if the encoder uses `string.length`.
 *  - a chunk boundary can fall anywhere — mid-header, mid-JSON, or between two
 *    complete messages. {@link MessageBuffer} therefore buffers and re-parses
 *    rather than assuming one chunk is one message.
 */

import { Buffer } from "node:buffer";

/**
 * Largest single message accepted, in bytes. A language server answering
 * `references` on a popular symbol can legitimately return a big payload, but
 * an unbounded frame length is an out-of-memory primitive handed to a
 * subprocess — bound it and fail the request instead.
 */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** Largest header block accepted, in bytes — a frame's worth of headers is tiny. */
export const MAX_HEADER_BYTES = 8 * 1024;

/** A malformed frame. Fatal for the connection: the stream cannot be resynchronised. */
export class LspProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspProtocolError";
  }
}

/** Serialise one JSON-RPC message into a framed buffer ready for the server's stdin. */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.byteLength > MAX_MESSAGE_BYTES) {
    throw new LspProtocolError(
      `outgoing message is ${body.byteLength} bytes (max ${MAX_MESSAGE_BYTES})`,
    );
  }
  // Byte length, never character length — see the module note.
  const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");

/**
 * Incremental decoder for a language server's stdout.
 *
 * Feed it every chunk with {@link append}; call {@link drain} to take whatever
 * complete messages have arrived. A partial frame stays buffered until the rest
 * of it turns up.
 */
export class MessageBuffer {
  private pending: Buffer = Buffer.alloc(0);

  append(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
  }

  /**
   * Every complete message received so far, in order. Throws
   * {@link LspProtocolError} on a frame that can never become valid — the
   * caller's only correct response is to tear the connection down.
   */
  drain(): unknown[] {
    const messages: unknown[] = [];
    for (;;) {
      const separator = this.pending.indexOf(HEADER_SEPARATOR);
      if (separator === -1) {
        // No header block yet. If the buffer has already outgrown what a header
        // block may be, this is not a slow header — it is garbage.
        if (this.pending.byteLength > MAX_HEADER_BYTES) {
          throw new LspProtocolError("no header terminator within the header size limit");
        }
        return messages;
      }
      if (separator > MAX_HEADER_BYTES) {
        throw new LspProtocolError(`header block is ${separator} bytes (max ${MAX_HEADER_BYTES})`);
      }

      const contentLength = parseContentLength(
        this.pending.subarray(0, separator).toString("ascii"),
      );
      const bodyStart = separator + HEADER_SEPARATOR.byteLength;
      if (this.pending.byteLength - bodyStart < contentLength) return messages; // body still arriving

      const body = this.pending.subarray(bodyStart, bodyStart + contentLength);
      // Advance past the consumed frame BEFORE parsing, so a JSON error does not
      // also leave the buffer wedged on the same bytes.
      this.pending = this.pending.subarray(bodyStart + contentLength);
      try {
        messages.push(JSON.parse(body.toString("utf8")));
      } catch (err) {
        throw new LspProtocolError(`message body is not JSON: ${(err as Error).message}`);
      }
    }
  }
}

/**
 * The declared body length from a header block. Header names are
 * case-insensitive and values may be padded (LSP's own examples send
 * `Content-Type` alongside); anything else in the block is ignored.
 */
function parseContentLength(headerBlock: string): number {
  for (const line of headerBlock.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== "content-length") continue;
    const raw = line.slice(colon + 1).trim();
    const value = Number(raw);
    if (raw.length === 0 || !Number.isSafeInteger(value) || value < 0) {
      throw new LspProtocolError(`invalid Content-Length: ${raw}`);
    }
    if (value > MAX_MESSAGE_BYTES) {
      throw new LspProtocolError(`declared Content-Length ${value} exceeds ${MAX_MESSAGE_BYTES}`);
    }
    return value;
  }
  throw new LspProtocolError("frame has no Content-Length header");
}
