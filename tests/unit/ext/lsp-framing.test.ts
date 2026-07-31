/**
 * R8.6 — the LSP base-protocol codec.
 *
 * Framing is where a bridge silently corrupts itself: a byte/char length mixup
 * or a chunk boundary in the wrong place desynchronises the stream and every
 * later answer is garbage. All of it is testable without a process, so it is.
 */

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  encodeMessage,
  LspProtocolError,
  MAX_HEADER_BYTES,
  MessageBuffer,
} from "../../../src/ext/lsp/framing.js";

function frame(
  body: string,
  header = `Content-Length: ${Buffer.byteLength(body, "utf8")}`,
): Buffer {
  return Buffer.concat([Buffer.from(`${header}\r\n\r\n`, "ascii"), Buffer.from(body, "utf8")]);
}

describe("encodeMessage", () => {
  it("declares the BYTE length, not the character count", () => {
    // "é" is one character and two UTF-8 bytes: the bug this guards against
    // truncates every frame containing a non-ASCII identifier.
    const encoded = encodeMessage({ hover: "café" });
    const header = encoded.subarray(0, encoded.indexOf("\r\n\r\n")).toString("ascii");
    const body = JSON.stringify({ hover: "café" });
    expect(header).toBe(`Content-Length: ${Buffer.byteLength(body, "utf8")}`);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(body.length);
  });

  it("round-trips through MessageBuffer", () => {
    const buffer = new MessageBuffer();
    buffer.append(encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    expect(buffer.drain()).toEqual([{ jsonrpc: "2.0", id: 1, method: "initialize" }]);
  });
});

describe("MessageBuffer", () => {
  it("returns every complete message in one chunk, in order", () => {
    const buffer = new MessageBuffer();
    buffer.append(Buffer.concat([frame('{"n":1}'), frame('{"n":2}'), frame('{"n":3}')]));
    expect(buffer.drain()).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("holds a partial frame until the rest arrives", () => {
    const buffer = new MessageBuffer();
    const whole = frame('{"n":42}');
    for (const byte of whole.subarray(0, whole.length - 1)) {
      buffer.append(Buffer.from([byte]));
      expect(buffer.drain()).toEqual([]);
    }
    buffer.append(whole.subarray(whole.length - 1));
    expect(buffer.drain()).toEqual([{ n: 42 }]);
  });

  it("ignores extra headers and tolerates header case and padding", () => {
    const buffer = new MessageBuffer();
    buffer.append(
      frame(
        '{"ok":true}',
        "Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length:   11  ",
      ),
    );
    expect(buffer.drain()).toEqual([{ ok: true }]);
  });

  it("decodes a multi-byte body by bytes, not characters", () => {
    const buffer = new MessageBuffer();
    buffer.append(encodeMessage({ s: "naïve — ✓" }));
    buffer.append(encodeMessage({ s: "second" }));
    expect(buffer.drain()).toEqual([{ s: "naïve — ✓" }, { s: "second" }]);
  });

  it("throws on a frame with no Content-Length", () => {
    const buffer = new MessageBuffer();
    buffer.append(frame('{"n":1}', "Content-Type: text/plain"));
    expect(() => buffer.drain()).toThrow(LspProtocolError);
  });

  it("throws on a non-numeric Content-Length", () => {
    const buffer = new MessageBuffer();
    buffer.append(frame('{"n":1}', "Content-Length: seven"));
    expect(() => buffer.drain()).toThrow(/invalid Content-Length/);
  });

  it("throws on a declared length beyond the cap", () => {
    const buffer = new MessageBuffer();
    buffer.append(frame("{}", "Content-Length: 99999999999"));
    expect(() => buffer.drain()).toThrow(/exceeds/);
  });

  it("throws on a body that is not JSON", () => {
    const buffer = new MessageBuffer();
    buffer.append(frame("not json"));
    expect(() => buffer.drain()).toThrow(/not JSON/);
  });

  it("refuses to buffer an unbounded header block", () => {
    const buffer = new MessageBuffer();
    buffer.append(Buffer.alloc(MAX_HEADER_BYTES + 1, 0x41));
    expect(() => buffer.drain()).toThrow(/header size limit/);
  });
});
