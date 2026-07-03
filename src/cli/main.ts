#!/usr/bin/env node
/**
 * Entry point for the `golem` command.
 *
 * Scaffold stub only — WS-E (agent-ux, tasks E2/E3) replaces the placeholder
 * commands. The commander program and the `"golem": "./dist/cli/main.js"` bin
 * entry in package.json are fixed; add subcommands rather than renaming.
 */

import { Command } from "commander";
import { VERSION } from "../index.js";

const program = new Command();

program.name("golem").description("Golem — edge offload for Claude (golem.run)").version(VERSION);

program
  .command("status")
  .description("Show Golem service status (stub — implemented in WS-E task E3)")
  .action(() => {
    process.stdout.write("golem: scaffold only — service not yet implemented (WS-E)\n");
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
