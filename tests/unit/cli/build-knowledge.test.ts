/**
 * B3 — build-knowledge.ts coverage.
 *
 * `ollamaHasModel` is a private (unexported) helper in src/cli/build-knowledge.ts;
 * it is the sole determinant of `buildKnowledgeStack`'s `embedMode`, so every
 * branch of its matching/timeout/fallback logic is exercised here indirectly
 * through the public `buildKnowledgeStack` entry point, backed by a fake Ollama
 * HTTP server (same real-`node:http`-server style as
 * tests/unit/inference/service.test.ts's `modelServer()`).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildKnowledgeStack } from "../../../src/cli/build-knowledge.js";
import {
  createProbeRunner,
  detectCapability,
  embedModelFor,
} from "../../../src/inference/index.js";
import { rmTemp } from "../../helpers/tmp.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** A fake Ollama endpoint whose /api/tags + /v1/embeddings behavior is swappable per-test. */
function fakeOllama(handler: Handler): { server: Server; start(): Promise<string> } {
  const server = createServer(handler);
  return {
    server,
    start: () =>
      new Promise<string>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        });
      }),
  };
}

/** /api/tags handler that reports exactly the given model names as available. */
function tagsHandler(names: readonly string[]): Handler {
  return (req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: names.map((name) => ({ name })) }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  };
}

/** /api/tags + /v1/embeddings handler for a full semantic round-trip. */
function semanticHandler(model: string): Handler {
  return (req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: model }] }));
      return;
    }
    if (req.url === "/v1/embeddings") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          input?: string[];
        };
        const inputs = Array.isArray(parsed.input) ? parsed.input : [];
        res.writeHead(200, { "content-type": "application/json" });
        // Distinct-ish deterministic vectors so different texts don't collide.
        res.end(
          JSON.stringify({
            data: inputs.map((text, index) => ({
              index,
              embedding: [text.length % 7, text.length % 5, text.length % 3, 1],
            })),
          }),
        );
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  };
}

let server: Server | undefined;
let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-build-knowledge-"));
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
  }
  await rm(projectDir, rmTemp);
});

// The tier (and therefore the text-embed model name the real code probes for)
// depends on the host running the tests — detect it once, the same way
// buildKnowledgeStack does, so the fake server can answer for the right model.
let textEmbedModel: string;
beforeAll(async () => {
  const facts = await detectCapability(createProbeRunner());
  textEmbedModel = embedModelFor(facts.tier, "text");
});

describe("buildKnowledgeStack — Ollama model probe (ollamaHasModel via embedMode)", () => {
  it("picks the semantic embedder when the exact model name is present", async () => {
    const fake = fakeOllama(tagsHandler([textEmbedModel]));
    server = fake.server;
    const ollamaBaseUrl = await fake.start();

    const stack = await buildKnowledgeStack({ projectDir, ollamaBaseUrl });
    expect(stack.embedMode).toBe("semantic");
  });

  it("matches a tagged variant on the server (bge-m3 request vs bge-m3:latest listed)", async () => {
    const fake = fakeOllama(tagsHandler([`${textEmbedModel}:latest`]));
    server = fake.server;
    const ollamaBaseUrl = await fake.start();

    const stack = await buildKnowledgeStack({ projectDir, ollamaBaseUrl });
    expect(stack.embedMode).toBe("semantic");
  });

  it("falls back to lexical when the model list doesn't include it", async () => {
    const fake = fakeOllama(tagsHandler(["some-other-model", "qwen2.5:1.5b"]));
    server = fake.server;
    const ollamaBaseUrl = await fake.start();

    const stack = await buildKnowledgeStack({ projectDir, ollamaBaseUrl });
    expect(stack.embedMode).toBe("lexical");
  });

  it("falls back to lexical on a non-200 /api/tags response", async () => {
    const fake = fakeOllama((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
    server = fake.server;
    const ollamaBaseUrl = await fake.start();

    const stack = await buildKnowledgeStack({ projectDir, ollamaBaseUrl });
    expect(stack.embedMode).toBe("lexical");
  });

  it("falls back to lexical on a malformed JSON /api/tags response", async () => {
    const fake = fakeOllama((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{ not json ");
    });
    server = fake.server;
    const ollamaBaseUrl = await fake.start();

    const stack = await buildKnowledgeStack({ projectDir, ollamaBaseUrl });
    expect(stack.embedMode).toBe("lexical");
  });

  it("falls back to lexical without throwing when Ollama is unreachable (connection refused)", async () => {
    // Grab an ephemeral port, then close the listener before use so the port
    // is (almost certainly) refused rather than served — no real Ollama needed.
    const fake = fakeOllama(tagsHandler([textEmbedModel]));
    const ollamaBaseUrl = await fake.start();
    await new Promise<void>((r) => fake.server.close(() => r()));

    await expect(buildKnowledgeStack({ projectDir, ollamaBaseUrl })).resolves.toMatchObject({
      embedMode: "lexical",
    });
  });
});

describe("buildKnowledgeStack — resulting KnowledgeBase is functional", () => {
  it("semantic mode: wires a KB that actually round-trips ingest/search through the fake Ollama embed endpoint", async () => {
    const fake = fakeOllama(semanticHandler(textEmbedModel));
    server = fake.server;
    const ollamaBaseUrl = await fake.start();

    const stack = await buildKnowledgeStack({ projectDir, ollamaBaseUrl });
    expect(stack.embedMode).toBe("semantic");

    const docPath = path.join(projectDir, "notes.md");
    await writeFile(docPath, "# Widget factory\n\nHow to configure the widget factory.\n", "utf8");

    const report = await stack.knowledge.ingest(docPath, "proj");
    expect(report.chunksIndexed).toBeGreaterThan(0);

    const hits = await stack.knowledge.search("widget factory", "proj", 3);
    expect(hits[0]?.chunk.text).toContain("widget factory");
  });

  it("lexical fallback mode: wires a KB that round-trips ingest/search with the hashing embedder, no Ollama needed", async () => {
    // Grab an ephemeral port, then close the listener before use so the
    // connection is refused — no real Ollama needed.
    const fake = fakeOllama(tagsHandler([textEmbedModel]));
    const ollamaBaseUrl = await fake.start();
    await new Promise<void>((r) => fake.server.close(() => r()));

    const stack = await buildKnowledgeStack({ projectDir, ollamaBaseUrl });
    expect(stack.embedMode).toBe("lexical");

    const docPath = path.join(projectDir, "notes.md");
    await writeFile(docPath, "# Widget factory\n\nHow to configure the widget factory.\n", "utf8");

    const report = await stack.knowledge.ingest(docPath, "proj");
    expect(report.chunksIndexed).toBeGreaterThan(0);

    const hits = await stack.knowledge.search("widget factory", "proj", 3);
    expect(hits[0]?.chunk.text).toContain("widget factory");
  });
});
