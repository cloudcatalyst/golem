/**
 * The panel's interaction rules, tested against the pure reducer — no ink, no
 * terminal, no filesystem. Every behaviour a user can feel (what space does, when
 * a confirm is required, where the cursor lands) is asserted here.
 */

import { describe, expect, it } from "vitest";
import type { StatusReport } from "../../src/cli/status.js";
import type { Control, ControlGroup, ControlSurface } from "../../src/config/control-surface.js";
import {
  effectiveScope,
  hiddenAdvancedCount,
  initialState,
  type KeyPress,
  type PanelState,
  reducePanel,
  selectedControl,
  visibleRows,
} from "../../src/tui/state.js";

// --- fixtures ---------------------------------------------------------------

function control(over: Partial<Control> & Pick<Control, "id">): Control {
  return {
    family: "setting",
    label: over.id,
    summary: "",
    kind: "toggle",
    value: false,
    layer: "default",
    writableScopes: ["project", "local", "user"],
    advanced: false,
    ...over,
  };
}

const HEADER = {
  version: "0.0.0-test",
  project_dir: "/tmp/p",
  slider: { level: 1, name: "lossless", layer: "default" },
  warnings: [],
} as unknown as StatusReport;

function surfaceOf(...groups: ControlGroup[]): ControlSurface {
  return { header: HEADER, groups, warnings: [] };
}

const SETTINGS_GROUP: ControlGroup = {
  id: "settings:knowledge",
  title: "Knowledge",
  tab: "settings",
  controls: [
    control({ id: "setting:a" }),
    control({ id: "setting:b", value: true }),
    control({ id: "setting:adv", advanced: true }),
  ],
};

const RUNTIME_GROUP: ControlGroup = {
  id: "runtime",
  title: "Runtime",
  tab: "runtime",
  controls: [
    control({
      id: "runtime:slider",
      family: "runtime",
      kind: "enum",
      value: "1",
      options: [
        { value: "0", label: "0 passthrough" },
        { value: "1", label: "1 lossless" },
        { value: "2", label: "2 balanced" },
      ],
      danger: "level 0 turns redaction off",
      writableScopes: ["local"],
    }),
  ],
};

const SURFACE = surfaceOf(SETTINGS_GROUP, RUNTIME_GROUP);

const key = (over: Partial<KeyPress> = {}): KeyPress => ({ input: "", ...over });
const press = (state: PanelState, over: Partial<KeyPress>) =>
  reducePanel(state, { kind: "key", key: key(over) });
/** Press a sequence and return the final step. */
function pressAll(state: PanelState, presses: Partial<KeyPress>[]) {
  let step = press(state, presses[0] ?? {});
  for (const p of presses.slice(1)) step = press(step.state, p);
  return step;
}

// --- rows and navigation ----------------------------------------------------

describe("visibleRows", () => {
  it("shows the current tab only, with a heading before its controls", () => {
    const rows = visibleRows(initialState(SURFACE));
    expect(rows.map((r) => r.kind)).toEqual(["group", "control", "control"]);
    expect(rows[0]?.kind === "group" && rows[0].group.id).toBe("settings:knowledge");
  });

  it("hides advanced controls until asked", () => {
    const state = initialState(SURFACE);
    expect(visibleRows(state)).toHaveLength(3); // heading + 2 non-advanced
    expect(hiddenAdvancedCount(state)).toBe(1);
    const shown = initialState(SURFACE, { showAdvanced: true });
    expect(visibleRows(shown)).toHaveLength(4);
    expect(hiddenAdvancedCount(shown)).toBe(0);
  });

  it("drops a group whose every control is advanced", () => {
    const surface = surfaceOf({
      id: "settings:x",
      title: "X",
      tab: "settings",
      controls: [control({ id: "setting:only", advanced: true })],
    });
    expect(visibleRows(initialState(surface))).toHaveLength(0);
  });
});

describe("navigation", () => {
  it("starts on the first control, not the group heading", () => {
    const state = initialState(SURFACE);
    expect(state.cursor).toBe(1);
    expect(selectedControl(state)?.id).toBe("setting:a");
  });

  it("moves with arrows and with j/k, skipping headings", () => {
    const state = initialState(SURFACE);
    expect(press(state, { downArrow: true }).state.cursor).toBe(2);
    expect(press(state, { input: "j" }).state.cursor).toBe(2);
    const down = press(state, { downArrow: true }).state;
    expect(press(down, { input: "k" }).state.cursor).toBe(1);
  });

  it("stops at the ends instead of wrapping", () => {
    const state = initialState(SURFACE);
    expect(press(state, { upArrow: true }).state.cursor).toBe(1);
    const last = press(state, { downArrow: true }).state;
    expect(press(last, { downArrow: true }).state.cursor).toBe(2);
  });

  it("changes tab with tab / [ / ] and re-anchors the cursor", () => {
    const state = initialState(SURFACE);
    const next = press(state, { tab: true }).state;
    expect(next.tab).toBe("guidance");
    // No guidance group in this fixture, so the runtime tab is one more along.
    const runtime = press(next, { tab: true }).state;
    expect(runtime.tab).toBe("runtime");
    expect(selectedControl(runtime)?.id).toBe("runtime:slider");
    expect(press(runtime, { tab: true, shift: true }).state.tab).toBe("guidance");
  });

  it("toggles advanced with `a` and keeps the cursor on a control", () => {
    const step = press(initialState(SURFACE), { input: "a" });
    expect(step.state.showAdvanced).toBe(true);
    expect(selectedControl(step.state)).not.toBeNull();
  });
});

// --- applying ---------------------------------------------------------------

describe("toggling", () => {
  it("space flips a toggle and asks for the write", () => {
    const step = press(initialState(SURFACE), { input: " " });
    expect(step.effects).toEqual([
      { kind: "apply", controlId: "setting:a", value: true, scope: "project" },
    ]);
    expect(step.state.busy).toContain("setting:a");
  });

  it("space flips an on toggle back off", () => {
    const onB = press(initialState(SURFACE), { downArrow: true }).state;
    const step = press(onB, { input: " " });
    expect(step.effects[0]).toMatchObject({ controlId: "setting:b", value: false });
  });

  it("refuses a locked control and says why, without queueing a write", () => {
    const surface = surfaceOf({
      ...SETTINGS_GROUP,
      controls: [control({ id: "setting:a", locked: "set by GOLEM_X", writableScopes: [] })],
    });
    const step = press(initialState(surface), { input: " " });
    expect(step.effects).toEqual([]);
    expect(step.state.status?.tone).toBe("error");
    expect(step.state.status?.text).toContain("GOLEM_X");
  });

  it("declines to edit an opaque value", () => {
    const surface = surfaceOf({
      ...SETTINGS_GROUP,
      controls: [control({ id: "setting:accounts", kind: "opaque", value: [] })],
    });
    const step = press(initialState(surface), { input: " " });
    expect(step.effects).toEqual([]);
    expect(step.state.status?.tone).toBe("error");
  });
});

describe("enum controls", () => {
  const runtimeState = () => press(initialState(SURFACE), { tab: true, shift: true }).state;

  it("steps forward with right arrow and wraps around the options", () => {
    const state = runtimeState();
    expect(state.tab).toBe("runtime");
    // From "1", right goes to "2"; right again wraps to "0" — which is dangerous,
    // so it must ask rather than apply.
    const toTwo = press(state, { rightArrow: true });
    expect(toTwo.effects[0]).toMatchObject({ controlId: "runtime:slider", value: "2" });
  });

  it("steps backward with left arrow", () => {
    const step = press(runtimeState(), { leftArrow: true });
    // "1" back one is "0" — dangerous, so a confirm instead of an immediate write.
    expect(step.effects).toEqual([]);
    expect(step.state.mode).toEqual({ kind: "confirm", controlId: "runtime:slider", value: "0" });
  });

  it("uses the control's own scope, not the panel's, when they differ", () => {
    const state = { ...runtimeState(), scope: "user" };
    const control = selectedControl(state);
    expect(control).not.toBeNull();
    // The slider only writes local scope; a `user`-scoped session must not send
    // "user" to it.
    if (control !== null) expect(effectiveScope(state, control)).toBe("local");
    const step = press(state, { rightArrow: true });
    expect(step.effects[0]).toMatchObject({ scope: "local" });
  });
});

describe("dangerous changes", () => {
  const toConfirm = () => {
    const runtime = press(initialState(SURFACE), { tab: true, shift: true }).state;
    return press(runtime, { leftArrow: true }).state; // → confirm level 0
  };

  it("requires an explicit y", () => {
    const confirming = toConfirm();
    const step = press(confirming, { input: "y" });
    expect(step.effects).toEqual([
      { kind: "apply", controlId: "runtime:slider", value: "0", scope: "local" },
    ]);
    expect(step.state.mode).toEqual({ kind: "browse" });
  });

  it("cancels on n, escape, enter, or space — never applies by accident", () => {
    for (const k of [{ input: "n" }, { escape: true }, { return: true }, { input: " " }]) {
      const step = press(toConfirm(), k);
      expect(step.effects, JSON.stringify(k)).toEqual([]);
      expect(step.state.mode).toEqual({ kind: "browse" });
      expect(step.state.status?.text).toBe("cancelled");
    }
  });

  it("does not confirm the safe direction", () => {
    // Stepping 1 → 2 is not dangerous even though the control carries a warning.
    const runtime = press(initialState(SURFACE), { tab: true, shift: true }).state;
    const step = press(runtime, { rightArrow: true });
    expect(step.state.mode).toEqual({ kind: "browse" });
    expect(step.effects).toHaveLength(1);
  });
});

describe("text editing", () => {
  const textSurface = surfaceOf({
    ...SETTINGS_GROUP,
    controls: [control({ id: "setting:dir", kind: "text", value: "docs/wiki" })],
  });

  it("enter opens the editor prefilled with the current value", () => {
    const step = press(initialState(textSurface), { return: true });
    expect(step.state.mode).toEqual({
      kind: "edit",
      controlId: "setting:dir",
      draft: "docs/wiki",
    });
  });

  it("types, backspaces, and commits on enter", () => {
    const opened = press(initialState(textSurface), { return: true }).state;
    const typed = pressAll(opened, [
      { backspace: true },
      { backspace: true },
      { backspace: true },
      { backspace: true },
      { input: "notes" },
    ]);
    expect(typed.state.mode).toMatchObject({ draft: "docs/notes" });
    const committed = press(typed.state, { return: true });
    expect(committed.effects[0]).toMatchObject({ controlId: "setting:dir", value: "docs/notes" });
  });

  it("commits an emptied field as null, meaning unset", () => {
    const opened = press(initialState(textSurface), { return: true }).state;
    let state = opened;
    for (let i = 0; i < "docs/wiki".length; i += 1) state = press(state, { backspace: true }).state;
    const step = press(state, { return: true });
    expect(step.effects[0]).toMatchObject({ value: null });
  });

  it("escape abandons the edit without writing", () => {
    const opened = press(initialState(textSurface), { return: true }).state;
    const typed = press(opened, { input: "x" }).state;
    const step = press(typed, { escape: true });
    expect(step.effects).toEqual([]);
    expect(step.state.mode).toEqual({ kind: "browse" });
  });

  it("ignores control characters so escape sequences can't land in the value", () => {
    const opened = press(initialState(textSurface), { return: true }).state;
    const step = press(opened, { input: "[A", upArrow: true });
    expect(step.state.mode).toMatchObject({ draft: "docs/wiki" });
  });
});

describe("scope selection", () => {
  it("cycles through the selected control's own scopes", () => {
    const state = initialState(SURFACE);
    expect(state.scope).toBe("project");
    const once = press(state, { input: "s" }).state;
    expect(once.scope).toBe("local");
    expect(press(once, { input: "s" }).state.scope).toBe("user");
  });

  it("explains, rather than cycling, when a control has one fixed scope", () => {
    const runtime = press(initialState(SURFACE), { tab: true, shift: true }).state;
    const step = press(runtime, { input: "s" });
    expect(step.state.scope).toBe(runtime.scope);
    expect(step.state.status?.text).toContain("local");
  });
});

describe("help, reload, and exit", () => {
  it("? opens help and any key closes it", () => {
    const helped = press(initialState(SURFACE), { input: "?" }).state;
    expect(helped.mode).toEqual({ kind: "help" });
    expect(press(helped, { input: "x" }).state.mode).toEqual({ kind: "browse" });
  });

  it("r asks for a reload", () => {
    expect(press(initialState(SURFACE), { input: "r" }).effects).toEqual([{ kind: "reload" }]);
  });

  it("q, escape, and ctrl-c all exit", () => {
    for (const k of [{ input: "q" }, { escape: true }, { input: "c", ctrl: true }]) {
      const step = press(initialState(SURFACE), k);
      expect(step.effects, JSON.stringify(k)).toEqual([{ kind: "exit" }]);
      expect(step.state.exiting).toBe(true);
    }
  });
});

describe("surface reloads", () => {
  it("keeps the cursor in place when the rows are unchanged", () => {
    const moved = press(initialState(SURFACE), { downArrow: true }).state;
    const step = reducePanel(moved, { kind: "surface", surface: SURFACE });
    expect(step.state.cursor).toBe(moved.cursor);
    expect(selectedControl(step.state)?.id).toBe("setting:b");
  });

  it("re-anchors when the row it pointed at is gone", () => {
    const moved = press(initialState(SURFACE), { downArrow: true }).state;
    const shrunk = surfaceOf({ ...SETTINGS_GROUP, controls: [control({ id: "setting:a" })] });
    const step = reducePanel(moved, { kind: "surface", surface: shrunk });
    expect(selectedControl(step.state)?.id).toBe("setting:a");
  });

  it("clears the busy list, since the fresh surface is the real state", () => {
    const busy = press(initialState(SURFACE), { input: " " }).state;
    expect(busy.busy).not.toEqual([]);
    expect(reducePanel(busy, { kind: "surface", surface: SURFACE }).state.busy).toEqual([]);
  });

  it("reports an apply result, and an error, in the status line", () => {
    const busy = press(initialState(SURFACE), { input: " " }).state;
    const ok = reducePanel(busy, {
      kind: "applied",
      controlId: "setting:a",
      message: "written",
    }).state;
    expect(ok.status).toEqual({ text: "written", tone: "info" });
    expect(ok.busy).toEqual([]);

    const bad = reducePanel(busy, {
      kind: "failed",
      controlId: "setting:a",
      message: "nope",
    }).state;
    expect(bad.status).toEqual({ text: "nope", tone: "error" });
    expect(bad.busy).toEqual([]);
  });
});
