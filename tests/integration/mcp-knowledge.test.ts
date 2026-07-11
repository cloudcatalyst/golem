/**
 * Task B3 — knowledge tools on the unified MCP server.
 *
 * Injects a fake KnowledgeBase (frozen `KnowledgeBase` contract) so the server
 * wiring is tested without WS-C's store or WS-D's Ollama endpoint: tool
 * registration is gated on `deps.knowledge`, and backend failures (inference
 * down / model missing / no embedder) must come back as actionable `isError`
 * results, not crashes.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  Chunk,
  HardwareTier,
  Hit,
  InferenceService,
  IngestReport,
  KnowledgeBase,
  Role,
  Scope,
  Vector,
} from "../../src/interfaces/index.js";
import { HardwareTier as Tier, UnknownChunkError } from "../../src/interfaces/index.js";
import {
  createGolemMcpServer,
  createStandaloneDeps,
  type GolemMcpServerDeps,
} from "../../src/mcp/index.js";
import { FileWikiStore } from "../../src/wiki/index.js";

const KNOWLEDGE_TOOLS = ["search", "fetch", "ingest"] as const;

/** A minimal in-memory KnowledgeBase: ingest() seeds chunks, search() returns them. */
class FakeKnowledgeBase implements KnowledgeBase {
  readonly #chunks = new Map<string, Chunk>();
  ingestCalls = 0;

  async ingest(path: string, projectId: string, watch = false): Promise<IngestReport> {
    this.ingestCalls += 1;
    const chunk: Chunk = {
      chunkId: `chunk-${this.#chunks.size + 1}`,
      projectId,
      text: `contents of ${path} — redaction runs before compression in the pipeline`,
      sourcePath: `${path}/redaction.ts`,
      startLine: 1,
      endLine: 42,
      metadata: { kind: "code" },
    };
    this.#chunks.set(chunk.chunkId, chunk);
    return {
      path,
      projectId,
      filesSeen: 1,
      chunksIndexed: 1,
      filesSkipped: 0,
      watching: watch,
    };
  }

  async search(
    query: string,
    projectId: string,
    k = 8,
    _scopes?: ReadonlySet<Scope>,
  ): Promise<Hit[]> {
    const hits: Hit[] = [];
    for (const chunk of this.#chunks.values()) {
      if (chunk.projectId === projectId && chunk.text.includes(query)) {
        hits.push({ chunk, score: 0.9, scope: "knowledge" });
      }
    }
    return hits.slice(0, k);
  }

  async getChunk(chunkId: string): Promise<Chunk> {
    const chunk = this.#chunks.get(chunkId);
    if (chunk === undefined) throw new UnknownChunkError(chunkId);
    return chunk;
  }
}

/** A KnowledgeBase whose embed path always fails as if Ollama were offline. */
class OfflineKnowledgeBase implements KnowledgeBase {
  async ingest(): Promise<IngestReport> {
    throw namedError("InferenceEndpointError", "could not reach inference endpoint");
  }
  async search(): Promise<Hit[]> {
    throw namedError("InferenceEndpointError", "could not reach inference endpoint");
  }
  async getChunk(chunkId: string): Promise<Chunk> {
    throw new UnknownChunkError(chunkId);
  }
}

function namedError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

/** R3.1 — a fake "judge" that reverses whatever chunkId order it's given. */
class ReversingInferenceService implements InferenceService {
  async chat(
    role: Role,
    messages: readonly ChatMessage[],
    _opts?: ChatOptions,
  ): Promise<ChatResult> {
    const prompt = JSON.stringify(messages);
    const ids = [...prompt.matchAll(/chunkId=([^\s\\]+)/g)].map((m) => m[1] as string);
    return {
      text: JSON.stringify({ order: [...ids].reverse() }),
      model: "fake-judge",
      role,
      promptTokens: 1,
      completionTokens: 1,
      finishReason: "stop",
    };
  }

  async embed(): Promise<Vector[]> {
    throw new Error("not used by these tests");
  }

  capabilities(): HardwareTier {
    return Tier.PMid;
  }
}

async function connect(deps: GolemMcpServerDeps): Promise<Client> {
  const server = createGolemMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "kb-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function depsWith(knowledge: KnowledgeBase): GolemMcpServerDeps {
  return { ...createStandaloneDeps(), knowledge, defaultProjectId: "proj-1" };
}

function textOf(result: unknown): string {
  const content = (result as { content?: ReadonlyArray<{ type: string; text?: string }> }).content;
  return (content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

describe("MCP knowledge tools (B3)", () => {
  it("does NOT register knowledge tools when no KB is injected", async () => {
    const client = await connect(createStandaloneDeps());
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const tool of KNOWLEDGE_TOOLS) expect(names).not.toContain(tool);
  });

  it("registers exactly the three knowledge tools when a KB is present", async () => {
    const client = await connect(depsWith(new FakeKnowledgeBase()));
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const tool of KNOWLEDGE_TOOLS) expect(names).toContain(tool);
  });

  it("indexes, then finds and expands a chunk end-to-end", async () => {
    const client = await connect(depsWith(new FakeKnowledgeBase()));

    const indexed = await client.callTool({
      name: "ingest",
      arguments: { path: "src" },
    });
    expect(indexed.isError).toBeFalsy();
    expect(indexed.structuredContent).toMatchObject({
      project_id: "proj-1",
      chunks_indexed: 1,
      files_seen: 1,
      watching: false,
    });

    const search = await client.callTool({
      name: "search",
      arguments: { query: "redaction" },
    });
    expect(search.isError).toBeFalsy();
    const structured = search.structuredContent as {
      count: number;
      project_id: string;
      hits: Array<{ chunk_id: string; score: number; source_path?: string; start_line?: number }>;
    };
    expect(structured.project_id).toBe("proj-1");
    expect(structured.count).toBe(1);
    const hit = structured.hits[0];
    expect(hit?.chunk_id).toBe("chunk-1");
    expect(hit?.source_path).toBe("src/redaction.ts");
    expect(hit?.start_line).toBe(1);

    const chunk = await client.callTool({
      name: "fetch",
      arguments: { chunk_id: "chunk-1" },
    });
    expect(chunk.isError).toBeFalsy();
    expect(textOf(chunk)).toContain("redaction runs before compression");
    expect(chunk.structuredContent).toMatchObject({
      chunk_id: "chunk-1",
      project_id: "proj-1",
      start_line: 1,
      end_line: 42,
    });
  });

  it("uses an explicit project_id over the session default", async () => {
    const kb = new FakeKnowledgeBase();
    const client = await connect(depsWith(kb));
    await client.callTool({
      name: "ingest",
      arguments: { path: "x", project_id: "other" },
    });
    // Default project has nothing; the explicit one has the chunk.
    const def = await client.callTool({ name: "search", arguments: { query: "redaction" } });
    expect((def.structuredContent as { count: number }).count).toBe(0);
    const other = await client.callTool({
      name: "search",
      arguments: { query: "redaction", project_id: "other" },
    });
    expect((other.structuredContent as { count: number }).count).toBe(1);
  });

  it("returns isError with current chunk ids for an unknown chunk", async () => {
    const client = await connect(depsWith(new FakeKnowledgeBase()));
    const result = await client.callTool({
      name: "fetch",
      arguments: { chunk_id: "nope" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("nope");
    expect(textOf(result)).toContain("search");
  });

  it("maps a dead inference endpoint to an actionable isError (search + index)", async () => {
    const client = await connect(depsWith(new OfflineKnowledgeBase()));

    const search = await client.callTool({ name: "search", arguments: { query: "q" } });
    expect(search.isError).toBe(true);
    expect(textOf(search)).toContain("Ollama");

    const index = await client.callTool({ name: "ingest", arguments: { path: "src" } });
    expect(index.isError).toBe(true);
    expect(textOf(index)).toContain("Ollama");
  });

  it("rejects invalid input (empty query) as an InvalidParams error result", async () => {
    const client = await connect(depsWith(new FakeKnowledgeBase()));
    const result = await client.callTool({ name: "search", arguments: { query: "" } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("Input validation error");
  });

  it("ranks a wiki hit above an equal-scoring non-wiki hit when wikiDir is set (Decision 28)", async () => {
    class TiedKnowledgeBase implements KnowledgeBase {
      async ingest(): Promise<IngestReport> {
        throw new Error("not used");
      }
      async search(): Promise<Hit[]> {
        return [
          {
            chunk: {
              chunkId: "src-1",
              projectId: "proj-1",
              text: "t",
              sourcePath: "src/a.ts",
              metadata: {},
            },
            score: 0.7,
            scope: "knowledge",
          },
          {
            chunk: {
              chunkId: "wiki-1",
              projectId: "proj-1",
              text: "t",
              sourcePath: "docs/wiki/Concept.md",
              metadata: {},
            },
            score: 0.7,
            scope: "knowledge",
          },
        ];
      }
      async getChunk(chunkId: string): Promise<Chunk> {
        throw new UnknownChunkError(chunkId);
      }
    }

    const client = await connect({
      ...createStandaloneDeps(),
      knowledge: new TiedKnowledgeBase(),
      defaultProjectId: "proj-1",
      wikiDir: "docs/wiki",
    });
    const search = await client.callTool({ name: "search", arguments: { query: "q" } });
    const structured = search.structuredContent as { hits: Array<{ chunk_id: string }> };
    expect(structured.hits.map((h) => h.chunk_id)).toEqual(["wiki-1", "src-1"]);
  });

  it("R3.1: applies deps.rerank to reorder search hits when injected", async () => {
    class TwoHitKnowledgeBase implements KnowledgeBase {
      async ingest(): Promise<IngestReport> {
        throw new Error("not used");
      }
      async search(): Promise<Hit[]> {
        return [
          {
            chunk: { chunkId: "a", projectId: "proj-1", text: "t", metadata: {} },
            score: 0.9,
            scope: "knowledge",
          },
          {
            chunk: { chunkId: "b", projectId: "proj-1", text: "t", metadata: {} },
            score: 0.5,
            scope: "knowledge",
          },
        ];
      }
      async getChunk(chunkId: string): Promise<Chunk> {
        throw new UnknownChunkError(chunkId);
      }
    }

    const client = await connect({
      ...createStandaloneDeps(),
      knowledge: new TwoHitKnowledgeBase(),
      defaultProjectId: "proj-1",
      rerank: new ReversingInferenceService(),
    });
    const search = await client.callTool({ name: "search", arguments: { query: "q" } });
    expect(search.isError).toBeFalsy();
    const structured = search.structuredContent as { hits: Array<{ chunk_id: string }> };
    expect(structured.hits.map((h) => h.chunk_id)).toEqual(["b", "a"]);
  });

  it("R3.1: does NOT apply rerank when deps.rerank is absent", async () => {
    class TwoHitKnowledgeBase implements KnowledgeBase {
      async ingest(): Promise<IngestReport> {
        throw new Error("not used");
      }
      async search(): Promise<Hit[]> {
        return [
          {
            chunk: { chunkId: "a", projectId: "proj-1", text: "t", metadata: {} },
            score: 0.9,
            scope: "knowledge",
          },
          {
            chunk: { chunkId: "b", projectId: "proj-1", text: "t", metadata: {} },
            score: 0.5,
            scope: "knowledge",
          },
        ];
      }
      async getChunk(chunkId: string): Promise<Chunk> {
        throw new UnknownChunkError(chunkId);
      }
    }

    const client = await connect(depsWith(new TwoHitKnowledgeBase()));
    const search = await client.callTool({ name: "search", arguments: { query: "q" } });
    const structured = search.structuredContent as { hits: Array<{ chunk_id: string }> };
    expect(structured.hits.map((h) => h.chunk_id)).toEqual(["a", "b"]);
  });
});

/**
 * T5 — graph-first lookup ahead of vector search, over a real FileWikiStore.
 */
describe("MCP search: graph-first + vector merge (T5)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-search-graph-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function depsWithWikiAnd(knowledge: KnowledgeBase): Promise<GolemMcpServerDeps> {
    const wiki = new FileWikiStore({ wikiDir: dir, now: () => "2026-07-11" });
    await wiki.upsertPage({
      relPath: "concepts/Redaction.md",
      frontmatter: { title: "Redaction", type: "concept", tags: [], sources: [] },
      body: "Redaction runs before compression. See [[Prompt Caching]] for the other half.",
    });
    await wiki.upsertPage({
      relPath: "concepts/Prompt Caching.md",
      frontmatter: { title: "Prompt Caching", type: "concept", tags: [], sources: [] },
      body: "no links here",
    });
    return {
      ...createStandaloneDeps(),
      knowledge,
      wiki,
      wikiDir: "docs/wiki",
      defaultProjectId: "proj-1",
    };
  }

  it("ranks an exact wiki-title match and its 1-hop link above a vector hit", async () => {
    const client = await connect(await depsWithWikiAnd(new FakeKnowledgeBase()));
    await client.callTool({ name: "ingest", arguments: { path: "src" } });

    const search = await client.callTool({ name: "search", arguments: { query: "redaction" } });
    expect(search.isError).toBeFalsy();
    const structured = search.structuredContent as { hits: Array<{ chunk_id: string }> };
    expect(structured.hits.map((h) => h.chunk_id)).toEqual([
      "wiki:concepts/Redaction.md",
      "wiki:concepts/Prompt Caching.md",
      "chunk-1",
    ]);
  });

  it("fetches a graph-first hit's full text straight from the wiki, not the vector store", async () => {
    const client = await connect(await depsWithWikiAnd(new FakeKnowledgeBase()));
    const fetched = await client.callTool({
      name: "fetch",
      arguments: { chunk_id: "wiki:concepts/Redaction.md" },
    });
    expect(fetched.isError).toBeFalsy();
    expect(textOf(fetched)).toContain("Redaction runs before compression");
  });

  it("de-duplicates a vector hit whose sourcePath matches a graph-matched wiki page", async () => {
    class DuplicatingKnowledgeBase implements KnowledgeBase {
      async ingest(): Promise<IngestReport> {
        throw new Error("not used");
      }
      async search(): Promise<Hit[]> {
        return [
          {
            chunk: {
              chunkId: "vector-dup",
              projectId: "proj-1",
              text: "stale vector-ingested copy of the same wiki page",
              sourcePath: "docs/wiki/concepts/Redaction.md",
              metadata: {},
            },
            score: 0.95,
            scope: "knowledge",
          },
        ];
      }
      async getChunk(chunkId: string): Promise<Chunk> {
        throw new UnknownChunkError(chunkId);
      }
    }

    const client = await connect(await depsWithWikiAnd(new DuplicatingKnowledgeBase()));
    const search = await client.callTool({ name: "search", arguments: { query: "redaction" } });
    const structured = search.structuredContent as { hits: Array<{ chunk_id: string }> };
    expect(structured.hits.map((h) => h.chunk_id)).toEqual([
      "wiki:concepts/Redaction.md",
      "wiki:concepts/Prompt Caching.md",
    ]);
  });

  it("degrades cleanly to vector-only search when no wiki is injected", async () => {
    const client = await connect({
      ...createStandaloneDeps(),
      knowledge: new FakeKnowledgeBase(),
      defaultProjectId: "proj-1",
    });
    await client.callTool({ name: "ingest", arguments: { path: "src" } });
    const search = await client.callTool({ name: "search", arguments: { query: "redaction" } });
    expect(search.isError).toBeFalsy();
    const structured = search.structuredContent as { hits: Array<{ chunk_id: string }> };
    expect(structured.hits.map((h) => h.chunk_id)).toEqual(["chunk-1"]);
  });
});
