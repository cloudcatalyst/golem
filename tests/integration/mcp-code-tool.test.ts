/**
 * R8.5 — the `code` tool on the unified MCP server.
 *
 * Two things this must prove beyond "it returns a map":
 *  - **modes, not tools.** §88/§100 measured tool definitions as a permanent
 *    per-request bill, so the map (and R8.6's LSP surfaces later) share ONE
 *    tool with a `mode` parameter. The registration test asserts exactly one new
 *    tool name appears.
 *  - **absence is a no-op, not an error.** Without a mappable tree the tool
 *    answers plainly and the session continues (CLAUDE.md's tier-2 rule).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRepoMapCache } from "../../src/knowledge/index.js";
import {
  createGolemMcpServer,
  createStandaloneDeps,
  type GolemMcpServerDeps,
} from "../../src/mcp/index.js";
import { rmTemp } from "../helpers/tmp.js";

let root: string;

beforeEach(async () => {
  clearRepoMapCache();
  root = await mkdtemp(path.join(tmpdir(), "golem-code-tool-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "core.ts"),
    "export function coreThing(input: string): string {\n  return input;\n}\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "src", "user.ts"),
    "import { coreThing } from './core.js';\nexport const wrapped = (s: string) => coreThing(s);\n",
    "utf8",
  );
});

afterEach(async () => {
  await rm(root, rmTemp);
});

async function connect(deps: GolemMcpServerDeps): Promise<Client> {
  const server = createGolemMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "code-tool-test", version: "0.0.0" });
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

function structuredOf(result: unknown): Record<string, unknown> {
  return ((result as { structuredContent?: Record<string, unknown> }).structuredContent ??
    {}) as Record<string, unknown>;
}

describe("code tool registration", () => {
  it("is absent when no codeRoot is injected", async () => {
    const client = await connect(createStandaloneDeps());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("code");
    await client.close();
  });

  it("adds exactly ONE tool — modes, not four tools", async () => {
    const before = (await connect(createStandaloneDeps())).listTools();
    const withCode = (await connect({ ...createStandaloneDeps(), codeRoot: root })).listTools();
    const beforeNames = (await before).tools.map((t) => t.name).sort();
    const afterNames = (await withCode).tools.map((t) => t.name).sort();
    expect(afterNames.filter((n) => !beforeNames.includes(n))).toEqual(["code"]);
  });

  it("declares `map` as a mode of one tool, not as its own tool", async () => {
    const client = await connect({ ...createStandaloneDeps(), codeRoot: root });
    const tool = (await client.listTools()).tools.find((t) => t.name === "code");
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool?.inputSchema)).toContain('"mode"');
    await client.close();
  });
});

describe("code tool — map mode", () => {
  it("returns a ranked, budgeted map with line numbers", async () => {
    const client = await connect({ ...createStandaloneDeps(), codeRoot: root });
    const result = await client.callTool({ name: "code", arguments: { mode: "map" } });
    const text = textOf(result);
    expect(text).toContain("[Golem repo map");
    expect(text).toContain("src/core.ts");
    expect(text).toContain("coreThing");
    const structured = structuredOf(result);
    expect(structured.available).toBe(true);
    expect(structured.files_scanned).toBe(2);
    expect(structured.tokens).toBeGreaterThan(0);
    expect(structured.tokens).toBeLessThanOrEqual(structured.budget_tokens as number);
    await client.close();
  });

  it("defaults `mode` to map", async () => {
    const client = await connect({ ...createStandaloneDeps(), codeRoot: root });
    const result = await client.callTool({ name: "code", arguments: {} });
    expect(textOf(result)).toContain("[Golem repo map");
    expect(structuredOf(result).mode).toBe("map");
    await client.close();
  });

  it("honours a smaller budget", async () => {
    const client = await connect({ ...createStandaloneDeps(), codeRoot: root });
    const result = await client.callTool({
      name: "code",
      arguments: { mode: "map", budget_tokens: 250 },
    });
    expect(structuredOf(result).budget_tokens).toBe(250);
    expect(structuredOf(result).tokens as number).toBeLessThan(400);
    await client.close();
  });

  it("rejects a budget outside the schema's range at the boundary", async () => {
    const client = await connect({ ...createStandaloneDeps(), codeRoot: root });
    const result = await client.callTool({
      name: "code",
      arguments: { mode: "map", budget_tokens: 10 },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    await client.close();
  });

  it("reports no map — without erroring — for a tree it cannot map", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "golem-code-empty-"));
    try {
      const client = await connect({ ...createStandaloneDeps(), codeRoot: empty });
      const result = await client.callTool({ name: "code", arguments: { mode: "map" } });
      expect((result as { isError?: boolean }).isError).toBeFalsy();
      expect(textOf(result)).toContain("No repo map available");
      expect(structuredOf(result).available).toBe(false);
      await client.close();
    } finally {
      await rm(empty, rmTemp);
    }
  });
});
