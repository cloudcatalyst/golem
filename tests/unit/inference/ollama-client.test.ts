/**
 * WS-D D2 — Ollama client against a local fake OpenAI-compatible server.
 * No real Ollama required.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EMBED_BATCH_SIZE,
  InferenceEndpointError,
  InferenceTimeoutError,
  MAX_EMBED_INPUT_CHARS,
  ModelNotAvailableError,
  OllamaClient,
} from "../../../src/inference/ollama-client.js";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server;
let baseUrl: string;
let client: OllamaClient;
let handler: Handler;

beforeEach(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = new OllamaClient({ baseUrl });
});

afterEach(async () => {
  await client.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("OllamaClient.chat", () => {
  it("posts an OpenAI-shaped request and parses the completion", async () => {
    let seenPath = "";
    let seenBody: Record<string, unknown> = {};
    handler = (req, res, body) => {
      seenPath = req.url ?? "";
      seenBody = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "qwen2.5:7b",
          choices: [{ message: { content: "hello there" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      );
    };

    const result = await client.chat({
      model: "qwen2.5:7b",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
    });

    expect(seenPath).toBe("/v1/chat/completions");
    expect(seenBody.model).toBe("qwen2.5:7b");
    expect(seenBody.stream).toBe(false);
    expect(seenBody.temperature).toBe(0.2);
    expect(result.text).toBe("hello there");
    expect(result.promptTokens).toBe(5);
    expect(result.completionTokens).toBe(2);
    expect(result.finishReason).toBe("stop");
  });

  it("throws ModelNotAvailableError on a 404 'not found' body", async () => {
    handler = (_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: 'model "qwen2.5:32b" not found, try pulling it' } }),
      );
    };
    await expect(
      client.chat({ model: "qwen2.5:32b", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(ModelNotAvailableError);
  });

  it("throws InferenceEndpointError on a 500", async () => {
    handler = (_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    };
    await expect(
      client.chat({ model: "x", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(InferenceEndpointError);
  });

  it("wraps a connection failure as InferenceEndpointError", async () => {
    const dead = new OllamaClient({ baseUrl: "http://127.0.0.1:1" });
    try {
      await expect(
        dead.chat({ model: "x", messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toBeInstanceOf(InferenceEndpointError);
    } finally {
      await dead.close();
    }
  });

  it("throws InferenceTimeoutError (not a generic endpoint error) when the model is too slow", async () => {
    // A reachable endpoint that responds only AFTER the client's request timeout:
    // the exact §66 failure — a slow/cold local model, misread previously as
    // "no model at this tier". Must surface as a distinct, actionable timeout.
    // (undici uses a coarse ~500ms timer tick, so keep the delay well above the
    // timeout for a deterministic fire.)
    let timer: ReturnType<typeof setTimeout> | undefined;
    handler = (_req, res) => {
      timer = setTimeout(() => {
        if (!res.destroyed) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "late" } }] }));
        }
      }, 5000);
      res.on("close", () => timer && clearTimeout(timer)); // client aborted → drop the late write
    };
    const slow = new OllamaClient({ baseUrl, requestTimeoutMs: 300 });
    try {
      const err = await slow
        .chat({ model: "x", messages: [{ role: "user", content: "hi" }] })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InferenceTimeoutError);
      // Subtype of InferenceEndpointError, but the message names the real cause + fix.
      expect(err).toBeInstanceOf(InferenceEndpointError);
      expect((err as InferenceTimeoutError).message).toContain("request_timeout_ms");
    } finally {
      if (timer) clearTimeout(timer);
      await slow.close();
    }
  });
});

describe("OllamaClient.embed", () => {
  it("returns one vector per input, reordered by index", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // Deliberately out of order to exercise the index sort.
      res.end(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0.4, 0.5, 0.6] },
            { index: 0, embedding: [0.1, 0.2, 0.3] },
          ],
        }),
      );
    };
    const vecs = await client.embed("bge-m3", ["alpha", "beta"]);
    expect(vecs).toStrictEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
  });

  it("bounds each input to MAX_EMBED_INPUT_CHARS so an oversized chunk can't exceed the model's physical batch (§69/LE5)", async () => {
    let seenInput: string[] = [];
    handler = (_req, res, body) => {
      seenInput = (JSON.parse(body) as { input: string[] }).input;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: seenInput.map((_v, i) => ({ index: i, embedding: [i] })),
        }),
      );
    };

    const oversized = "x".repeat(MAX_EMBED_INPUT_CHARS + 5000);
    const normal = "small chunk";
    await client.embed("bge-m3", [oversized, normal]);

    expect(seenInput[0]?.length).toBe(MAX_EMBED_INPUT_CHARS); // truncated
    expect(seenInput[1]).toBe(normal); // untouched
  });

  it("splits a large input into batches of EMBED_BATCH_SIZE, preserving overall order (§69/LE5)", async () => {
    const batchSizes: number[] = [];
    let call = 0;
    handler = (_req, res, body) => {
      const inputs = (JSON.parse(body) as { input: string[] }).input;
      batchSizes.push(inputs.length);
      const base = call * EMBED_BATCH_SIZE;
      call += 1;
      res.writeHead(200, { "content-type": "application/json" });
      // Return per-item vectors carrying the item's global index so we can
      // verify concatenation order across batches. Deliberately reversed to
      // exercise the per-response index sort.
      res.end(
        JSON.stringify({
          data: inputs.map((_v, i) => ({ index: i, embedding: [base + i] })).reverse(),
        }),
      );
    };

    const n = EMBED_BATCH_SIZE * 2 + 5; // 133 inputs -> 3 requests (64, 64, 5)
    const vecs = await client.embed(
      "bge-m3",
      Array.from({ length: n }, (_v, i) => `chunk ${i}`),
    );

    expect(batchSizes).toStrictEqual([EMBED_BATCH_SIZE, EMBED_BATCH_SIZE, 5]);
    expect(vecs).toHaveLength(n);
    expect(vecs.map((v) => v[0])).toStrictEqual(Array.from({ length: n }, (_v, i) => i));
  });
});
