/**
 * WS-D — Ollama's native `/api/tags` + `/api/pull` surface, against a local
 * fake HTTP server. No real Ollama required.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OllamaNativeClient,
  OllamaPullError,
  OllamaUnreachableError,
  parsePullProgressLine,
} from "../../../src/inference/ollama-native.js";

describe("parsePullProgressLine", () => {
  it("returns null for a blank line", () => {
    expect(parsePullProgressLine("")).toBeNull();
    expect(parsePullProgressLine("   \n")).toBeNull();
  });

  it("returns null for unparseable JSON", () => {
    expect(parsePullProgressLine("not json")).toBeNull();
  });

  it("returns null for JSON with neither status nor error", () => {
    expect(parsePullProgressLine('{"digest":"sha256:abc"}')).toBeNull();
  });

  it("parses a plain status line", () => {
    expect(parsePullProgressLine('{"status":"pulling manifest"}')).toEqual({
      status: "pulling manifest",
    });
  });

  it("parses a progress line with digest/total/completed", () => {
    expect(
      parsePullProgressLine(
        '{"status":"downloading","digest":"sha256:abc","total":100,"completed":40}',
      ),
    ).toEqual({ status: "downloading", digest: "sha256:abc", total: 100, completed: 40 });
  });

  it("parses an error line", () => {
    expect(parsePullProgressLine('{"error":"model not found"}')).toEqual({
      status: "",
      error: "model not found",
    });
  });
});

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let baseUrl: string;
let client: OllamaNativeClient;
let handler: Handler;

beforeEach(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = new OllamaNativeClient({ baseUrl });
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("OllamaNativeClient.listModels / isReachable / hasModel", () => {
  it("parses the models array from /api/tags", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            { name: "qwen2.5-coder:7b", size: 4_000_000 },
            { name: "bge-m3:latest", size: 500_000 },
          ],
        }),
      );
    };
    const models = await client.listModels();
    expect(models).toEqual([
      { name: "qwen2.5-coder:7b", sizeBytes: 4_000_000 },
      { name: "bge-m3:latest", sizeBytes: 500_000 },
    ]);
    expect(await client.hasModel("qwen2.5-coder")).toBe(true);
    expect(await client.hasModel("llama3")).toBe(false);
  });

  it("returns an empty list when /api/tags omits models", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
    };
    expect(await client.listModels()).toEqual([]);
  });

  it("isReachable is true on a 200 and false on connection failure", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
    };
    expect(await client.isReachable()).toBe(true);

    const dead = new OllamaNativeClient({ baseUrl: "http://127.0.0.1:1" });
    expect(await dead.isReachable()).toBe(false);
  });

  it("throws OllamaUnreachableError on a non-2xx /api/tags response", async () => {
    handler = (_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    };
    await expect(client.listModels()).rejects.toBeInstanceOf(OllamaUnreachableError);
  });

  it("throws OllamaUnreachableError on a non-JSON /api/tags body", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not json");
    };
    await expect(client.listModels()).rejects.toBeInstanceOf(OllamaUnreachableError);
  });
});

describe("OllamaNativeClient.pull", () => {
  it("resolves once a success status line is streamed", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ status: "pulling manifest" })}\n`);
      res.write(`${JSON.stringify({ status: "downloading", total: 100, completed: 50 })}\n`);
      res.write(`${JSON.stringify({ status: "success" })}\n`);
      res.end();
    };
    const events: string[] = [];
    await client.pull("qwen2.5-coder:7b", (e) => events.push(e.status));
    expect(events).toEqual(["pulling manifest", "downloading", "success"]);
  });

  it("throws OllamaPullError on a stream-level error line", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ error: "model not found" })}\n`);
      res.end();
    };
    await expect(client.pull("nonexistent:model")).rejects.toBeInstanceOf(OllamaPullError);
  });

  it("throws OllamaPullError when the stream ends without success", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ status: "downloading" })}\n`);
      res.end();
    };
    await expect(client.pull("qwen2.5-coder:7b")).rejects.toBeInstanceOf(OllamaPullError);
  });

  it("throws OllamaPullError on a non-2xx /api/pull response", async () => {
    handler = (_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    };
    await expect(client.pull("qwen2.5-coder:7b")).rejects.toBeInstanceOf(OllamaPullError);
  });
});
