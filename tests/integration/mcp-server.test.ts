/**
 * WS-B task B1 — unified MCP server integration tests.
 *
 * Spins the server in-process over the SDK's linked in-memory transport pair
 * (plus one real streamable-HTTP round-trip), lists tools and prompts, and
 * exercises every P0 tool with valid and invalid inputs.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { InferenceEndpointError, ModelNotAvailableError } from "../../src/inference/index.js";
import type { Chunk, Hit, IngestReport, KnowledgeBase } from "../../src/interfaces/index.js";
import { sliderPolicyForLevel } from "../../src/interfaces/index.js";
import { NotImplementedYetError } from "../../src/knowledge/index.js";
import { createGolemMcpServer, createStandaloneDeps, serveHttp } from "../../src/mcp/index.js";

const P0_TOOLS = ["golem_expand", "golem_stats", "golem_set_slider"] as const;
const ALL_PROMPTS = [
  "slider",
  "index",
  "search",
  "stats",
  "expand",
  "bypass",
  "devices",
  "delegate",
] as const;

type Deps = ReturnType<typeof createStandaloneDeps>;

async function connectInMemory(deps: Deps): Promise<Client> {
  const server = createGolemMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "golem-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/**
 * Assert the SDK's boundary behavior for invalid tool input: zod validation
 * failures come back as `isError: true` tool results whose text embeds the
 * JSON-RPC InvalidParams code (-32602) — not as protocol-level errors
 * (SDK 1.29.0; verification-notes.md §18).
 */
function expectInvalidParamsResult(result: unknown): void {
  expect((result as { isError?: boolean }).isError).toBe(true);
  const text = textOf(result);
  expect(text).toContain(String(ErrorCode.InvalidParams));
  expect(text).toContain("Input validation error");
}

function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content as ReadonlyArray<{
    type: string;
    text?: string;
  }>;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/** Compress an oversized tool_result at level 2 so a CCR ref exists. */
async function seedCcrRef(deps: Deps): Promise<{ refId: string; original: string }> {
  const original = "error CS0103: name 'foo' does not exist ".repeat(200);
  const result = await deps.compression.compress(
    [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_01", content: original }],
      },
    ],
    sliderPolicyForLevel(2),
    "mcp-test-project",
  );
  const ref = result.refs[0];
  expect(ref).toBeDefined();
  if (ref === undefined) throw new Error("stub emitted no CCR ref");
  return { refId: ref.refId, original };
}

describe("golem MCP server (in-memory transport)", () => {
  it("lists exactly the P0 tools with the frozen names", async () => {
    const client = await connectInMemory(createStandaloneDeps());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toStrictEqual([...P0_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("lists all 8 frozen prompts", async () => {
    const client = await connectInMemory(createStandaloneDeps());
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toStrictEqual([...ALL_PROMPTS].sort());
  });

  describe("golem_expand", () => {
    it("returns the original content for a stored CCR ref", async () => {
      const deps = createStandaloneDeps();
      const { refId, original } = await seedCcrRef(deps);
      const client = await connectInMemory(deps);

      const result = await client.callTool({
        name: "golem_expand",
        arguments: { ref_id: refId },
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toBe(original);
    });

    it("returns isError (not a protocol error) for an unknown ref", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const result = await client.callTool({
        name: "golem_expand",
        arguments: { ref_id: "no-such-ref" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("no-such-ref");
    });

    it("maps invalid input (missing ref_id) to an InvalidParams error result", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const result = await client.callTool({ name: "golem_expand", arguments: {} });
      expectInvalidParamsResult(result);
    });

    it("maps a wrongly-typed ref_id to an InvalidParams error result", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const result = await client.callTool({
        name: "golem_expand",
        arguments: { ref_id: 42 },
      });
      expectInvalidParamsResult(result);
    });
  });

  describe("golem_set_slider + golem_stats", () => {
    it("sets a valid level, persists it, and reports it via golem_stats", async () => {
      const deps = createStandaloneDeps();
      const client = await connectInMemory(deps);

      const setResult = await client.callTool({
        name: "golem_set_slider",
        arguments: { level: 3 },
      });
      expect(setResult.isError).toBeFalsy();
      expect(setResult.structuredContent).toMatchObject({
        slider_level: 3,
        slider_level_name: "balanced",
      });
      await expect(deps.sliderStore.get()).resolves.toBe(3);

      const statsResult = await client.callTool({ name: "golem_stats", arguments: {} });
      expect(statsResult.isError).toBeFalsy();
      expect(statsResult.structuredContent).toMatchObject({ slider_level: 3 });
    });

    it.each([
      -1, 6, 2.5,
    ])("maps out-of-range level %s to an InvalidParams error result", async (level) => {
      const deps = createStandaloneDeps();
      const client = await connectInMemory(deps);
      const result = await client.callTool({ name: "golem_set_slider", arguments: { level } });
      expectInvalidParamsResult(result);
      // Invalid calls must not have changed persisted state.
      await expect(deps.sliderStore.get()).resolves.toBe(1);
    });

    it("maps a non-numeric level to an InvalidParams error result", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const result = await client.callTool({
        name: "golem_set_slider",
        arguments: { level: "high" },
      });
      expectInvalidParamsResult(result);
    });

    it("golem_stats reports snake_case savings fields, globally and per project", async () => {
      const deps = createStandaloneDeps();
      await seedCcrRef(deps); // one compress() against "mcp-test-project"
      const client = await connectInMemory(deps);

      const globalStats = await client.callTool({ name: "golem_stats", arguments: {} });
      expect(globalStats.structuredContent).toMatchObject({
        project_id: null,
        slider_level: 1,
        slider_level_name: "lossless",
        requests: 1,
        ccr_refs_stored: 1,
      });
      const structured = globalStats.structuredContent as Record<string, number>;
      expect(structured.tokens_saved).toBe(
        (structured.tokens_before ?? 0) - (structured.tokens_after ?? 0),
      );
      expect(structured.tokens_saved).toBeGreaterThan(0);

      const projectStats = await client.callTool({
        name: "golem_stats",
        arguments: { project_id: "mcp-test-project" },
      });
      expect(projectStats.structuredContent).toMatchObject({
        project_id: "mcp-test-project",
        requests: 1,
      });
    });

    it("maps a wrongly-typed project_id to an InvalidParams error result", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const result = await client.callTool({
        name: "golem_stats",
        arguments: { project_id: 7 },
      });
      expectInvalidParamsResult(result);
    });
  });

  describe("prompts", () => {
    it("slider prompt embeds the requested level and points at golem_set_slider", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const prompt = await client.getPrompt({ name: "slider", arguments: { level: "4" } });
      const first = prompt.messages[0];
      expect(first?.role).toBe("user");
      const text = first?.content.type === "text" ? first.content.text : "";
      expect(text).toContain("golem_set_slider");
      expect(text).toContain("level 4");
    });

    it("slider prompt without args points at golem_stats instead", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const prompt = await client.getPrompt({ name: "slider", arguments: {} });
      const first = prompt.messages[0];
      const text = first?.content.type === "text" ? first.content.text : "";
      expect(text).toContain("golem_stats");
    });

    it("expand prompt requires ref_id", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      await expect(client.getPrompt({ name: "expand", arguments: {} })).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
      });
      const prompt = await client.getPrompt({ name: "expand", arguments: { ref_id: "abc123" } });
      const first = prompt.messages[0];
      const text = first?.content.type === "text" ? first.content.text : "";
      expect(text).toContain("golem_expand");
      expect(text).toContain("abc123");
    });

    it("bypass prompt instructs a level-0 set and mentions the bypass header", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const prompt = await client.getPrompt({ name: "bypass" });
      const first = prompt.messages[0];
      const text = first?.content.type === "text" ? first.content.text : "";
      expect(text).toContain("golem_set_slider");
      expect(text).toContain("x-golem-bypass");
    });
  });
});

/**
 * `backendUnavailableMessage()` (src/mcp/server.ts) maps a knowledge-backend
 * failure's `err.name` to a friendly, actionable message shared by all three
 * P1 knowledge tools. It is not exported, so these tests drive it through the
 * real `golem_search` / `golem_get_chunk` / `golem_index_path` handlers with a
 * KnowledgeBase stub that throws a chosen error from every method.
 */
describe("golem knowledge tools — backendUnavailableMessage mapping (B3)", () => {
  class ThrowingKnowledgeBase implements KnowledgeBase {
    constructor(private readonly err: Error) {}
    async ingest(): Promise<IngestReport> {
      throw this.err;
    }
    async search(): Promise<Hit[]> {
      throw this.err;
    }
    async getChunk(): Promise<Chunk> {
      throw this.err;
    }
  }

  function depsWithKnowledgeError(err: Error): Deps {
    return {
      ...createStandaloneDeps(),
      knowledge: new ThrowingKnowledgeBase(err),
      defaultProjectId: "proj-1",
    };
  }

  const modelNotAvailableErr = new ModelNotAvailableError("bge-m3");

  const MAPPED_ERRORS: ReadonlyArray<readonly [name: string, err: Error, friendlyMessage: string]> =
    [
      [
        "InferenceEndpointError",
        new InferenceEndpointError("connect ECONNREFUSED 127.0.0.1:11434"),
        "Golem's local inference endpoint (Ollama) is unreachable, so the knowledge " +
          "base cannot embed. Start Ollama and ensure the embedding model is pulled " +
          "(see `golem devices`), then retry.",
      ],
      [
        "ModelNotAvailableError",
        modelNotAvailableErr,
        `A local model the knowledge base needs is not installed: ${modelNotAvailableErr.message}`,
      ],
      [
        "NotImplementedYetError",
        new NotImplementedYetError("Qdrant server driver", "C1-followup"),
        "Golem's knowledge base has no embedding backend available in this run " +
          "(local inference required). Check `golem devices` and that Ollama is running.",
      ],
    ];

  describe.each(MAPPED_ERRORS)("%s", (_name, err, friendlyMessage) => {
    it("golem_search surfaces the friendly message as an isError result", async () => {
      const client = await connectInMemory(depsWithKnowledgeError(err));
      const result = await client.callTool({ name: "golem_search", arguments: { query: "q" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(friendlyMessage);
    });

    it("golem_get_chunk surfaces the friendly message as an isError result", async () => {
      const client = await connectInMemory(depsWithKnowledgeError(err));
      const result = await client.callTool({
        name: "golem_get_chunk",
        arguments: { chunk_id: "chunk-1" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(friendlyMessage);
    });

    it("golem_index_path surfaces the friendly message as an isError result", async () => {
      const client = await connectInMemory(depsWithKnowledgeError(err));
      const result = await client.callTool({
        name: "golem_index_path",
        arguments: { path: "src" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(friendlyMessage);
    });
  });

  describe("an error name with no mapping", () => {
    // err.name defaults to "Error", which matches none of the switch's cases,
    // so backendUnavailableMessage returns null and the handler rethrows the
    // original error verbatim. The SDK's own catch-all then turns that into an
    // `isError: true` result whose text is the raw `err.message` (server/mcp.js
    // `createToolError`) — no friendly wrapping.
    const unmapped = new Error("weird backend failure");

    it("golem_search rethrows to a plain isError with the raw message", async () => {
      const client = await connectInMemory(depsWithKnowledgeError(unmapped));
      const result = await client.callTool({ name: "golem_search", arguments: { query: "q" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("weird backend failure");
    });

    it("golem_get_chunk rethrows to a plain isError with the raw message", async () => {
      const client = await connectInMemory(depsWithKnowledgeError(unmapped));
      const result = await client.callTool({
        name: "golem_get_chunk",
        arguments: { chunk_id: "chunk-1" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("weird backend failure");
    });

    it("golem_index_path rethrows to a plain isError with the raw message", async () => {
      const client = await connectInMemory(depsWithKnowledgeError(unmapped));
      const result = await client.callTool({
        name: "golem_index_path",
        arguments: { path: "src" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("weird backend failure");
    });
  });
});

describe("golem MCP server (streamable HTTP transport)", () => {
  const handles: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.close()));
  });

  it("serves initialize → tools → tool call over real HTTP, sharing state across sessions", async () => {
    const deps = createStandaloneDeps();
    const handle = await serveHttp(deps, { port: 0 });
    handles.push(handle);

    const clientA = new Client({ name: "http-client-a", version: "0.0.0" });
    // Casts: exactOptionalPropertyTypes friction in SDK 1.29.0 transport types
    // (see verification-notes.md §18).
    await clientA.connect(new StreamableHTTPClientTransport(handle.url) as Transport);
    const { tools } = await clientA.listTools();
    expect(tools.map((t) => t.name).sort()).toStrictEqual([...P0_TOOLS].sort());

    const setResult = await clientA.callTool({
      name: "golem_set_slider",
      arguments: { level: 5 },
    });
    expect(setResult.structuredContent).toMatchObject({ slider_level: 5 });

    // A second, independent session sees the same injected deps (shared state).
    const clientB = new Client({ name: "http-client-b", version: "0.0.0" });
    await clientB.connect(new StreamableHTTPClientTransport(handle.url) as Transport);
    const stats = await clientB.callTool({ name: "golem_stats", arguments: {} });
    expect(stats.structuredContent).toMatchObject({ slider_level: 5 });

    await clientA.close();
    await clientB.close();
  });

  it("rejects non-initialize requests without a session id", async () => {
    const handle = await serveHttp(createStandaloneDeps(), { port: 0 });
    handles.push(handle);

    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32000);
  });

  it("returns 404 off the MCP path", async () => {
    const handle = await serveHttp(createStandaloneDeps(), { port: 0 });
    handles.push(handle);
    const response = await fetch(new URL("/other", handle.url));
    expect(response.status).toBe(404);
  });
});
