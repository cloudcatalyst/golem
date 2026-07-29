#!/usr/bin/env node

/**
 * The `golem` binary entry point — deliberately tiny, and deliberately importing
 * NOTHING at module scope.
 *
 * Why this file exists at all: the CLI's own module graph (`./program.js` —
 * commander plus every command's dependencies, including the MCP SDK) costs
 * **~810ms** to load, and it used to be paid by every invocation before anything
 * else could happen (verification-notes §86).
 *
 * ESM imports are hoisted and evaluated before any statement runs, so the routing
 * decision cannot live in a module that statically imports either branch. Hence a
 * shim: it looks at argv, then dynamically imports exactly ONE of
 *
 *   - `../tui/index.js`  — the control panel. `golem` on its own IS the panel
 *                          (Decision 51); it needs neither commander nor any other
 *                          command's dependencies, and opens in ~170ms;
 *   - `./fast-path.js`   — the commands Claude Code invokes constantly (`hook
 *                          <event>` on every tool call, `statusline` on every
 *                          prompt), handled without commander at all; or
 *   - `./program.js`     — every named command, unchanged.
 *
 * Keep this file dependency-free. Anything imported here is imported by every
 * `golem` process on the machine, including `golem hook pre-tool-use`, which Claude
 * Code runs on every single tool call.
 *
 * `bin` in package.json still points here (`dist/cli/main.js`), so installed shims
 * and `detectInstallMethod`'s argv[1] matching are unaffected.
 */

import type { PanelArgs } from "./panel-args.js";

async function openPanel(panel: PanelArgs): Promise<void> {
  const [{ runTui }, { VERSION }, { findProjectDir }] = await Promise.all([
    import("../tui/index.js"),
    import("../version.js"),
    import("../config/paths.js"),
  ]);
  const result = await runTui({
    projectDir: panel.dir ?? findProjectDir(process.cwd()) ?? process.cwd(),
    version: VERSION,
    ...(panel.pet === false && { noPet: true }),
    ...(panel.advanced && { advanced: true }),
    ...(process.argv[1] !== undefined && { cliPath: process.argv[1] }),
  });
  if (!result.started) {
    process.stderr.write(`golem: ${result.reason ?? "could not start the panel"}\n`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const argv = process.argv;

  // Tiny, no-dependency module — see panel-args.ts for why it isn't inlined here.
  const { parsePanelArgs, REMOVED_PANEL_COMMANDS } = await import("./panel-args.js");

  if (REMOVED_PANEL_COMMANDS.includes(argv[2] ?? "")) {
    process.stderr.write(
      `golem: \`golem ${argv[2]}\` was removed — run \`golem\` on its own to open the panel ` +
        "(flags: --dir <path>, --no-pet, --advanced)\n",
    );
    process.exitCode = 2;
    return;
  }

  const panel = parsePanelArgs(argv);
  if (panel !== null) {
    if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
      await openPanel(panel);
      return;
    }
    // Panel flags outside a terminal are a clear statement of intent, so say why it
    // can't run. A BARE `golem` outside a terminal keeps its old behaviour of
    // printing help — that's what `golem | cat`, CI, and a stray hook invocation get.
    if (argv.length > 2) {
      process.stderr.write(
        "golem: the control panel needs an interactive terminal (stdin and stdout must " +
          "both be a TTY). Use `golem status` and `golem config` for non-interactive use.\n",
      );
      process.exitCode = 1;
      return;
    }
  }

  // The commands Claude Code invokes constantly (hook events on every tool call,
  // statusline on every prompt) skip commander entirely. `fastPathFor` returns null
  // for anything it doesn't handle exactly, so the CLI stays authoritative.
  const { fastPathFor, runFastPath } = await import("./fast-path.js");
  const fast = fastPathFor(argv);
  if (fast !== null) {
    await runFastPath(fast, argv);
    return;
  }

  const { runCli } = await import("./program.js");
  await runCli(argv);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
