/**
 * Decision 21c — golem statusline: defensive stdin parsing + pure rendering.
 */

import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proxyPidPath, writeProxyPid } from "../../../src/cli/proxy-daemon.js";
import {
  BLOCKED_STALE_MS,
  collectGolemState,
  isBlockedFresh,
  parseSessionInput,
  providerUpstreamLabel,
  renderStatusLine,
  upstreamLabel,
} from "../../../src/cli/statusline.js";
import { writeSetting } from "../../../src/config/index.js";
import { sessionStatePath, writeSessionState } from "../../../src/hooks/index.js";
import { writeServedModel } from "../../../src/proxy/index.js";
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

describe("providerUpstreamLabel (R6.2)", () => {
  it("shows the account id when one is active", () => {
    expect(providerUpstreamLabel("openai", "https://api.openai.com/v1", "work")).toBe("work");
  });
  it("names a translating provider when no account is active", () => {
    expect(providerUpstreamLabel("ollama", "http://gpubox.lan:11434/v1", null)).toBe("ollama");
    expect(providerUpstreamLabel("gemini", "https://generativelanguage.googleapis.com", null)).toBe(
      "gemini",
    );
    expect(providerUpstreamLabel("openai", "https://api.openai.com/v1", null)).toBe("openai");
  });
  it("falls back to the URL label for Anthropic-family providers", () => {
    expect(providerUpstreamLabel("anthropic", "https://api.anthropic.com", null)).toBe("anthropic");
    expect(providerUpstreamLabel("azure-foundry", "https://x.services.ai.azure.com", null)).toBe(
      "foundry",
    );
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
  it("renders the core one-liner without color: brand · level → destination", () => {
    const line = renderStatusLine(
      // Session signals are captured but intentionally not rendered yet (deferred).
      { contextUsedPct: 8, costUsd: 0.0123, fiveHourPct: 23 },
      {
        sliderLevel: 3,
        upstreamLabel: "foundry",
        tokensBefore: 12300,
        tokensAfter: 8100,
        proxyRunning: true,
      },
    );
    expect(line).toContain("⬢ Golem · Aggressive");
    expect(line).toContain("→ foundry");
    // Savings moved to the fuller summary; ctx/5h/$ are deferred off the line.
    expect(line).not.toContain("saved");
    expect(line).not.toContain("ctx");
    expect(line).not.toContain("5h");
    expect(line).not.toContain("$");
    // no-color mode emits no escape bytes
    expect(line).not.toContain(String.fromCharCode(27));
  });

  it("names each backend with its own versioned model (Decision 23 format)", () => {
    const line = renderStatusLine(
      {},
      {
        sliderLevel: 1,
        upstreamLabel: "anthropic",
        lastServedModel: "claude-opus-4-8[1m]",
        localModelReachable: true,
        localCoderModel: "qwen2.5-coder:7b",
        proxyRunning: true,
      },
    );
    expect(line).toContain("⬢ Golem · Lossless → local (Qwen 2.5) + anthropic (Opus 4.8)");
  });

  it("shows the configured model in the destination when nothing served yet", () => {
    const line = renderStatusLine(
      {},
      {
        sliderLevel: 1,
        upstreamLabel: "kimi",
        upstreamProvider: "openai",
        upstreamModel: "kimi-k3",
        proxyRunning: true,
      },
    );
    expect(line).toContain("→ kimi (kimi-k3)");
  });

  it("prefers the last-served model over the configured default", () => {
    const line = renderStatusLine(
      {},
      {
        sliderLevel: 1,
        upstreamLabel: "kimi",
        upstreamProvider: "openai",
        upstreamModel: "kimi-k3",
        lastServedModel: "kimi-k3-turbo",
      },
    );
    expect(line).toContain("→ kimi (kimi-k3-turbo)");
  });

  it("prefixes a bare 'local' when the local model is up but its id is unknown", () => {
    const line = renderStatusLine(
      {},
      {
        sliderLevel: 1,
        upstreamLabel: "kimi",
        upstreamModel: "kimi-k3",
        localModelReachable: true,
        proxyRunning: true,
      },
    );
    expect(line).toContain("→ local + kimi (kimi-k3)");
  });

  it("omits the local prefix when the local coder is disabled, even if reachable", () => {
    const line = renderStatusLine(
      {},
      {
        sliderLevel: 1,
        upstreamLabel: "kimi",
        upstreamModel: "kimi-k3",
        localModelReachable: true,
        localCoderEnabled: false,
        localCoderModel: "qwen2.5-coder:7b",
        proxyRunning: true,
      },
    );
    expect(line).toContain("→ kimi (kimi-k3)");
    expect(line).not.toContain("local");
  });

  it("omits the parenthetical for a plain Anthropic passthrough (no model known)", () => {
    const line = renderStatusLine(
      {},
      { sliderLevel: 1, upstreamLabel: "anthropic", upstreamProvider: "anthropic" },
    );
    expect(line).toContain("→ anthropic");
    expect(line).not.toContain("(");
  });

  it("renders a stopped proxy as hollow 'Passthrough' and still shows the destination", () => {
    const line = renderStatusLine(
      {},
      { sliderLevel: 1, upstreamLabel: "foundry", proxyRunning: false },
    );
    // Proxy off = not transforming traffic → "Passthrough" (not the level name).
    expect(line).toContain("⬡ Golem · Passthrough");
    expect(line).not.toContain("Lossless");
    expect(line).not.toContain("proxy off");
    // The configured destination is still shown (passthrough goes straight there).
    expect(line).toContain("→ foundry");
  });

  it("renders slider level 0 (running) as filled 'Passthrough' with local + upstream", () => {
    const line = renderStatusLine(
      {},
      {
        sliderLevel: 0,
        upstreamLabel: "anthropic",
        proxyRunning: true,
        localModelReachable: true,
      },
    );
    expect(line).toContain("⬢ Golem · Passthrough");
    expect(line).toContain("→ local + anthropic");
  });

  it("appends the waiting/update badges after the destination", () => {
    const line = renderStatusLine(
      {},
      {
        sliderLevel: 2,
        upstreamLabel: "anthropic",
        proxyRunning: true,
        blocked: true,
        updateAvailable: true,
      },
    );
    expect(line).toContain("⬢ Golem · Balanced → anthropic");
    expect(line).toContain("⏸ waiting");
    expect(line).toContain("⇧ update");
  });

  it("emits ANSI escapes when color is on", () => {
    const line = renderStatusLine(
      {},
      { sliderLevel: 1, upstreamLabel: "foundry" },
      { color: true },
    );
    expect(line).toContain(String.fromCharCode(27));
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

  it("does not probe or create .golem in a non-Golem project (no .golem dir)", async () => {
    let probed = false;
    const state = await collectGolemState(dir, {
      localReachable: async () => {
        probed = true;
        return { reachable: true };
      },
    });
    // The status line runs in every project; a repo that never opted into Golem
    // must not be probed, nor gain a `.golem/` folder from the status line.
    expect(probed).toBe(false);
    expect(state.localModelReachable).toBeUndefined();
    await expect(access(path.join(dir, ".golem"))).rejects.toBeDefined();
  });

  it("probes the local model once the project has a .golem dir", async () => {
    await mkdir(path.join(dir, ".golem"), { recursive: true });
    const state = await collectGolemState(dir, {
      localReachable: async () => ({ reachable: true }),
    });
    expect(state.localModelReachable).toBe(true);
  });

  it("reflects the ACTIVE account in the upstream label + provider/model (R6.2)", async () => {
    await writeSetting(
      "project",
      "proxy.accounts",
      [
        {
          id: "kimi",
          provider: "openai",
          base_url: "https://api.moonshot.ai/v1",
          model: "kimi-k3",
        },
      ],
      { projectDir: dir },
    );
    await writeSetting("project", "proxy.active_account", "kimi", { projectDir: dir });
    const state = await collectGolemState(dir, {
      localReachable: async () => ({ reachable: false }),
    });
    expect(state.upstreamLabel).toBe("kimi"); // the account id, not the top-level base URL
    expect(state.upstreamProvider).toBe("openai");
    expect(state.upstreamModel).toBe("kimi-k3");
  });

  it("reads the last-served model from served-model.json (R6.2)", async () => {
    await writeSetting(
      "project",
      "proxy.accounts",
      [
        {
          id: "kimi",
          provider: "openai",
          base_url: "https://api.moonshot.ai/v1",
          model: "kimi-k3",
        },
      ],
      { projectDir: dir },
    );
    await writeSetting("project", "proxy.active_account", "kimi", { projectDir: dir });
    await writeServedModel(dir, {
      model: "kimi-k3-0724",
      servedAtIso: "2026-07-24T00:00:00.000Z",
      accountId: "kimi",
    });
    const state = await collectGolemState(dir, {
      localReachable: async () => ({ reachable: false }),
    });
    expect(state.lastServedModel).toBe("kimi-k3-0724");
  });

  /**
   * The stale-model bug: a snapshot written under a different upstream must not
   * be reported as the current model — the line falls back to the configured one.
   */
  it("ignores a served-model snapshot from a different account", async () => {
    await writeSetting(
      "project",
      "proxy.accounts",
      [
        {
          id: "kimi",
          provider: "openai",
          base_url: "https://api.moonshot.ai/v1",
          model: "kimi-k3",
        },
        { id: "work", provider: "openai", base_url: "https://api.openai.com/v1", model: "gpt-5.2" },
      ],
      { projectDir: dir },
    );
    await writeSetting("project", "proxy.active_account", "work", { projectDir: dir });
    await writeServedModel(dir, {
      model: "kimi-k3-0724",
      servedAtIso: "2026-07-24T00:00:00.000Z",
      accountId: "kimi",
    });
    const state = await collectGolemState(dir, {
      localReachable: async () => ({ reachable: false }),
    });
    expect(state.lastServedModel).toBeUndefined();
    expect(state.upstreamModel).toBe("gpt-5.2"); // falls back to the configured model
  });

  it("labels a translating provider set at the top level (no account)", async () => {
    await writeSetting("project", "proxy.upstream_provider", "ollama", { projectDir: dir });
    await writeSetting("project", "proxy.upstream_base_url", "http://localhost:11434/v1", {
      projectDir: dir,
    });
    const state = await collectGolemState(dir, {
      localReachable: async () => ({ reachable: false }),
    });
    expect(state.upstreamLabel).toBe("ollama");
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

    await expect(
      collectGolemState(dir, { localReachable: async () => ({ reachable: false }) }),
    ).resolves.toStrictEqual({
      sliderLevel: 1,
      upstreamLabel: "anthropic",
      upstreamProvider: "anthropic",
      proxyRunning: false,
      localCoderEnabled: true,
      localModelReachable: false,
    });
  });
});
