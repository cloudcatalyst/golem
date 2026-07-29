/**
 * Control-panel entry point: load the control surface, draw frames, feed keys to the
 * reducer, run the effects it asks for.
 *
 * This dispatch loop is the whole "framework" now that ink is gone — about 40 lines
 * over the pure reducer in state.ts. What ink contributed (flexbox layout, a diffing
 * renderer, key decoding, colour degradation) now lives in render.ts, screen.ts,
 * keys.ts, and ansi.ts, and cost ~890ms to import; the panel reaches its first frame
 * in ~150ms total (verification-notes §86c).
 *
 * **Nothing heavy is imported at module scope.** src/cli/main.ts dynamically imports
 * this module in order to decide whether to open the panel at all, so a static import
 * of the control surface (~140ms) would be paid even when it turns out not to be
 * wanted. `tests/unit/tui-lazy-import.test.ts` enforces that.
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
}

export interface RunTuiResult {
  /** False when the terminal can't host a full-screen panel; the caller prints help. */
  readonly started: boolean;
  readonly reason?: string;
}

/**
 * True when a full-screen interactive panel is possible: both ends of the TTY are a
 * terminal. The caller checks too, so `golem | cat` and hook/CI invocations never try
 * to open it.
 */
export function canRunTui(
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

/** Load, draw, and run until the user quits. */
export async function runTui(options: RunTuiOptions): Promise<RunTuiResult> {
  if (!canRunTui()) {
    return {
      started: false,
      reason:
        "the control panel needs an interactive terminal (stdin and stdout must both be a TTY). " +
        "Use `golem status` and `golem config` for non-interactive use.",
    };
  }

  const shared = {
    projectDir: options.projectDir,
    version: options.version,
    ...(options.userDir !== undefined && { userDir: options.userDir }),
    ...(options.env !== undefined && { env: options.env }),
  };

  const [
    { applyControl, collectControlSurface, collectHeader },
    { loadConfig },
    { initialState, reducePanel },
    { renderPanel },
    { clearScreen, createScreen },
    { readKeys },
    { themeFor },
  ] = await Promise.all([
    import("../config/control-surface.js"),
    import("../config/index.js"),
    import("./state.js"),
    import("./render.js"),
    import("./screen.js"),
    import("./keys.js"),
    import("./theme.js"),
  ]);

  const [{ settings }, surface] = await Promise.all([
    loadConfig({
      projectDir: options.projectDir,
      ...(options.userDir !== undefined && { userDir: options.userDir }),
      ...(options.env !== undefined && { env: options.env }),
    }),
    // Short probe: the panel repaints on its own reload, so a stopped proxy must not
    // hold up the first frame.
    collectControlSurface({ ...shared, probeTimeoutMs: 400 }),
  ]);

  const theme = themeFor(settings.ui);
  const showPet = settings.ui.pet && options.noPet !== true;
  const applyOptions = {
    ...shared,
    ...(options.cliPath !== undefined && { cliPath: options.cliPath }),
  };

  let state = initialState(surface, {
    showAdvanced: options.advanced === true || settings.ui.advanced,
    version: options.version,
    projectDir: options.projectDir,
  });

  const screen = createScreen({ onResize: () => paint() });
  const keys = readKeys((key) => dispatch({ kind: "key", key }));
  clearScreen();

  let done: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  function paint(): void {
    screen.paint(
      renderPanel(state, { theme, showPet, width: screen.columns, height: screen.rows }),
    );
  }

  /**
   * One reduction: update the state, repaint, then start whatever effects the reducer
   * asked for. Safe to run effects inline — every caller is an event callback (a
   * keypress, the file watcher, an async completion), never a render.
   */
  function dispatch(event: Parameters<typeof reducePanel>[1]): void {
    const step = reducePanel(state, event);
    state = step.state;
    paint();
    for (const effect of step.effects) void run(effect);
    if (state.exiting) done?.();
  }

  async function reload(): Promise<void> {
    try {
      dispatch({
        kind: "surface",
        surface: await collectControlSurface({ ...shared, probeTimeoutMs: 400 }),
      });
    } catch (err) {
      dispatch({ kind: "failed", controlId: "", message: messageOf(err) });
    }
  }

  async function run(effect: Effect): Promise<void> {
    if (effect.kind === "exit") {
      done?.();
      return;
    }
    if (effect.kind === "reload") {
      await reload();
      return;
    }
    try {
      const result = await applyControl(effect.controlId, effect.value, effect.scope, applyOptions);
      const hint = result.restartHint !== undefined ? ` — ${result.restartHint}` : "";
      const clash = result.overridden !== undefined ? ` (${result.overridden})` : "";
      dispatch({
        kind: "applied",
        controlId: effect.controlId,
        message: `${result.message}${clash}${hint}`,
      });
    } catch (err) {
      dispatch({ kind: "failed", controlId: effect.controlId, message: messageOf(err) });
    }
    // Re-read either way: a failed write may still have changed something, and a
    // stale row is worse than a redundant reload.
    await reload();
  }

  paint();

  // The header is fetched AFTER the first frame, on purpose: it needs cli/status.js
  // (~400ms of module load) plus a proxy and an Ollama probe. The panel is already
  // usable; the values slot into a same-height placeholder a moment later.
  void collectHeader({ ...shared, probeTimeoutMs: 1_000 })
    .then((header) => dispatch({ kind: "header", header }))
    .catch(() => {
      // A header we can't build is not worth breaking the panel over.
    });

  // Watch the settings files so an external `golem config set` shows up live.
  // Debounced: editors often write a file two or three times.
  const [{ watch }, nodePath] = await Promise.all([import("node:fs"), import("node:path")]);
  let timer: NodeJS.Timeout | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(
      nodePath.join(nodePath.resolve(options.projectDir), ".golem"),
      (_event, filename) => {
        if (filename !== null && !String(filename).startsWith("settings")) return;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => void reload(), 150);
      },
    );
  } catch {
    // No `.golem/` yet (an uninitialized project) — nothing to watch.
  }

  try {
    await finished;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    watcher?.close();
    keys.stop();
    screen.close();
  }
  return { started: true };
}

/** Mirrors PanelEffect; declared locally so this module imports state.ts only lazily. */
type Effect =
  | {
      readonly kind: "apply";
      readonly controlId: string;
      readonly value: unknown;
      readonly scope: string;
    }
  | { readonly kind: "reload" }
  | { readonly kind: "exit" };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
