/**
 * `src/plugins/init.ts` — the one place a process turns settings into loaded
 * plugins (R8.11 / ADR-0005).
 *
 * Two entry points need this (the proxy daemon and `golem mcp serve`), and both
 * must do it identically: load, register the redaction rules into the
 * append-only table, and **say out loud what just got loaded**. That last part
 * is not decoration — a plugin has the full authority of the process, so the one
 * thing Golem owes the user is that it never happens quietly.
 */

import { registerExtraRedactionRules } from "../pipeline/redaction-rules.js";
import { proxyLog } from "../shared/proxy-log.js";
import { loadPlugins } from "./loader.js";
import type { LoadedPlugins } from "./types.js";

export interface InitPluginsOptions {
  readonly specifiers: readonly string[];
  readonly enabled: boolean;
  readonly projectDir: string;
  readonly golemVersion: string;
  /** Where to announce what loaded. Defaults to the proxy log. */
  readonly log?: (message: string) => void;
}

/**
 * Load the configured plugins and install their redaction rules.
 *
 * Never throws: a broken plugin is a logged problem and a no-op. Returns the
 * whole outcome so the caller can wire `stages` into the pipeline and `mcpTools`
 * into the MCP server.
 *
 * Called **once per process, before serving**. Redaction has to be a pure
 * function of its input for prompt-cache prefix stability (verification-notes
 * §14), and the rule table enforces that by refusing a second registration.
 */
export async function initPlugins(opts: InitPluginsOptions): Promise<LoadedPlugins> {
  const log = opts.log ?? proxyLog;
  const loaded = await loadPlugins({
    specifiers: opts.specifiers,
    enabled: opts.enabled,
    projectDir: opts.projectDir,
    golemVersion: opts.golemVersion,
  });

  if (!loaded.attempted && opts.specifiers.length > 0) {
    log(
      `plugins.enabled is false — ${opts.specifiers.length} configured plugin(s) were NOT loaded`,
    );
    return loaded;
  }
  if (loaded.plugins.length === 0 && loaded.problems.length === 0) return loaded;

  for (const plugin of loaded.plugins) {
    const seams = [
      `${plugin.seams["redaction-rule"]} redaction rule(s)`,
      `${plugin.seams["pipeline-stage"]} stage(s)`,
      `${plugin.seams["mcp-tool"]} MCP tool(s)`,
    ].join(", ");
    // Name the resolved path, not just the specifier: "which copy of this is
    // running inside my process" is the question that matters here.
    log(`plugin loaded: ${plugin.name} from ${plugin.resolved} — ${seams}`);
  }
  for (const problem of loaded.problems) {
    log(`plugin problem (skipped, no-op): ${problem.subject}: ${problem.reason}`);
  }

  if (loaded.redactionRules.length > 0) {
    const outcome = registerExtraRedactionRules(loaded.redactionRules);
    if (outcome.refused !== null) {
      log(`plugin redaction rules were NOT installed: ${outcome.refused}`);
    } else {
      log(
        `${outcome.accepted} plugin redaction rule(s) appended after the built-in table ` +
          "(built-ins always run first; a plugin can add a rule, never remove or reorder one)",
      );
    }
  }
  if (loaded.plugins.length > 0) {
    log(
      "note: plugins run inside this process, so inside the redaction path, and are NOT " +
        "sandboxed (ADR-0005). `golem plugin` lists what loaded.",
    );
  }
  return loaded;
}
