/**
 * Unified Golem MCP server (WS-B task B1) — tool/prompt registration wiring.
 *
 * Tool registrations live in per-concern modules under src/mcp/ (R8.28).
 * This file owns the deps interface, the entry point, and the wiring.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compressionName } from "../interfaces/index.js";
import type { ToolUsageStats } from "../telemetry/index.js";
import { registerCodeTool } from "./code-tool.js";
import { registerCoderTool } from "./coder-tools.js";
import { registerDevicesTool, registerSnoozeTool } from "./devices-snooze.js";
import { registerPrompts } from "./prompts.js";
import { registerKnowledgeTools } from "./search.js";
import {
  errorResult,
  GOLEM_MCP_SERVER_NAME,
  GOLEM_MCP_SERVER_VERSION,
  instrumented,
  type ToolTelemetry,
  textResult,
} from "./shared.js";
import { registerWikiTools } from "./wiki-tools.js";

export type { GolemMcpServerDeps } from "./deps.js";
export { createStandaloneDeps } from "./deps.js";
export type { Grounding, HitAssemblyDeps } from "./search.js";
export { boostWikiHits, gatherGrounding, graphFirstWikiHits, pageToHit } from "./search.js";

/** R4.3 — snake_case tool_usage map for the `stats` tool, or undefined if nothing was recorded. */
function toolUsageToStructured(
  usage: ToolUsageStats | undefined,
): Record<string, Record<string, number>> | undefined {
  if (usage === undefined) return undefined;
  const entries = Object.entries(usage.byTool);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([tool, u]) => [
      tool,
      {
        calls: u.calls,
        total_duration_ms: u.totalDurationMs,
        total_result_bytes: u.totalResultBytes,
        draft_chars: u.draftChars,
      },
    ]),
  );
}

/** R4.3 — a one-line tool-usage summary appended to the `stats` text (empty when none). */
function toolUsageSummaryLine(usage: ToolUsageStats | undefined): string {
  if (usage === undefined) return "";
  const entries = Object.entries(usage.byTool);
  if (entries.length === 0) return "";
  const calls = entries.reduce((n, [, u]) => n + u.calls, 0);
  const draftChars = entries.reduce((n, [, u]) => n + u.draftChars, 0);
  const parts = entries.map(([tool, u]) => `${tool}×${u.calls}`).join(", ");
  const drafted = draftChars > 0 ? ` ~${Math.round(draftChars / 4)} tokens drafted locally.` : "";
  return ` Local tools: ${calls} call(s) (${parts}).${drafted}`;
}

/** Build the unified MCP server: P0 tools + all 8 frozen prompts. */
export function createGolemMcpServer(deps: import("./deps.js").GolemMcpServerDeps): McpServer {
  const server = new McpServer({
    name: GOLEM_MCP_SERVER_NAME,
    version: GOLEM_MCP_SERVER_VERSION,
  });

  registerTools(server, deps);
  registerPrompts(server);
  return server;
}

function registerTools(server: McpServer, deps: import("./deps.js").GolemMcpServerDeps): void {
  // R9.11: built HERE rather than further down, because `expand`/`stats`/`level`
  // (and `devices`/`snooze`) are registered above where it used to be declared and
  // were therefore the only tools recording NOTHING. That gap was not visible as a
  // gap: `stats` reported per-tool call counts for the instrumented tools and
  // simply omitted the others, so five tools read as "never used" when they were
  // only never measured. R9.11 asked whether any tool should be demoted to a
  // skill-only capability and required a call count to justify it — a question the
  // instrument could not answer for three of its four candidates.
  const tel: ToolTelemetry | undefined =
    deps.telemetry !== undefined
      ? { store: deps.telemetry, projectId: deps.defaultProjectId ?? "default" }
      : undefined;

  server.registerTool(
    "expand",
    {
      title: "Expand a Golem CCR reference",
      description:
        "Retrieve the original, uncompressed content behind a Golem CCR " +
        "(compress-cache-retrieve) reference marker such as " +
        "`Retrieve original: hash=<hex id>` (standalone stub runs emit " +
        "`[golem:ccr ref=<id> ...]`). Use when compressed context is not " +
        "detailed enough and the full original is needed.",
      inputSchema: {
        ref_id: z
          .string()
          .min(1)
          .describe("The CCR ref id from the marker — the hex id after `hash=` (or `ref=`)"),
        content_type: z
          .string()
          .optional()
          .describe("MIME content type from the marker, if present (default text/plain)"),
      },
    },
    async ({ ref_id, content_type }) => {
      const startMs = Date.now();
      try {
        const original = await deps.compression.retrieve({
          refId: ref_id,
          contentType: content_type ?? "text/plain",
          originalTokens: 0,
        });
        return instrumented(tel, "expand", startMs, textResult(original.content));
      } catch (error) {
        if (error instanceof Error && error.name === "UnknownRefError") {
          return instrumented(
            tel,
            "expand",
            startMs,
            errorResult(
              `Unknown or expired CCR ref "${ref_id}". The original content is no ` +
                "longer in the Golem store; re-run the tool that produced it if the " +
                "full output is still needed.",
            ),
          );
        }
        return instrumented(
          tel,
          "expand",
          startMs,
          errorResult(
            `Failed to retrieve content for ref "${ref_id}": ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    },
  );

  server.registerTool(
    "stats",
    {
      title: "Golem savings statistics",
      description:
        "Report Golem's cumulative token-savings statistics (tokens before/after " +
        "compression, per-stage attribution, CCR store activity) plus the current " +
        "compression level. Optionally scoped to one project.",
      inputSchema: {
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe("Limit stats to this project id; omit for global stats"),
      },
      outputSchema: {
        project_id: z.string().nullable(),
        // R11.1: was `slider_level` (0–3). The slider is retired (ADR-0004) and
        // the dial that remains is `off|1|2|3`, so the value is a string.
        compression_level: z.string(),
        compression_level_name: z.string(),
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
        tool_usage: z
          .record(
            z.object({
              calls: z.number().int().nonnegative(),
              total_duration_ms: z.number().int().nonnegative(),
              total_result_bytes: z.number().int().nonnegative(),
              draft_chars: z.number().int().nonnegative(),
            }),
          )
          .optional(),
      },
    },
    async ({ project_id }) => {
      const startMs = Date.now();
      const [stats, level, toolUsage] = await Promise.all([
        project_id === undefined ? deps.compression.stats() : deps.compression.stats(project_id),
        deps.compressionLevel(),
        deps.telemetry?.aggregateToolUsage(project_id),
      ]);
      const tokensSaved = stats.tokensBefore - stats.tokensAfter;
      const toolUsageStructured = toolUsageToStructured(toolUsage);
      const structuredContent = {
        project_id: stats.projectId,
        compression_level: String(level),
        compression_level_name: compressionName(level),
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
        ...(toolUsageStructured !== undefined ? { tool_usage: toolUsageStructured } : {}),
      };
      const scope = stats.projectId === null ? "all projects" : `project ${stats.projectId}`;
      // Note the ordering: the counts above were read BEFORE this call is recorded,
      // so `stats` never reports itself in the same breath as reporting it. That is
      // the honest reading — a self-inflating counter would be worse than none.
      return instrumented(tel, "stats", startMs, {
        content: [
          {
            type: "text" as const,
            text:
              `Golem stats (${scope}): compression ${level} (${compressionName(level)}), ` +
              `${stats.requests} requests, ${tokensSaved} tokens saved ` +
              `(${stats.tokensBefore} before → ${stats.tokensAfter} after), ` +
              `${stats.ccrRefsStored} CCR refs stored / ${stats.ccrRefsRetrieved} retrieved.` +
              toolUsageSummaryLine(toolUsage),
          },
        ],
        structuredContent,
      });
    },
  );

  registerDevicesTool(server, deps, tel);
  registerSnoozeTool(server, deps);

  if (deps.knowledge !== undefined) {
    registerKnowledgeTools(
      server,
      deps.knowledge,
      deps.defaultProjectId ?? "default",
      deps.wikiDir,
      deps.projectRootDir ?? deps.defaultProjectId,
      deps.wikiSearch ?? deps.wiki,
      deps.rerank,
      tel,
    );
  }

  if (deps.coder !== undefined) {
    registerCoderTool(
      server,
      deps.coder,
      {
        knowledge: deps.knowledge,
        wiki: deps.wikiSearch ?? deps.wiki,
        wikiDir: deps.wikiDir,
        rerank: deps.rerank,
        defaultProjectId: deps.defaultProjectId ?? "default",
        ...(deps.projectRootDir === undefined ? {} : { projectRootDir: deps.projectRootDir }),
        editEnabled: deps.localEditor === true,
      },
      tel,
      deps.targetDispatcher,
    );
  }

  if (deps.codeRoot !== undefined) {
    registerCodeTool(server, deps.codeRoot, tel, deps.lsp);
  }

  if (deps.wiki !== undefined) {
    registerWikiTools(server, deps.wiki, tel);
  }
}
