/**
 * WS-D / spec Decision 26 — `golem ollama status` / `golem ollama setup`
 * engine. `status` is read-only. `setup` is the ONLY call site in this
 * codebase that installs Ollama or pulls a model — it never runs
 * automatically (not at `golem init`, not at proxy auto-start) and always
 * gates behind explicit consent before touching the OS or downloading a
 * multi-GB model.
 */

import path from "node:path";
import readline from "node:readline/promises";
import { loadConfig } from "../config/index.js";
import {
  chatModelFor,
  createOllamaBootstrapDeps,
  detectCapability,
  detectInstallEnvironment,
  type InstallResult,
  installOllama,
  isOllamaInstalled,
  type OllamaBootstrapDeps,
  OllamaClient,
  OllamaNativeClient,
  OllamaNotReadyError,
  type PullResult,
  pullDrafterModel,
  resolveInstallPlan,
  smokeTestModel,
} from "../inference/index.js";
import type { HardwareTier } from "../interfaces/inference.js";

const TIER_NAMES: Readonly<Record<HardwareTier, string>> = {
  0: "P_CPU",
  1: "P_MIN",
  2: "P_MID",
  3: "P_MAX",
};

export interface OllamaStatusReport {
  readonly installed: boolean;
  readonly reachable: boolean;
  readonly tier: HardwareTier;
  readonly tierName: string;
  readonly targetModel: string;
  readonly modelPulled: boolean;
  readonly baseUrl: string;
}

export interface OllamaStatusOptions {
  readonly projectDir: string;
  readonly deps?: OllamaBootstrapDeps;
  /** Test injection (forwarded to loadConfig). */
  readonly userDir?: string;
}

export async function collectOllamaStatus(opts: OllamaStatusOptions): Promise<OllamaStatusReport> {
  const projectDir = path.resolve(opts.projectDir);
  const { settings } = await loadConfig({
    projectDir,
    ...(opts.userDir !== undefined && { userDir: opts.userDir }),
  });
  const deps = opts.deps ?? createOllamaBootstrapDeps();
  const native =
    opts.deps === undefined
      ? new OllamaNativeClient({ baseUrl: settings.inference.ollama_base_url })
      : deps.native;

  const [installed, facts] = await Promise.all([
    isOllamaInstalled(deps.probe),
    detectCapability(deps.probe),
  ]);
  const targetModel = chatModelFor(facts.tier, "drafter");
  const reachable = await native.isReachable();
  const modelPulled = reachable ? await native.hasModel(targetModel) : false;

  return {
    installed,
    reachable,
    tier: facts.tier,
    tierName: TIER_NAMES[facts.tier],
    targetModel,
    modelPulled,
    baseUrl: settings.inference.ollama_base_url,
  };
}

export function renderOllamaStatus(report: OllamaStatusReport, json: boolean): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  const lines: string[] = [];
  lines.push(
    `Ollama: ${report.installed ? "installed" : "not installed"}, ` +
      `${report.reachable ? "reachable" : "not reachable"} at ${report.baseUrl}`,
  );
  lines.push(`Hardware tier: ${report.tier} (${report.tierName})`);
  lines.push(
    `Drafter model for this tier: ${report.targetModel} — ` +
      `${report.modelPulled ? "pulled" : "not pulled"}`,
  );
  if (!report.installed || !report.reachable || !report.modelPulled) {
    lines.push("", "Run `golem ollama setup` to install Ollama and pull this model.");
  }
  return `${lines.join("\n")}\n`;
}

/** Refuses (rather than hangs) when consent can't be interactively confirmed. */
export class SetupRefusedError extends Error {}

export type SetupOutcomeKind = "cancelled" | "completed";

export interface SetupResult {
  readonly kind: SetupOutcomeKind;
  readonly install?: InstallResult;
  readonly pull?: PullResult;
  readonly smokeTest?: { readonly ok: boolean; readonly detail: string };
}

export interface SetupOptions {
  readonly projectDir: string;
  readonly yes: boolean;
  readonly isTTY?: boolean;
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly deps?: OllamaBootstrapDeps;
  readonly onLine?: (line: string) => void;
  /** Test injection (forwarded to loadConfig). */
  readonly userDir?: string;
  /** Test injection (forwarded to pullDrafterModel) — default is a real 30s poll window. */
  readonly reachableTimeoutMs?: number;
}

async function defaultConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

export async function runOllamaSetup(opts: SetupOptions): Promise<SetupResult> {
  const projectDir = path.resolve(opts.projectDir);
  const { settings } = await loadConfig({
    projectDir,
    ...(opts.userDir !== undefined && { userDir: opts.userDir }),
  });
  const deps =
    opts.deps ??
    createOllamaBootstrapDeps({
      native: new OllamaNativeClient({ baseUrl: settings.inference.ollama_base_url }),
      ...(opts.onLine !== undefined && {
        onOutput: (chunk: string) => opts.onLine?.(chunk),
      }),
    });

  const facts = await detectCapability(deps.probe);
  const targetModel = chatModelFor(facts.tier, "drafter");

  const alreadyInstalled = await isOllamaInstalled(deps.probe);
  const planSummary = alreadyInstalled
    ? "Ollama is already installed"
    : resolveInstallPlan(await detectInstallEnvironment(deps.probe, deps.platform)).summary;

  if (!opts.yes) {
    const isTTY = opts.isTTY ?? process.stdin.isTTY === true;
    if (!isTTY) {
      throw new SetupRefusedError(
        "stdin is not a TTY — re-run with --yes to install Ollama and pull " +
          `${targetModel} non-interactively`,
      );
    }
    const confirm = opts.confirm ?? defaultConfirm;
    const question =
      `This will ${alreadyInstalled ? "" : `${planSummary}, then `}` +
      `pull the ${targetModel} model (a multi-GB download) if it isn't already present. Continue?`;
    const accepted = await confirm(question);
    if (!accepted) return { kind: "cancelled" };
  }

  const install = await installOllama(deps);
  const installFailed = install.plan.kind === "manual" || install.outcome?.ok === false;
  if (!install.alreadyInstalled && installFailed) {
    return { kind: "completed", install };
  }

  let pull: PullResult;
  try {
    pull = await pullDrafterModel(deps, facts.tier, {
      onProgress: (e) => opts.onLine?.(`pull ${targetModel}: ${e.status}`),
      ...(opts.reachableTimeoutMs !== undefined && { reachableTimeoutMs: opts.reachableTimeoutMs }),
    });
  } catch (err) {
    if (err instanceof OllamaNotReadyError) return { kind: "completed", install };
    throw err;
  }

  const client = new OllamaClient({ baseUrl: settings.inference.ollama_base_url });
  try {
    const smokeTest = await smokeTestModel(client, pull.model);
    return { kind: "completed", install, pull, smokeTest };
  } finally {
    await client.close();
  }
}

export function renderSetupResult(result: SetupResult): string {
  if (result.kind === "cancelled") {
    return "Setup cancelled — nothing was installed or downloaded.\n";
  }
  const lines: string[] = [];
  const install = result.install;
  if (install !== undefined) {
    if (install.alreadyInstalled) {
      lines.push("Ollama is already installed.");
    } else if (install.plan.kind === "manual") {
      lines.push(`Could not install Ollama automatically (${install.plan.summary}).`);
      lines.push(
        `Install it manually, then re-run \`golem ollama setup\`: ${install.plan.manualUrl}`,
      );
    } else if (install.outcome?.ok === false) {
      lines.push(
        `Ollama install command failed (exit code ${install.outcome.code}). See output above.`,
      );
    } else {
      lines.push(`Installed Ollama (${install.plan.summary}).`);
    }
  }
  if (result.pull !== undefined) {
    lines.push(
      result.pull.alreadyPulled
        ? `Model ${result.pull.model} was already pulled.`
        : `Pulled model ${result.pull.model}.`,
    );
  }
  if (result.smokeTest !== undefined) {
    lines.push(
      result.smokeTest.ok
        ? `Smoke test passed — model replied: "${result.smokeTest.detail}"`
        : `Smoke test failed: ${result.smokeTest.detail}`,
    );
  }
  const installSucceeded =
    install !== undefined &&
    (install.alreadyInstalled || (install.plan.kind !== "manual" && install.outcome?.ok !== false));
  if (result.pull === undefined && installSucceeded) {
    lines.push(
      "Ollama did not become reachable yet — open a new terminal (PATH may need " +
        "refreshing) or start Ollama manually, then re-run `golem ollama setup`.",
    );
  }
  return `${lines.join("\n")}\n`;
}
