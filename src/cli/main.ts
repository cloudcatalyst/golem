#!/usr/bin/env node

/**
 * The `golem` binary entry point — deliberately tiny, and deliberately importing
 * NOTHING at module scope.
 *
 * Why this file exists at all: the CLI's own module graph (`./program.js` —
 * commander plus every command's dependencies, including the MCP SDK) costs
 * **~750ms** to load, and it used to be paid by every invocation before anything
 * else could happen. Bare `golem` then paid ink on top of that, so the panel took
 * multiple seconds to appear (measured in verification-notes §86).
 *
 * ESM imports are hoisted and evaluated before any statement runs, so the routing
 * decision cannot live in a module that statically imports either branch. Hence a
 * shim: it looks at argv, then dynamically imports exactly ONE of
 *
 *   - `../tui/index.js`  — bare, interactive `golem`: the control panel, which
 *                          never needs commander or any other command's deps;
 *   - `./fast-path.js`   — the two commands Claude Code invokes constantly
 *                          (`hook <event>` on every tool call, `statusline` on
 *                          every prompt), handled without commander at all; or
 *   - `./program.js`     — everything else, unchanged.
 *
 * Keep this file dependency-free. Anything imported here is imported by every
 * `golem` process on the machine, including `golem hook pre-tool-use`, which
 * Claude Code runs on every single tool call.
 *
 * `bin` in package.json still points here (`dist/cli/main.js`), so installed shims
 * and `detectInstallMethod`'s argv[1] matching are unaffected.
 */

/**
 * Should a bare `golem` open the panel instead of printing help?
 *
 * Only for `golem` with NO arguments at all, in a terminal. `--help`, `--version`,
 * every subcommand, a pipe (`golem | cat`), CI, hook invocations, and the detached
 * proxy daemon all fall through to the normal CLI.
 *
 * Note this is NOT a commander root `.action()`: an action handler on the root
 * makes commander report a typo'd subcommand as "too many arguments" instead of
 * "unknown command".
 */
export function shouldOpenPanel(
  argv: readonly string[] = process.argv,
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  return argv.length <= 2 && stdin.isTTY === true && stdout.isTTY === true;
}

async function main(): Promise<void> {
  if (shouldOpenPanel()) {
    // The panel path: ink + the control surface, and nothing from ./program.js.
    const [{ runTui }, { VERSION }] = await Promise.all([
      import("../tui/index.js"),
      import("../version.js"),
    ]);
    const { findProjectDir } = await import("../config/paths.js");
    const result = await runTui({
      projectDir: findProjectDir(process.cwd()) ?? process.cwd(),
      version: VERSION,
      ...(process.argv[1] !== undefined && { cliPath: process.argv[1] }),
    });
    if (!result.started) {
      process.stderr.write(`golem: ${result.reason ?? "could not start the panel"}\n`);
      process.exitCode = 1;
    }
    return;
  }

  // The commands Claude Code invokes constantly (hook events on every tool call,
  // statusline on every prompt) skip commander entirely. `fastPathFor` returns null
  // for anything it doesn't handle exactly, so the CLI stays authoritative.
  const { fastPathFor, runFastPath } = await import("./fast-path.js");
  const fast = fastPathFor(process.argv);
  if (fast !== null) {
    await runFastPath(fast, process.argv);
    return;
  }

  const { runCli } = await import("./program.js");
  await runCli(process.argv);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
