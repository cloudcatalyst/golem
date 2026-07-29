/**
 * One real ink render of the panel, to catch what the pure tests can't: that the
 * components mount at all, and that the pet + header + rows actually appear in the
 * frame.
 *
 * Deliberately thin — the interaction rules live in tests/unit/tui-state.test.ts.
 * Colour is forced off so the assertions are about text, not escape codes.
 */

import { render } from "ink-testing-library";
import { beforeAll, describe, expect, it } from "vitest";
import type { StatusReport } from "../../src/cli/status.js";
import type { ControlGroup, ControlSurface } from "../../src/config/control-surface.js";
import { App } from "../../src/tui/app.js";
import { controlRowText, formatValue, scrollWindow, stateBox } from "../../src/tui/controls.js";
import { Header, headerLines } from "../../src/tui/header.js";
import { PET_LINES, themeFor } from "../../src/tui/theme.js";

beforeAll(() => {
  // chalk reads this at import time; ink-testing-library's stdout stub is not a
  // TTY, so colour would be off anyway — this makes it explicit and stable.
  process.env.FORCE_COLOR = "0";
});

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

const UI = { pet: true, pet_color: "#a78bfa", color: "never", advanced: false } as const;

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

const SURFACE: ControlSurface = { header: REPORT, groups: [GROUP], warnings: [] };

describe("the panel renders", () => {
  it("draws the pet, the header, and the control rows", () => {
    const { lastFrame, unmount } = render(
      <App
        surface={SURFACE}
        theme={themeFor(UI)}
        showPet={true}
        showAdvanced={false}
        options={{ projectDir: "/tmp/demo", version: "1.2.3" }}
      />,
    );
    const frame = lastFrame() ?? "";
    unmount();

    for (const line of PET_LINES) expect(frame).toContain(line);
    expect(frame).toContain("1.2.3");
    expect(frame).toContain("http://localhost:4653");
    expect(frame).toContain("Knowledge");
    expect(frame).toContain("Vector knowledge base");
    expect(frame).toContain("[x]");
    expect(frame).toContain("[ ]");
    // Tabs and the footer hint bar.
    expect(frame).toContain("SETTINGS");
    expect(frame).toContain("Guidance");
    expect(frame).toContain("q quit");
  });

  it("omits the pet when it's turned off", () => {
    const { lastFrame, unmount } = render(
      <Header report={REPORT} theme={themeFor(UI)} showPet={false} width={100} />,
    );
    const frame = lastFrame() ?? "";
    unmount();
    for (const line of PET_LINES) expect(frame).not.toContain(line);
    // The information is still all there.
    expect(frame).toContain("1.2.3");
    expect(frame).toContain("qwen2.5-coder:7b");
  });
});

describe("headerLines", () => {
  it("always returns three lines, one per pet row", () => {
    expect(headerLines(REPORT)).toHaveLength(3);
    expect(PET_LINES).toHaveLength(3);
  });

  it("flags a reachable proxy and an unreachable one differently", () => {
    const [, second] = headerLines(REPORT);
    expect(second?.[0]?.tone).toBe("ok");
    const down = { ...REPORT, proxy: { ...REPORT.proxy, reachable: false } };
    expect(headerLines(down)[1]?.[0]?.tone).toBe("warn");
    expect(headerLines(down)[1]?.[0]?.value).toContain("not running");
  });

  it("marks slider level 0 as an error tone, because redaction is off there", () => {
    const bypass = { ...REPORT, slider: { level: 0, name: "passthrough", layer: "local" } };
    const level = headerLines(bypass)[1]?.[1];
    expect(level?.value).toContain("passthrough");
    expect(level?.tone).toBe("error");
  });

  it("shows the coder model when it's live, and says so when it isn't", () => {
    expect(headerLines(REPORT)[2]?.[0]?.value).toContain("qwen2.5-coder:7b");
    const off = { ...REPORT, local_model: { ...REPORT.local_model, coder_enabled: false } };
    expect(headerLines(off)[2]?.[0]?.value).toContain("coder disabled");
    const down = { ...REPORT, local_model: { ...REPORT.local_model, reachable: false } };
    expect(headerLines(down)[2]?.[0]?.value).toContain("unreachable");
  });

  it("includes the limit window only when the proxy has observed one", () => {
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
    const line = headerLines(limited)[2];
    expect(line).toHaveLength(2);
    expect(line?.[1]?.value).toBe("5h 42% used");
  });
});

describe("row formatting", () => {
  const first = GROUP.controls[0];
  const second = GROUP.controls[1];

  it("uses a checkbox for toggles and a dot for locked controls", () => {
    if (first === undefined || second === undefined) throw new Error("fixture");
    expect(stateBox(first)).toBe("[x]");
    expect(stateBox(second)).toBe("[ ]");
    expect(stateBox({ ...first, locked: "env" })).toBe("[·]");
    // A non-toggle gets blank space, not a checkbox it doesn't obey.
    expect(stateBox({ ...first, kind: "text", value: "x" })).toBe("   ");
  });

  it("formats values for one line of terminal text", () => {
    if (first === undefined) throw new Error("fixture");
    expect(formatValue(first)).toBe("on");
    expect(formatValue({ ...first, value: false })).toBe("off");
    expect(formatValue({ ...first, kind: "text", value: undefined })).toBe("(unset)");
    expect(formatValue({ ...first, kind: "list", value: [] })).toBe("(none)");
    expect(formatValue({ ...first, kind: "list", value: ["a", "b"] })).toBe("a, b");
    // A structured array must not join to "[object Object]".
    expect(formatValue({ ...first, kind: "opaque", value: [{ id: "x" }, { id: "y" }] })).toBe(
      "2 entries",
    );
    expect(formatValue({ ...first, kind: "opaque", value: [{ id: "x" }] })).toBe("1 entry");
    expect(
      formatValue({
        ...first,
        kind: "enum",
        value: "1",
        options: [{ value: "1", label: "1 lossless" }],
      }),
    ).toBe("1 lossless");
  });

  it("puts the label, value, and layer on one aligned line", () => {
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

  it("centres on the cursor once the list is longer than the viewport", () => {
    expect(scrollWindow(20, 100, 10)).toEqual({ start: 15, end: 25 });
  });

  it("clamps at both ends rather than scrolling past them", () => {
    expect(scrollWindow(0, 100, 10)).toEqual({ start: 0, end: 10 });
    expect(scrollWindow(99, 100, 10)).toEqual({ start: 90, end: 100 });
  });
});
