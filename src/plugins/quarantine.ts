/**
 * R8.11 seams B and C — the quarantine adapters (ADR-0004 threat 8).
 *
 * Every call into plugin code goes through one of these. The contract they
 * enforce is Decision 53's admission criterion 3, restated as code: **a plugin
 * failing is a no-op with a reason, never an error path.** A throw, a rejected
 * promise, a returned value of the wrong shape, or a stage that hands back
 * something that is not an object all resolve to "this plugin contributed
 * nothing to this request" plus one line on stderr.
 *
 * What these adapters are NOT: a security boundary. A seam-B or seam-C plugin
 * is ordinary Node code with the full privilege of this process — ADR-0004 §4
 * says so plainly rather than implying an isolation that `try`/`catch` cannot
 * provide. These adapters contain *accidents*, not *intent*.
 */

import type {
  PluginStage,
  PluginStageContext,
  PluginTool,
  PluginToolArgs,
  PluginToolContext,
} from "../interfaces/plugin.js";

/** One diagnostic line, always attributed to the plugin that caused it. */
export function pluginLog(pluginName: string, message: string): void {
  process.stderr.write(`golem plugin ${pluginName}: ${message}\n`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Run a plugin stage and return its replacement body, or `null` for "nothing
 * changed" — including every failure mode. The caller treats `null` as an
 * untouched request, so a broken plugin costs a log line and nothing else.
 */
export async function runStageQuarantined(
  pluginName: string,
  stage: PluginStage,
  context: PluginStageContext,
): Promise<Record<string, unknown> | null> {
  let result: unknown;
  try {
    result = await stage.transform(context);
  } catch (error) {
    pluginLog(pluginName, `stage "${stage.name}" threw, skipping it (${describe(error)})`);
    return null;
  }
  if (result === null || result === undefined) {
    return null;
  }
  if (!isRecord(result) || !isRecord(result.body)) {
    pluginLog(
      pluginName,
      `stage "${stage.name}" returned ${typeof result} instead of {body} or null, skipping it`,
    );
    return null;
  }
  // A stage that drops `messages` would send a malformed request upstream. The
  // stage seam exists to transform a request, not to invent one.
  if (!Array.isArray(result.body.messages)) {
    pluginLog(
      pluginName,
      `stage "${stage.name}" returned a body without a messages array, skipping it`,
    );
    return null;
  }
  return result.body;
}

/**
 * Run a plugin tool handler and return its text. A failure returns a message
 * for the model rather than propagating — an MCP server that dies because a
 * third-party tool threw would take every Golem tool down with it.
 */
export async function runToolQuarantined(
  pluginName: string,
  tool: PluginTool,
  args: PluginToolArgs,
  context: PluginToolContext,
): Promise<{ readonly text: string; readonly isError: boolean }> {
  try {
    const text = await tool.handler(args, context);
    if (typeof text !== "string") {
      pluginLog(pluginName, `tool "${tool.name}" returned ${typeof text} instead of a string`);
      return {
        text: `Plugin tool "${tool.name}" returned a non-string result; nothing to show.`,
        isError: true,
      };
    }
    return { text, isError: false };
  } catch (error) {
    const reason = describe(error);
    pluginLog(pluginName, `tool "${tool.name}" threw (${reason})`);
    return { text: `Plugin tool "${tool.name}" failed: ${reason}`, isError: true };
  }
}
