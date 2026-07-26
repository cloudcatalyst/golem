/**
 * Decision 46 — pre-flight credential probe.
 *
 * Verdict mapping is the contract: 2xx accepted, 401/403 rejected (the only
 * verdict that blocks a store), everything else honestly inconclusive. Exercised
 * against a real local HTTP server so the undici path is real, not mocked.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { modelsUrl, probeCredential } from "../../../src/credentials/probe.js";

describe("modelsUrl", () => {
  it("appends /v1/models to an Anthropic-style base", () => {
    expect(modelsUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/models");
    expect(modelsUrl("https://api.anthropic.com/")).toBe("https://api.anthropic.com/v1/models");
  });

  it("does not double a base that already ends in /v1", () => {
    expect(modelsUrl("https://api.moonshot.ai/v1")).toBe("https://api.moonshot.ai/v1/models");
  });
});

describe("probeCredential", () => {
  let server: Server;
  let baseUrl: string;
  /** The one key the fake upstream accepts. */
  const GOOD = "sk-good-key";
  let lastAuthHeader: string | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      lastAuthHeader = req.headers.authorization as string | undefined;
      const key = req.headers["x-api-key"] as string | undefined;
      if (!req.url?.startsWith("/v1/models")) {
        res.writeHead(404).end("{}");
        return;
      }
      if (key === GOOD || lastAuthHeader === `Bearer ${GOOD}`) {
        res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
        return;
      }
      res.writeHead(401).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("accepts a key the upstream answers 2xx for", async () => {
    const r = await probeCredential({
      provider: "anthropic",
      baseUrl,
      authScheme: "x-api-key",
      secret: GOOD,
    });
    expect(r.verdict).toBe("accepted");
    expect(r.status).toBe(200);
  });

  it("rejects a key the upstream answers 401 for — the only blocking verdict", async () => {
    const r = await probeCredential({
      provider: "anthropic",
      baseUrl,
      authScheme: "x-api-key",
      secret: "sk-wrong",
    });
    expect(r.verdict).toBe("rejected");
    expect(r.status).toBe(401);
    expect(r.detail).toMatch(/rejected/);
  });

  it("maps a missing endpoint to inconclusive, never to accepted", async () => {
    const r = await probeCredential({
      provider: "openai",
      baseUrl: `${baseUrl}/no-such-base`, // → /v1/models under a 404 path
      authScheme: "bearer",
      secret: GOOD,
    });
    // The fake server 404s anything not under /v1/models at its root.
    expect(r.verdict).toBe("inconclusive");
    expect(r.status).toBe(404);
  });

  it("sends a bearer header for an OpenAI-style provider", async () => {
    await probeCredential({ provider: "openai", baseUrl, authScheme: "bearer", secret: GOOD });
    expect(lastAuthHeader).toBe(`Bearer ${GOOD}`);
  });

  it("never throws on an unreachable host — that is inconclusive, not evidence about the key", async () => {
    const r = await probeCredential({
      provider: "anthropic",
      baseUrl: "http://127.0.0.1:1", // nothing listens on port 1
      authScheme: "x-api-key",
      secret: "sk-anything",
      timeoutMs: 500,
    });
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toMatch(/could not reach/);
  });

  it("no detail string ever contains the secret", async () => {
    const secret = "sk-must-never-leak";
    for (const base of [baseUrl, "http://127.0.0.1:1"]) {
      const r = await probeCredential({
        provider: "anthropic",
        baseUrl: base,
        authScheme: "x-api-key",
        secret,
        timeoutMs: 500,
      });
      expect(r.detail).not.toContain(secret);
    }
  });
});
