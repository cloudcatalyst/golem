/**
 * R10.24 — the two status lines a user reads in the SAME window must describe the
 * same state the same way.
 *
 * They had drifted: `golem statusline` rendered
 * `⬢ Golem · → ✎ coder · ◆ chat · 🗜 lossless · ✂ full` while the VS Code status
 * bar rendered `⬢ Golem · Lossless → ✎ coder · ◆ chat` — a dial between the brand
 * and the arrow, the compression level in a different place, and the drafting
 * model where the chat model belonged. Nothing pinned them together, because they
 * share no module: the CLI is TypeScript, the extension is plain CommonJS JS.
 *
 * `role-marks-parity.test.ts` already pins the GLYPHS. This pins the SHAPE, by
 * rendering equivalent state through both and demanding one string.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type GolemState, renderStatusLine } from "../../../src/cli/statusline.js";

const require_ = createRequire(import.meta.url);
const render = require_(path.join(process.cwd(), "vscode-extension", "render.js")) as {
  statusBarText: (model: Record<string, unknown>) => string;
};

/** The CLI's state and the extension's view model, for one shared situation. */
function pair(situation: {
  readonly running: boolean;
  readonly wired: boolean;
  readonly bypass?: boolean;
}): { cli: string; bar: string } {
  const cli: GolemState = {
    compression: 1 as const,
    upstreamLabel: "openrouter",
    upstreamModel: "deepseek/deepseek-v4-flash",
    brevity: "full",
    proxyRunning: situation.running,
    proxyInPath: situation.wired,
    ...(situation.bypass === true ? { proxyBypass: true } : {}),
    workers: [{ worker: "coder", model: "qwen2.5-coder:7b", gateway: "ollama" }],
  };
  const bar = render.statusBarText({
    proxyReachable: situation.running,
    proxyInPath: situation.wired,
    proxyBypass: situation.bypass === true,
    compression: "1",
    compressionName: "lossless",
    brevity: "full",
    upstreamDisplay: "openrouter (deepseek/deepseek-v4-flash)",
    lastServedModel: "deepseek/deepseek-v4-flash",
    workers: [{ worker: "coder", target: "x", model: "qwen2.5-coder:7b", gateway: "ollama" }],
  });
  return { cli: renderStatusLine({}, cli), bar };
}

describe("status-line parity: CLI vs VS Code status bar (R10.24)", () => {
  it("renders a running, wired proxy identically", () => {
    const { cli, bar } = pair({ running: true, wired: true });
    expect(cli).toBe(
      "⬢ Golem → ◆ openrouter (deepseek/deepseek-v4-flash) + ✎ ollama (qwen2.5-coder:7b) · 🗜 lossless · ✂ full",
    );
    expect(bar).toBe(cli);
  });

  it("gives every model segment ONE format, and joins them with + (R11.6)", () => {
    const { cli, bar } = pair({ running: true, wired: true });
    for (const line of [cli, bar]) {
      // Same shape for the chat model and for a worker: `<gateway> (<model>)`.
      expect(line).toContain("◆ openrouter (deepseek/deepseek-v4-flash)");
      expect(line).toContain("✎ ollama (qwen2.5-coder:7b)");
      // `+` joins models (same kind); `·` separates kinds (models · dials).
      expect(line).toContain("(deepseek/deepseek-v4-flash) + ✎");
      expect(line).toContain("(qwen2.5-coder:7b) · 🗜");
      // The worker's model id is never left bare beside a gateway it has.
      expect(line).not.toContain("✎ ollama qwen2.5-coder:7b");
    }
    expect(bar).toBe(cli);
  });

  it("falls back to the bare model id for a worker with no known gateway", () => {
    const cli: GolemState = {
      compression: 1 as const,
      upstreamLabel: "openrouter",
      upstreamModel: "deepseek/deepseek-v4-flash",
      brevity: "full",
      proxyRunning: true,
      proxyInPath: true,
      workers: [{ worker: "coder", model: "qwen2.5-coder:7b" }],
    };
    const bar = render.statusBarText({
      proxyReachable: true,
      proxyInPath: true,
      compression: "1",
      compressionName: "lossless",
      brevity: "full",
      upstreamDisplay: "openrouter (deepseek/deepseek-v4-flash)",
      lastServedModel: "deepseek/deepseek-v4-flash",
      workers: [{ worker: "coder", target: "x", model: "qwen2.5-coder:7b" }],
    });
    const line = renderStatusLine({}, cli);
    // An older CLI sends no gateway; inventing one would be worse than omitting.
    expect(line).toContain("+ ✎ qwen2.5-coder:7b");
    expect(line).not.toContain("✎  (");
    expect(bar).toBe(line);
  });

  it("puts the CHAT model first, and the arrow immediately after the brand", () => {
    const { cli, bar } = pair({ running: true, wired: true });
    for (const line of [cli, bar]) {
      // The arrow belongs to the brand, with no separator between them...
      expect(line).toContain("Golem → ◆");
      // ...and the model the conversation runs on comes before any worker.
      expect(line.indexOf("◆")).toBeLessThan(line.indexOf("✎"));
      // Dials come after the destination, never between brand and arrow.
      expect(line.indexOf("→")).toBeLessThan(line.indexOf("🗜"));
    }
  });

  it("names an unwired proxy the same way on both surfaces, and drops the dials", () => {
    const { cli, bar } = pair({ running: true, wired: false });
    for (const line of [cli, bar]) {
      expect(line).toContain("⬡ Golem unwired →");
      // Nothing is being compressed or shortened, so nothing is advertised.
      expect(line).not.toContain("🗜");
      expect(line).not.toContain("✂");
    }
    expect(bar).toBe(cli);
  });

  it("names a stopped proxy 'off' on both surfaces", () => {
    const { cli, bar } = pair({ running: false, wired: true });
    for (const line of [cli, bar]) expect(line).toContain("⬡ Golem off →");
    expect(bar).toBe(cli);
  });

  it("names the bypass shim on both surfaces", () => {
    const { cli, bar } = pair({ running: true, wired: true, bypass: true });
    for (const line of [cli, bar]) expect(line).toContain("⬡ Golem bypass →");
    expect(bar).toBe(cli);
  });
});
