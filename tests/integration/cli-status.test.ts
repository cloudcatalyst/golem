/**
 * WS-E task E3 — `golem status` engine tests.
 *
 * Verifies the --json report shape for an initialized vs uninitialized
 * project, config provenance surfacing, and the proxy reachability probe
 * (against a real ephemeral HTTP server and an unused port).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { writeSetting } from "../../src/config/index.js";
import type { LimitPrediction } from "../../src/proxy/index.js";
import { rmTemp } from "../helpers/tmp.js";

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
    await rm(join(projectDir, ".."), rmTemp);
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

  /**
   * R9.22 — init moved the CA trust to `.claude/settings.local.json`, so status
   * has to look there to answer the colour question. Reading only the committed
   * file would report `wired: false` on a correctly wired project — a green path
   * that works while status calls it broken.
   */
  it("reads the CA trust from settings.local.json (R9.22)", async () => {
    await golemInit({ projectDir, probe: passingProbe });

    // Pin the premise: the committed file must NOT carry the machine-absolute path.
    const committed = JSON.parse(
      await readFile(join(projectDir, ".claude", "settings.json"), "utf8"),
    ) as { env?: Record<string, unknown> };
    expect(committed.env?.NODE_EXTRA_CA_CERTS).toBeUndefined();

    const report = await collectStatus({
      projectDir,
      version: VERSION,
      userDir,
      probeTimeoutMs: 200,
    });

    // `wired` is the whole point: it must come from the local file. (`trusted`
    // and `foreign_ca` read THIS process's env, which the runner inherits from
    // the developer's own session — not something a temp project can pin.)
    expect(report.webfetch_green?.wired).toBe(true);
  });

  /**
   * R8.32 — status now READS `.claude/settings.json` to answer "is Golem in the
   * request path?". The obvious next step is to have it repair what it finds,
   * and that is exactly the mistake R8.31 avoided by keeping `start`/`stop` out
   * of this file. Pinned, because a fix that edits on read would still pass
   * every other assertion here.
   */
  it("never writes .claude/settings.json — reporting the gap must not repair it", async () => {
    await golemInit({ projectDir, probe: passingProbe });
    const settingsPath = join(projectDir, ".claude", "settings.json");
    const before = await readFile(settingsPath, "utf8");

    // The defect state: wiring removed while the daemon would report healthy.
    const parsed = JSON.parse(before) as { env?: Record<string, unknown> };
    delete parsed.env;
    const unwired = JSON.stringify(parsed, null, 2);
    await writeFile(settingsPath, unwired, "utf8");

    const report = await collectStatus({
      projectDir,
      version: VERSION,
      userDir,
      probeTimeoutMs: 200,
    });

    expect(report.proxy.wiring).toBe("none");
    expect(report.proxy.in_path).toBe(false);
    expect(await readFile(settingsPath, "utf8")).toBe(unwired);
  });

  it("distinguishes a foreign ANTHROPIC_BASE_URL from no wiring at all", async () => {
    await golemInit({ projectDir, probe: passingProbe });
    const settingsPath = join(projectDir, ".claude", "settings.json");
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as {
      env?: Record<string, unknown>;
    };
    parsed.env = { ...parsed.env, ANTHROPIC_BASE_URL: "http://localhost:9999" };
    await writeFile(settingsPath, JSON.stringify(parsed, null, 2), "utf8");

    const report = await collectStatus({
      projectDir,
      version: VERSION,
      userDir,
      probeTimeoutMs: 200,
    });

    expect(report.proxy.wiring).toBe("foreign");
    expect(report.proxy.wiring_base_url).toBe("http://localhost:9999");
    expect(report.proxy.in_path).toBe(false);
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
    expect(report.local_model.model).toBe("qwen2.5-coder:7b");
    expect(report.local_model.reachable).toBe(true);
  });

  it("reports the default upstream when inference.default_target is not set", async () => {
    await writeSetting(
      "local",
      "proxy.gateways",
      [
        {
          id: "anthropic",
          provider: "anthropic",
          base_url: "https://api.anthropic.com",
          models: ["claude-opus-5[1m]"],
          auth_scheme: "x-api-key",
        },
      ],
      { projectDir },
    );
    const report = await collectStatus({
      projectDir,
      version: VERSION,
      userDir,
      probeTimeoutMs: 200,
      localProbe: async () => ({ reachable: true, coderModel: "qwen2.5-coder:7b" }),
    });
    expect(report.local_model.reachable).toBe(true);
    expect(report.upstream.provider).toBe("anthropic");
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
    dials: {
      brevity: { setting: "off", effective: "off", pinned: true, layer: "default" },
      compression: { setting: "auto", effective: "1", pinned: false, layer: "default" },
    },
    effective_compression: {
      nominal: 1,
      nominal_name: "lossless",
      effective: 1,
      effective_name: "lossless",
      degraded: false,
    },
    config: {
      "slider.level": { value: 1, layer: "project", source: ".golem/settings.json" },
      "proxy.port": { value: 4653, layer: "default" },
    },
    local_model: { reachable: true, model: "qwen2.5-coder:7b", base_url: "http://localhost:11434" },
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
    dials: {
      brevity: { setting: "off", effective: "off", pinned: true, layer: "default" },
      compression: { setting: "auto", effective: "3", pinned: false, layer: "default" },
    },
    // Level 3 against Anthropic: the §103 degraded case, so renderStatus must say
    // the effective level is 1 rather than letting "aggressive" stand alone.
    effective_compression: {
      nominal: 3,
      nominal_name: "aggressive",
      effective: 1,
      effective_name: "lossless",
      degraded: true,
      reason:
        "the lossy semantic and context-substitution stages are off on a prompt-caching upstream",
    },
    config: {
      "slider.level": { value: 3, layer: "env", source: "GOLEM_SLIDER_LEVEL" },
      "proxy.port": { value: 4653, layer: "default" },
    },
    local_model: { reachable: true, model: "qwen2.5-coder:7b", base_url: "http://localhost:11434" },
    warnings: ["config file .golem/settings.json is malformed JSON; using defaults"],
  };

  /**
   * R8.32 — a reachable proxy nothing is wired to. `reachable` stays true (the
   * daemon really is up), so the honesty has to come from `in_path`.
   */
  describe("running but not in the request path (R8.32)", () => {
    const unwiredReport: StatusReport = {
      ...healthyReport,
      initialized: { ...healthyReport.initialized, overall: false, claude_settings: false },
      proxy: {
        port: 4653,
        url: "http://localhost:4653",
        reachable: true,
        wiring: "none",
        wiring_base_url: null,
        in_path: false,
      },
    };

    it("says so on the proxy line, not just in the checkbox 6 lines above", () => {
      const output = renderStatus(unwiredReport);
      const proxyLine = output.indexOf("Proxy: http://localhost:4653");
      const warning = output.indexOf("NOT in the request path");
      expect(warning).toBeGreaterThan(proxyLine);
      // Adjacent to the proxy line, where the eye lands — the whole defect was
      // that the reader had to correlate two distant lines themselves.
      expect(output.slice(proxyLine, warning)).not.toContain("\n\n");
    });

    it("names `golem proxy wire`, not the far heavier `golem init`", () => {
      const output = renderStatus(unwiredReport);
      expect(output).toContain("golem proxy wire");
      expect(output).toContain("reload the window");
    });

    it("reports a foreign gateway without offering to overwrite it", () => {
      const output = renderStatus({
        ...unwiredReport,
        proxy: {
          ...unwiredReport.proxy,
          wiring: "foreign",
          wiring_base_url: "http://localhost:9999",
        },
      });
      expect(output).toContain("http://localhost:9999");
      expect(output).toContain("another gateway owns it");
      expect(output).not.toContain("golem proxy wire");
    });

    it("stays quiet on the healthy path", () => {
      expect(
        renderStatus({ ...healthyReport, proxy: { ...healthyReport.proxy, in_path: true } }),
      ).not.toContain("NOT in the request path");
    });

    it("stays quiet when the proxy is down — that is R8.31's case, not this one", () => {
      expect(renderStatus(unhealthyReport)).not.toContain("NOT in the request path");
    });
  });

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
    // R9.4: roles, not locality — the coder end can be any target now.
    expect(output).toContain("Inference: chat ");
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
      "Proxy: http://localhost:4653 — not running — the SessionStart hook restarts it on project open",
    );
    // No active account, no configured model, host label == provider → just the provider.
    expect(output).toMatch(/Upstream: anthropic(\n| —|$)/m);
    // §103: this fixture is level 3 against Anthropic, so the HEADLINE itself must
    // name the level that runs. A warning line under a headline still reading
    // "aggressive" was the bug — assert the label, not just the footnote.
    expect(output).toContain(
      "Slider: level 3 (aggressive) → effectively 1 (lossless) — set by env (GOLEM_SLIDER_LEVEL)",
    );
    expect(output).toContain("compression 3→1 (auto — follows slider 3)");
    expect(output).toContain("⚠ level 3 (aggressive) is inert here:");
    expect(output).toContain("slider.level = 3 — env (GOLEM_SLIDER_LEVEL)");
    expect(output).toContain("Warnings:");
    expect(output).toContain(
      "  - config file .golem/settings.json is malformed JSON; using defaults",
    );
    expect(output).toContain("Inference: chat ");
  });

  it("shows the coder model on the Inference line when a local model is reachable", () => {
    const output = renderStatus({
      ...healthyReport,
      local_model: {
        reachable: true,
        model: "qwen2.5-coder:7b",
        base_url: "http://localhost:11434",
      },
    });
    expect(output).toContain("  coder: qwen2.5-coder:7b (local)");
  });

  it("names a configured coder target and flags one that resolves to nothing (R9.4)", () => {
    const output = renderStatus({
      ...healthyReport,
      local_model: {
        reachable: false,
        model: "qwen2.5-coder:7b",
        base_url: "http://localhost:11434",
      },
      // R9.10: workers are top-level — a worker's target need not be local.
      workers: [{ worker: "coder", target: "ghost", target_unknown: true }],
    });
    // An unresolvable default must be called out, not papered over: `coder`
    // fails closed on it rather than quietly drafting on the local model.
    expect(output).toContain('coder: FAILS CLOSED — target "ghost"');
  });

  it("does not advertise a coder model when coder_target resolves to nothing (R9.4)", () => {
    // Regression, found live: this rendered `coder qwen2.5-coder:7b (target
    // ghost)` — a model that will never run, via a target that does not exist,
    // directly contradicting the warning underneath it.
    const output = renderStatus({
      ...healthyReport,
      local_model: {
        reachable: true,
        model: "qwen2.5-coder:7b",
        base_url: "http://localhost:11434",
      },
      workers: [{ worker: "coder", target: "ghost", target_unknown: true }],
    });
    expect(output).toContain('coder: FAILS CLOSED — target "ghost"');
    expect(output).not.toContain("coder qwen2.5-coder:7b");
  });

  it("shows coder on the local model when reachable with no worker targets", () => {
    const output = renderStatus({
      ...healthyReport,
      local_model: {
        reachable: true,
        model: "qwen2.5-coder:7b",
        base_url: "http://localhost:11434",
      },
    });
    expect(output).toContain("coder: qwen2.5-coder:7b (local)");
    expect(output).not.toContain("unavailable");
  });

  describe("renderUpstream", () => {
    const base = {
      provider: "anthropic",
      account: null,
      base_url: "https://api.anthropic.com",
      default_model: null,
    } as const;

    it("shows the sniffed Claude model id verbatim (no configured default)", () => {
      expect(renderUpstream({ ...base, last_served_model: "claude-opus-5[1m]" })).toBe(
        "anthropic · model claude-opus-5[1m]",
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
        // Explicitly empty env: inheriting process.env lets an unrelated
        // GOLEM_* var (e.g. a credential for an account) raise an
        // unknown-setting warning and break the no-warnings assertion.
        env: {},
      });
      const output = renderStatus(report);

      expect(output).toContain(`Golem ${VERSION} — ${projectDir}`);
      expect(output).toContain("Project wiring (run `golem init`)");
      expect(output).toContain("[--] .claude/settings.json -> proxy base URL");
      expect(output).toContain(
        "Proxy: http://localhost:4653 — not running — the SessionStart hook restarts it on project open",
      );
      expect(output).toContain("Slider: level 1 (lossless) — set by default");
      expect(output).toContain("slider.level = 1 — default");
      expect(output).not.toContain("Warnings:");
    } finally {
      await rm(root, rmTemp);
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
    await rm(join(projectDir, ".."), rmTemp);
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
    // Enforcement is ON by default (Decision 45).
    expect(report.limits?.enforced).toBe(true);
    expect(renderStatus(report)).toContain("park enforced");
  });

  it("enforce defaults on; env can override it to advisory", async () => {
    const fresh: LimitPrediction = {
      observedAtIso: new Date(NOW_MS - 60_000).toISOString(),
      fiveHour: { utilization: 0.95, resetAtIso: "2026-07-25T05:00:00.000Z" },
    };
    // Default (no env) → enforced.
    const dflt = await collectStatus(base(projectDir, userDir, () => Promise.resolve(fresh)));
    expect(dflt.limits?.enforced).toBe(true);
    // Env override → advisory.
    const overridden = await collectStatus({
      ...base(projectDir, userDir, () => Promise.resolve(fresh)),
      env: { GOLEM_SNOOZE_ENFORCE: "false" },
    });
    expect(overridden.limits?.enforced).toBe(false);
    expect(renderStatus(overridden)).toContain("park advisory");
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
