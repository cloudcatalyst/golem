/**
 * R8.11 / ADR-0005 — plugin MCP tools, and the reserved-name list that keeps a
 * plugin from shadowing a built-in.
 *
 * The drift guard is the important half. `BUILTIN_MCP_TOOL_NAMES` is a hardcoded
 * list, deliberately: the collision check runs at LOAD time, before any server
 * exists, so it cannot be derived from one. A hardcoded list rots, hence this
 * test — renaming or adding a built-in tool must consciously update the reserved
 * set, and if it does not, this fails.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createGolemMcpServer, createStandaloneDeps } from "../../../src/mcp/index.js";
import type { PluginMcpTool } from "../../../src/plugins/index.js";
import { BUILTIN_MCP_TOOL_NAMES } from "../../../src/plugins/index.js";
import { golemToolCensus } from "../../../src/tools/catalog.js";

/** List the tools a server actually advertises, over an in-memory transport. */
async function toolNames(pluginTools?: readonly PluginMcpTool[]): Promise<string[]> {
  const server = createGolemMcpServer({
    ...createStandaloneDeps(),
    ...(pluginTools !== undefined ? { pluginTools } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "plugin-tool-test", version: "0.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  pluginTools: readonly PluginMcpTool[],
): Promise<{ text: string; isError: boolean }> {
  const server = createGolemMcpServer({ ...createStandaloneDeps(), pluginTools });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "plugin-tool-test", version: "0.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = (await client.callTool({ name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    return {
      text: (result.content ?? []).map((c) => c.text ?? "").join(""),
      isError: result.isError === true,
    };
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

describe("BUILTIN_MCP_TOOL_NAMES — the reserved set must not drift", () => {
  it("covers every tool Golem's own server registers", async () => {
    // The census builds a server with the fullest dep set available, so it sees
    // the conditionally-registered tools too.
    const census = await golemToolCensus();
    const registered = census.tools.map((t) => t.name).sort();
    const reserved = [...BUILTIN_MCP_TOOL_NAMES].sort();
    for (const name of registered) {
      expect(
        reserved,
        `${name} is registered by Golem but not reserved — a plugin could shadow it`,
      ).toContain(name);
    }
  });

  it("reserves nothing that no longer exists", async () => {
    const census = await golemToolCensus();
    const registered = new Set(census.tools.map((t) => t.name));
    for (const name of BUILTIN_MCP_TOOL_NAMES) {
      expect(registered.has(name), `${name} is reserved but no longer registered`).toBe(true);
    }
  });
});

describe("plugin MCP tools", () => {
  it("registers nothing extra when no plugin tools are passed", async () => {
    const withNone = await toolNames();
    const withEmpty = await toolNames([]);
    expect(withEmpty).toEqual(withNone);
  });

  it("adds a plugin tool alongside the built-ins", async () => {
    const before = await toolNames();
    const after = await toolNames([
      { name: "acme_lookup", title: "Look up", description: "d", handler: () => "ok" },
    ]);
    expect(after).toEqual([...before, "acme_lookup"].sort());
  });

  it("labels a plugin tool as a plugin tool in the text the model reads", async () => {
    const server = createGolemMcpServer({
      ...createStandaloneDeps(),
      pluginTools: [
        { name: "acme_lookup", title: "Look up", description: "Finds a thing", handler: () => "" },
      ],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0.0.0" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const listed = await client.listTools();
      const tool = listed.tools.find((t) => t.name === "acme_lookup");
      expect(tool?.description).toContain("contributed by a Golem plugin");
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  it("renders a plain return value as text", async () => {
    const out = await callTool("acme_lookup", {}, [
      { name: "acme_lookup", title: "t", description: "d", handler: () => "the answer" },
    ]);
    expect(out.text).toBe("the answer");
    expect(out.isError).toBe(false);
  });

  it("passes an MCP-shaped result through unchanged", async () => {
    const out = await callTool("acme_lookup", {}, [
      {
        name: "acme_lookup",
        title: "t",
        description: "d",
        handler: () => ({ content: [{ type: "text", text: "verbatim" }] }),
      },
    ]);
    expect(out.text).toBe("verbatim");
  });

  it("turns a throwing handler into one failed call, not a dead server", async () => {
    const tools: readonly PluginMcpTool[] = [
      {
        name: "acme_lookup",
        title: "t",
        description: "d",
        handler: () => {
          throw new Error("handler exploded");
        },
      },
      { name: "acme_other", title: "t", description: "d", handler: () => "still here" },
    ];
    const failed = await callTool("acme_lookup", {}, tools);
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("handler exploded");
    // The other tool on the same server still answers.
    const ok = await callTool("acme_other", {}, tools);
    expect(ok.text).toBe("still here");
  });
});
