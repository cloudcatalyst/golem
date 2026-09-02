/**
 * golem personas — the bench CLI (R14.1).
 *
 * `list` reports; `eject` hands a persona's prompt to the user to edit. There is
 * deliberately no `add`/`set` verb: a persona is config, and `golem config set`
 * already writes config. A second write path would be a second place for the
 * schema's rules to be enforced — or not.
 */

import type { Command } from "commander";
import { collectPersonas, ejectPersonaPrompt, renderPersonas } from "../personas.js";

function fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

export default function register(program: Command): void {
  const personasCmd = program
    .command("personas")
    .description(
      "Inspect the persona bench — who is staffed, on what, and from which config layer",
    );

  const list = async (opts: { dir: string; json: boolean }): Promise<void> => {
    try {
      const report = await collectPersonas(opts.dir);
      process.stdout.write(
        opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderPersonas(report),
      );
    } catch (err) {
      fail(err);
    }
  };

  personasCmd
    .command("list", { isDefault: true })
    .description("List every declared persona: discipline, model, owner, prompt source, and layer")
    .option("--dir <path>", "project directory", process.cwd())
    .option("--json", "machine-readable output", false)
    .action(list);

  personasCmd
    .command("eject")
    .description(
      "Write a persona's current prompt to .golem/personas/<id>.md so you can edit it " +
        "(never overwrites an existing file)",
    )
    .argument("<id>", "a persona id from `golem personas`")
    .option("--dir <path>", "project directory", process.cwd())
    .action(async (id: string, opts: { dir: string }) => {
      try {
        const result = await ejectPersonaPrompt(opts.dir, id);
        if (result.created) {
          process.stdout.write(
            `wrote ${result.path}\n` +
              `  (from the ${result.source} prompt — it is yours now; edit it freely)\n`,
          );
        } else {
          process.stdout.write(
            `${result.path} already exists — left untouched.\n` +
              "  Delete it first if you want the default back.\n",
          );
        }
      } catch (err) {
        fail(err);
      }
    });
}
