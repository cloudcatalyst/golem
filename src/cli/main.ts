#!/usr/bin/env node
/**
 * Entry point for the `eol` command.
 *
 * Scaffold stub only — WS-E (agent-ux, tasks E2/E3) replaces the placeholder
 * commands. The commander program and the `"eol": "./dist/cli/main.js"` bin
 * entry in package.json are fixed; add subcommands rather than renaming.
 */

import { Command } from "commander";
import { VERSION } from "../index.js";

const program = new Command();

program.name("eol").description("EOL — Edge Offload Layer for Claude").version(VERSION);

program
  .command("status")
  .description("Show EOL service status (stub — implemented in WS-E task E3)")
  .action(() => {
    process.stdout.write("eol: scaffold only — service not yet implemented (WS-E)\n");
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
