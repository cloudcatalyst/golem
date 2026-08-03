/**
 * The `code` tool (repo map + LSP modes). Extracted from server.ts (R8.28).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LSP_MODES, type LspBridge, type LspMode } from "../ext/index.js";
import {
  buildRepoMap,
  DEFAULT_MAP_BUDGET_TOKENS,
  MAX_MAP_BUDGET_TOKENS,
} from "../knowledge/repo-map.js";
import { instrumented, type ToolTelemetry } from "./shared.js";

/**
 * R8.5/R8.6 — the `code` tool: ONE tool with a `mode` parameter, never one tool
 * per capability.
 */

/** Validated `code` arguments — the union of the map shape and the LSP shape. */
interface CodeToolArgs {
  readonly mode?: string | undefined;
  readonly query?: string | undefined;
  readonly paths?: string[] | undefined;
  readonly budget_tokens?: number | undefined;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
  readonly character?: number | undefined;
  readonly symbol?: string | undefined;
}

export function registerCodeTool(
  server: McpServer,
  root: string,
  tel?: ToolTelemetry,
  lsp?: LspBridge,
): void {
  const modes = lsp !== undefined ? (["map", ...LSP_MODES] as const) : (["map"] as const);
  const modeDescription =
    lsp !== undefined
      ? "`map` (whole-repo skeleton), or an LSP question about one position: " +
        "`diagnostics` | `definition` | `references` | `hover`"
      : "What to return; only `map` (the whole-repo skeleton) exists today";
  const lspInputs =
    lsp !== undefined
      ? {
          file: z
            .string()
            .min(1)
            .optional()
            .describe("Repo-relative file the LSP modes ask about (required by those modes)"),
          line: z.number().int().min(1).optional().describe("1-based line for the LSP position"),
          character: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("1-based column; defaults to `symbol`'s position or the first non-blank"),
          symbol: z
            .string()
            .min(1)
            .optional()
            .describe("Name to locate instead of a column — pairs with a `map` row"),
        }
      : {};

  server.registerTool(
    "code",
    {
      title: "Map this repository's code",
      description:
        "Whole-repo code map: the files that matter, each with its key symbol " +
        "signatures and line numbers, ranked by an import/reference graph and " +
        "rendered to a token budget (~1.4k). Use it BEFORE reading files to find " +
        "where something lives — pass the question as `query` and it re-ranks " +
        "toward that topic. Cheaper than opening candidate files: read a narrow " +
        "range of the file it names instead. Local, no network." +
        (lsp !== undefined
          ? " Other modes ask a language server about one position instead of the " +
            "whole repo: `definition`/`references` beat grepping, `hover` gives the " +
            "resolved type, `diagnostics` lists a file's problems. Pass `file` plus " +
            "`symbol` (or `line`)."
          : ""),
      inputSchema: {
        mode: z.enum(modes).optional().describe(modeDescription),
        query: z
          .string()
          .min(1)
          .optional()
          .describe("What you are looking for — re-ranks the map toward matching files/symbols"),
        paths: z
          .array(z.string().min(1))
          .optional()
          .describe("Repo-relative paths to weight heavily, e.g. files already in play"),
        budget_tokens: z
          .number()
          .int()
          .min(200)
          .max(MAX_MAP_BUDGET_TOKENS)
          .optional()
          .describe(`Token budget for the rendered map (default ${DEFAULT_MAP_BUDGET_TOKENS})`),
        ...lspInputs,
      },
      outputSchema: {
        mode: z.string(),
        available: z.boolean(),
        files_scanned: z.number().int().nonnegative().optional(),
        files_shown: z.number().int().nonnegative().optional(),
        symbols_total: z.number().int().nonnegative().optional(),
        symbols_shown: z.number().int().nonnegative().optional(),
        tokens: z.number().int().nonnegative().optional(),
        budget_tokens: z.number().int().nonnegative().optional(),
        ...(lsp !== undefined
          ? {
              reason: z.string().optional(),
              server: z.string().optional(),
              locations: z
                .array(
                  z.object({
                    file: z.string(),
                    line: z.number().int(),
                    character: z.number().int(),
                  }),
                )
                .optional(),
              diagnostics: z
                .array(
                  z.object({
                    file: z.string(),
                    line: z.number().int(),
                    character: z.number().int(),
                    severity: z.string(),
                    message: z.string(),
                    code: z.string().optional(),
                    source: z.string().optional(),
                  }),
                )
                .optional(),
            }
          : {}),
      },
    },
    async ({ mode, query, paths, budget_tokens, file, line, character, symbol }: CodeToolArgs) => {
      const startMs = Date.now();

      if (lsp !== undefined && mode !== undefined && mode !== "map") {
        return instrumented(
          tel,
          "code",
          startMs,
          await runLspMode(lsp, mode as LspMode, { file, line, character, symbol }),
        );
      }

      const result = await buildRepoMap(root, {
        ...(query !== undefined ? { query } : {}),
        ...(paths !== undefined ? { focusPaths: paths } : {}),
        ...(budget_tokens !== undefined ? { budgetTokens: budget_tokens } : {}),
      });
      if (!result.available) {
        return instrumented(tel, "code", startMs, {
          content: [
            {
              type: "text" as const,
              text: `No repo map available: ${result.reason}`,
            },
          ],
          structuredContent: {
            mode: mode ?? "map",
            available: false,
            files_scanned: 0,
            files_shown: 0,
            symbols_total: 0,
            symbols_shown: 0,
            tokens: 0,
            budget_tokens: 0,
          },
        });
      }
      return instrumented(tel, "code", startMs, {
        content: [{ type: "text" as const, text: result.text }],
        structuredContent: {
          mode: mode ?? "map",
          available: true,
          files_scanned: result.filesScanned,
          files_shown: result.filesShown,
          symbols_total: result.symbolsTotal,
          symbols_shown: result.symbolsShown,
          tokens: result.tokens,
          budget_tokens: result.budgetTokens,
        },
      });
    },
  );
}

/**
 * R8.6 — one LSP mode of the `code` tool, rendered as a tool result.
 *
 * Nothing here is an error path. A missing `file`, an absent language server, a
 * timeout and a protocol failure all come back as `available: false` plus the
 * reason, because a tool that throws teaches the model to stop asking — and the
 * fallback (read the file, grep it) was always available anyway.
 */
async function runLspMode(
  lsp: LspBridge,
  mode: LspMode,
  args: {
    file?: string | undefined;
    line?: number | undefined;
    character?: number | undefined;
    symbol?: string | undefined;
  },
): Promise<{
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
}> {
  if (args.file === undefined) {
    const text = `No LSP ${mode} available: this mode needs a \`file\``;
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { mode, available: false, reason: "missing `file`" },
    };
  }
  const result = await lsp.query({
    mode,
    file: args.file,
    ...(args.line !== undefined ? { line: args.line } : {}),
    ...(args.character !== undefined ? { character: args.character } : {}),
    ...(args.symbol !== undefined ? { symbol: args.symbol } : {}),
  });
  return {
    content: [{ type: "text" as const, text: result.text }],
    structuredContent: {
      mode: result.mode,
      available: result.available,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.server !== undefined ? { server: result.server } : {}),
      ...(result.locations.length > 0 ? { locations: [...result.locations] } : {}),
      ...(result.diagnostics.length > 0 ? { diagnostics: [...result.diagnostics] } : {}),
    },
  };
}
