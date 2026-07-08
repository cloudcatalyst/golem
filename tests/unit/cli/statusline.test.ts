/**
 * Decision 21c — golem statusline: defensive stdin parsing + pure rendering.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proxyPidPath, writeProxyPid } from "../../../src/cli/proxy-daemon.js";
import {
  BLOCKED_STALE_MS,
  collectGolemState,
  isBlockedFresh,
  parseSessionInput,
  renderStatusLine,
  upstreamLabel,
} from "../../../src/cli/statusline.js";
import { sessionStatePath, writeSessionState } from "../../../src/hooks/index.js";
import { openTelemetryStore } from "../../../src/telemetry/index.js";

describe("parseSessionInput", () => {
  it("extracts the fields we use from the real stdin shape", () => {
    const raw = JSON.stringify({
      model: { id: "claude-opus-4-8", display_name: "Opus" },
      workspace: { current_dir: "/proj" },
      cost: { total_cost_usd: 0.0123 },
      context_window: {
        used_percentage: 8,
        current_usage: { cache_read_input_tokens: 2000 },
      },
      rate_limits: { five_hour: { used_percentage: 23.5 }, seven_day: { used_percentage: 41 } },
    });
    const s = parseSessionInput(raw);
    expect(s.contextUsedPct).toBe(8);
    expect(s.cacheReadTokens).toBe(2000);
    expect(s.costUsd).toBeCloseTo(0.0123);
    expect(s.fiveHourPct).toBe(23.5);
    expect(s.modelName).toBe("Opus");
    expect(s.cwd).toBe("/proj");
  });

  it("never throws on malformed or empty input", () => {
    // Malformed input yields all-undefined fields (never throws); the renderer
    // then omits every optional section.
    for (const bad of ["", "{not json", "[]", '{"context_window":42}']) {
      const s = parseSessionInput(bad);
      expect(s.contextUsedPct).toBeUndefined();
      expect(s.costUsd).toBeUndefined();
      expect(s.fiveHourPct).toBeUndefined();
      expect(s.cwd).toBeUndefined();
    }
  });
});

describe("upstreamLabel", () => {
  it("labels known upstreams", () => {
    expect(upstreamLabel("https://golem-x.services.ai.azure.com")).toBe("foundry");
    expect(upstreamLabel("https://api.anthropic.com")).toBe("anthropic");
    expect(upstreamLabel("https://openrouter.ai/api")).toBe("openrouter");
    expect(upstreamLabel("https://gw.example.com")).toBe("gw.example.com");
    expect(upstreamLabel("not-a-url")).toBe("upstream");
  });
});

describe("isBlockedFresh (stale 'waiting' self-heals)", () => {
  const now = Date.parse("2026-07-06T12:00:00Z");
  it("is true for a recent blocked timestamp", () => {
    expect(isBlockedFresh("2026-07-06T11:55:00Z", now)).toBe(true); // 5 min ago
  });
  it("is false for a stale one (past the TTL)", () => {
    expect(isBlockedFresh("2026-07-06T11:30:00Z", now)).toBe(false); // 30 min ago
  });
  it("is false for a garbage or future timestamp", () => {
    expect(isBlockedFresh("not-a-date", now)).toBe(false);
    expect(isBlockedFresh("2026-07-06T12:05:00Z", now)).toBe(false);
  });
});

describe("renderStatusLine", () => {
  it("renders the core line without color, leading with the level name", () => {
    const line = renderStatusLine(
      { contextUsedPct: 8, costUsd: 0.0123, fiveHourPct: 23 },
      {
        sliderLevel: 3,
        upstreamLabel: "foundry",
        tokensBefore: 12300,
        tokensAfter: 8100,
        proxyRunning: true,
      },
    );
    expect(line).toContain("⬢ Golem: Balanced");
    expect(line).toContain("→foundry");
    expect(line).toContain("saved 34% (12.3k→8.1k)");
    expect(line).toContain("ctx 8%");
    expect(line).toContain("5h 23%");
    expect(line).toContain("$0.012");
    // no-color mode emits no escape bytes
    expect(line).not.toContain(String.fromCharCode(27));
  });

  it("shows a hollow icon + 'proxy off' and HIDES the upstream when not running", () => {
    const line = renderStatusLine(
      {},
      { sliderLevel: 1, upstreamLabel: "foundry", proxyRunning: false },
    );
    expect(line).toContain("⬡ Golem: Lossless");
    expect(line).toContain("proxy off");
    // Nothing is going to the upstream when the proxy is off — don't imply it is.
    expect(line).not.toContain("→foundry");
  });

  it("omits sections whose data is absent", () => {
    const line = renderStatusLine({}, { sliderLevel: 2, upstreamLabel: "anthropic" });
    expect(line).toContain("⬢ Golem: Conservative");
    expect(line).not.toContain("saved");
    expect(line).not.toContain("ctx");
    expect(line).not.toContain("5h");
    expect(line).not.toContain("$");
  });

  it("emits ANSI escapes when color is on", () => {
    const line = renderStatusLine(
      {},
      { sliderLevel: 1, upstreamLabel: "foundry" },
      { color: true },
    );
    expect(line).toContain(String.fromCharCode(27));
  });

  it("does not show savings when nothing has been recorded", () => {
    const line = renderStatusLine(
      {},
      { sliderLevel: 1, upstreamLabel: "foundry", tokensBefore: 0, tokensAfter: 0 },
    );
    expect(line).not.toContain("saved");
  });
});

describe("collectGolemState", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-statusline-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns sane defaults for a bare project dir with no Golem state", async () => {
    const state = await collectGolemState(dir);
    expect(state.sliderLevel).toBe(1);
    expect(state.upstreamLabel).toBe("anthropic");
    expect(state.tokensBefore).toBeUndefined();
    expect(state.tokensAfter).toBeUndefined();
    expect(state.blocked).toBeUndefined();
  });

  describe("proxy running", () => {
    it("is true when the pid file points at this (alive) process", async () => {
      await writeProxyPid(dir, { pid: process.pid, port: 4653, ts: "2026-07-08T00:00:00Z" });
      const state = await collectGolemState(dir);
      expect(state.proxyRunning).toBe(true);
    });

    it("is false when the pid file points at a certainly-dead pid", async () => {
      await writeProxyPid(dir, { pid: 2_000_000_000, port: 4653, ts: "2026-07-08T00:00:00Z" });
      const state = await collectGolemState(dir);
      expect(state.proxyRunning).toBe(false);
    });

    it("resolves with defaults (does not throw) on a corrupt pid file", async () => {
      await mkdir(path.dirname(proxyPidPath(dir)), { recursive: true });
      await writeFile(proxyPidPath(dir), "{bad json", "utf8");
      await expect(collectGolemState(dir)).resolves.toBeDefined();
      const state = await collectGolemState(dir);
      expect(state.proxyRunning).toBe(false);
    });
  });

  describe("blocked", () => {
    it("is true for a fresh blocked session state", async () => {
      await writeSessionState(dir, { blocked: true, ts: new Date().toISOString() });
      const state = await collectGolemState(dir);
      expect(state.blocked).toBe(true);
    });

    it("is not set for a stale blocked session state", async () => {
      const staleTs = new Date(Date.now() - BLOCKED_STALE_MS - 60_000).toISOString();
      await writeSessionState(dir, { blocked: true, ts: staleTs });
      const state = await collectGolemState(dir);
      expect(state.blocked).toBeFalsy();
    });

    it("resolves with defaults (does not throw) on a corrupt session-state file", async () => {
      await mkdir(path.dirname(sessionStatePath(dir)), { recursive: true });
      await writeFile(sessionStatePath(dir), "{bad json", "utf8");
      const state = await collectGolemState(dir);
      expect(state.blocked).toBeUndefined();
    });
  });

  describe("telemetry aggregate", () => {
    it("includes tokensBefore/tokensAfter once telemetry has at least one request", async () => {
      const store = openTelemetryStore(dir);
      await store.record({
        ts: "2026-07-08T00:00:00.000Z",
        projectId: "projA",
        level: 1,
        requestTokens: { tokensBefore: 1000, tokensAfter: 400 },
        stageSavings: { dedup: { tokensBefore: 1000, tokensAfter: 400 } },
        ccrRefsStored: 1,
      });
      await store.close();

      const state = await collectGolemState(dir);
      expect(state.tokensBefore).toBe(1000);
      expect(state.tokensAfter).toBe(400);
    });

    it("omits tokens fields when the telemetry store has no requests yet", async () => {
      // Touch the store without recording anything (empty/unseeded).
      const store = openTelemetryStore(dir);
      await store.close();

      const state = await collectGolemState(dir);
      expect(state.tokensBefore).toBeUndefined();
      expect(state.tokensAfter).toBeUndefined();
    });
  });

  it("never throws or rejects when every piece of state is corrupt at once", async () => {
    await mkdir(path.dirname(proxyPidPath(dir)), { recursive: true });
    await writeFile(proxyPidPath(dir), "{bad json", "utf8");
    await mkdir(path.dirname(sessionStatePath(dir)), { recursive: true });
    await writeFile(sessionStatePath(dir), "{bad json", "utf8");

    await expect(collectGolemState(dir)).resolves.toStrictEqual({
      sliderLevel: 1,
      upstreamLabel: "anthropic",
      proxyRunning: false,
    });
  });
});
