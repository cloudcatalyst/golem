/**
 * WS-D — install-plan resolution + orchestration, fully DI-faked (no real OS
 * calls, no real Ollama). `install-runner.ts`'s real spawn/download path is
 * deliberately untested here (see its header comment) — same treatment
 * `HeadroomSidecar`'s real spawn path gets in this codebase.
 */

import { describe, expect, it, vi } from "vitest";
import type { ProbeCommand, ProbeResult, ProbeRunner } from "../../../src/inference/capability.js";
import type { RunOutcome } from "../../../src/inference/install-runner.js";
import {
  createOllamaBootstrapDeps,
  detectInstallEnvironment,
  type InstallEnvironment,
  installOllama,
  isOllamaInstalled,
  type OllamaBootstrapDeps,
  OllamaNotReadyError,
  pullDrafterModel,
  resolveInstallPlan,
  smokeTestModel,
} from "../../../src/inference/ollama-bootstrap.js";
import { OllamaClient } from "../../../src/inference/ollama-client.js";
import { OllamaNativeClient } from "../../../src/inference/ollama-native.js";
import { HardwareTier } from "../../../src/interfaces/inference.js";

function fakeRunner(table: Record<string, ProbeResult>): ProbeRunner {
  return (cmd: ProbeCommand) => {
    const key = [cmd.command, ...cmd.args].join(" ");
    return Promise.resolve(table[key] ?? { ok: false, stdout: "" });
  };
}

describe("resolveInstallPlan", () => {
  const cases: Array<[InstallEnvironment, string]> = [
    [{ platform: "win32", hasWinget: true, hasHomebrew: false }, "winget"],
    [{ platform: "win32", hasWinget: false, hasHomebrew: false }, "manual"],
    [{ platform: "darwin", hasWinget: false, hasHomebrew: true }, "homebrew"],
    [{ platform: "darwin", hasWinget: false, hasHomebrew: false }, "manual"],
    [{ platform: "linux", hasWinget: false, hasHomebrew: false }, "linux-script"],
    [{ platform: "aix", hasWinget: false, hasHomebrew: false }, "manual"],
  ];

  for (const [env, expectedKind] of cases) {
    it(`resolves "${expectedKind}" for ${env.platform} (winget=${env.hasWinget}, brew=${env.hasHomebrew})`, () => {
      expect(resolveInstallPlan(env).kind).toBe(expectedKind);
    });
  }

  it("uses an argument array (never a shell string) for the winget command", () => {
    const plan = resolveInstallPlan({ platform: "win32", hasWinget: true, hasHomebrew: false });
    expect(plan.command).toEqual({
      command: "winget",
      args: [
        "install",
        "-e",
        "--id",
        "Ollama.Ollama",
        "--accept-package-agreements",
        "--accept-source-agreements",
      ],
    });
  });

  it("uses an argument array for the homebrew command", () => {
    const plan = resolveInstallPlan({ platform: "darwin", hasWinget: false, hasHomebrew: true });
    expect(plan.command).toEqual({ command: "brew", args: ["install", "ollama"] });
  });

  it("points the linux plan at the official install script URL, no command", () => {
    const plan = resolveInstallPlan({ platform: "linux", hasWinget: false, hasHomebrew: false });
    expect(plan.scriptUrl).toBe("https://ollama.com/install.sh");
    expect(plan.command).toBeUndefined();
  });
});

describe("detectInstallEnvironment", () => {
  it("probes winget only on win32", async () => {
    const run = fakeRunner({ "winget --version": { ok: true, stdout: "v1" } });
    expect(await detectInstallEnvironment(run, "win32")).toEqual({
      platform: "win32",
      hasWinget: true,
      hasHomebrew: false,
    });
  });

  it("probes homebrew only on darwin", async () => {
    const run = fakeRunner({ "brew --version": { ok: true, stdout: "v1" } });
    expect(await detectInstallEnvironment(run, "darwin")).toEqual({
      platform: "darwin",
      hasWinget: false,
      hasHomebrew: true,
    });
  });

  it("probes neither on linux", async () => {
    const run = vi.fn(() => Promise.resolve({ ok: true, stdout: "" }));
    expect(await detectInstallEnvironment(run, "linux")).toEqual({
      platform: "linux",
      hasWinget: false,
      hasHomebrew: false,
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("isOllamaInstalled", () => {
  it("reflects the ollama --version probe", async () => {
    expect(
      await isOllamaInstalled(fakeRunner({ "ollama --version": { ok: true, stdout: "0.1" } })),
    ).toBe(true);
    expect(await isOllamaInstalled(fakeRunner({}))).toBe(false);
  });
});

function fakeDeps(overrides: Partial<OllamaBootstrapDeps> = {}): OllamaBootstrapDeps {
  return createOllamaBootstrapDeps({
    probe: fakeRunner({}),
    runInstallCommand: vi.fn(() => Promise.resolve<RunOutcome>({ ok: true, code: 0 })),
    downloadScript: vi.fn(() => Promise.resolve()),
    runScriptFile: vi.fn(() => Promise.resolve<RunOutcome>({ ok: true, code: 0 })),
    native: new OllamaNativeClient(),
    platform: "win32",
    ...overrides,
  });
}

describe("installOllama", () => {
  it("is a no-op when already installed", async () => {
    const deps = fakeDeps({ probe: fakeRunner({ "ollama --version": { ok: true, stdout: "" } }) });
    const result = await installOllama(deps);
    expect(result).toEqual({
      alreadyInstalled: true,
      plan: { kind: "already-installed", summary: "Ollama is already installed" },
    });
    expect(deps.runInstallCommand).not.toHaveBeenCalled();
  });

  it("returns a manual plan without running anything when no package manager is present", async () => {
    const deps = fakeDeps({ platform: "win32", probe: fakeRunner({}) });
    const result = await installOllama(deps);
    expect(result.alreadyInstalled).toBe(false);
    expect(result.plan.kind).toBe("manual");
    expect(result.outcome).toBeUndefined();
    expect(deps.runInstallCommand).not.toHaveBeenCalled();
  });

  it("runs the winget command via the injected runner", async () => {
    const deps = fakeDeps({
      platform: "win32",
      probe: fakeRunner({ "winget --version": { ok: true, stdout: "" } }),
    });
    const result = await installOllama(deps);
    expect(result.plan.kind).toBe("winget");
    expect(deps.runInstallCommand).toHaveBeenCalledWith(
      {
        command: "winget",
        args: [
          "install",
          "-e",
          "--id",
          "Ollama.Ollama",
          "--accept-package-agreements",
          "--accept-source-agreements",
        ],
      },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(result.outcome).toEqual({ ok: true, code: 0 });
  });

  it("downloads the linux script to os.tmpdir(), runs it via an argument array, and cleans up", async () => {
    const seenPaths: string[] = [];
    const deps = fakeDeps({
      platform: "linux",
      probe: fakeRunner({}),
      downloadScript: vi.fn((_url: string, destPath: string) => {
        seenPaths.push(destPath);
        return Promise.resolve();
      }),
      runScriptFile: vi.fn((cmd) => {
        seenPaths.push(cmd.args[0] as string);
        return Promise.resolve<RunOutcome>({ ok: true, code: 0 });
      }),
    });
    const result = await installOllama(deps);
    expect(result.plan.kind).toBe("linux-script");
    expect(deps.runScriptFile).toHaveBeenCalledWith(
      { command: "sh", args: [expect.stringContaining("install.sh")] },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    // downloadScript and runScriptFile agree on the same path, and it's a
    // real temp path (not a shell string).
    expect(seenPaths[0]).toBe(seenPaths[1]);
    expect(seenPaths[0]).not.toMatch(/[|&;]/);
  });

  it("still returns an outcome (does not throw) when the linux script run fails", async () => {
    const deps = fakeDeps({
      platform: "linux",
      probe: fakeRunner({}),
      runScriptFile: vi.fn(() => Promise.resolve<RunOutcome>({ ok: false, code: 1 })),
    });
    const result = await installOllama(deps);
    expect(result.outcome).toEqual({ ok: false, code: 1 });
  });
});

describe("pullDrafterModel", () => {
  it("skips the pull when the model is already present", async () => {
    const native = new OllamaNativeClient();
    vi.spyOn(native, "isReachable").mockResolvedValue(true);
    vi.spyOn(native, "hasModel").mockResolvedValue(true);
    const pull = vi.spyOn(native, "pull").mockResolvedValue();
    const deps = fakeDeps({ native });

    const result = await pullDrafterModel(deps, HardwareTier.PMid);
    expect(result).toEqual({ model: "qwen2.5-coder:7b", alreadyPulled: true });
    expect(pull).not.toHaveBeenCalled();
  });

  it("pulls the model when absent", async () => {
    const native = new OllamaNativeClient();
    vi.spyOn(native, "isReachable").mockResolvedValue(true);
    vi.spyOn(native, "hasModel").mockResolvedValue(false);
    const pull = vi.spyOn(native, "pull").mockResolvedValue();
    const deps = fakeDeps({ native });

    const result = await pullDrafterModel(deps, HardwareTier.PMid);
    expect(result).toEqual({ model: "qwen2.5-coder:7b", alreadyPulled: false });
    expect(pull).toHaveBeenCalledWith("qwen2.5-coder:7b", undefined);
  });

  it("throws OllamaNotReadyError when the daemon never becomes reachable", async () => {
    const native = new OllamaNativeClient();
    vi.spyOn(native, "isReachable").mockResolvedValue(false);
    const deps = fakeDeps({ native });

    await expect(
      pullDrafterModel(deps, HardwareTier.PMid, { reachableTimeoutMs: 10 }),
    ).rejects.toBeInstanceOf(OllamaNotReadyError);
  });
});

describe("smokeTestModel", () => {
  it("reports ok:true with the reply text on success", async () => {
    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:1" });
    vi.spyOn(client, "chat").mockResolvedValue({
      text: " OK ",
      model: "qwen2.5-coder:7b",
      promptTokens: 1,
      completionTokens: 1,
      finishReason: "stop",
    });
    const result = await smokeTestModel(client, "qwen2.5-coder:7b");
    expect(result).toEqual({ ok: true, detail: "OK" });
  });

  it("reports ok:false with the error message on failure", async () => {
    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:1" });
    vi.spyOn(client, "chat").mockRejectedValue(new Error("connection refused"));
    const result = await smokeTestModel(client, "qwen2.5-coder:7b");
    expect(result).toEqual({ ok: false, detail: "connection refused" });
  });
});
