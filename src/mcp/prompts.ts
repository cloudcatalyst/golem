/**
 * All 8 Golem MCP prompt registrations. Extracted from server.ts (R8.28).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { promptMessages } from "./shared.js";

const P1_TOOL_FALLBACK =
  "If that tool is not available in this session, tell the user this Golem capability has not shipped or is not enabled yet, and suggest checking `golem status`.";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "slider",
    {
      title: "Golem slider",
      description: "Show or set Golem's quality/savings slider (0–3)",
      argsSchema: {
        level: z
          .string()
          .optional()
          .describe("New slider level 1–3 (0 is CLI-only); omit to show the current level"),
      },
    },
    ({ level }) =>
      promptMessages(
        level === undefined || level === ""
          ? "Call the stats tool and report the current Golem slider level, " +
              "then briefly list what each level 0–3 enables " +
              "(0 passthrough — full bypass, NO redaction; 1 lossless; 2 balanced; 3 aggressive)."
          : `Set the Golem savings slider to level ${level} using the level ` +
              "tool (it accepts integers 1–3; if the requested value is not a valid " +
              "level, tell the user instead of guessing). Then confirm the new level " +
              "and summarize in one sentence what changes at that level. Level 0 is a " +
              "full bypass that turns redaction OFF and CANNOT be set from a tool " +
              "call — if 0 was requested, do not attempt it: say that redaction would " +
              "be off and that the user must run `golem slider 0` themselves.",
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
        `Call the stats tool${
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
        ref_id: z
          .string()
          .describe(
            "The CCR ref id — the hex id from a `Retrieve original: hash=<id>` " +
              "(or `[golem:ccr ref=<id>]`) marker",
          ),
      },
    },
    ({ ref_id }) =>
      promptMessages(
        `Call the expand tool with ref_id "${ref_id}" and show the retrieved ` +
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
        "The user wants to bypass Golem's compression. Explain the two options " +
          "and pick per intent: (1) a per-request bypass that leaves the " +
          "persistent slider alone — direct API callers add the `x-golem-bypass` " +
          "header. (2) a persistent change — `level 1` keeps redaction on while " +
          "compression stays byte-faithful, and you can set it with the level " +
          "tool. `level 0` turns Golem fully OFF but ALSO disables redaction " +
          "(secrets reach the upstream raw), so it cannot be set from a tool call " +
          "at all: for a deliberate full bypass, tell the user to run " +
          "`golem slider 0` in their terminal. Prefer level 1 unless a true full " +
          "bypass is intended; confirm the choice and remind the user to restore " +
          "their previous level afterwards.",
      ),
  );

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
        } into the Golem knowledge base using the ingest tool, then ` +
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
        `Search the Golem knowledge base for "${query}" using the search tool ` +
          "and summarize the most relevant hits (use fetch for full " +
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
          `available local models) using the devices tool. ${P1_TOOL_FALLBACK}`,
      ),
  );

  server.registerPrompt(
    "coder",
    {
      title: "Draft code or tests with a local model",
      description:
        "Delegate a code/test drafting task to a local model via Golem's tiered inference",
      argsSchema: {
        task: z.string().optional().describe("The task to delegate to a local model"),
      },
    },
    ({ task }) =>
      promptMessages(
        `Delegate ${
          task === undefined || task === "" ? "the user's current task" : `this task: "${task}"`
        } to a local model using the coder tool and relay the result, ` +
          `noting it was produced locally. ${P1_TOOL_FALLBACK}`,
      ),
  );
}
