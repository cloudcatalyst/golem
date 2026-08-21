/**
 * `golem plugin` — the in-process plugin surface (R8.11 / ADR-0005).
 *
 * Read-only on purpose, and separate from `golem pkg` on purpose: a pkg runs
 * beside Golem in its own process (a real boundary, so its installs can be
 * consent-gated), while a plugin runs inside it (no boundary at all). Merging
 * the two surfaces would blur exactly the distinction the user needs.
 */

import type { Command } from "commander";
import { findProjectDir } from "../../config/index.js";
import { VERSION } from "../../version.js";
import { InitError } from "../init.js";
import { collectPlugins, renderPlugins } from "../plugin.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

export default function register(program: Command): void {
  const pluginCmd = program
    .command("plugin")
    .description(
      "Third-party code running INSIDE Golem — redaction rules, pipeline stages, MCP tools (ADR-0005)",
    );

  pluginCmd
    .command("list", { isDefault: true })
    .alias("status")
    .description("Show which plugins load, from where, and what each one registers")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .option("--verbose", "also list every rule, stage and tool contributed", false)
    .action(async (opts: { dir: string; json: boolean; verbose: boolean }) => {
      try {
        const report = await collectPlugins(opts.dir, VERSION);
        if (opts.json) {
          // Functions do not serialize, so the JSON view carries the facts a
          // machine can act on rather than a lossy half-render of the handlers.
          process.stdout.write(
            `${JSON.stringify(
              {
                projectDir: report.projectDir,
                enabled: report.enabled,
                configured: report.configured,
                plugins: report.loaded.plugins,
                problems: report.loaded.problems,
                redactionRuleIds: report.loaded.redactionRules.map((r) => r.id),
                stageNames: report.loaded.stages.map((s) => s.name),
                mcpToolNames: report.loaded.mcpTools.map((t) => t.name),
              },
              null,
              2,
            )}\n`,
          );
          return;
        }
        process.stdout.write(renderPlugins(report, opts.verbose));
      } catch (err) {
        _fail(err);
      }
    });
}
