/**
 * Unified Golem MCP server (WS-B task B1).
 *
 * Frozen names (IMPLEMENTATION_PLAN §2.5 — do not rename):
 * - P0 tools: `golem_expand`, `golem_stats`, `golem_set_slider`
 *   (P1 tools golem_search/golem_get_chunk/golem_index_path/golem_delegate/
 *   golem_devices arrive with task B3.)
 * - Prompts: `slider`, `index`, `search`, `stats`, `expand`, `bypass`,
 *   `devices`, `delegate` — surfaced by Claude Code as `/mcp__golem__<name>`
 *   (verification-notes.md §10).
 *
 * Tool inputs are zod-validated at the boundary: the zod schemas below are
 * enforced by the SDK, which maps failures to InvalidParams (-32602) MCP tool
 * errors — surfaced as `isError: true` results embedding the code, per SDK
 * 1.29.0 behavior (verification-notes.md §18); prompt-argument validation
 * failures reject at the protocol level. Business failures (e.g. unknown CCR
 * ref) are returned as `isError: true` tool results so the model can react.
 *
 * Implementations are injected via {@link GolemMcpServerDeps} — WS-A wires the
 * real CompressionService in later; `createStandaloneDeps()` provides the
 * in-memory stubs used by tests and standalone runs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CompressionService, SliderLevel } from "../interfaces/index.js";
import { UnknownRefError } from "../interfaces/index.js";
import type { SliderStore } from "./slider-store.js";
import { InMemorySliderStore } from "./slider-store.js";
import { InMemoryCompressionService } from "./stub-compression.js";

export const GOLEM_MCP_SERVER_NAME = "golem";
export const GOLEM_MCP_SERVER_VERSION = "0.1.0";

/** Injected implementation boundary (frozen interfaces only). */
export interface GolemMcpServerDeps {
  readonly compression: CompressionService;
  readonly sliderStore: SliderStore;
}

/** In-memory deps for tests and for running standalone before WS-A lands. */
export function createStandaloneDeps(): GolemMcpServerDeps & {
  readonly compression: InMemoryCompressionService;
} {
  return {
    compression: new InMemoryCompressionService(),
    sliderStore: new InMemorySliderStore(),
  };
}

const LEVEL_NAMES: Readonly<Record<SliderLevel, string>> = {
  0: "passthrough",
  1: "lossless",
  2: "conservative",
  3: "balanced",
  4: "aggressive",
  5: "max savings",
};

const sliderLevelInput = z
  .number()
  .int()
  .min(0)
  .max(5)
  .describe(
    "Slider level: 0 passthrough, 1 lossless, 2 conservative, 3 balanced, 4 aggressive, 5 max savings",
  );

function asSliderLevel(level: number): SliderLevel {
  // zod has already enforced int 0..5 at the boundary; this narrows the type.
  return level as SliderLevel;
}

function textResult(text: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): {
  isError: true;
  content: [{ type: "text"; text: string }];
} {
  return { isError: true, content: [{ type: "text", text }] };
}

/** One user-role text message — the shape every Golem prompt returns. */
function promptMessages(text: string): {
  messages: [{ role: "user"; content: { type: "text"; text: string } }];
} {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

const P1_TOOL_FALLBACK =
  "If that tool is not available in this session, tell the user this Golem capability has not shipped or is not enabled yet, and suggest checking `golem status`.";

/** Build the unified MCP server: P0 tools + all 8 frozen prompts. */
export function createGolemMcpServer(deps: GolemMcpServerDeps): McpServer {
  const server = new McpServer({
    name: GOLEM_MCP_SERVER_NAME,
    version: GOLEM_MCP_SERVER_VERSION,
  });

  registerTools(server, deps);
  registerPrompts(server);
  return server;
}

function registerTools(server: McpServer, deps: GolemMcpServerDeps): void {
  server.registerTool(
    "golem_expand",
    {
      title: "Expand a Golem CCR reference",
      description:
        "Retrieve the original, uncompressed content behind a Golem CCR " +
        "(compress-cache-retrieve) reference marker such as " +
        "`[golem:ccr ref=abc123 ...]`. Use when compressed context is not " +
        "detailed enough and the full original is needed.",
      inputSchema: {
        ref_id: z.string().min(1).describe("The CCR ref id from the marker, e.g. `abc123`"),
        content_type: z
          .string()
          .optional()
          .describe("MIME content type from the marker, if present (default text/plain)"),
      },
    },
    async ({ ref_id, content_type }) => {
      try {
        const original = await deps.compression.retrieve({
          refId: ref_id,
          contentType: content_type ?? "text/plain",
          originalTokens: 0,
        });
        return textResult(original.content);
      } catch (error) {
        if (error instanceof UnknownRefError) {
          return errorResult(
            `Unknown or expired CCR ref "${ref_id}". The original content is no ` +
              "longer in the Golem store; re-run the tool that produced it if the " +
              "full output is still needed.",
          );
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "golem_stats",
    {
      title: "Golem savings statistics",
      description:
        "Report Golem's cumulative token-savings statistics (tokens before/after " +
        "compression, per-stage attribution, CCR store activity) plus the current " +
        "slider level. Optionally scoped to one project.",
      inputSchema: {
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe("Limit stats to this project id; omit for global stats"),
      },
      outputSchema: {
        project_id: z.string().nullable(),
        slider_level: z.number().int().min(0).max(5),
        slider_level_name: z.string(),
        requests: z.number().int().nonnegative(),
        tokens_before: z.number().int().nonnegative(),
        tokens_after: z.number().int().nonnegative(),
        tokens_saved: z.number().int(),
        per_stage: z.record(
          z.object({
            tokens_before: z.number().int().nonnegative(),
            tokens_after: z.number().int().nonnegative(),
          }),
        ),
        ccr_refs_stored: z.number().int().nonnegative(),
        ccr_refs_retrieved: z.number().int().nonnegative(),
      },
    },
    async ({ project_id }) => {
      const [stats, level] = await Promise.all([
        project_id === undefined ? deps.compression.stats() : deps.compression.stats(project_id),
        deps.sliderStore.get(),
      ]);
      const tokensSaved = stats.tokensBefore - stats.tokensAfter;
      const structuredContent = {
        project_id: stats.projectId,
        slider_level: level,
        slider_level_name: LEVEL_NAMES[level],
        requests: stats.requests,
        tokens_before: stats.tokensBefore,
        tokens_after: stats.tokensAfter,
        tokens_saved: tokensSaved,
        per_stage: Object.fromEntries(
          Object.entries(stats.perStage).map(([stage, delta]) => [
            stage,
            { tokens_before: delta.tokensBefore, tokens_after: delta.tokensAfter },
          ]),
        ),
        ccr_refs_stored: stats.ccrRefsStored,
        ccr_refs_retrieved: stats.ccrRefsRetrieved,
      };
      const scope = stats.projectId === null ? "all projects" : `project ${stats.projectId}`;
      return {
        content: [
          {
            type: "text",
            text:
              `Golem stats (${scope}): slider level ${level} (${LEVEL_NAMES[level]}), ` +
              `${stats.requests} requests, ${tokensSaved} tokens saved ` +
              `(${stats.tokensBefore} before → ${stats.tokensAfter} after), ` +
              `${stats.ccrRefsStored} CCR refs stored / ${stats.ccrRefsRetrieved} retrieved.`,
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "golem_set_slider",
    {
      title: "Set the Golem savings slider",
      description:
        "Set Golem's global quality/savings slider (0–5). 0 = passthrough " +
        "(redaction only), 1 = lossless compression, 2 adds tool-result caching, " +
        "3–5 add increasingly aggressive semantic stages. The level persists " +
        "across sessions.",
      inputSchema: { level: sliderLevelInput },
      outputSchema: {
        slider_level: z.number().int().min(0).max(5),
        slider_level_name: z.string(),
      },
    },
    async ({ level }) => {
      const sliderLevel = asSliderLevel(level);
      await deps.sliderStore.set(sliderLevel);
      return {
        content: [
          {
            type: "text",
            text: `Golem slider set to level ${sliderLevel} (${LEVEL_NAMES[sliderLevel]}).`,
          },
        ],
        structuredContent: {
          slider_level: sliderLevel,
          slider_level_name: LEVEL_NAMES[sliderLevel],
        },
      };
    },
  );
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "slider",
    {
      title: "Golem slider",
      description: "Show or set Golem's quality/savings slider (0–5)",
      argsSchema: {
        level: z
          .string()
          .optional()
          .describe("New slider level 0–5; omit to show the current level"),
      },
    },
    ({ level }) =>
      promptMessages(
        level === undefined || level === ""
          ? "Call the golem_stats tool and report the current Golem slider level, " +
              "then briefly list what each level 0–5 enables " +
              "(0 passthrough, 1 lossless, 2 conservative, 3 balanced, 4 aggressive, 5 max savings)."
          : `Set the Golem savings slider to level ${level} using the golem_set_slider ` +
              "tool (it accepts integers 0–5; if the requested value is not a valid " +
              "level, tell the user instead of guessing). Then confirm the new level " +
              "and summarize in one sentence what changes at that level.",
      ),
  );

  server.registerPrompt(
    "stats",
    {
      title: "Golem savings stats",
      description: "Show Golem token-savings statistics",
      argsSchema: {
        project_id: z
          .string()
          .optional()
          .describe("Limit stats to this project id; omit for global stats"),
      },
    },
    ({ project_id }) =>
      promptMessages(
        `Call the golem_stats tool${
          project_id === undefined || project_id === "" ? "" : ` with project_id "${project_id}"`
        } and present the results concisely: current slider level, total tokens ` +
          "saved (before → after), request count, per-stage attribution if any, " +
          "and CCR store activity.",
      ),
  );

  server.registerPrompt(
    "expand",
    {
      title: "Expand a Golem CCR reference",
      description: "Retrieve the original content behind a Golem CCR ref marker",
      argsSchema: {
        ref_id: z.string().describe("The CCR ref id, e.g. abc123 from `[golem:ccr ref=abc123]`"),
      },
    },
    ({ ref_id }) =>
      promptMessages(
        `Call the golem_expand tool with ref_id "${ref_id}" and show the retrieved ` +
          "original content to the user. If the ref is unknown or expired, say so " +
          "and suggest re-running the tool that produced the content.",
      ),
  );

  server.registerPrompt(
    "bypass",
    {
      title: "Bypass Golem compression",
      description: "Temporarily bypass Golem's compression pipeline",
    },
    () =>
      promptMessages(
        "The user wants to temporarily bypass Golem's compression pipeline. " +
          "Call golem_set_slider with level 0 (passthrough — redaction still runs, " +
          "nothing else is transformed) and confirm. Remind the user to restore " +
          "their previous level afterwards (e.g. /mcp__golem__slider 1), and " +
          "mention that direct API callers can bypass per-request with the " +
          "`x-golem-bypass` header instead.",
      ),
  );

  // P1 prompts (frozen names; backing tools ship with tasks B3 / WS-C / WS-D).
  server.registerPrompt(
    "index",
    {
      title: "Index into the Golem knowledge base",
      description: "Ingest a path into Golem's local vector knowledge base",
      argsSchema: {
        path: z.string().optional().describe("File or directory to ingest (default: project root)"),
      },
    },
    ({ path }) =>
      promptMessages(
        `Ingest ${
          path === undefined || path === "" ? "the current project root" : `"${path}"`
        } into the Golem knowledge base using the golem_index_path tool, then ` +
          `report what was indexed. ${P1_TOOL_FALLBACK}`,
      ),
  );

  server.registerPrompt(
    "search",
    {
      title: "Search the Golem knowledge base",
      description: "Federated semantic search over Golem's local knowledge base",
      argsSchema: {
        query: z.string().describe("What to search for"),
      },
    },
    ({ query }) =>
      promptMessages(
        `Search the Golem knowledge base for "${query}" using the golem_search tool ` +
          "and summarize the most relevant hits (use golem_get_chunk for full " +
          `chunk contents when needed). ${P1_TOOL_FALLBACK}`,
      ),
  );

  server.registerPrompt(
    "devices",
    {
      title: "Golem hardware capabilities",
      description: "Show detected local hardware tier and available local models",
    },
    () =>
      promptMessages(
        "Report the local hardware capabilities Golem detected (tier, GPU/VRAM, " +
          `available local models) using the golem_devices tool. ${P1_TOOL_FALLBACK}`,
      ),
  );

  server.registerPrompt(
    "delegate",
    {
      title: "Delegate to a local model",
      description: "Delegate a task to a local model via Golem's tiered inference",
      argsSchema: {
        task: z.string().optional().describe("The task to delegate to a local model"),
      },
    },
    ({ task }) =>
      promptMessages(
        `Delegate ${
          task === undefined || task === "" ? "the user's current task" : `this task: "${task}"`
        } to a local model using the golem_delegate tool and relay the result, ` +
          `noting it was produced locally. ${P1_TOOL_FALLBACK}`,
      ),
  );
}
