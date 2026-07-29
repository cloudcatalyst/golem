/**
 * Argv parsing for the control panel: `golem` on its own IS the panel, and these are
 * the flags it accepts (Decision 51 removed `golem ui` / `golem settings` and moved
 * their flags here).
 *
 * Split out of main.ts for two reasons: main.ts self-executes on import (it is the
 * `bin` entry), so a test importing it would run the CLI; and main.ts must stay free
 * of static imports, so it reaches this module through `await import()` — which is
 * ~0ms, since the only thing here is string handling.
 */

/** Panel flags that take no value. */
const PANEL_FLAGS: readonly string[] = ["--no-pet", "--advanced"];
/** Panel flags that take a value, as `--dir <path>` or `--dir=<path>`. */
const PANEL_VALUE_FLAGS: readonly string[] = ["--dir"];

/** What a panel invocation asked for. */
export interface PanelArgs {
  /** Project directory; undefined means "detect from cwd". */
  readonly dir?: string;
  /** False when `--no-pet` was passed. */
  readonly pet: boolean;
  /** True when `--advanced` was passed. */
  readonly advanced: boolean;
}

/**
 * Parse argv as a panel invocation, or return null if it is anything else.
 *
 * `golem` on its own opens the panel, and so does `golem` with only panel flags
 * (`--dir <path>`, `--no-pet`, `--advanced`).
 *
 * Anything else returns null and goes to commander: every named command, `--help`,
 * `--version`, and **any unrecognised flag**. That last case is the important one —
 * it keeps commander authoritative for error messages, so a mistyped flag is
 * reported by the code that owns flag parsing instead of silently opening a panel.
 *
 * Deliberately NOT a commander root `.action()`: an action handler on the root makes
 * commander report a typo'd subcommand as "too many arguments" rather than "unknown
 * command".
 */
export function parsePanelArgs(argv: readonly string[] = process.argv): PanelArgs | null {
  const args = argv.slice(2);
  let dir: string | undefined;
  let pet = true;
  let advanced = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (PANEL_FLAGS.includes(arg)) {
      if (arg === "--no-pet") pet = false;
      else advanced = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (PANEL_VALUE_FLAGS.includes(name)) {
      const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
      // A value flag with nothing usable after it is a usage error, not a panel
      // launch — let commander say so.
      if (value === undefined || value === "" || value.startsWith("-")) return null;
      dir = value;
      continue;
    }
    return null;
  }

  return { ...(dir !== undefined && { dir }), pet, advanced };
}

/**
 * `golem ui` / `golem settings` were removed (Decision 51). Recognised for one
 * release so the error explains the move instead of just "unknown command".
 */
export const REMOVED_PANEL_COMMANDS: readonly string[] = ["ui", "settings"];
