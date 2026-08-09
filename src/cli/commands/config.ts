/**
 * golem config — extracted from program.ts (R8.27).
 */

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { collectControlSurface } from "../../config/control-surface.js";
import { findProjectDir } from "../../config/index.js";
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
    .description("Show the effective value of one setting (e.g. slider.level)")
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
    .description("Write a setting to a scope (project, local, or user)")
    .argument("<key>", "dotted section.key")
    .argument(
      "[value]",
      "new value (booleans: true/false/1/0/yes/no/on/off; arrays: JSON or comma-separated; " +
        "objects: JSON). Omit it and pass --value-file instead when your shell mangles quotes.",
    )
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option(
      "--scope <scope>",
      "settings scope: project (default, committed), local (gitignored), user (~/.golem)",
      "project",
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
    .option("--scope <scope>", "settings scope: project (default), local, or user", "project")
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
    .command("schema")
    .description("Print every control (settings, guidance, runtime) with labels, kinds, and values")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        const surface = await collectControlSurface({
          projectDir: opts.dir,
          version: VERSION,
          withHeader: true,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(surface, null, 2)}\n`);
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
