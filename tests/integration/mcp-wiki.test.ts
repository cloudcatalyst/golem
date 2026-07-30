/**
 * WS-W W2 — wiki_read / wiki_upsert on the unified MCP server.
 *
 * Exercises the real FileWikiStore (not a fake) over a temp directory,
 * through the actual MCP wire protocol, mirroring mcp-knowledge.test.ts's
 * pattern: tool registration is gated on `deps.wiki`, and errors (unknown
 * page, write conflict) must come back as actionable `isError` results.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGolemMcpServer,
  createStandaloneDeps,
  type GolemMcpServerDeps,
} from "../../src/mcp/index.js";
import { FileWikiStore } from "../../src/wiki/index.js";
import { rmTemp } from "../helpers/tmp.js";

const WIKI_TOOLS = ["wiki_read", "wiki_upsert"] as const;

async function connect(deps: GolemMcpServerDeps): Promise<Client> {
  const server = createGolemMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "wiki-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: ReadonlyArray<{ type: string; text?: string }> }).content;
  return (content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-wiki-mcp-"));
});

afterEach(async () => {
  await rm(dir, rmTemp);
});

function depsWithWiki(): GolemMcpServerDeps {
  return {
    ...createStandaloneDeps(),
    wiki: new FileWikiStore({ wikiDir: dir, now: () => "2026-07-10" }),
  };
}

describe("MCP wiki tools (WS-W W2)", () => {
  it("does NOT register wiki tools when no WikiStore is injected", async () => {
    const client = await connect(createStandaloneDeps());
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const tool of WIKI_TOOLS) expect(names).not.toContain(tool);
  });

  it("registers both wiki tools when a WikiStore is present", async () => {
    const client = await connect(depsWithWiki());
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const tool of WIKI_TOOLS) expect(names).toContain(tool);
  });

  it("creates a page via wiki_upsert, then reads it back by title and by path", async () => {
    const client = await connect(depsWithWiki());

    const created = await client.callTool({
      name: "wiki_upsert",
      arguments: {
        rel_path: "concepts/Prompt Caching.md",
        title: "Prompt Caching",
        type: "concept",
        tags: ["cache"],
        sources: ["docs/wiki/WIKI.md"],
        body: "Caching keeps a byte-identical prefix.",
      },
    });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent).toMatchObject({
      rel_path: "concepts/Prompt Caching.md",
      title: "Prompt Caching",
      type: "concept",
      created: "2026-07-10",
      updated: "2026-07-10",
      appended: false,
    });

    const byTitle = await client.callTool({
      name: "wiki_read",
      arguments: { title_or_path: "Prompt Caching" },
    });
    expect(byTitle.isError).toBeFalsy();
    expect(textOf(byTitle)).toContain("byte-identical prefix");
    expect(byTitle.structuredContent).toMatchObject({ rel_path: "concepts/Prompt Caching.md" });

    const byPath = await client.callTool({
      name: "wiki_read",
      arguments: { title_or_path: "concepts/Prompt Caching.md" },
    });
    expect(byPath.isError).toBeFalsy();
    expect(byPath.structuredContent).toMatchObject({ title: "Prompt Caching" });
  });

  it("appends and merges tags/sources on a second upsert to the same page", async () => {
    const client = await connect(depsWithWiki());
    await client.callTool({
      name: "wiki_upsert",
      arguments: {
        rel_path: "concepts/Prompt Caching.md",
        title: "Prompt Caching",
        type: "concept",
        tags: ["cache"],
        sources: ["a"],
        body: "First note.",
      },
    });
    const second = await client.callTool({
      name: "wiki_upsert",
      arguments: {
        rel_path: "concepts/Prompt Caching.md",
        title: "Prompt Caching",
        type: "concept",
        tags: ["cache", "prompts"],
        sources: ["b"],
        body: "Second note.",
      },
    });
    expect(second.isError).toBeFalsy();
    expect(second.structuredContent).toMatchObject({
      tags: ["cache", "prompts"],
      sources: ["a", "b"],
      appended: true,
    });
    const body = (second.structuredContent as { body: string }).body;
    expect(body).toContain("First note.");
    expect(body).toContain("Second note.");
  });

  it("returns isError with a helpful hint for an unknown page", async () => {
    const client = await connect(depsWithWiki());
    const result = await client.callTool({
      name: "wiki_read",
      arguments: { title_or_path: "Nonexistent Page" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Nonexistent Page");
    expect(textOf(result)).toContain("WIKI.md");
  });

  it("returns isError on a title/type conflict at an existing path", async () => {
    const client = await connect(depsWithWiki());
    await client.callTool({
      name: "wiki_upsert",
      arguments: {
        rel_path: "concepts/Prompt Caching.md",
        title: "Prompt Caching",
        type: "concept",
        body: "body",
      },
    });
    const conflict = await client.callTool({
      name: "wiki_upsert",
      arguments: {
        rel_path: "concepts/Prompt Caching.md",
        title: "Something Else",
        type: "concept",
        body: "body",
      },
    });
    expect(conflict.isError).toBe(true);
    expect(textOf(conflict)).toContain("conflict");
  });

  it("rejects invalid input (empty body) as an InvalidParams error result", async () => {
    const client = await connect(depsWithWiki());
    const result = await client.callTool({
      name: "wiki_upsert",
      arguments: {
        rel_path: "concepts/Prompt Caching.md",
        title: "Prompt Caching",
        type: "concept",
        body: "",
      },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("Input validation error");
  });
});
