/**
 * WS-E task E3 — `golem status` engine tests.
 *
 * Verifies the --json report shape for an initialized vs uninitialized
 * project, config provenance surfacing, and the proxy reachability probe
 * (against a real ephemeral HTTP server and an unused port).
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { golemInit } from "../../src/cli/init.js";
import {
  collectStatus,
  probeProxy,
  renderLimits,
  renderStatus,
  renderUpstream,
  type StatusReport,
} from "../../src/cli/status.js";
import type { LimitPrediction } from "../../src/proxy/index.js";

const VERSION = "0.1.0-test";

/** init requires a Claude Code marker + no headroom wrap; inject a passing probe. */
const passingProbe = {
  claudeCodeInstalled: () => Promise.resolve(true),
  headroomWrapActive: () => Promise.resolve(false),
};

describe("collectStatus", () => {
  let projectDir: string;
  let userDir: string;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "golem-status-"));
    projectDir = join(root, "project");
    userDir = join(root, "user");
    await mkdir(projectDir, { recursive: true });
    await mkdir(userDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(join(projectDir, ".."), { recursive: true, force: true });
  });

  it("reports an uninitialized project with default-layer config", async () => {
    const report = await collectStatus({
      projectDir,
      version: VERSION,
      userDir,
      probeTimeoutMs: 200,
    });

    expect(report.version).toBe(VERSION);
    expect(report.initialized.overall).toBe(false);
    expect(report.initialized.claude_settings).toBe(false);
    expect(report.initialized.golem_settings).toBe(false);
    // Defaults: proxy 4653, slider level 1 from the default layer.
    expect(report.proxy.port).toBe(4653);
    expect(report.slider.level).toBe(1);
    expect(report.slider.layer).toBe("default");
    expect(report.config["slider.level"]).toEqual({ value: 1, layer: "default" });
    expect(report.config["proxy.port"]).toEqual({ value: 4653, layer: "default" });
  });

  it("reports an initialized project and local-layer provenance", async () => {
    await golemInit({ projectDir, probe: passingProbe });
    const report = await collectStatus({
      projectDir,
      version: VERSION,
      userDir,
      probeTimeoutMs: 200,
    });

    expect(report.initialized.overall).toBe(true);
    expect(report.initialized.claude_settings).toBe(true);
    expect(report.initialized.mcp_registered).toBe(true);
    expect(report.initialized.skills).toBe(true);
    expect(report.initialized.golem_settings).toBe(true);
    // init writes slider.level=1 to the gitignored local scope (spec Decision 43).
    expect(report.config["slider.level"]?.layer).toBe("local");
    expect(report.config["slider.level"]?.source).toContain("settings.local.json");
  });

  it("surfaces an env override with env provenance", async () => {
    const report = await collectStatus({
      projectDir,
      version: VERSION,
      userDir,
      probeTimeoutMs: 200,
      env: { GOLEM_SLIDER_LEVEL: "3" },
    });
    expect(report.slider.level).toBe(3);
    expect(report.slider.layer).toBe("env");
    expect(report.slider.source).toBe("GOLEM_SLIDER_LEVEL");
    expect(report.config["slider.level"]).toEqual({
      value: 3,
      layer: "env",
      source: "GOLEM_SLIDER_LEVEL",
    });
  });

  it("reports a reachable local model as local+upstream (Decision 30/31)", async () => {
    const report = await collectStatus({
      projectDir,
      version: VERSION,
      userDir,
      probeTimeoutMs: 200,
      localProbe: async () => ({ reachable: true, coderModel: "qwen2.5-coder:7b" }),
    });
    expect(report.local_model.reachable).toBe(true);
    expect(report.local_model.coder_model).toBe("qwen2.5-coder:7b");
  });
});

describe("probeProxy", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it("returns true when a server answers on the port", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    const port = await new Promise<number>((resolve) => {
      server?.listen(0, "127.0.0.1", () => resolve((server?.address() as AddressInfo).port));
    });
    await expect(probeProxy(port, 500)).resolves.toBe(true);
  });

  it("returns false quickly when nothing is listening", async () => {
    // Port 1 is privileged/unused in test envs; connection is refused fast.
    await expect(probeProxy(1, 300)).resolves.toBe(false);
  });
});

describe("renderStatus", () => {
  const healthyReport: StatusReport = {
    version: "1.2.3",
    project_dir: "/tmp/healthy-project",
    initialized: {
      overall: true,
      claude_settings: true,
      mcp_registered: true,
      skills: true,
      golem_settings: true,
    },
    proxy: { port: 4653, url: "http://localhost:4653", reachable: true },
    upstream: {
      provider: "openai",
      account: "kimi",
      base_url: "https://api.moonshot.ai/v1",
      default_model: "kimi-k3",
    },
    slider: { level: 1, name: "lossless", layer: "project", source: ".golem/settings.json" },
    config: {
      "slider.level": { value: 1, layer: "project", source: ".golem/settings.json" },
      "proxy.port": { value: 4653, layer: "default" },
    },
    local_model: { reachable: true, base_url: "http://localhost:11434" },
    warnings: [],
  };

  const unhealthyReport: StatusReport = {
    version: "1.2.3",
    project_dir: "/tmp/unhealthy-project",
    initialized: {
      overall: false,
      claude_settings: false,
      mcp_registered: true,
      skills: false,
      golem_settings: false,
    },
    proxy: { port: 4653, url: "http://localhost:4653", reachable: false },
    upstream: {
      provider: "anthropic",
      account: null,
      base_url: "https://api.anthropic.com",
      default_model: null,
    },
    slider: { level: 3, name: "aggressive", layer: "env", source: "GOLEM_SLIDER_LEVEL" },
    config: {
      "slider.level": { value: 3, layer: "env", source: "GOLEM_SLIDER_LEVEL" },
      "proxy.port": { value: 4653, layer: "default" },
    },
    local_model: { reachable: false, base_url: "http://localhost:11434" },
    warnings: ["config file .golem/settings.json is malformed JSON; using defaults"],
  };

  it("renders an all-healthy report with [ok] checkboxes, reachable proxy, and no warnings section", () => {
    const output = renderStatus(healthyReport);

    expect(output).toContain("Golem 1.2.3 — /tmp/healthy-project");
    expect(output).toContain("Project wiring (initialized)");
    expect(output).toContain("[ok] .claude/settings.json -> proxy base URL");
    expect(output).toContain("[ok] .mcp.json -> golem MCP server");
    expect(output).toContain("[ok] /golem/* skills installed");
    expect(output).toContain("[ok] .golem/settings.json present");
    expect(output).toContain("Proxy: http://localhost:4653 — reachable");
    expect(output).toContain("Upstream: kimi (openai) · api.moonshot.ai · model kimi-k3");
    expect(output).toContain("Slider: level 1 (lossless) — set by project (.golem/settings.json)");
    expect(output).toContain("Config (value — layer):");
    expect(output).toContain("slider.level = 1 — project (.golem/settings.json)");
    // Default-layer entry has no `source`, so no trailing "(...)" suffix.
    expect(output).toContain("proxy.port = 4653 — default");
    expect(output).not.toContain("proxy.port = 4653 — default (");
    expect(output).not.toContain("Warnings:");
    expect(output).toContain("Inference: local + upstream");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("renders an unhealthy/partial report with [--] checkboxes, unreachable proxy, and a warnings section", () => {
    const output = renderStatus(unhealthyReport);

    expect(output).toContain("Golem 1.2.3 — /tmp/unhealthy-project");
    expect(output).toContain("Project wiring (run `golem init`)");
    expect(output).toContain("[--] .claude/settings.json -> proxy base URL");
    // Mixed state: mcp_registered is true even though the project overall isn't initialized.
    expect(output).toContain("[ok] .mcp.json -> golem MCP server");
    expect(output).toContain("[--] /golem/* skills installed");
    expect(output).toContain("[--] .golem/settings.json present");
    expect(output).toContain(
      "Proxy: http://localhost:4653 — not running (start with `golem proxy`)",
    );
    // No active account, no configured model, host label == provider → just the provider.
    expect(output).toMatch(/Upstream: anthropic(\n| —|$)/m);
    expect(output).toContain("Slider: level 3 (aggressive) — set by env (GOLEM_SLIDER_LEVEL)");
    expect(output).toContain("slider.level = 3 — env (GOLEM_SLIDER_LEVEL)");
    expect(output).toContain("Warnings:");
    expect(output).toContain(
      "  - config file .golem/settings.json is malformed JSON; using defaults",
    );
    expect(output).toContain("Inference: upstream only");
  });

  it("shows the coder model on the Inference line when a local model is reachable", () => {
    const output = renderStatus({
      ...healthyReport,
      local_model: {
        reachable: true,
        coder_model: "qwen2.5-coder:7b",
        base_url: "http://localhost:11434",
      },
    });
    expect(output).toContain("Inference: local + upstream · coder qwen2.5-coder:7b");
  });

  describe("renderUpstream", () => {
    const base = {
      provider: "anthropic",
      account: null,
      base_url: "https://api.anthropic.com",
      default_model: null,
    } as const;

    it("shows the sniffed Claude model as a friendly family label (no configured default)", () => {
      expect(renderUpstream({ ...base, last_served_model: "claude-opus-4-8[1m]" })).toBe(
        "anthropic · model opus",
      );
    });

    it("shows just the provider when nothing has been served yet", () => {
      expect(renderUpstream(base)).toBe("anthropic");
    });

    it("shows a configured default model verbatim (translating upstream)", () => {
      expect(
        renderUpstream({
          provider: "openai",
          account: "kimi",
          base_url: "https://api.moonshot.ai/v1",
          default_model: "kimi-k3",
        }),
      ).toBe("kimi (openai) · api.moonshot.ai · model kimi-k3");
    });

    it("shows both when the served model diverges from a configured default", () => {
      expect(
        renderUpstream({
          provider: "openai",
          account: "kimi",
          base_url: "https://api.moonshot.ai/v1",
          default_model: "kimi-k3",
          last_served_model: "kimi-k3-turbo",
        }),
      ).toBe("kimi (openai) · api.moonshot.ai · default model kimi-k3 · last served kimi-k3-turbo");
    });
  });

  it("renders collectStatus's real output for an uninitialized project (no source suffixes, no warnings)", async () => {
    const root = await mkdtemp(join(tmpdir(), "golem-status-render-"));
    try {
      const projectDir = join(root, "project");
      const userDir = join(root, "user");
      await mkdir(projectDir, { recursive: true });
      await mkdir(userDir, { recursive: true });

      const report = await collectStatus({
        projectDir,
        version: VERSION,
        userDir,
        probeTimeoutMs: 200,
      });
      const output = renderStatus(report);

      expect(output).toContain(`Golem ${VERSION} — ${projectDir}`);
      expect(output).toContain("Project wiring (run `golem init`)");
      expect(output).toContain("[--] .claude/settings.json -> proxy base URL");
      expect(output).toContain(
        "Proxy: http://localhost:4653 — not running (start with `golem proxy`)",
      );
      expect(output).toContain("Slider: level 1 (lossless) — set by default");
      expect(output).toContain("slider.level = 1 — default");
      expect(output).not.toContain("Warnings:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("status — usage-limit prediction freshness", () => {
  const NOW_MS = Date.parse("2026-07-25T00:00:00.000Z");
  const base = (
    projectDir: string,
    userDir: string,
    readLimit: () => Promise<LimitPrediction | null>,
  ) => ({
    projectDir,
    version: VERSION,
    userDir,
    probeTimeoutMs: 200,
    now: () => NOW_MS,
    readLimit,
  });

  let projectDir: string;
  let userDir: string;
  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "golem-status-lim-"));
    projectDir = join(root, "project");
    userDir = join(root, "user");
    await mkdir(projectDir, { recursive: true });
    await mkdir(userDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(join(projectDir, ".."), { recursive: true, force: true });
  });

  it("omits limits entirely when the proxy has never seen the headers", async () => {
    const report = await collectStatus(base(projectDir, userDir, () => Promise.resolve(null)));
    expect(report.limits).toBeUndefined();
    expect(renderStatus(report)).not.toContain("Limits:");
  });

  it("surfaces a fresh reading (not stale, no warning)", async () => {
    const fresh: LimitPrediction = {
      observedAtIso: new Date(NOW_MS - 60_000).toISOString(), // 1 min ago
      fiveHour: { utilization: 0.17, resetAtIso: "2026-07-25T05:00:00.000Z" },
      sevenDay: { utilization: 0.72, resetAtIso: "2026-07-29T09:00:00.000Z" },
    };
    const report = await collectStatus(base(projectDir, userDir, () => Promise.resolve(fresh)));
    expect(report.limits?.stale).toBe(false);
    expect(report.limits?.five_hour_utilization).toBe(0.17);
    expect(report.limits?.seven_day_utilization).toBe(0.72);
    expect(report.warnings.some((w) => w.includes("STALE"))).toBe(false);
    expect(renderStatus(report)).toContain("Limits: 5h window 17% used");
  });

  it("reflects snooze.enforce (env override) in the limits view", async () => {
    const fresh: LimitPrediction = {
      observedAtIso: new Date(NOW_MS - 60_000).toISOString(),
      fiveHour: { utilization: 0.95, resetAtIso: "2026-07-25T05:00:00.000Z" },
    };
    const report = await collectStatus({
      ...base(projectDir, userDir, () => Promise.resolve(fresh)),
      env: { GOLEM_SNOOZE_ENFORCE: "true" },
    });
    expect(report.limits?.enforced).toBe(true);
    expect(renderStatus(report)).toContain("park enforced");
  });

  it("flags a stale reading and adds a warning (feed cold — e.g. account switch)", async () => {
    const stale: LimitPrediction = {
      observedAtIso: new Date(NOW_MS - 9 * 3_600_000).toISOString(), // 9h ago
      fiveHour: { utilization: 0.17, resetAtIso: "2026-07-24T19:40:00.000Z" },
    };
    const report = await collectStatus(base(projectDir, userDir, () => Promise.resolve(stale)));
    expect(report.limits?.stale).toBe(true);
    expect(report.warnings.some((w) => w.includes("STALE"))).toBe(true);
    const out = renderStatus(report);
    expect(out).toContain("Limits: STALE");
    expect(out).toContain("Warnings:");
  });
});

describe("renderLimits", () => {
  it("renders a fresh line with utilization, reset, age, and advisory park mode", () => {
    expect(
      renderLimits({
        five_hour_utilization: 0.42,
        reset_at: "2026-07-25T05:00:00.000Z",
        observed_at: "2026-07-25T00:00:00.000Z",
        age_minutes: 2,
        stale: false,
        enforced: false,
      }),
    ).toBe(
      "Limits: 5h window 42% used (resets 2026-07-25T05:00:00.000Z) · observed 2m ago · park advisory",
    );
  });

  it("shows enforced park mode when enforcement is on", () => {
    const line = renderLimits({
      five_hour_utilization: 0.95,
      reset_at: "2026-07-25T05:00:00.000Z",
      observed_at: "2026-07-25T00:00:00.000Z",
      age_minutes: 1,
      stale: false,
      enforced: true,
    });
    expect(line).toContain("park enforced");
  });

  it("renders a stale line naming the blind auto-park", () => {
    const line = renderLimits({
      five_hour_utilization: 0.17,
      reset_at: null,
      observed_at: "2026-07-24T15:00:00.000Z",
      age_minutes: 540,
      stale: true,
      enforced: false,
    });
    expect(line).toContain("STALE");
    expect(line).toContain("auto-park blind");
    expect(line).toContain("540m ago");
  });
});
