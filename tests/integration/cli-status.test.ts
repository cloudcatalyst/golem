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
import { collectStatus, probeProxy } from "../../src/cli/status.js";

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

  it("reports an initialized project and project-layer provenance", async () => {
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
    // init writes slider.level=1 at project scope.
    expect(report.config["slider.level"]?.layer).toBe("project");
    expect(report.config["slider.level"]?.source).toContain("settings.json");
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
