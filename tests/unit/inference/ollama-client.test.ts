/**
 * WS-D D2 — Ollama client against a local fake OpenAI-compatible server.
 * No real Ollama required.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InferenceEndpointError,
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
});
