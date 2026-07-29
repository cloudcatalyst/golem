/**
 * `golem ui` entry point — and the place where startup latency is won or lost.
 *
 * Two hard rules, both measured (verification-notes §86):
 *
 * 1. **Nothing heavy is imported at module scope.** ink costs ~880ms to load on
 *    top of node's own boot, and `../config/control-surface.js` (which reaches into
 *    src/cli and src/hooks) ~400ms. src/cli/main.ts dynamically imports THIS
 *    module, so a static import here would pay both before the process could even
 *    decide what to do.
 * 2. **Load the modules and the data CONCURRENTLY, and paint before either
 *    finishes.** The first version awaited the config, then awaited ink, then
 *    rendered — so the user waited for the sum. Now a plain-ANSI skeleton (the pet,
 *    from a constant) is on screen within a few ms, ink and the control surface
 *    load side by side, and the panel replaces the skeleton when ink is ready.
 */

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
  /** Skip the instant pre-paint (tests, and anything parsing our stdout). */
  readonly noSplash?: boolean;
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

/**
 * Control Sequence Introducer, built rather than written literally: a raw ESC byte
 * in source is invisible in diffs and is easily mangled by tooling.
 */
const CSI = `${String.fromCharCode(27)}[`;

/** The pet, duplicated from theme.ts so the splash needs no import at all. */
const SPLASH_PET: readonly string[] = ["■▜▛▜▆▛▜▙", "▝▜██▀███", "▚▟█▛▚█▛▘"];

/**
 * The pre-paint: the pet plus a title, as plain ANSI, before ink exists.
 *
 * Everything here is free — the glyphs are a constant, the version is compiled in,
 * the directory is an argument — so it lands in single-digit milliseconds and the
 * terminal stops looking hung. Exported for the test that asserts the line count
 * matches the pet's height (the erase depends on that).
 *
 * Colour is emitted as plain SGR (256-colour violet), not via chalk: importing
 * chalk here would mean importing a chunk of exactly what we are deferring.
 */
export function splashLines(
  version: string,
  projectDir: string,
  showPet: boolean,
  colour: boolean,
): readonly string[] {
  const violet = `${CSI}38;5;141m`;
  const dim = `${CSI}2m`;
  const reset = `${CSI}0m`;
  const paint = (text: string, sgr: string) => (colour ? `${sgr}${text}${reset}` : text);
  const info = [`Golem ${version}`, projectDir, "opening…"];
  const lines: string[] = [];
  for (let i = 0; i < SPLASH_PET.length; i += 1) {
    const pet = showPet ? `${paint(SPLASH_PET[i] ?? "", violet)}   ` : "";
    lines.push(` ${pet}${paint(info[i] ?? "", dim)}`);
  }
  return lines;
}

function paintSplash(version: string, projectDir: string, showPet: boolean): number {
  const colour = process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== "0";
  const lines = splashLines(version, projectDir, showPet, colour);
  process.stdout.write(`${lines.join("\n")}\n`);
  return lines.length;
}

/** Take the splash back, so ink starts from a clean cursor position. */
function eraseSplash(count: number): void {
  if (count > 0) process.stdout.write(`${CSI}${count}A${CSI}0J`);
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

  // Instant feedback. `ui.pet` isn't known yet — that needs the config we haven't
  // read — so the splash honours `--no-pet` and the *setting* takes effect from the
  // first real frame. Blocking the splash on a file read would defeat its purpose.
  const painted =
    options.noSplash === true
      ? 0
      : paintSplash(options.version, options.projectDir, options.noPet !== true);

  const shared = {
    projectDir: options.projectDir,
    version: options.version,
    ...(options.userDir !== undefined && { userDir: options.userDir }),
    ...(options.env !== undefined && { env: options.env }),
  };

  // Everything starts at once: the module trees (ink, the panel components, the
  // control surface) and the config read. Wall-clock becomes the slowest single
  // item instead of the sum of all of them.
  const inkPromise = import("ink");
  const appPromise = import("./app.js");
  const surfacePromise = import("../config/control-surface.js");
  const configPromise = import("../config/index.js").then((m) =>
    m.loadConfig({
      projectDir: options.projectDir,
      ...(options.userDir !== undefined && { userDir: options.userDir }),
      ...(options.env !== undefined && { env: options.env }),
    }),
  );

  // theme.js is tiny and pulls in no ink, so awaiting it first costs nothing and
  // lets `ui.color` reach the environment before ink is evaluated — chalk fixes its
  // colour level at import time.
  const [{ applyColorPolicy, themeFor }, { settings }] = await Promise.all([
    import("./theme.js"),
    configPromise,
  ]);
  applyColorPolicy(settings.ui.color);

  const [{ render }, { App }, { collectControlSurface }] = await Promise.all([
    inkPromise,
    appPromise,
    surfacePromise,
  ]);

  const surface = await collectControlSurface({
    ...shared,
    // The panel repaints on its own reload, so first paint uses a short proxy probe
    // instead of the 1.5s default: a stopped proxy must not hold the UI hostage.
    probeTimeoutMs: 400,
  });

  eraseSplash(painted);

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
