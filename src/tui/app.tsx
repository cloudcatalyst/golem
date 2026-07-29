/**
 * The panel root: wires keypresses into the pure reducer (state.ts), performs the
 * effects it asks for, and re-collects the control surface after each write.
 *
 * All decision-making lives in the reducer; this component only does I/O —
 * `applyControl`, `collectControlSurface`, and a watcher on the settings files so
 * an external `golem config set` (or another editor) shows up live.
 */

import { watch } from "node:fs";
import path from "node:path";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  applyControl,
  CONTROL_TABS,
  type ControlSurface,
  type ControlSurfaceOptions,
  collectControlSurface,
  collectHeader,
} from "../config/control-surface.js";
import { ControlList } from "./controls.js";
import { Header } from "./header.js";
import {
  hiddenAdvancedCount,
  initialState,
  type PanelEffect,
  type PanelEvent,
  type PanelState,
  reducePanel,
  selectedControl,
} from "./state.js";
import { RULE_CHAR, type Theme } from "./theme.js";

export interface AppProps {
  readonly surface: ControlSurface;
  readonly theme: Theme;
  readonly showPet: boolean;
  readonly showAdvanced: boolean;
  /** Everything collect/apply need; `cliPath` lets the Runtime tab start the proxy. */
  readonly options: ControlSurfaceOptions & { readonly cliPath?: string };
}

export function App({
  surface,
  theme,
  showPet,
  showAdvanced,
  options,
}: AppProps): React.JSX.Element {
  const [state, dispatch] = useReducer(step, undefined, () =>
    initialState(surface, { showAdvanced }),
  );
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 100;
  const rows = stdout?.rows ?? 30;

  // Effects are collected by the reducer and drained here. A ref keeps the
  // latest state available to async callbacks without re-creating them.
  const latest = useRef(state);
  latest.current = state;

  const reload = useCallback(async () => {
    try {
      const next = await collectControlSurface(options);
      dispatch({ kind: "surface", surface: next });
    } catch (err) {
      dispatch({ kind: "failed", controlId: "", message: messageOf(err) });
    }
  }, [options]);

  const run = useCallback(
    async (effect: PanelEffect) => {
      switch (effect.kind) {
        case "exit":
          exit();
          return;
        case "reload":
          await reload();
          return;
        case "apply":
          try {
            const result = await applyControl(
              effect.controlId,
              effect.value,
              effect.scope,
              options,
            );
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
          // Re-read either way: a failed write may still have changed something
          // upstream of it, and a stale row is worse than a redundant reload.
          await reload();
          return;
      }
    },
    [exit, options, reload],
  );

  /**
   * Reduce once, dispatch the state change, and start the effects the reduction
   * asked for. Safe to run effects inline here: every caller is an event callback
   * (a keypress, the file watcher), never a render.
   */
  const dispatchEvent = useCallback(
    (event: PanelEvent) => {
      const result = reducePanel(latest.current, event);
      dispatch(event);
      for (const effect of result.effects) void run(effect);
    },
    [run],
  );

  useInput((input, key) => {
    dispatchEvent({
      kind: "key",
      key: {
        input,
        ...(key.upArrow && { upArrow: true }),
        ...(key.downArrow && { downArrow: true }),
        ...(key.leftArrow && { leftArrow: true }),
        ...(key.rightArrow && { rightArrow: true }),
        ...(key.tab && { tab: true }),
        ...(key.shift && { shift: true }),
        ...(key.return && { return: true }),
        ...(key.escape && { escape: true }),
        ...(key.backspace && { backspace: true }),
        ...(key.delete && { delete: true }),
        ...(key.ctrl && { ctrl: true }),
      },
    });
  });

  // The header is fetched AFTER mount, on purpose: `collectHeader` costs a ~400ms
  // module load plus a proxy/Ollama probe, and the panel must not wait on either to
  // appear. It slots into place a moment later (Header renders a same-height
  // placeholder until then), and reloads pick it up like any other data.
  useEffect(() => {
    let cancelled = false;
    void collectHeader({ ...options, probeTimeoutMs: 1_000 })
      .then((header) => {
        if (!cancelled) dispatch({ kind: "header", header });
      })
      .catch(() => {
        // A header we can't build is not worth breaking the panel over; the
        // controls — the reason the user opened it — are already on screen.
      });
    return () => {
      cancelled = true;
    };
  }, [options]);

  // Watch the settings files so an external change is reflected without a
  // keypress. Debounced: editors often write a file two or three times.
  useEffect(() => {
    const dir = path.join(path.resolve(options.projectDir), ".golem");
    let timer: NodeJS.Timeout | undefined;
    let watcher: ReturnType<typeof watch> | undefined;
    try {
      watcher = watch(dir, (_event, filename) => {
        if (filename !== null && !String(filename).startsWith("settings")) return;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => void reload(), 150);
      });
    } catch {
      // No `.golem/` yet (an uninitialized project) — nothing to watch.
    }
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      watcher?.close();
    };
  }, [options.projectDir, reload]);

  // width - 4: the outer Box's paddingX={1} costs two columns, and leaving one
  // spare stops the rule wrapping onto a second line on an exact-fit terminal.
  const rule = useMemo(() => RULE_CHAR.repeat(Math.max(10, width - 4)), [width]);
  // Header (3 + warnings) + rule + tabs + rule + footer ≈ 9 lines of chrome.
  const listHeight = Math.max(5, rows - 11 - state.surface.warnings.length);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header
        report={state.surface.header}
        theme={theme}
        showPet={showPet}
        width={width}
        placeholder={{ version: options.version, projectDir: options.projectDir }}
      />
      <Text color={theme.dim}>{rule}</Text>
      <Tabs state={state} theme={theme} />
      <Text color={theme.dim}>{rule}</Text>
      <ControlList state={state} theme={theme} height={listHeight} />
      <Text color={theme.dim}>{rule}</Text>
      <Footer state={state} theme={theme} />
    </Box>
  );
}

function Tabs({ state, theme }: { state: PanelState; theme: Theme }): React.JSX.Element {
  const control = selectedControl(state);
  const scopes = control?.writableScopes ?? [];
  const scope = scopes.includes(state.scope) ? state.scope : scopes[0];
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row">
        {CONTROL_TABS.map((tab) => (
          <Text
            key={tab.id}
            bold={tab.id === state.tab}
            color={tab.id === state.tab ? theme.accent : theme.dim}
          >
            {`  ${tab.id === state.tab ? tab.title.toUpperCase() : tab.title}  `}
          </Text>
        ))}
      </Box>
      <Text color={theme.dim}>
        {scope === undefined ? "read-only" : "scope: "}
        {scope !== undefined ? <Text color={theme.accent}>{scope}</Text> : null}
      </Text>
    </Box>
  );
}

function Footer({ state, theme }: { state: PanelState; theme: Theme }): React.JSX.Element {
  if (state.mode.kind === "help") {
    return (
      <Box flexDirection="column">
        <Text color={theme.accent} bold>
          Keys
        </Text>
        <Text color={theme.dim}>
          {"  ↑↓ / j k   move        space   toggle · step an enum\n" +
            "  ← →        step enum   enter   edit a text value (empty = unset)\n" +
            "  s          cycle write scope   a       show/hide advanced\n" +
            "  tab / [ ]  change tab          r       reload from disk\n" +
            "  ?          this help           q / esc quit"}
        </Text>
        <Text color={theme.dim}>Press any key to close.</Text>
      </Box>
    );
  }
  if (state.status !== null) {
    return (
      <Text color={state.status.tone === "error" ? theme.error : theme.ok} wrap="truncate-end">
        {state.status.text}
      </Text>
    );
  }
  const hidden = hiddenAdvancedCount(state);
  const advanced =
    hidden > 0 ? ` · a ${hidden} advanced` : state.showAdvanced ? " · a hide advanced" : "";
  return (
    <Text color={theme.dim} wrap="truncate-end">
      {`↑↓ move · space toggle · enter edit · s scope · tab group${advanced} · ? help · q quit`}
    </Text>
  );
}

/** Reducer adapter: the pure reducer returns effects, `useReducer` wants state. */
function step(state: PanelState, event: PanelEvent): PanelState {
  return reducePanel(state, event).state;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
