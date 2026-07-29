/**
 * `golem ui` entry point — the ONLY module src/cli/main.ts imports from here, and
 * it must stay behind a dynamic `await import()`.
 *
 * Why: ink pulls in React, a reconciler, and yoga-layout. `golem hook
 * pre-tool-use` runs on EVERY Claude Code tool call, so a static import of this
 * tree would add that load cost to every hook invocation. Nothing in
 * src/cli/main.ts may `import` this file at module scope
 * (tests/unit/tui-lazy-import.test.ts enforces it).
 */

import { type ControlSurfaceOptions, collectControlSurface, loadConfig } from "../config/index.js";

export interface RunTuiOptions {
  readonly projectDir: string;
  readonly version: string;
  /** Force the pet off for this run (`--no-pet`), whatever `ui.pet` says. */
  readonly noPet?: boolean;
  /** Start with advanced controls shown (`--advanced`), whatever `ui.advanced` says. */
  readonly advanced?: boolean;
  /** `process.argv[1]` — needed only so the Runtime tab can start the proxy daemon. */
  readonly cliPath?: string;
  readonly userDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface RunTuiResult {
  /** False when the terminal can't host a full-screen panel; the caller prints help. */
  readonly started: boolean;
  readonly reason?: string;
}

/**
 * True when a full-screen interactive panel is possible: both ends of the TTY are
 * a terminal. Checked by the caller too, so `golem | cat` and hook/CI invocations
 * never try to open it.
 */
export function canRunTui(
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

/** Load config + the control surface, mount the panel, and resolve when it exits. */
export async function runTui(options: RunTuiOptions): Promise<RunTuiResult> {
  if (!canRunTui()) {
    return {
      started: false,
      reason:
        "golem ui needs an interactive terminal (stdin and stdout must both be a TTY). " +
        "Use `golem status` and `golem config` for non-interactive use.",
    };
  }

  const shared: ControlSurfaceOptions = {
    projectDir: options.projectDir,
    version: options.version,
    ...(options.userDir !== undefined && { userDir: options.userDir }),
    ...(options.env !== undefined && { env: options.env }),
  };

  const [{ settings }, surface] = await Promise.all([
    loadConfig({
      projectDir: options.projectDir,
      ...(options.userDir !== undefined && { userDir: options.userDir }),
      ...(options.env !== undefined && { env: options.env }),
    }),
    collectControlSurface(shared),
  ]);

  // `ui.color` is applied to the environment BEFORE ink (and therefore chalk) is
  // imported — chalk decides its colour level at import time.
  const { applyColorPolicy, themeFor } = await import("./theme.js");
  applyColorPolicy(settings.ui.color);

  // ink, React, and the components load here — after the cheap work above has
  // already succeeded, so a config error reports itself as a plain message rather
  // than from inside a half-mounted alternate screen.
  const [{ render }, { App }] = await Promise.all([import("ink"), import("./app.js")]);

  const instance = render(
    <App
      surface={surface}
      theme={themeFor(settings.ui)}
      showPet={settings.ui.pet && options.noPet !== true}
      showAdvanced={options.advanced === true || settings.ui.advanced}
      options={{ ...shared, ...(options.cliPath !== undefined && { cliPath: options.cliPath }) }}
    />,
    { exitOnCtrlC: false },
  );

  await instance.waitUntilExit();
  return { started: true };
}
