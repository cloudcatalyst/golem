import { describe, expect, it, vi } from "vitest";
import { GolemProxy } from "../../../src/proxy/server.js";

describe("GolemProxy OpenRouter Context Compression Plugin", () => {
  it("injects the header when the plugin is present in the translated body", async () => {
    const mockTranslate = {
      translateRequest: vi.fn().mockReturnValue({
        body: Buffer.from(
          JSON.stringify({
            model: "openai/gpt-4o",
            messages: [{ role: "user", content: "hello" }],
            plugins: [{ id: "context-compression" }],
          }),
        ),
        stream: false,
      }),
      createStreamTranslator: vi.fn(),
    };

    const capturedPoolHeaders: Record<string, string | string[] | undefined>[] = [];

    const proxy = new GolemProxy({
      upstreamBaseUrl: "http://127.0.0.1:18999",
      translateUpstream: mockTranslate as any,
    });

    // @ts-expect-error — accessing private pool for testing
    vi.spyOn(proxy.pool, "request").mockImplementation(async ({ headers }) => {
      capturedPoolHeaders.push(headers as any);
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: {
          arrayBuffer: async () =>
            Buffer.from(
              JSON.stringify({
                id: "test",
                model: "gpt-4o",
                choices: [{ message: { content: "hi" } }],
              }),
            ).buffer,
        },
      } as any;
    });

    // Start the proxy so it's actually listening
    const addr = await proxy.listen(0);
    const port = addr.port;

    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(
        JSON.stringify({
          model: "claude-3-opus-20240229",
          max_tokens: 100,
          messages: [{ role: "user", content: "hello" }],
        }),
      ),
    });

    expect(capturedPoolHeaders.length).toBeGreaterThan(0);
    const upstreamHeaders = capturedPoolHeaders[0];
    expect(upstreamHeaders?.["openrouter-context-compression"]).toBe("true");

    await proxy.close();
  });

  it("does NOT inject the header when the plugin is absent", async () => {
    const mockTranslate = {
      translateRequest: vi.fn().mockReturnValue({
        body: Buffer.from(
          JSON.stringify({
            model: "openai/gpt-4o",
            messages: [{ role: "user", content: "hello" }],
            plugins: [{ id: "web" }],
          }),
        ),
        stream: false,
      }),
      createStreamTranslator: vi.fn(),
    };

    const capturedPoolHeaders: Record<string, string | string[] | undefined>[] = [];

    const proxy = new GolemProxy({
      upstreamBaseUrl: "http://127.0.0.1:18998",
      translateUpstream: mockTranslate as any,
    });

    // @ts-expect-error
    vi.spyOn(proxy.pool, "request").mockImplementation(async ({ headers }) => {
      capturedPoolHeaders.push(headers as any);
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: {
          arrayBuffer: async () =>
            Buffer.from(
              JSON.stringify({
                id: "test",
                model: "gpt-4o",
                choices: [{ message: { content: "hi" } }],
              }),
            ).buffer,
        },
      } as any;
    });

    const addr = await proxy.listen(0);
    const port = addr.port;

    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(
        JSON.stringify({
          model: "claude-3-opus-20240229",
          max_tokens: 100,
          messages: [{ role: "user", content: "hello" }],
        }),
      ),
    });

    expect(capturedPoolHeaders.length).toBeGreaterThan(0);
    const upstreamHeaders = capturedPoolHeaders[0];
    expect(upstreamHeaders?.["openrouter-context-compression"]).toBeUndefined();

    await proxy.close();
  });
});
