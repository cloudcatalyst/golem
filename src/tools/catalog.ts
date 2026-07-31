/**
 * Workstream B (Decision 52 follow-up) — Golem's own tool catalog, read from the
 * live MCP server rather than transcribed.
 *
 * The §88 census that scoped this workstream was measured by hand, which means it
 * was already stale the next time a description changed (and it did: adding the
 * Decision-52 dial explanation to `level` took it from ~78 to ~191 tokens). This
 * module lists the catalog by connecting to the real server over the SDK's
 * in-memory transport, so the census cannot drift from what is actually sent.
 *
 * Stub dependencies are injected purely to make *registration* happen — several
 * tools are only registered when their dep is present. Nothing here ever calls a
 * tool, so the stubs reject rather than pretend to work.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { estimateTokens } from "../compression/tokens.js";
import type { LspBridge } from "../ext/index.js";
import type {
  Chunk,
  Hit,
  InferenceService,
  IngestReport,
  KnowledgeBase,
  Vector,
  WikiPage,
  WikiStore,
} from "../interfaces/index.js";
import { HardwareTier } from "../interfaces/index.js";
import { createGolemMcpServer, createStandaloneDeps } from "../mcp/index.js";

/** One tool as the model actually receives it. */
export interface CatalogTool {
  readonly name: string;
  readonly description: string;
  /** ≈tokens for this tool's description alone (4 chars/token, as in §88). */
  readonly descriptionTokens: number;
  /** ≈tokens for the whole serialized definition (description + schema). */
  readonly definitionTokens: number;
  /**
   * The input schema, kept so R8.S1 can transform it.
   *
   * §89's closing finding was that the schemas are ~2900 of the ~3847 definition
   * tokens — the prose shrinker was attacking the smaller half. A schema transform
   * cannot be scored without the schema itself, so the catalog now carries it.
   */
  readonly schema: unknown;
  readonly schemaTokens: number;
}

export interface ToolCensus {
  readonly tools: readonly CatalogTool[];
  readonly descriptionTokens: number;
  readonly definitionTokens: number;
  readonly schemaTokens: number;
}

const REJECT = (): never => {
  throw new Error("catalog stub: tools are listed here, never invoked");
};

/**
 * Deps whose only job is to make every conditional tool register. Each member
 * throws if called — a silent no-op would let a future harness "measure" a tool
 * that cannot run.
 */
function catalogDeps() {
  const knowledge: KnowledgeBase = {
    search: (): Promise<Hit[]> => REJECT(),
    getChunk: (): Promise<Chunk> => REJECT(),
    ingest: (): Promise<IngestReport> => REJECT(),
  };
  const inference: InferenceService = {
    chat: () => REJECT(),
    embed: (): Promise<Vector[]> => REJECT(),
    capabilities: (): HardwareTier => HardwareTier.PMid,
  };
  const wiki: WikiStore = {
    readPage: (): Promise<WikiPage> => REJECT(),
    resolveLink: (): Promise<string | undefined> => REJECT(),
    backlinks: (): Promise<readonly string[]> => REJECT(),
    listPages: (): Promise<readonly WikiPage[]> => REJECT(),
    upsertPage: (): Promise<WikiPage> => REJECT(),
  };
  return {
    ...createStandaloneDeps(),
    knowledge,
    inference,
    coder: inference,
    wiki,
    // R8.5: `code` registers only when a root is set, and its definition bills on
    // every request like any other — so the census must see it. The path is never
    // read here (nothing is invoked), it only satisfies registration.
    codeRoot: process.cwd(),
  };
}

/**
 * R8.6 — a bridge that registers the LSP modes without being able to spawn
 * anything. `resolveCommand` returning null is the honest posture for a census:
 * the question is what the *definition* costs, and no census should start a
 * language server as a side effect of counting tokens.
 */
async function catalogLspBridge(): Promise<LspBridge> {
  const { LspBridge: Bridge } = await import("../ext/index.js");
  return new Bridge({ root: process.cwd(), resolveCommand: () => null });
}

export interface ToolCensusOptions {
  /**
   * R8.6: register the `code` tool's LSP modes, as `knowledge.lsp_enabled`
   * would. Off by default because the shipped default is off — a census that
   * reported a cost nobody is paying would be exactly the dishonest metric
   * §99's cache-prefix verdict is on the roadmap for.
   */
  readonly lsp?: boolean;
  /**
   * R8.7: register `coder`'s `edit` mode, as `inference.local_editor_enabled`
   * would. Off by default for the same reason as {@link lsp} — the shipped
   * default is off, and the on-state must be measurable rather than assumed.
   */
  readonly editor?: boolean;
}

/**
 * List every tool Golem's MCP server registers, with a token census.
 *
 * Sorted by descending description size: the first rows are where any shrinker
 * would have to earn its keep.
 */
export async function golemToolCensus(options: ToolCensusOptions = {}): Promise<ToolCensus> {
  const deps = {
    ...catalogDeps(),
    ...(options.lsp === true ? { lsp: await catalogLspBridge() } : {}),
    ...(options.editor === true ? { localEditor: true } : {}),
  };
  const server = createGolemMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "golem-tool-census", version: "0.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const tools = listed.tools
      .map((t): CatalogTool => {
        const description = t.description ?? "";
        const schema = t.inputSchema;
        return {
          name: t.name,
          description,
          descriptionTokens: estimateTokens(description),
          definitionTokens: estimateTokens(JSON.stringify(t)),
          schema,
          schemaTokens: estimateTokens(JSON.stringify(schema)),
        };
      })
      .sort((a, b) => b.descriptionTokens - a.descriptionTokens || a.name.localeCompare(b.name));
    return {
      tools,
      descriptionTokens: tools.reduce((n, t) => n + t.descriptionTokens, 0),
      definitionTokens: tools.reduce((n, t) => n + t.definitionTokens, 0),
      schemaTokens: tools.reduce((n, t) => n + t.schemaTokens, 0),
    };
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
