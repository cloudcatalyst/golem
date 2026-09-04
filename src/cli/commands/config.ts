/**
 * golem config — extracted from program.ts (R8.27).
 */

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { ControlSurface } from "../../config/control-surface.js";
import { collectControlSurface } from "../../config/control-surface.js";
import { findProjectDir, renderSweep, sweepSettingsFiles } from "../../config/index.js";
import type { SettingsScope } from "../../config/write-setting.js";
import { VERSION } from "../../index.js";
import {
  getConfig,
  listConfig,
  renderConfigGet,
  renderConfigList,
  renderConfigSet,
  renderConfigUnset,
  resolveSetValue,
  setConfig,
  unsetConfig,
} from "../config.js";
import { InitError } from "../init.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

/**
 * What `config schema --json` prints.
 *
 * With the header, it is the control surface `golem status` and the panel read.
 * Without it, it is the PUBLISHED artifact: `config-schema.json`, attached to
 * every release and fetched by the portal to validate team settings before a
 * developer's machine ever sees them. That artifact must describe the schema and
 * nothing about the machine that built it, so both machine-shaped fields are
 * dropped together — `header` (absolute paths, proxy port, upstream account) and
 * `warnings` (complaints about the local settings files). `version` is carried
 * explicitly because the portal caches these by version.
 *
 * Exported so the boundary is testable without spawning the CLI.
 */
export function schemaPayload(
  surface: ControlSurface,
  withHeader: boolean,
): ControlSurface | { version: string; groups: ControlSurface["groups"] } {
  return withHeader ? surface : { version: VERSION, groups: surface.groups };
}

function parseConfigScope(raw: string): SettingsScope {
  if (raw === "user" || raw === "project" || raw === "local") return raw;
  throw new InvalidArgumentError(`invalid scope "${raw}" (expected user, project, or local)`);
}

export default function register(program: Command): void {
  const configCmd = program
    .command("config")
    .description("Read and write Golem settings with schema validation");

  configCmd
    .command("list", { isDefault: true })
    .description("List all effective settings and the layers that supplied them")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        const report = await listConfig({ projectDir: opts.dir });
        process.stdout.write(
          opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderConfigList(report),
        );
      } catch (err) {
        _fail(err);
      }
    });

  configCmd
    .command("get")
    .description("Show the effective value of one setting (e.g. compression.level)")
    .argument("<key>", "dotted section.key")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (key: string, opts: { dir: string; json: boolean }) => {
      try {
        const report = await getConfig(key, { projectDir: opts.dir });
        process.stdout.write(
          opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderConfigGet(report),
        );
      } catch (err) {
        _fail(err);
      }
    });

  configCmd
    .command("set")
    // Local is the default scope: a setting written here is one person's choice
    // on one machine (a port, a local model, a dial) far more often than it is a
    // team decision, and `.golem/settings.local.json` is gitignored — so the
    // default cannot commit a personal preference into everyone's checkout.
    // `--scope project` is the deliberate act of making it a team setting.
    .description("Write a setting to a scope (local, project, or user)")
    .argument("<key>", "dotted section.key")
    .argument(
      "[value]",
      "new value (booleans: true/false/1/0/yes/no/on/off; arrays: JSON or comma-separated; " +
        "objects: JSON). Omit it and pass --value-file instead when your shell mangles quotes.",
    )
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option(
      "--scope <scope>",
      "settings scope: local (default, gitignored), project (committed), user (~/.golem)",
      "local",
    )
    .option(
      "--value-file <path>",
      'read the value from a file, or from stdin when <path> is "-" ' +
        "(the quoting-proof way to write a JSON object)",
    )
    .option("--json", "machine-readable output", false)
    .action(
      async (
        key: string,
        value: string | undefined,
        opts: { dir: string; scope: string; json: boolean; valueFile?: string },
      ) => {
        try {
          const scope = parseConfigScope(opts.scope);
          const raw = await resolveSetValue(value, opts.valueFile);
          const result = await setConfig(scope, key, raw, { projectDir: opts.dir });
          process.stdout.write(
            opts.json ? `${JSON.stringify(result, null, 2)}\n` : renderConfigSet(result),
          );
        } catch (err) {
          _fail(err);
        }
      },
    );

  configCmd
    .command("unset")
    .description("Remove a setting from a scope so lower layers take effect again")
    .argument("<key>", "dotted section.key")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--scope <scope>", "settings scope: local (default), project, or user", "local")
    .option("--json", "machine-readable output", false)
    .action(async (key: string, opts: { dir: string; scope: string; json: boolean }) => {
      try {
        const scope = parseConfigScope(opts.scope);
        const result = await unsetConfig(scope, key, { projectDir: opts.dir });
        process.stdout.write(
          opts.json ? `${JSON.stringify(result, null, 2)}\n` : renderConfigUnset(result),
        );
      } catch (err) {
        _fail(err);
      }
    });

  configCmd
    .command("migrate")
    .description(
      "Rewrite retired setting names to their current ones in every scope " +
        "(runs automatically on the first run after an upgrade)",
    )
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--write", "apply the changes; without it, nothing is written", false)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; write: boolean; json: boolean }) => {
      try {
        const sweep = await sweepSettingsFiles({
          projectDir: opts.dir,
          write: opts.write,
          version: VERSION,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(sweep, null, 2)}\n`);
          return;
        }
        const lines = renderSweep(sweep, opts.write);
        process.stdout.write(
          lines.length === 0
            ? "Every settings file uses current setting names.\n"
            : `${lines.join("\n")}\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });

  configCmd
    .command("schema")
    .description("Print every control (settings, guidance, runtime) with labels, kinds, and values")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    // The header describes THIS machine — absolute paths, the proxy port, the
    // upstream account, when a model was last served. Fine for `golem status`,
    // wrong for an artifact that leaves the machine: `config-schema.json` is
    // attached to every release and fetched by the portal to validate team
    // settings, so it must describe the SCHEMA and nothing about who built it.
    // `warnings` goes with it — those are complaints about the local settings
    // files, not properties of the schema.
    .option("--no-header", "omit the machine-specific header and warnings (portable output)")
    .action(async (opts: { dir: string; json: boolean; header: boolean }) => {
      try {
        const surface = await collectControlSurface({
          projectDir: opts.dir,
          version: VERSION,
          withHeader: opts.header,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(schemaPayload(surface, opts.header), null, 2)}\n`);
          return;
        }
        for (const group of surface.groups) {
          process.stdout.write(`${group.title}\n`);
          for (const control of group.controls) {
            const lock = control.locked !== undefined ? " (locked)" : "";
            process.stdout.write(
              `  ${control.id.padEnd(44)} ${control.kind.padEnd(7)} ${JSON.stringify(control.value)} — ${control.layer}${lock}\n`,
            );
          }
        }
      } catch (err) {
        _fail(err);
      }
    });
}
