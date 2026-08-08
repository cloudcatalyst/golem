/**
 * WS-B task B1 — unified MCP server integration tests.
 *
 * Spins the server in-process over the SDK's linked in-memory transport pair
 * (plus one real streamable-HTTP round-trip), lists tools and prompts, and
 * exercises every P0 tool with valid and invalid inputs.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { InferenceEndpointError, ModelNotAvailableError } from "../../src/inference/index.js";
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  Chunk,
  Hit,
  InferenceService,
  IngestReport,
  KnowledgeBase,
  Role,
  Vector,
} from "../../src/interfaces/index.js";
import {
  CapabilityUnavailableError,
  HardwareTier,
  sliderPolicyForLevel,
} from "../../src/interfaces/index.js";
import { NotImplementedYetError } from "../../src/knowledge/index.js";
import { MAX_EDIT_LINES } from "../../src/mcp/coder-edit.js";
import { createGolemMcpServer, createStandaloneDeps, serveHttp } from "../../src/mcp/index.js";
import { JsonlTelemetryStore, recordToolCall } from "../../src/telemetry/index.js";
import { rmTemp } from "../helpers/tmp.js";

// Unconditionally-registered tools (need no injected service): the P0 trio +
// `devices` + `snooze` (park-until-reset, proposal golem-snooze.md).
const P0_TOOLS = ["expand", "stats", "level", "devices", "snooze"] as const;
const ALL_PROMPTS = [
  "slider",
  "index",
  "search",
  "stats",
  "expand",
  "bypass",
  "devices",
  "coder",
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

  describe("expand", () => {
    it("returns the original content for a stored CCR ref", async () => {
      const deps = createStandaloneDeps();
      const { refId, original } = await seedCcrRef(deps);
      const client = await connectInMemory(deps);

      const result = await client.callTool({
        name: "expand",
        arguments: { ref_id: refId },
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toBe(original);
    });

    it("returns isError (not a protocol error) for an unknown ref", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const result = await client.callTool({
        name: "expand",
        arguments: { ref_id: "no-such-ref" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("no-such-ref");
    });

    it("maps invalid input (missing ref_id) to an InvalidParams error result", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const result = await client.callTool({ name: "expand", arguments: {} });
      expectInvalidParamsResult(result);
    });

    it("maps a wrongly-typed ref_id to an InvalidParams error result", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const result = await client.callTool({
        name: "expand",
        arguments: { ref_id: 42 },
      });
      expectInvalidParamsResult(result);
    });
  });

  describe("level + stats", () => {
    it("sets a valid level, persists it, and reports it via stats", async () => {
      const deps = createStandaloneDeps();
      const client = await connectInMemory(deps);

      const setResult = await client.callTool({
        name: "level",
        arguments: { level: 3 },
      });
      expect(setResult.isError).toBeFalsy();
      expect(setResult.structuredContent).toMatchObject({
        slider_level: 3,
        slider_level_name: "aggressive",
      });
      await expect(deps.sliderStore.get()).resolves.toBe(3);

      const statsResult = await client.callTool({ name: "stats", arguments: {} });
      expect(statsResult.isError).toBeFalsy();
      expect(statsResult.structuredContent).toMatchObject({ slider_level: 3 });
    });

    // R8.33 — the security boundary: no sequence of tool calls may reach a
    // state where redaction is off. Level 0 stays a supported setting, but it
    // is CLI-only (`golem slider 0`), mirroring ADR-0002 threat item 4.
    it("refuses level 0 and leaves the persisted level untouched", async () => {
      const deps = createStandaloneDeps();
      await deps.sliderStore.set(2);
      const client = await connectInMemory(deps);

      const result = await client.callTool({ name: "level", arguments: { level: 0 } });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("golem slider 0");
      // The refusal must land BEFORE the write, not as a warning after it.
      await expect(deps.sliderStore.get()).resolves.toBe(2);
    });

    it("still reports a level 0 set out-of-band via the CLI", async () => {
      const deps = createStandaloneDeps();
      await deps.sliderStore.set(0); // as `golem slider 0` would
      const client = await connectInMemory(deps);

      const statsResult = await client.callTool({ name: "stats", arguments: {} });
      expect(statsResult.isError).toBeFalsy();
      expect(statsResult.structuredContent).toMatchObject({
        slider_level: 0,
        slider_level_name: "passthrough",
      });
    });

    it.each([
      -1, 6, 2.5,
    ])("maps out-of-range level %s to an InvalidParams error result", async (level) => {
      const deps = createStandaloneDeps();
      const client = await connectInMemory(deps);
      const result = await client.callTool({ name: "level", arguments: { level } });
      expectInvalidParamsResult(result);
      // Invalid calls must not have changed persisted state.
      await expect(deps.sliderStore.get()).resolves.toBe(1);
    });

    it("maps a non-numeric level to an InvalidParams error result", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const result = await client.callTool({
        name: "level",
        arguments: { level: "high" },
      });
      expectInvalidParamsResult(result);
    });

    it("stats reports snake_case savings fields, globally and per project", async () => {
      const deps = createStandaloneDeps();
      await seedCcrRef(deps); // one compress() against "mcp-test-project"
      const client = await connectInMemory(deps);

      const globalStats = await client.callTool({ name: "stats", arguments: {} });
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
        name: "stats",
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
        name: "stats",
        arguments: { project_id: 7 },
      });
      expectInvalidParamsResult(result);
    });
  });

  describe("devices", () => {
    it("reports the detected hardware tier and its models, with matching text and structuredContent", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const result = await client.callTool({ name: "devices", arguments: {} });
      expect(result.isError).toBeFalsy();

      const structured = result.structuredContent as {
        tier: number;
        tier_name: string;
        source: string;
        device?: string;
        memory_mib?: number;
        detail: string;
        models: string[];
        endpoint: string;
        endpoint_reachable: boolean;
        model_slots: Array<{ slot: string; model: string; state: string }>;
        missing: string[];
      };
      expect(Object.values(HardwareTier)).toContain(structured.tier);
      expect(structured.tier_name).toMatch(/^P_(CPU|MIN|MID|MAX)$/);
      expect(typeof structured.source).toBe("string");
      expect(structured.source.length).toBeGreaterThan(0);
      expect(typeof structured.detail).toBe("string");
      expect(structured.detail.length).toBeGreaterThan(0);
      expect(Array.isArray(structured.models)).toBe(true);
      expect(structured.models.length).toBeGreaterThan(0);
      for (const model of structured.models) expect(typeof model).toBe("string");
      if (structured.device !== undefined) expect(typeof structured.device).toBe("string");
      if (structured.memory_mib !== undefined) {
        expect(typeof structured.memory_mib).toBe("number");
      }

      const text = textOf(result);
      expect(text).toContain(`Hardware tier: ${structured.tier} (${structured.tier_name})`);
      expect(text).toContain(structured.detail);

      // Task `local-models`: the tool reports, per slot, whether the model is
      // actually pulled — the flat list alone read as an availability claim.
      // Written to hold whether or not this machine has an Ollama running.
      expect(structured.model_slots.map((s) => s.slot)).toEqual([
        "summarizer",
        "extractor",
        "classifier",
        "drafter",
        "judge",
        "text-embed",
        "code-embed",
      ]);
      expect(text).toContain(`endpoint ${structured.endpoint}`);
      for (const slot of structured.model_slots) {
        expect(["pulled", "not-pulled", "unknown"]).toContain(slot.state);
        expect(text).toContain(`${slot.slot}: ${slot.model}`);
      }
      if (structured.endpoint_reachable) {
        // A reachable endpoint yields a verdict for every slot, never "unknown".
        expect(structured.model_slots.every((s) => s.state !== "unknown")).toBe(true);
        expect(structured.missing).toEqual([
          ...new Set(
            structured.model_slots.filter((s) => s.state === "not-pulled").map((s) => s.model),
          ),
        ]);
      } else {
        // Unreachable: nothing is KNOWN to be missing. Never invent an absence.
        expect(structured.model_slots.every((s) => s.state === "unknown")).toBe(true);
        expect(structured.missing).toEqual([]);
      }
    });
  });

  describe("snooze", () => {
    it("returns immediately with reset:true when the reset time is already past", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const result = await client.callTool({
        name: "snooze",
        arguments: { until: "2020-01-01T00:00:00.000Z" },
      });
      expect(result.isError).toBeFalsy();
      const s = result.structuredContent as { reset: boolean; waited_ms: number };
      expect(s.reset).toBe(true);
      expect(s.waited_ms).toBe(0);
    });

    it("errors when neither `until` nor `duration_ms` is given", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const result = await client.callTool({ name: "snooze", arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result).toLowerCase()).toMatch(/until|duration/);
    });

    it("declines (reset:false) when the reset is beyond the snooze cap", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const result = await client.callTool({
        name: "snooze",
        arguments: { duration_ms: 25_000_000 }, // > the ~6h default cap
      });
      expect(result.isError).toBeFalsy();
      const s = result.structuredContent as { reset: boolean; reason?: string };
      expect(s.reset).toBe(false);
      expect(s.reason ?? "").toMatch(/beyond/i);
    });

    // Task `snooze-taskadd`: parking and documenting are ONE call, because
    // enforcement (Decision 45) denies the `Bash` that `golem task add` needs.
    describe("`note` — the park procedure's documenting step", () => {
      it("files the note as a durable local task before waiting", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "golem-snooze-note-mcp-"));
        try {
          const client = await connectInMemory({
            ...createStandaloneDeps(),
            projectRootDir: dir,
          });
          const result = await client.callTool({
            name: "snooze",
            arguments: {
              until: "2020-01-01T00:00:00.000Z",
              note: "R8 batch parked\nnext: finish local-models",
            },
          });
          expect(result.isError).toBeFalsy();
          const s = result.structuredContent as { task_id?: string; note_error?: string };
          expect(s.note_error).toBeUndefined();
          expect(s.task_id).toBeTruthy();
          expect(textOf(result)).toContain(`local task \`${(s.task_id as string).slice(0, 8)}\``);

          const { FileTaskStore } = await import("../../src/tasks/store.js");
          const stored = await new FileTaskStore(dir).get(s.task_id as string);
          expect(stored?.prompt).toBe("R8 batch parked\nnext: finish local-models");
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });

      it("still parks — and echoes the note back — when it cannot be filed", async () => {
        // No projectRootDir: nowhere to write. The wait must happen anyway, and the
        // note must survive in the transcript rather than being silently dropped.
        const client = await connectInMemory(createStandaloneDeps());
        const result = await client.callTool({
          name: "snooze",
          arguments: { until: "2020-01-01T00:00:00.000Z", note: "do not lose this" },
        });
        expect(result.isError).toBeFalsy();
        const s = result.structuredContent as {
          reset: boolean;
          task_id?: string;
          note_error?: string;
        };
        expect(s.reset).toBe(true); // parked regardless
        expect(s.task_id).toBeUndefined();
        expect(s.note_error).toMatch(/project root/i);
        expect(textOf(result)).toContain("do not lose this");
        expect(textOf(result)).toContain("WARNING");
      });
    });
  });

  describe("prompts", () => {
    it("slider prompt embeds the requested level and points at the level tool", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const prompt = await client.getPrompt({ name: "slider", arguments: { level: "2" } });
      const first = prompt.messages[0];
      expect(first?.role).toBe("user");
      const text = first?.content.type === "text" ? first.content.text : "";
      expect(text).toContain("level tool");
      expect(text).toContain("level 2");
    });

    it("slider prompt without args points at the stats tool instead", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const prompt = await client.getPrompt({ name: "slider", arguments: {} });
      const first = prompt.messages[0];
      const text = first?.content.type === "text" ? first.content.text : "";
      expect(text).toContain("stats tool");
    });

    it("expand prompt requires ref_id", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      await expect(client.getPrompt({ name: "expand", arguments: {} })).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
      });
      const prompt = await client.getPrompt({ name: "expand", arguments: { ref_id: "abc123" } });
      const first = prompt.messages[0];
      const text = first?.content.type === "text" ? first.content.text : "";
      expect(text).toContain("expand tool");
      expect(text).toContain("abc123");
    });

    it("bypass prompt explains the header and level options (0/1), mentioning the bypass header", async () => {
      const client = await connectInMemory(createStandaloneDeps());
      const prompt = await client.getPrompt({ name: "bypass" });
      const first = prompt.messages[0];
      const text = first?.content.type === "text" ? first.content.text : "";
      expect(text).toContain("x-golem-bypass");
      expect(text).toContain("level 1");
      expect(text).toContain("level 0");
    });
  });
});

/**
 * `backendUnavailableMessage()` (src/mcp/server.ts) maps a knowledge-backend
 * failure's `err.name` to a friendly, actionable message shared by all three
 * P1 knowledge tools. It is not exported, so these tests drive it through the
 * real `search` / `fetch` / `ingest` handlers with a
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
    it("search surfaces the friendly message as an isError result", async () => {
      const client = await connectInMemory(depsWithKnowledgeError(err));
      const result = await client.callTool({ name: "search", arguments: { query: "q" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(friendlyMessage);
    });

    it("fetch surfaces the friendly message as an isError result", async () => {
      const client = await connectInMemory(depsWithKnowledgeError(err));
      const result = await client.callTool({
        name: "fetch",
        arguments: { chunk_id: "chunk-1" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(friendlyMessage);
    });

    it("ingest surfaces the friendly message as an isError result", async () => {
      const client = await connectInMemory(depsWithKnowledgeError(err));
      const result = await client.callTool({
        name: "ingest",
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

    it("search rethrows to a plain isError with the raw message", async () => {
      const client = await connectInMemory(depsWithKnowledgeError(unmapped));
      const result = await client.callTool({ name: "search", arguments: { query: "q" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("weird backend failure");
    });

    it("fetch rethrows to a plain isError with the raw message", async () => {
      const client = await connectInMemory(depsWithKnowledgeError(unmapped));
      const result = await client.callTool({
        name: "fetch",
        arguments: { chunk_id: "chunk-1" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("weird backend failure");
    });

    it("ingest rethrows to a plain isError with the raw message", async () => {
      const client = await connectInMemory(depsWithKnowledgeError(unmapped));
      const result = await client.callTool({
        name: "ingest",
        arguments: { path: "src" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("weird backend failure");
    });
  });
});

/**
 * `coder` (src/mcp/server.ts `registerCoderTool`, formerly `delegate`) is
 * registered only when `deps.inference` is supplied, and hands the task off
 * to the "drafter" role of an injected InferenceService.
 */
describe("coder tool", () => {
  class FakeInferenceService implements InferenceService {
    lastRole: Role | undefined;
    lastMessages: readonly ChatMessage[] | undefined;

    constructor(
      private readonly impl: (
        role: Role,
        messages: readonly ChatMessage[],
        opts?: ChatOptions,
      ) => Promise<ChatResult>,
    ) {}

    async chat(
      role: Role,
      messages: readonly ChatMessage[],
      opts?: ChatOptions,
    ): Promise<ChatResult> {
      this.lastRole = role;
      this.lastMessages = messages;
      return this.impl(role, messages, opts);
    }

    async embed(): Promise<Vector[]> {
      throw new Error("not used by these tests");
    }

    capabilities(): HardwareTier {
      return HardwareTier.PMid;
    }
  }

  // The coder tool is registered from `deps.coder` (the CLI passes it only when
  // `inference.local_coder_enabled` is true); `deps.inference` drives the other
  // local roles. Tests exercising the tool wire both to the same fake.
  function depsWithInference(inference: InferenceService): Deps {
    return {
      ...createStandaloneDeps(),
      inference,
      coder: inference,
    };
  }

  it("is not listed when deps.coder is omitted", async () => {
    const client = await connectInMemory(createStandaloneDeps());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("coder");
  });

  it("is not listed when deps.inference is wired but deps.coder is not (coder disabled)", async () => {
    const fake = new FakeInferenceService(async (role) => ({
      text: "unused",
      model: "qwen2.5-coder:7b",
      role,
      promptTokens: 1,
      completionTokens: 1,
      finishReason: "stop",
    }));
    const client = await connectInMemory({ ...createStandaloneDeps(), inference: fake });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("coder");
  });

  it("drafts a task-only call and reports the local model in text and structuredContent", async () => {
    const fake = new FakeInferenceService(async (role) => ({
      text: "draft code here",
      model: "qwen2.5-coder:7b",
      role,
      promptTokens: 10,
      completionTokens: 20,
      finishReason: "stop",
    }));
    const client = await connectInMemory(depsWithInference(fake));

    const result = await client.callTool({
      name: "coder",
      arguments: { task: "write a hello world function" },
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("draft code here");
    expect(text).toContain("**Golem** Used qwen2.5-coder:7b locally");
    expect(result.structuredContent).toMatchObject({
      model: "qwen2.5-coder:7b",
      role: "drafter",
    });
  });

  it("sends both task and context to the local model when context is provided", async () => {
    const fake = new FakeInferenceService(async (role) => ({
      text: "ok",
      model: "qwen2.5-coder:7b",
      role,
      promptTokens: 1,
      completionTokens: 1,
      finishReason: "stop",
    }));
    const client = await connectInMemory(depsWithInference(fake));

    await client.callTool({
      name: "coder",
      arguments: {
        task: "refactor this function",
        context: "function foo() { return 1; }",
      },
    });

    expect(fake.lastRole).toBe("drafter");
    const sent = (fake.lastMessages ?? []).map((m) => String(m.content)).join("\n");
    expect(sent).toContain("refactor this function");
    expect(sent).toContain("function foo() { return 1; }");
  });

  it("surfaces a friendly isError result when the inference endpoint is unreachable", async () => {
    const fake = new FakeInferenceService(async () => {
      throw new InferenceEndpointError("connect ECONNREFUSED 127.0.0.1:11434");
    });
    const client = await connectInMemory(depsWithInference(fake));

    const result = await client.callTool({
      name: "coder",
      arguments: { task: "write a hello world function" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Golem's local inference endpoint (Ollama) is unreachable, so the knowledge " +
        "base cannot embed. Start Ollama and ensure the embedding model is pulled " +
        "(see `golem devices`), then retry.",
    );
  });

  it("surfaces a friendly isError result when no local model is available at the current tier", async () => {
    const fake = new FakeInferenceService(async () => {
      throw new CapabilityUnavailableError("drafter", HardwareTier.PCpu);
    });
    const client = await connectInMemory(depsWithInference(fake));

    const result = await client.callTool({
      name: "coder",
      arguments: { task: "write a hello world function" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Golem has no local model available for this task at the current hardware " +
        "tier. Check `golem devices` for what's detected, or ask Claude to do this " +
        "task directly instead of delegating it.",
    );
  });

  it("appends the underlying cause when CapabilityUnavailableError carries one", async () => {
    const fake = new FakeInferenceService(async () => {
      throw new CapabilityUnavailableError(
        "drafter",
        HardwareTier.PMid,
        new InferenceEndpointError("could not reach inference endpoint: timeout"),
      );
    });
    const client = await connectInMemory(depsWithInference(fake));

    const result = await client.callTool({
      name: "coder",
      arguments: { task: "write a hello world function" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Golem has no local model available for this task at the current hardware " +
        "tier. Check `golem devices` for what's detected, or ask Claude to do this " +
        "task directly instead of delegating it. Last attempt failed: could not reach " +
        "inference endpoint: timeout",
    );
  });

  // ---- R4.2: retrieval-augmented drafting (coder grounding) ----

  /** A KB whose search returns one hit whenever the query mentions "redaction". */
  class GroundingKnowledgeBase implements KnowledgeBase {
    searchCalls = 0;
    async ingest(): Promise<IngestReport> {
      throw new Error("not used by these tests");
    }
    async search(query: string, projectId: string): Promise<Hit[]> {
      this.searchCalls += 1;
      if (!query.toLowerCase().includes("redaction")) return [];
      return [
        {
          chunk: {
            chunkId: "chunk-red-1",
            projectId,
            text: "redaction runs BEFORE compression — never weaken or reorder it (T-C3)",
            sourcePath: "src/hooks/redact.ts",
            startLine: 12,
            metadata: { kind: "code" },
          },
          score: 0.95,
          scope: "knowledge",
        },
      ];
    }
    async getChunk(): Promise<Chunk> {
      throw new Error("not used by these tests");
    }
  }

  /** A KB whose search always throws, to exercise graceful grounding degradation. */
  class ThrowingKnowledgeBase implements KnowledgeBase {
    async ingest(): Promise<IngestReport> {
      throw new Error("not used by these tests");
    }
    async search(): Promise<Hit[]> {
      throw new Error("vector store on fire");
    }
    async getChunk(): Promise<Chunk> {
      throw new Error("not used by these tests");
    }
  }

  const okDrafter = () =>
    new FakeInferenceService(async (role) => ({
      text: "draft",
      model: "qwen2.5-coder:7b",
      role,
      promptTokens: 1,
      completionTokens: 1,
      finishReason: "stop",
    }));

  it("grounds the draft in KB hits by default and reports the injected sources", async () => {
    const fake = okDrafter();
    const kb = new GroundingKnowledgeBase();
    const client = await connectInMemory({ ...depsWithInference(fake), knowledge: kb });

    const result = await client.callTool({
      name: "coder",
      arguments: { task: "add a redaction rule for API keys" },
    });

    expect(result.isError).toBeFalsy();
    // The retrieved chunk text is injected into the drafter prompt under a labeled block.
    const sent = (fake.lastMessages ?? []).map((m) => String(m.content)).join("\n");
    expect(sent).toContain("Relevant project context");
    expect(sent).toContain("src/hooks/redact.ts:12");
    expect(sent).toContain("redaction runs BEFORE compression");
    // ...and the sources are echoed in the structured output for the caller to judge.
    expect(result.structuredContent).toMatchObject({
      grounding: { sources: ["src/hooks/redact.ts:12"] },
    });
    expect(textOf(result)).toContain("Grounded on 1 local source(s).");
  });

  it("skips grounding when ground:false, leaving the prompt ungrounded", async () => {
    const fake = okDrafter();
    const kb = new GroundingKnowledgeBase();
    const client = await connectInMemory({ ...depsWithInference(fake), knowledge: kb });

    const result = await client.callTool({
      name: "coder",
      arguments: { task: "add a redaction rule for API keys", ground: false },
    });

    expect(kb.searchCalls).toBe(0);
    const sent = (fake.lastMessages ?? []).map((m) => String(m.content)).join("\n");
    expect(sent).not.toContain("Relevant project context");
    expect(result.structuredContent).not.toHaveProperty("grounding");
  });

  it("omits grounding when the KB has no relevant hits (no empty block)", async () => {
    const fake = okDrafter();
    const client = await connectInMemory({
      ...depsWithInference(fake),
      knowledge: new GroundingKnowledgeBase(),
    });

    const result = await client.callTool({
      name: "coder",
      arguments: { task: "write an unrelated helper" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty("grounding");
  });

  it("degrades gracefully to an ungrounded draft when KB search throws", async () => {
    const fake = okDrafter();
    const client = await connectInMemory({
      ...depsWithInference(fake),
      knowledge: new ThrowingKnowledgeBase(),
    });

    const result = await client.callTool({
      name: "coder",
      arguments: { task: "add a redaction rule for API keys" },
    });

    // Grounding failure must never turn a successful draft into an error.
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("draft");
    expect(result.structuredContent).not.toHaveProperty("grounding");
  });

  it("does not attempt grounding when no knowledge base is wired", async () => {
    const fake = okDrafter();
    const client = await connectInMemory(depsWithInference(fake));

    const result = await client.callTool({
      name: "coder",
      arguments: { task: "add a redaction rule for API keys" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty("grounding");
  });

  // ---- R4.4: opt-in draft → judge → revise refinement ----

  it("runs a judge→revise pass when refine:true and the judge flags real issues", async () => {
    let drafterCalls = 0;
    const fake = new FakeInferenceService(async (role) => {
      if (role === "judge") {
        return {
          text: JSON.stringify({
            hasIssues: true,
            summary: "missing null check",
            issues: [{ severity: "high", description: "guard the undefined case" }],
          }),
          model: "fake-judge",
          role,
          promptTokens: 1,
          completionTokens: 1,
          finishReason: "stop",
        };
      }
      drafterCalls += 1;
      return {
        text: drafterCalls === 1 ? "first draft" : "revised draft",
        model: "qwen2.5-coder:7b",
        role,
        promptTokens: 1,
        completionTokens: 1,
        finishReason: "stop",
      };
    });
    const client = await connectInMemory(depsWithInference(fake));

    const result = await client.callTool({
      name: "coder",
      arguments: { task: "write a safe parse function", refine: true },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      text: "revised draft",
      refinement: { rounds: 1, critique_summary: "missing null check" },
    });
    expect(textOf(result)).toContain("Refined 1 round(s)");
    expect(drafterCalls).toBe(2); // initial draft + one revision
  });

  it("reports rounds:0 when refine:true but the judge finds nothing worth revising", async () => {
    const fake = new FakeInferenceService(async (role) => {
      if (role === "judge") {
        return {
          text: JSON.stringify({ hasIssues: false, summary: "fine", issues: [] }),
          model: "fake-judge",
          role,
          promptTokens: 1,
          completionTokens: 1,
          finishReason: "stop",
        };
      }
      return {
        text: "the one draft",
        model: "qwen2.5-coder:7b",
        role,
        promptTokens: 1,
        completionTokens: 1,
        finishReason: "stop",
      };
    });
    const client = await connectInMemory(depsWithInference(fake));

    const result = await client.callTool({
      name: "coder",
      arguments: { task: "trivial", refine: true },
    });

    expect(result.structuredContent).toMatchObject({
      text: "the one draft",
      refinement: { rounds: 0 },
    });
  });

  it("does not refine by default (no refinement field)", async () => {
    const client = await connectInMemory(depsWithInference(okDrafter()));
    const result = await client.callTool({
      name: "coder",
      arguments: { task: "write something" },
    });
    expect(result.structuredContent).not.toHaveProperty("refinement");
  });

  /**
   * R8.7 — `mode: "edit"`. The properties under test are the refusals: the
   * default outcome of an edit call is a diff and an unchanged file, an edit that
   * fails validation is never written, and no path outside the project root is
   * touched whatever the model or the caller says.
   */
  describe('mode: "edit" (R8.7)', () => {
    const FIXTURE = ["export function f(a: number): number {", "  return a + 1;", "}", ""].join(
      "\n",
    );

    /** A drafter that replies with `after` as a whole-file block. */
    function wholeFileDrafter(after: string): FakeInferenceService {
      return new FakeInferenceService(async (role) => ({
        text: `fixture.ts\n\`\`\`\n${after.replace(/\n$/u, "")}\n\`\`\`\n`,
        model: "qwen2.5-coder:7b",
        role,
        promptTokens: 1,
        completionTokens: 1,
        finishReason: "stop",
      }));
    }

    async function withProject(
      inference: InferenceService,
      contents = FIXTURE,
    ): Promise<{ client: Client; dir: string; file: string }> {
      const dir = await mkdtemp(path.join(tmpdir(), "golem-edit-"));
      const file = path.join(dir, "fixture.ts");
      await writeFile(file, contents, "utf8");
      const client = await connectInMemory({
        ...depsWithInference(inference),
        projectRootDir: dir,
        localEditor: true,
      });
      return { client, dir, file };
    }

    it("is not in the schema at all unless localEditor is wired (the +313-token bill)", async () => {
      const client = await connectInMemory(depsWithInference(okDrafter()));
      const { tools } = await client.listTools();
      const coder = tools.find((t) => t.name === "coder");
      const properties = (coder?.inputSchema.properties ?? {}) as Record<string, unknown>;
      expect(Object.keys(properties)).not.toContain("mode");
      expect(Object.keys(properties)).not.toContain("apply");
      expect(coder?.description).not.toContain('mode: "edit"');
    });

    it("appears in the schema when localEditor is wired", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "golem-edit-schema-"));
      try {
        const client = await connectInMemory({
          ...depsWithInference(okDrafter()),
          projectRootDir: dir,
          localEditor: true,
        });
        const { tools } = await client.listTools();
        const coder = tools.find((t) => t.name === "coder");
        const properties = (coder?.inputSchema.properties ?? {}) as Record<string, unknown>;
        expect(Object.keys(properties)).toContain("mode");
        expect(Object.keys(properties)).toContain("file");
        expect(Object.keys(properties)).toContain("apply");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("proposes a diff and changes nothing by default", async () => {
      const { client, dir, file } = await withProject(
        wholeFileDrafter(FIXTURE.replace("a + 1", "a + 2")),
      );
      try {
        const result = await client.callTool({
          name: "coder",
          arguments: { task: "return a + 2 instead", mode: "edit", file: "fixture.ts" },
        });
        expect(result.isError).toBeFalsy();
        const text = textOf(result);
        expect(text).toContain("Proposed for fixture.ts");
        expect(text).toContain("nothing written");
        expect(text).toContain("-  return a + 1;");
        expect(text).toContain("+  return a + 2;");
        expect(result.structuredContent).toMatchObject({
          edit: { status: "proposed", path: "fixture.ts", validation: "valid" },
        });
        expect(await readFile(file, "utf8")).toBe(FIXTURE);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("writes the file only when apply is true", async () => {
      const after = FIXTURE.replace("a + 1", "a + 2");
      const { client, dir, file } = await withProject(wholeFileDrafter(after));
      try {
        const result = await client.callTool({
          name: "coder",
          arguments: {
            task: "return a + 2 instead",
            mode: "edit",
            file: "fixture.ts",
            apply: true,
          },
        });
        expect(textOf(result)).toContain("Applied to fixture.ts");
        expect(result.structuredContent).toMatchObject({ edit: { status: "applied" } });
        expect(await readFile(file, "utf8")).toBe(after);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("refuses — and does not write — an edit that drops an existing definition", async () => {
      const { client, dir, file } = await withProject(
        wholeFileDrafter("export function g(): void {}\n"),
      );
      try {
        const result = await client.callTool({
          name: "coder",
          arguments: { task: "add a g function", mode: "edit", file: "fixture.ts", apply: true },
        });
        const text = textOf(result);
        expect(text).toContain("Refused to edit fixture.ts");
        expect(text).toContain("no longer defines f");
        expect(result.structuredContent).toMatchObject({
          edit: { status: "rejected", validation: "symbols-lost" },
        });
        expect(await readFile(file, "utf8")).toBe(FIXTURE);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("refuses a path outside the project root", async () => {
      const { client, dir } = await withProject(wholeFileDrafter("whatever\n"));
      try {
        const result = await client.callTool({
          name: "coder",
          arguments: { task: "edit it", mode: "edit", file: "../outside.ts", apply: true },
        });
        expect(textOf(result)).toContain("outside this project");
        expect(result.structuredContent).toMatchObject({ edit: { validation: "refused" } });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("declines a file above the line cap rather than guessing at it", async () => {
      const big = `${"// a line\n".repeat(MAX_EDIT_LINES + 5)}export const x = 1;\n`;
      const { client, dir } = await withProject(wholeFileDrafter("export const x = 2;\n"), big);
      try {
        const result = await client.callTool({
          name: "coder",
          arguments: { task: "change x to 2", mode: "edit", file: "fixture.ts" },
        });
        expect(textOf(result)).toContain(`above the ${MAX_EDIT_LINES}-line cap`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("asks for a file rather than editing something it guessed", async () => {
      const { client, dir } = await withProject(okDrafter());
      try {
        const result = await client.callTool({
          name: "coder",
          arguments: { task: "fix the bug", mode: "edit" },
        });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("needs `file`");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("refuses to edit at all when the server has no project root", async () => {
      const client = await connectInMemory({
        ...depsWithInference(okDrafter()),
        localEditor: true,
      });
      const result = await client.callTool({
        name: "coder",
        arguments: { task: "fix the bug", mode: "edit", file: "fixture.ts" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("no project root");
    });
  });
});

describe("tool telemetry (R4.3 — §59 gap)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, rmTemp);
  });

  class OneHitKnowledgeBase implements KnowledgeBase {
    async ingest(): Promise<IngestReport> {
      throw new Error("not used");
    }
    async search(_query: string, projectId: string): Promise<Hit[]> {
      return [
        {
          chunk: { chunkId: "c1", projectId, text: "hello", sourcePath: "a.ts", metadata: {} },
          score: 0.9,
          scope: "knowledge",
        },
      ];
    }
    async getChunk(chunkId: string, projectId = "default"): Promise<Chunk> {
      return { chunkId, projectId, text: "hello", sourcePath: "a.ts", metadata: {} };
    }
  }

  class DrafterInferenceService implements InferenceService {
    async chat(role: Role): Promise<ChatResult> {
      return {
        text: "a locally drafted answer",
        model: "qwen2.5-coder:7b",
        role,
        promptTokens: 1,
        completionTokens: 1,
        finishReason: "stop",
      };
    }
    async embed(): Promise<Vector[]> {
      throw new Error("not used");
    }
    capabilities(): HardwareTier {
      return HardwareTier.PMid;
    }
  }

  it("records a per-call tool event for search and coder (with model + draft length)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-tooltel-"));
    const store = new JsonlTelemetryStore(dir);
    const drafter = new DrafterInferenceService();
    const client = await connectInMemory({
      ...createStandaloneDeps(),
      knowledge: new OneHitKnowledgeBase(),
      inference: drafter,
      coder: drafter,
      defaultProjectId: "projA",
      telemetry: store,
    });

    await client.callTool({ name: "search", arguments: { query: "anything" } });
    await client.callTool({
      name: "coder",
      arguments: { task: "write a function", ground: false },
    });
    // Drain the fire-and-forget appends, then read with a fresh store.
    await store.close();

    const usage = await new JsonlTelemetryStore(dir).aggregateToolUsage("projA");
    expect(usage.byTool.search?.calls).toBe(1);
    expect(usage.byTool.coder?.calls).toBe(1);
    // The coder event carries the drafted-locally char bucket.
    expect(usage.byTool.coder?.draftChars).toBe("a locally drafted answer".length);
  });

  it("stats tool surfaces a per-tool tool_usage summary when telemetry is present", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-tooltel-"));
    const store = new JsonlTelemetryStore(dir);
    await recordToolCall(
      store,
      { projectId: "projA", tool: "coder", durationMs: 900, resultBytes: 100, draftChars: 400 },
      "2026-07-16T00:00:00.000Z",
    );
    await store.close();

    const client = await connectInMemory({
      ...createStandaloneDeps(),
      defaultProjectId: "projA",
      telemetry: new JsonlTelemetryStore(dir),
    });
    const result = await client.callTool({ name: "stats", arguments: { project_id: "projA" } });

    expect(result.structuredContent).toHaveProperty("tool_usage");
    expect(
      (result.structuredContent as { tool_usage: Record<string, unknown> }).tool_usage,
    ).toMatchObject({ coder: { calls: 1, draft_chars: 400 } });
    expect(textOf(result)).toContain("Local tools:");
    expect(textOf(result)).toContain("tokens drafted locally");
  });

  it("omits tool_usage when no telemetry store is wired", async () => {
    const client = await connectInMemory(createStandaloneDeps());
    const result = await client.callTool({ name: "stats", arguments: {} });
    expect(result.structuredContent).not.toHaveProperty("tool_usage");
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
      name: "level",
      arguments: { level: 3 },
    });
    expect(setResult.structuredContent).toMatchObject({ slider_level: 3 });

    // A second, independent session sees the same injected deps (shared state).
    const clientB = new Client({ name: "http-client-b", version: "0.0.0" });
    await clientB.connect(new StreamableHTTPClientTransport(handle.url) as Transport);
    const stats = await clientB.callTool({ name: "stats", arguments: {} });
    expect(stats.structuredContent).toMatchObject({ slider_level: 3 });

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
