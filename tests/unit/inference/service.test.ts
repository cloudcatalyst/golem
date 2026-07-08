/**
 * WS-D D3 — InferenceService routing + fallback, and the frozen contract.
 * Backed by a local fake OpenAI-compatible server.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CapabilityFacts } from "../../../src/inference/capability.js";
import { chatModelFor } from "../../../src/inference/catalog.js";
import { OllamaClient } from "../../../src/inference/ollama-client.js";
import { HaikuFallbackRequired, OllamaInferenceService } from "../../../src/inference/service.js";
import { CapabilityUnavailableError, HardwareTier } from "../../../src/interfaces/inference.js";
import { describeInferenceServiceContract } from "../../contract/inference-contract.js";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

/** A fake endpoint that only "has" the given set of model ids. */
function modelServer(available: ReadonlySet<string>): { handler: Handler } {
  const box: { handler: Handler } = {
    handler: (_req, res, body) => {
      const req = JSON.parse(body) as { model: string; input?: string[] };
      if (!available.has(req.model)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `model "${req.model}" not found` } }));
        return;
      }
      const inputs = Array.isArray(req.input) ? req.input : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: req.model,
          choices: [{ message: { content: `ok from ${req.model}` }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 3 },
          data: inputs.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3, 0.4] })),
        }),
      );
    },
  };
  return box;
}

let server: Server;
let baseUrl: string;
let box: { handler: Handler };

async function start(available: ReadonlySet<string>): Promise<void> {
  box = modelServer(available);
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => box.handler(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

function facts(tier: HardwareTier): CapabilityFacts {
  return { tier, source: "test", detail: "test" };
}

describe("OllamaInferenceService routing", () => {
  it("uses the tier's model for a role when available", async () => {
    const model = chatModelFor(HardwareTier.PMid, "summarizer");
    await start(new Set([model]));
    const client = new OllamaClient({ baseUrl });
    try {
      const svc = new OllamaInferenceService(client, facts(HardwareTier.PMid));
      const res = await svc.chat("summarizer", [{ role: "user", content: "hi" }]);
      expect(res.model).toBe(model);
      expect(res.role).toBe("summarizer");
      expect(res.text).toContain(model);
    } finally {
      await client.close();
    }
  });

  it("steps down a tier when the preferred model is missing", async () => {
    // Only the P_CPU judge model is present; a P_MID service must step down.
    const cpuModel = chatModelFor(HardwareTier.PCpu, "judge");
    await start(new Set([cpuModel]));
    const client = new OllamaClient({ baseUrl });
    try {
      const svc = new OllamaInferenceService(client, facts(HardwareTier.PMid), {
        fallback: { stepDownTier: true },
      });
      const res = await svc.chat("judge", [{ role: "user", content: "hi" }]);
      expect(res.model).toBe(cpuModel);
    } finally {
      await client.close();
    }
  });

  it("throws CapabilityUnavailableError when nothing local works and Haiku is off", async () => {
    await start(new Set()); // no models at all
    const client = new OllamaClient({ baseUrl });
    try {
      const svc = new OllamaInferenceService(client, facts(HardwareTier.PMin), {
        fallback: { stepDownTier: true, allowHaiku: false },
      });
      await expect(svc.chat("drafter", [{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(
        CapabilityUnavailableError,
      );
    } finally {
      await client.close();
    }
  });

  it("signals HaikuFallbackRequired when local fails and Haiku is allowed", async () => {
    await start(new Set());
    const client = new OllamaClient({ baseUrl });
    try {
      const svc = new OllamaInferenceService(client, facts(HardwareTier.PMin), {
        fallback: { allowHaiku: true },
      });
      await expect(svc.chat("drafter", [{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(
        HaikuFallbackRequired,
      );
    } finally {
      await client.close();
    }
  });

  it("stops at the first InferenceEndpointError instead of hammering every remaining tier", async () => {
    // Every request gets a 200 with a malformed (non-JSON) body, which
    // ollama-client.ts turns into an InferenceEndpointError — distinct from
    // the ModelNotAvailableError (404) the other tests simulate. That error
    // is documented as terminal for the fallback loop (service.ts `break`),
    // so with stepDownTier from P_MAX down to P_CPU we expect exactly ONE
    // request, not one per tier (4, if `break` regressed to `continue`).
    let requestCount = 0;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        requestCount += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("not valid json");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = new OllamaClient({ baseUrl });
    try {
      const svc = new OllamaInferenceService(client, facts(HardwareTier.PMax), {
        fallback: { stepDownTier: true },
      });
      await expect(svc.chat("judge", [{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(
        CapabilityUnavailableError,
      );
      expect(requestCount).toBe(1);
    } finally {
      await client.close();
    }
  });
});

// The frozen contract, backed by a server that has every model the CPU tier
// asks for (the harness runs at whatever tier we report).
describe("contract", () => {
  // We need a running server for the whole contract block; start one that
  // answers for any model (superset), by intercepting with an always-available
  // set built from the CPU tier's needs is fragile — simplest: a server that
  // says yes to everything.
  let contractServer: Server;
  let contractBase: string;

  beforeEach(async () => {
    contractServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const reqBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          model: string;
          input?: string[];
        };
        res.writeHead(200, { "content-type": "application/json" });
        // Embeddings: one row per input (real Ollama shape). Chat: choices.
        const inputs = Array.isArray(reqBody.input) ? reqBody.input : [];
        res.end(
          JSON.stringify({
            model: reqBody.model,
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            data: inputs.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3, 0.4] })),
          }),
        );
      });
    });
    await new Promise<void>((r) => contractServer.listen(0, "127.0.0.1", r));
    contractBase = `http://127.0.0.1:${(contractServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => contractServer.close(() => r()));
  });

  describeInferenceServiceContract("OllamaInferenceService", () => {
    const client = new OllamaClient({ baseUrl: contractBase });
    return new OllamaInferenceService(client, facts(HardwareTier.PCpu));
  });
});
