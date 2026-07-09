/**
 * WS-D — Golem-managed Ollama install + model pull (spec Decision 26). The
 * only module in this codebase that installs software or downloads a model;
 * it is never invoked automatically — `golem init` and proxy auto-start never
 * import this file. The sole call site is `golem ollama setup`
 * (`src/cli/ollama.ts`), which gates every call here behind explicit consent.
 *
 * "One shared model across all Golem projects on a machine" needs no new
 * architecture here: Ollama is already a single machine-wide daemon,
 * `detectCapability()` already probes real hardware machine-wide (not per
 * project), and `"drafter"` is the only role any call site in this codebase
 * ever invokes. This module only closes the actual gap: nothing installs
 * Ollama or pulls that one model.
 *
 * Platform install plans:
 *   - Windows: `winget install -e --id Ollama.Ollama ...` if winget is
 *     present, else a manual pointer to https://ollama.com/download.
 *   - macOS: `brew install ollama` if Homebrew is present, else the same
 *     manual pointer.
 *   - Linux: download https://ollama.com/install.sh to a temp file and
 *     execute that file directly via an argument array
 *     (`spawn("sh", [scriptPath])`) — never a piped `curl | sh` shell
 *     string. The downloaded artifact genuinely is a shell script, so
 *     invoking `sh` on it is not shell-string command *construction* from
 *     untrusted input; it is the one legitimate exception to "argument
 *     arrays, not shell strings" in this module.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HardwareTier } from "../interfaces/inference.js";
import type { ProbeCommand, ProbeRunner } from "./capability.js";
import { chatModelFor } from "./catalog.js";
import {
  createInstallCommandRunner,
  createScriptDownloader,
  DEFAULT_INSTALL_TIMEOUT_MS,
  type InstallCommandRunner,
  type OutputSink,
  type RunOutcome,
  type ScriptDownloader,
} from "./install-runner.js";
import type { OllamaClient } from "./ollama-client.js";
import { OllamaNativeClient, type PullProgressEvent } from "./ollama-native.js";
import { createProbeRunner } from "./probe.js";

export const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";
export const OLLAMA_LINUX_INSTALL_SCRIPT_URL = "https://ollama.com/install.sh";
const DEFAULT_REACHABLE_TIMEOUT_MS = 30_000;
const REACHABLE_POLL_INTERVAL_MS = 1_000;

export type InstallMethodKind =
  | "winget"
  | "homebrew"
  | "linux-script"
  | "manual"
  | "already-installed";

export interface InstallPlan {
  readonly kind: InstallMethodKind;
  readonly summary: string;
  readonly command?: ProbeCommand;
  readonly scriptUrl?: string;
  readonly manualUrl?: string;
}

export interface InstallEnvironment {
  readonly platform: NodeJS.Platform;
  readonly hasWinget: boolean;
  readonly hasHomebrew: boolean;
}

function manualPlan(reason: string): InstallPlan {
  return {
    kind: "manual",
    summary: `Install Ollama manually from ${OLLAMA_DOWNLOAD_URL} (${reason})`,
    manualUrl: OLLAMA_DOWNLOAD_URL,
  };
}

/** PURE — resolve which install method to use for an already-detected environment. */
export function resolveInstallPlan(env: InstallEnvironment): InstallPlan {
  if (env.platform === "win32") {
    if (!env.hasWinget) return manualPlan("winget is not available");
    return {
      kind: "winget",
      summary: "Install Ollama via winget (Ollama.Ollama)",
      command: {
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
    };
  }
  if (env.platform === "darwin") {
    if (!env.hasHomebrew) return manualPlan("Homebrew is not available");
    return {
      kind: "homebrew",
      summary: "Install Ollama via Homebrew",
      command: { command: "brew", args: ["install", "ollama"] },
    };
  }
  if (env.platform === "linux") {
    return {
      kind: "linux-script",
      summary: `Download and run Ollama's official install script (${OLLAMA_LINUX_INSTALL_SCRIPT_URL})`,
      scriptUrl: OLLAMA_LINUX_INSTALL_SCRIPT_URL,
    };
  }
  return manualPlan(`unsupported platform "${env.platform}"`);
}

/** Probes only the package manager relevant to the current OS (never both, never on Linux). */
export async function detectInstallEnvironment(
  run: ProbeRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<InstallEnvironment> {
  const hasWinget =
    platform === "win32" ? (await run({ command: "winget", args: ["--version"] })).ok : false;
  const hasHomebrew =
    platform === "darwin" ? (await run({ command: "brew", args: ["--version"] })).ok : false;
  return { platform, hasWinget, hasHomebrew };
}

/** Is `ollama` already resolvable on PATH? */
export async function isOllamaInstalled(run: ProbeRunner): Promise<boolean> {
  const res = await run({ command: "ollama", args: ["--version"] });
  return res.ok;
}

export interface OllamaBootstrapDeps {
  readonly probe: ProbeRunner;
  readonly runInstallCommand: InstallCommandRunner;
  readonly downloadScript: ScriptDownloader;
  readonly runScriptFile: InstallCommandRunner;
  readonly native: OllamaNativeClient;
  readonly platform: NodeJS.Platform;
  readonly onOutput?: OutputSink;
}

/** Wires the real implementations. The only place this feature touches the OS "for real". */
export function createOllamaBootstrapDeps(
  overrides: Partial<OllamaBootstrapDeps> = {},
): OllamaBootstrapDeps {
  return {
    probe: overrides.probe ?? createProbeRunner(),
    runInstallCommand: overrides.runInstallCommand ?? createInstallCommandRunner(),
    downloadScript: overrides.downloadScript ?? createScriptDownloader(),
    runScriptFile: overrides.runScriptFile ?? createInstallCommandRunner(),
    native: overrides.native ?? new OllamaNativeClient(),
    platform: overrides.platform ?? process.platform,
    ...(overrides.onOutput !== undefined && { onOutput: overrides.onOutput }),
  };
}

export interface InstallResult {
  readonly alreadyInstalled: boolean;
  readonly plan: InstallPlan;
  readonly outcome?: RunOutcome;
}

/** Idempotent: no-ops if `ollama` is already on PATH. */
export async function installOllama(deps: OllamaBootstrapDeps): Promise<InstallResult> {
  if (await isOllamaInstalled(deps.probe)) {
    return {
      alreadyInstalled: true,
      plan: { kind: "already-installed", summary: "Ollama is already installed" },
    };
  }

  const env = await detectInstallEnvironment(deps.probe, deps.platform);
  const plan = resolveInstallPlan(env);

  if (plan.kind === "manual") {
    return { alreadyInstalled: false, plan };
  }

  if (plan.kind === "winget" || plan.kind === "homebrew") {
    if (plan.command === undefined) {
      throw new Error(`install plan "${plan.kind}" is missing a command`);
    }
    const outcome = await deps.runInstallCommand(plan.command, {
      ...(deps.onOutput !== undefined && { onOutput: deps.onOutput }),
      timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    });
    return { alreadyInstalled: false, plan, outcome };
  }

  // linux-script: download the official install.sh to a temp file, then
  // execute that file directly (argument array) — never a piped shell string.
  if (plan.scriptUrl === undefined) {
    throw new Error('install plan "linux-script" is missing a scriptUrl');
  }
  const scriptDir = await mkdtemp(path.join(os.tmpdir(), "golem-ollama-install-"));
  const scriptPath = path.join(scriptDir, "install.sh");
  try {
    await deps.downloadScript(plan.scriptUrl, scriptPath);
    const outcome = await deps.runScriptFile(
      { command: "sh", args: [scriptPath] },
      {
        ...(deps.onOutput !== undefined && { onOutput: deps.onOutput }),
        timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
      },
    );
    return { alreadyInstalled: false, plan, outcome };
  } finally {
    await rm(scriptDir, { recursive: true, force: true });
  }
}

export interface PullResult {
  readonly model: string;
  readonly alreadyPulled: boolean;
}

/** The daemon never became reachable within the polling window. */
export class OllamaNotReadyError extends Error {}

async function waitForReachable(native: OllamaNativeClient, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await native.isReachable()) return true;
    await new Promise((resolve) => setTimeout(resolve, REACHABLE_POLL_INTERVAL_MS));
  }
  return native.isReachable();
}

/** Waits (bounded) for the daemon, then pulls the tier's drafter model if absent. */
export async function pullDrafterModel(
  deps: OllamaBootstrapDeps,
  tier: HardwareTier,
  opts: {
    readonly onProgress?: (e: PullProgressEvent) => void;
    readonly reachableTimeoutMs?: number;
  } = {},
): Promise<PullResult> {
  const model = chatModelFor(tier, "drafter");
  const reachable = await waitForReachable(
    deps.native,
    opts.reachableTimeoutMs ?? DEFAULT_REACHABLE_TIMEOUT_MS,
  );
  if (!reachable) {
    throw new OllamaNotReadyError(
      "Ollama did not become reachable in time — start it manually and re-run `golem ollama setup`",
    );
  }
  if (await deps.native.hasModel(model)) {
    return { model, alreadyPulled: true };
  }
  await deps.native.pull(model, opts.onProgress);
  return { model, alreadyPulled: false };
}

/** Minimal post-pull smoke test through the existing OpenAI-compat client. */
export async function smokeTestModel(
  client: OllamaClient,
  model: string,
): Promise<{ readonly ok: boolean; readonly detail: string }> {
  try {
    const result = await client.chat({
      model,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      maxTokens: 16,
    });
    return { ok: true, detail: result.text.trim() };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
