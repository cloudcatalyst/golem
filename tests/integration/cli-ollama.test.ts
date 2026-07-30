/**
 * WS-D / spec Decision 26 — `golem ollama status` / `golem ollama setup`
 * engine tests. Everything OS-touching is faked: no real Ollama, no real
 * winget/brew/install.sh. The highest-value coverage here is
 * `runOllamaSetup`'s consent/TTY/--yes gating.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectOllamaStatus,
  renderOllamaStatus,
  renderSetupResult,
  runOllamaSetup,
  SetupRefusedError,
} from "../../src/cli/ollama.js";
import type { ProbeCommand, ProbeResult, ProbeRunner } from "../../src/inference/capability.js";
import {
  createOllamaBootstrapDeps,
  type OllamaBootstrapDeps,
} from "../../src/inference/ollama-bootstrap.js";
import { OllamaNativeClient } from "../../src/inference/ollama-native.js";
import { rmTemp } from "../helpers/tmp.js";

function fakeRunner(table: Record<string, ProbeResult>): ProbeRunner {
  return (cmd: ProbeCommand) => {
    const key = [cmd.command, ...cmd.args].join(" ");
    return Promise.resolve(table[key] ?? { ok: false, stdout: "" });
  };
}

/** Forces detectCapability to P_MID (qwen2.5-coder:7b), matching a real RTX 3070 laptop. */
const PMID_PROBE_TABLE: Record<string, ProbeResult> = {
  "nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits": {
    ok: true,
    stdout: "8192, NVIDIA RTX 3070 Laptop GPU",
  },
};

let projectDir: string;
let userDir: string;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "golem-ollama-cli-"));
  projectDir = join(root, "project");
  userDir = join(root, "user");
  await mkdir(projectDir, { recursive: true });
  await mkdir(userDir, { recursive: true });
});

afterEach(async () => {
  await rm(join(projectDir, ".."), rmTemp);
});

describe("collectOllamaStatus", () => {
  it("reports not-installed/not-reachable/not-pulled with the tier's target model", async () => {
    const deps = createOllamaBootstrapDeps({
      probe: fakeRunner(PMID_PROBE_TABLE),
      native: new OllamaNativeClient({ baseUrl: "http://127.0.0.1:1" }),
      platform: "win32",
    });

    const report = await collectOllamaStatus({ projectDir, userDir, deps });
    expect(report).toEqual({
      installed: false,
      reachable: false,
      tier: 2,
      tierName: "P_MID",
      targetModel: "qwen2.5-coder:7b",
      modelPulled: false,
      baseUrl: "http://localhost:11434",
    });
  });

  it("reports installed/reachable/pulled once the daemon and model are present", async () => {
    const native = new OllamaNativeClient();
    vi.spyOn(native, "isReachable").mockResolvedValue(true);
    vi.spyOn(native, "hasModel").mockResolvedValue(true);
    const deps = createOllamaBootstrapDeps({
      probe: fakeRunner({
        ...PMID_PROBE_TABLE,
        "ollama --version": { ok: true, stdout: "0.1.0" },
      }),
      native,
      platform: "win32",
    });

    const report = await collectOllamaStatus({ projectDir, userDir, deps });
    expect(report.installed).toBe(true);
    expect(report.reachable).toBe(true);
    expect(report.modelPulled).toBe(true);
  });

  it("renders human-readable and JSON forms", async () => {
    const deps = createOllamaBootstrapDeps({
      probe: fakeRunner(PMID_PROBE_TABLE),
      native: new OllamaNativeClient({ baseUrl: "http://127.0.0.1:1" }),
      platform: "win32",
    });
    const report = await collectOllamaStatus({ projectDir, userDir, deps });

    const text = renderOllamaStatus(report, false);
    expect(text).toContain("not installed");
    expect(text).toContain("qwen2.5-coder:7b");
    expect(text).toContain("golem ollama setup");

    const json = JSON.parse(renderOllamaStatus(report, true));
    expect(json).toEqual(report);
  });
});

function fakeSetupDeps(overrides: Partial<OllamaBootstrapDeps> = {}): OllamaBootstrapDeps {
  return createOllamaBootstrapDeps({
    probe: fakeRunner(PMID_PROBE_TABLE),
    runInstallCommand: vi.fn(() => Promise.resolve({ ok: true, code: 0 })),
    downloadScript: vi.fn(() => Promise.resolve()),
    runScriptFile: vi.fn(() => Promise.resolve({ ok: true, code: 0 })),
    native: new OllamaNativeClient(),
    platform: "win32",
    ...overrides,
  });
}

describe("runOllamaSetup — consent gating", () => {
  it("throws SetupRefusedError without ever calling confirm when stdin is not a TTY and --yes was not passed", async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    await expect(
      runOllamaSetup({
        projectDir,
        userDir,
        yes: false,
        isTTY: false,
        confirm,
        deps: fakeSetupDeps(),
      }),
    ).rejects.toBeInstanceOf(SetupRefusedError);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("cancels cleanly (not an error) when a TTY user declines", async () => {
    const confirm = vi.fn(() => Promise.resolve(false));
    const deps = fakeSetupDeps();
    const result = await runOllamaSetup({
      projectDir,
      userDir,
      yes: false,
      isTTY: true,
      confirm,
      deps,
    });
    expect(result).toEqual({ kind: "cancelled" });
    expect(deps.runInstallCommand).not.toHaveBeenCalled();
  });

  it("proceeds when a TTY user accepts", async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const native = new OllamaNativeClient();
    vi.spyOn(native, "isReachable").mockResolvedValue(true);
    vi.spyOn(native, "hasModel").mockResolvedValue(true);
    const deps = fakeSetupDeps({ native });

    const result = await runOllamaSetup({
      projectDir,
      userDir,
      yes: false,
      isTTY: true,
      confirm,
      deps,
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(result.kind).toBe("completed");
  });

  it("proceeds without prompting when --yes is passed, even off a TTY", async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const native = new OllamaNativeClient();
    vi.spyOn(native, "isReachable").mockResolvedValue(true);
    vi.spyOn(native, "hasModel").mockResolvedValue(true);
    const deps = fakeSetupDeps({ native });

    const result = await runOllamaSetup({
      projectDir,
      userDir,
      yes: true,
      isTTY: false,
      confirm,
      deps,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(result.kind).toBe("completed");
  });
});

describe("runOllamaSetup — happy path", () => {
  it("installs, pulls the tier's model, and smoke-tests it end to end (all faked)", async () => {
    const native = new OllamaNativeClient();
    vi.spyOn(native, "isReachable").mockResolvedValue(true);
    vi.spyOn(native, "hasModel").mockResolvedValue(false);
    vi.spyOn(native, "pull").mockResolvedValue();
    const deps = fakeSetupDeps({
      probe: fakeRunner({ ...PMID_PROBE_TABLE, "winget --version": { ok: true, stdout: "" } }),
      native,
    });

    const lines: string[] = [];
    const result = await runOllamaSetup({
      projectDir,
      userDir,
      yes: true,
      deps,
      onLine: (l) => lines.push(l),
      // Fake the smoke test too — the default builds a real OllamaClient, and
      // on a machine with a live local Ollama this "all faked" test would
      // otherwise trigger a real model generation (and time out).
      smokeTest: () => Promise.resolve({ ok: true, detail: "OK" }),
    });

    expect(result.kind).toBe("completed");
    expect(result.install?.alreadyInstalled).toBe(false);
    expect(result.install?.plan.kind).toBe("winget");
    expect(result.pull).toEqual({ model: "qwen2.5-coder:7b", alreadyPulled: false });
    expect(deps.runInstallCommand).toHaveBeenCalledOnce();
    expect(native.pull).toHaveBeenCalledOnce();

    const rendered = renderSetupResult(result);
    expect(rendered).toContain("Installed Ollama");
    expect(rendered).toContain("Pulled model qwen2.5-coder:7b");
  });

  it("stops after install with no pull attempt when the install plan is manual", async () => {
    const deps = fakeSetupDeps({ probe: fakeRunner({}), platform: "win32" });
    const result = await runOllamaSetup({ projectDir, userDir, yes: true, deps });

    expect(result.kind).toBe("completed");
    expect(result.install?.plan.kind).toBe("manual");
    expect(result.pull).toBeUndefined();
    expect(deps.runInstallCommand).not.toHaveBeenCalled();

    const rendered = renderSetupResult(result);
    expect(rendered).toContain("Install it manually");
  });

  it("completes with no pull result when the daemon never becomes reachable", async () => {
    const native = new OllamaNativeClient();
    vi.spyOn(native, "isReachable").mockResolvedValue(false);
    const deps = fakeSetupDeps({
      probe: fakeRunner({ "ollama --version": { ok: true, stdout: "" } }),
      native,
    });

    const result = await runOllamaSetup({
      projectDir,
      userDir,
      yes: true,
      deps,
      reachableTimeoutMs: 10,
    });
    expect(result.kind).toBe("completed");
    expect(result.install?.alreadyInstalled).toBe(true);
    expect(result.pull).toBeUndefined();

    const rendered = renderSetupResult(result);
    expect(rendered).toContain("did not become reachable yet");
  });
});
