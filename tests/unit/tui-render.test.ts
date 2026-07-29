/**
 * The panel's view, asserted as strings.
 *
 * `renderPanel` is pure — state in, terminal lines out — so the whole UI is testable
 * without a terminal or a framework. (Under ink this needed `ink-testing-library` and
 * a real mount; removing ink made the view *easier* to test, not harder.)
 *
 * Colour is off (`ui.color: "never"` → theme level 0) so assertions are about layout
 * and content; ansi.ts's colour degradation is tested separately below.
 */

import { describe, expect, it } from "vitest";
import type { StatusReport } from "../../src/cli/status.js";
import type { ControlGroup, ControlSurface } from "../../src/config/control-surface.js";
import type { UiSettings } from "../../src/config/index.js";
import { detectColorLevel, ESC, fg, paint } from "../../src/tui/ansi.js";
import { controlRowText, formatValue, scrollWindow, stateBox } from "../../src/tui/controls.js";
import { headerLines, pendingHeaderLines } from "../../src/tui/header.js";
import { renderPanel } from "../../src/tui/render.js";
import { initialState, reducePanel } from "../../src/tui/state.js";
import { PET_LINES, themeFor } from "../../src/tui/theme.js";
import { displayWidth, padTo, stripAnsi, truncateTo } from "../../src/tui/width.js";

const REPORT: StatusReport = {
  version: "1.2.3",
  project_dir: "/tmp/demo",
  initialized: {
    overall: true,
    claude_settings: true,
    mcp_registered: true,
    skills: true,
    golem_settings: true,
  },
  proxy: { port: 4653, url: "http://localhost:4653", reachable: true },
  upstream: {
    provider: "anthropic",
    account: null,
    base_url: "https://api.anthropic.com",
    default_model: null,
  },
  slider: { level: 1, name: "lossless", layer: "default" },
  config: {},
  local_model: {
    reachable: true,
    coder_model: "qwen2.5-coder:7b",
    coder_enabled: true,
    base_url: "http://localhost:11434",
  },
  warnings: [],
};

const PLAIN: UiSettings = { pet: true, pet_color: "#a78bfa", color: "never", advanced: false };
const COLOURFUL: UiSettings = { ...PLAIN, color: "always" };

const GROUP: ControlGroup = {
  id: "settings:knowledge",
  title: "Knowledge",
  summary: "Vector search and the wiki",
  tab: "settings",
  controls: [
    {
      id: "setting:knowledge.enabled",
      family: "setting",
      label: "Vector knowledge base",
      summary: "Master switch",
      kind: "toggle",
      value: true,
      layer: "project",
      writableScopes: ["project", "local", "user"],
      advanced: false,
    },
    {
      id: "setting:knowledge.rerank_enabled",
      family: "setting",
      label: "Rerank search hits locally",
      summary: "Judge hits with the local model",
      kind: "toggle",
      value: false,
      layer: "default",
      writableScopes: ["project", "local", "user"],
      advanced: false,
    },
  ],
};

const surfaceWith = (header: StatusReport | null): ControlSurface => ({
  header,
  groups: [GROUP],
  warnings: [],
});

const stateFor = (header: StatusReport | null = REPORT) =>
  initialState(surfaceWith(header), { version: "1.2.3", projectDir: "/tmp/demo" });

const frame = (
  state = stateFor(),
  opts: { showPet?: boolean; width?: number; height?: number; ui?: UiSettings } = {},
) =>
  renderPanel(state, {
    theme: themeFor(opts.ui ?? PLAIN, {}, false),
    showPet: opts.showPet ?? true,
    width: opts.width ?? 100,
    height: opts.height ?? 30,
  });

describe("renderPanel", () => {
  it("draws the pet, the header, the rows, the tabs, and the footer", () => {
    const text = frame().join("\n");
    for (const line of PET_LINES) expect(text).toContain(line);
    expect(text).toContain("1.2.3");
    expect(text).toContain("http://localhost:4653");
    expect(text).toContain("qwen2.5-coder:7b");
    expect(text).toContain("Knowledge");
    expect(text).toContain("Vector knowledge base");
    expect(text).toContain("[x]");
    expect(text).toContain("[ ]");
    expect(text).toContain("SETTINGS");
    expect(text).toContain("Guidance");
    expect(text).toContain("scope: project");
    expect(text).toContain("q quit");
  });

  it("omits the pet when asked, keeping the information", () => {
    const text = frame(stateFor(), { showPet: false }).join("\n");
    for (const line of PET_LINES) expect(text).not.toContain(line);
    expect(text).toContain("1.2.3");
    expect(text).toContain("qwen2.5-coder:7b");
  });

  it("never emits a line wider than the terminal", () => {
    for (const width of [40, 60, 80, 100, 200]) {
      for (const line of frame(stateFor(), { width })) {
        expect(displayWidth(line), `width ${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(
          width,
        );
      }
    }
  });

  it("keeps the header three lines tall before the report arrives", () => {
    // Same height either way, so nothing below it jumps when the values land.
    const pending = frame(stateFor(null));
    const settled = frame(stateFor(REPORT));
    expect(pending.length).toBe(settled.length);
    expect(pending.join("\n")).toContain("1.2.3");
    expect(pending.join("\n")).toContain("/tmp/demo");
  });

  it("marks the cursor row and moves the marker with the cursor", () => {
    const first = frame();
    const moved = frame(reducePanel(stateFor(), { kind: "key", key: { input: "j" } }).state);
    const markedIn = (lines: readonly string[]) =>
      lines.findIndex((l) => l.includes("▸") && l.includes("["));
    expect(markedIn(first)).toBeGreaterThan(0);
    expect(markedIn(moved)).toBe(markedIn(first) + 1);
  });

  it("shows the help card, then the hint bar again", () => {
    const helped = reducePanel(stateFor(), { kind: "key", key: { input: "?" } }).state;
    expect(frame(helped).join("\n")).toContain("cycle write scope");
    const closed = reducePanel(helped, { kind: "key", key: { input: "x" } }).state;
    expect(frame(closed).join("\n")).toContain("q quit");
  });

  it("shows a status message in place of the hint bar", () => {
    const applied = reducePanel(stateFor(), {
      kind: "applied",
      controlId: "setting:knowledge.enabled",
      message: "knowledge.enabled = false (project scope)",
    }).state;
    expect(frame(applied).join("\n")).toContain("knowledge.enabled = false");
  });

  it("shows the danger warning and the y/n prompt when confirming", () => {
    const danger: ControlSurface = {
      header: REPORT,
      warnings: [],
      groups: [
        {
          id: "runtime",
          title: "Runtime",
          tab: "runtime",
          controls: [
            {
              id: "runtime:slider",
              family: "runtime",
              label: "Savings level",
              summary: "the dial",
              kind: "enum",
              value: "1",
              options: [
                { value: "0", label: "0 passthrough" },
                { value: "1", label: "1 lossless" },
              ],
              danger: "Level 0 disables redaction",
              layer: "local",
              writableScopes: ["local"],
              advanced: false,
            },
          ],
        },
      ],
    };
    let state = initialState(danger, { version: "1.2.3", projectDir: "/tmp/demo" });
    state = reducePanel(state, { kind: "key", key: { input: "", tab: true } }).state;
    state = reducePanel(state, { kind: "key", key: { input: "", tab: true } }).state;
    state = reducePanel(state, { kind: "key", key: { input: "", leftArrow: true } }).state;
    const text = frame(state).join("\n");
    expect(text).toContain("Level 0 disables redaction");
    expect(text).toContain("Apply it? y / n");
  });

  it("renders warnings from the report", () => {
    const warned = { ...REPORT, warnings: ["Slider level 0 is a FULL BYPASS: redaction is OFF"] };
    expect(frame(stateFor(warned)).join("\n")).toContain("redaction is OFF");
  });

  it("emits colour only when the theme allows it", () => {
    expect(frame().join("")).not.toContain(ESC);
    const coloured = frame(stateFor(), { ui: COLOURFUL }).join("");
    expect(coloured).toContain(ESC);
    // ...and the visible text is unchanged by colouring.
    expect(stripAnsi(coloured)).toContain("Vector knowledge base");
  });
});

describe("headerLines", () => {
  it("returns one line per pet row", () => {
    expect(headerLines(REPORT)).toHaveLength(PET_LINES.length);
    expect(pendingHeaderLines("1.0.0", "/p")).toHaveLength(PET_LINES.length);
  });

  it("tones the proxy by reachability", () => {
    expect(headerLines(REPORT)[1]?.[0]?.tone).toBe("ok");
    const down = { ...REPORT, proxy: { ...REPORT.proxy, reachable: false } };
    expect(headerLines(down)[1]?.[0]?.tone).toBe("warn");
    expect(headerLines(down)[1]?.[0]?.value).toContain("not running");
  });

  it("marks slider level 0 as an error, because redaction is off there", () => {
    const bypass = { ...REPORT, slider: { level: 0, name: "passthrough", layer: "local" } };
    expect(headerLines(bypass)[1]?.[1]?.tone).toBe("error");
  });

  it("describes the local model's three states", () => {
    expect(headerLines(REPORT)[2]?.[0]?.value).toContain("qwen2.5-coder:7b");
    const off = { ...REPORT, local_model: { ...REPORT.local_model, coder_enabled: false } };
    expect(headerLines(off)[2]?.[0]?.value).toContain("coder disabled");
    const down = { ...REPORT, local_model: { ...REPORT.local_model, reachable: false } };
    expect(headerLines(down)[2]?.[0]?.value).toContain("unreachable");
  });

  it("includes the limit window only once the proxy has observed one", () => {
    expect(headerLines(REPORT)[2]).toHaveLength(1);
    const limited: StatusReport = {
      ...REPORT,
      limits: {
        five_hour_utilization: 0.42,
        reset_at: null,
        observed_at: "2026-07-29T00:00:00.000Z",
        age_minutes: 3,
        stale: false,
        enforced: true,
      },
    };
    expect(headerLines(limited)[2]?.[1]?.value).toBe("5h 42% used");
  });
});

describe("row formatting", () => {
  const first = GROUP.controls[0];

  it("uses a checkbox for toggles and a dot for locked controls", () => {
    if (first === undefined) throw new Error("fixture");
    expect(stateBox(first)).toBe("[x]");
    expect(stateBox({ ...first, value: false })).toBe("[ ]");
    expect(stateBox({ ...first, locked: "env" })).toBe("[·]");
    expect(stateBox({ ...first, kind: "text", value: "x" })).toBe("   ");
  });

  it("formats the value shapes a settings file can hold", () => {
    if (first === undefined) throw new Error("fixture");
    expect(formatValue(first)).toBe("on");
    expect(formatValue({ ...first, value: false })).toBe("off");
    expect(formatValue({ ...first, kind: "text", value: undefined })).toBe("(unset)");
    expect(formatValue({ ...first, kind: "list", value: [] })).toBe("(none)");
    expect(formatValue({ ...first, kind: "list", value: ["a", "b"] })).toBe("a, b");
    expect(formatValue({ ...first, kind: "opaque", value: [{ id: "x" }, { id: "y" }] })).toBe(
      "2 entries",
    );
    expect(formatValue({ ...first, kind: "opaque", value: [{ id: "x" }] })).toBe("1 entry");
  });

  it("puts label, value, and layer on one aligned line", () => {
    if (first === undefined) throw new Error("fixture");
    const text = controlRowText(first);
    expect(text.startsWith("[x] Vector knowledge base")).toBe(true);
    expect(text.endsWith("project")).toBe(true);
  });
});

describe("scrollWindow", () => {
  it("shows everything when it fits", () => {
    expect(scrollWindow(0, 5, 10)).toEqual({ start: 0, end: 5 });
  });
  it("centres on the cursor once the list overflows", () => {
    expect(scrollWindow(20, 100, 10)).toEqual({ start: 15, end: 25 });
  });
  it("clamps at both ends", () => {
    expect(scrollWindow(0, 100, 10)).toEqual({ start: 0, end: 10 });
    expect(scrollWindow(99, 100, 10)).toEqual({ start: 90, end: 100 });
  });
});

describe("width arithmetic (what string-width/cli-truncate used to do)", () => {
  it("ignores ANSI escapes when measuring", () => {
    const coloured = paint("hello", "#ff0000", 3);
    expect(coloured).not.toBe("hello");
    expect(displayWidth(coloured)).toBe(5);
    expect(stripAnsi(coloured)).toBe("hello");
  });

  it("counts wide characters as two columns", () => {
    expect(displayWidth("日本語")).toBe(6);
    expect(displayWidth("abc")).toBe(3);
  });

  it("counts the pet's Ambiguous-width glyph as one, as the layout assumes", () => {
    // U+25A0 is East Asian Ambiguous; string-width called it 1 and so do we, so the
    // fixed-width pet column stays correct on a Western terminal.
    for (const line of PET_LINES) expect(displayWidth(line)).toBe(8);
  });

  it("truncates to a column budget with an ellipsis", () => {
    expect(truncateTo("abcdefghij", 5)).toBe("abcd…");
    expect(truncateTo("abc", 10)).toBe("abc");
    expect(displayWidth(truncateTo("日本語日本語", 5))).toBeLessThanOrEqual(5);
  });

  it("closes the style when it truncates coloured text", () => {
    const cut = truncateTo(paint("abcdefghij", "#00ff00", 3), 5);
    expect(displayWidth(cut)).toBeLessThanOrEqual(5);
    expect(cut.endsWith(`${ESC}[0m`)).toBe(true);
  });

  it("pads to an exact column count", () => {
    expect(displayWidth(padTo("abc", 10))).toBe(10);
    expect(displayWidth(padTo("日本語", 10))).toBe(10);
    expect(displayWidth(padTo("abcdefghijk", 5))).toBeLessThanOrEqual(5);
  });
});

describe("colour degradation (what chalk used to do)", () => {
  it("honours NO_COLOR and FORCE_COLOR above everything", () => {
    expect(detectColorLevel({ NO_COLOR: "1" }, true)).toBe(0);
    expect(detectColorLevel({ FORCE_COLOR: "0" }, true)).toBe(0);
    expect(detectColorLevel({ FORCE_COLOR: "1" }, false)).toBe(1);
    expect(detectColorLevel({ FORCE_COLOR: "3" }, false)).toBe(3);
  });

  it("reports no colour for a non-TTY", () => {
    expect(detectColorLevel({ TERM: "xterm-256color" }, false)).toBe(0);
  });

  it("recognises 24-bit and 256-colour terminals", () => {
    expect(detectColorLevel({ COLORTERM: "truecolor" }, true)).toBe(3);
    expect(detectColorLevel({ WT_SESSION: "x" }, true)).toBe(3);
    expect(detectColorLevel({ TERM: "xterm-256color" }, true)).toBe(2);
    expect(detectColorLevel({ TERM: "xterm" }, true)).toBe(1);
    expect(detectColorLevel({ TERM: "dumb" }, true)).toBe(0);
  });

  it("emits the right SGR form per level", () => {
    expect(fg("#a78bfa", 3)).toBe(`${ESC}[38;2;167;139;250m`);
    expect(fg("#a78bfa", 2)).toMatch(new RegExp(`^${ESC}\\[38;5;\\d+m$`));
    expect(fg("#a78bfa", 1)).toMatch(new RegExp(`^${ESC}\\[\\d+m$`));
    expect(fg("#a78bfa", 0)).toBe("");
  });

  it("supports the short hex form and rejects nonsense", () => {
    expect(fg("#fff", 3)).toBe(`${ESC}[38;2;255;255;255m`);
    expect(fg("not-a-colour", 3)).toBe("");
  });

  it("leaves text alone at level 0 and always closes the style otherwise", () => {
    expect(paint("x", "#ffffff", 0)).toBe("x");
    expect(paint("x", "#ffffff", 3).endsWith(`${ESC}[0m`)).toBe(true);
  });

  it("maps the theme's ui.color policy onto a level", () => {
    expect(themeFor(PLAIN, { COLORTERM: "truecolor" }, true).level).toBe(0);
    expect(themeFor(COLOURFUL, {}, false).level).toBe(1);
    expect(themeFor({ ...PLAIN, color: "auto" }, { COLORTERM: "truecolor" }, true).level).toBe(3);
  });
});
