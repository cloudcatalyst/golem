/**
 * `golem local` — enable/disable and configure the local (or LAN) model.
 *
 * The two levers that decide whether Golem is a local+upstream hybrid already
 * existed as settings leaves; what was missing was one place to see and set
 * them. This is that place:
 *
 * - `inference.coder_enabled` — whether the `coder` MCP tool (the only
 *   thing that routinely engages the local model, Decision 31) is offered.
 * - `inference.ollama_base_url` — *which* Ollama the local roles talk to.
 *   Pointing this at another machine is the whole LAN-offload story (spec §6,
 *   Decision 12): a laptop can borrow the GPU box without any other change.
 *
 * Deliberately a thin layer over `golem config` rather than new semantics — the
 * settings, their scopes, and their env overrides are unchanged, so anything
 * `golem local` does can still be done (and undone) with `golem config set`.
 *
 * Everything here is read-only or a single validated settings write; the probe
 * is bounded and never throws, so `status` works offline.
 */

import { loadConfig, type SettingsScope } from "../config/index.js";
import {
  chatModelFor,
  createProbeRunner,
  detectCapability,
  matchesPulledName,
  OllamaNativeClient,
  type PulledState,
} from "../inference/index.js";
import { isKnownWorker } from "../inference/workers.js";
import type { HardwareTier } from "../interfaces/inference.js";
import { type ConfigWriteResult, setConfig } from "./config.js";
import { InitError } from "./init.js";
import { probeLocalModel } from "./local-model.js";

const TIER_NAMES: Readonly<Record<HardwareTier, string>> = {
  0: "P_CPU",
  1: "P_MIN",
  2: "P_MID",
  3: "P_MAX",
};

const BASE_URL_KEY = "inference.ollama_base_url";

/**
 * A LAN endpoint deserves a longer probe budget than the per-turn status line's
 * 800 ms: the point of `golem local url` is to tell the user *now* whether the
 * box they just named answers, and a first hop across a home network plus a cold
 * Ollama can legitimately exceed a second.
 */
const URL_PROBE_TIMEOUT_MS = 2500;

/** Hostnames that mean "this machine" — everything else is treated as remote. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/**
 * True when `baseUrl` points somewhere other than this machine — i.e. the LAN
 * offload case, which is worth labelling because its failure modes are
 * different (the other box must be running Ollama *and* be listening on a
 * non-loopback interface, which is not Ollama's default).
 */
export function isRemoteEndpoint(baseUrl: string): boolean {
  try {
    return !LOOPBACK_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false; // unparseable → don't claim it's remote
  }
}

export interface LocalModelReport {
  readonly base_url: string;
  readonly base_url_layer: string;
  /** Whether that endpoint answered a bounded probe just now. */
  readonly reachable: boolean;
  /** True when `base_url` names another machine (LAN offload). */
  readonly remote: boolean;
  readonly tier: HardwareTier;
  readonly tier_name: string;
  /** The model the coder/drafter role runs at this tier. */
  readonly model: string;
  /**
   * Whether `model` is actually pulled on `base_url` (task `local-models`).
   * `"unknown"` when the endpoint didn't answer — reporting "not pulled" for a
   * model we could not look up would be a fabricated fact, and a not-pulled
   * drafter is precisely what made `coder --refine` silently do nothing (§89/§100).
   */
  readonly model_state: PulledState;
  /**
   * R9.10 — workers whose `inference.worker_targets` entry sends them somewhere
   * other than this local backend. Non-empty means this command is NOT
   * describing where `coder` runs, and it must say so rather than letting
   * "Local model: ACTIVE" imply otherwise.
   */
  readonly non_local_workers?: readonly { readonly worker: string; readonly target: string }[];
  /**
   * The effective state the status surfaces show: the local model counts as
   * ACTIVE only when it is both enabled and reachable. Neither alone is enough —
   * which is the distinction the VS Code status bar previously lost.
   */
  readonly active: boolean;
}

export interface LocalModelOptions {
  readonly projectDir: string;
  /** User config dir override — lets tests isolate from the real ~/.golem. */
  readonly userDir?: string;
  /** Test seam: override the reachability probe. */
  readonly probe?: (baseUrl: string) => Promise<boolean>;
  /** Test seam: override hardware/model detection. */
  readonly detect?: () => Promise<{ tier: HardwareTier; coderModel: string }>;
  /** Test seam: what the endpoint reports as pulled (task `local-models`). */
  readonly listModels?: () => Promise<readonly { readonly name: string }[]>;
}

async function detectTierAndModel(): Promise<{ tier: HardwareTier; coderModel: string }> {
  try {
    const facts = await detectCapability(createProbeRunner());
    return { tier: facts.tier, coderModel: chatModelFor(facts.tier, "drafter") };
  } catch {
    // detectCapability already degrades to the CPU tier; this only catches a
    // probe-path failure, and a status command must never throw over it.
    return { tier: 0, coderModel: "" };
  }
}

/** Read the current local-model configuration + live reachability. Never throws. */
export async function collectLocalModel(opts: LocalModelOptions): Promise<LocalModelReport> {
  const { settings, provenance } = await loadConfig({
    projectDir: opts.projectDir,
    ...(opts.userDir !== undefined ? { userDir: opts.userDir } : {}),
  });
  const baseUrl = settings.inference.ollama_base_url;

  // R9.10: a worker with a `worker_targets` entry does not run on this backend.
  // Unknown worker names are ignored here — `unknownWorkerWarnings` already
  // reports those, and repeating it would be a second voice for one fact.
  const nonLocalWorkers = Object.entries(settings.inference.worker_targets)
    .filter(([worker, target]) => isKnownWorker(worker) && target !== "")
    .map(([worker, target]) => ({ worker, target }));

  const probe = opts.probe ?? ((url: string) => probeLocalModel(url, URL_PROBE_TIMEOUT_MS));
  const detect = opts.detect ?? detectTierAndModel;
  // Both are guarded here rather than inside the defaults: a status command must
  // not throw because hardware detection or a network probe failed, and that has
  // to hold for an injected implementation too.
  const listModels =
    opts.listModels ??
    (() =>
      new OllamaNativeClient({
        baseUrl,
        requestTimeoutMs: URL_PROBE_TIMEOUT_MS,
      }).listModels());
  const [reachable, detected, pulledNames] = await Promise.all([
    probe(baseUrl).catch(() => false),
    detect().catch(() => ({ tier: 0 as HardwareTier, coderModel: "" })),
    listModels()
      .then((models) => models.map((m) => m.name))
      .catch(() => null),
  ]);
  const { tier, coderModel } = detected;

  // Three states, not two: an endpoint we couldn't list tells us nothing about
  // what is pulled, and saying "not pulled" there would invent a fact.
  const modelState: PulledState =
    pulledNames === null || coderModel === ""
      ? "unknown"
      : pulledNames.some((n) => matchesPulledName(n, coderModel))
        ? "pulled"
        : "not-pulled";

  return {
    base_url: baseUrl,
    base_url_layer: provenance[BASE_URL_KEY]?.layer ?? "default",
    reachable,
    remote: isRemoteEndpoint(baseUrl),
    tier,
    tier_name: TIER_NAMES[tier],
    model: coderModel,
    model_state: modelState,
    // R9.10: which workers this backend does NOT serve. Built here rather than
    // in the renderer so `--json` carries the same fact the text does.
    ...(nonLocalWorkers.length > 0 ? { non_local_workers: nonLocalWorkers } : {}),
    active: reachable,
  };
}

/** Enable or disable the coder tool in one scope. */
export async function setLocalCoderEnabled(
  enabled: boolean,
  scope: SettingsScope,
  opts: { readonly projectDir: string },
): Promise<ConfigWriteResult> {
  // R9.23: coder_enabled removed — coder is always available. Enable means
  // clear the worker target (falls through to default_target); disable means
  // set a target that will never resolve.
  if (enabled) {
    return setConfig(scope, "inference.worker_targets", "{}", { projectDir: opts.projectDir });
  }
  return setConfig(scope, "inference.worker_targets", '{"coder":"__disabled__"}', {
    projectDir: opts.projectDir,
  });
}

export interface LocalUrlResult {
  readonly write: ConfigWriteResult;
  /** Probe verdict for the NEW endpoint, or null when probing was skipped. */
  readonly reachable: boolean | null;
  readonly remote: boolean;
}

/**
 * Point the local roles at a different Ollama — the LAN-offload switch.
 *
 * Probes the new endpoint first and **reports** the verdict rather than
 * refusing: the box may legitimately be off right now, and a config command that
 * won't let you pre-configure a machine you'll boot later is worse than one that
 * tells you the truth and writes anyway. `probe: false` skips the network call.
 */
export async function setLocalBaseUrl(
  rawUrl: string,
  scope: SettingsScope,
  opts: {
    readonly projectDir: string;
    readonly probe?: boolean;
    readonly probeFn?: (baseUrl: string) => Promise<boolean>;
  },
): Promise<LocalUrlResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new InitError(
      `"${rawUrl}" is not a URL. Give a full origin, e.g. http://gpubox.lan:11434 ` +
        "(host and port, no trailing path).",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // `new URL("gpubox:11434")` parses — `gpubox:` becomes the scheme — so a bare
    // host:port lands here rather than in the catch above. Name that case
    // specifically; "unsupported scheme gpubox:" would be a baffling answer to a
    // simple missing `http://`.
    const bare = !rawUrl.includes("//");
    throw new InitError(
      bare
        ? `"${rawUrl}" is missing a scheme — write it as http://${rawUrl}`
        : `unsupported scheme "${url.protocol}" — use http:// or https://`,
    );
  }

  // Probe BEFORE writing so the reported verdict is about the URL the user gave,
  // not about whatever a concurrent edit left in the file.
  const probeFn = opts.probeFn ?? ((u: string) => probeLocalModel(u, URL_PROBE_TIMEOUT_MS));
  const reachable = opts.probe === false ? null : await probeFn(rawUrl);

  const write = await setConfig(scope, BASE_URL_KEY, rawUrl, { projectDir: opts.projectDir });
  return { write, reachable, remote: isRemoteEndpoint(rawUrl) };
}

/** Human-readable `golem local status`. */
export function renderLocalModel(report: LocalModelReport): string {
  const lines: string[] = [];
  const where = report.remote ? "LAN" : "this machine";
  lines.push(`Local model: ${report.active ? "ACTIVE" : "not active"} (${where})`);
  lines.push(
    `  coder tool: ${report.reachable ? "enabled" : "DISABLED"} ` +
      `(inference.coder_enabled, from ${report.base_url_layer})`,
  );
  // R9.10: a worker with a target does not run here, and this command must not
  // imply it does. Everything below describes the LOCAL backend, which such a
  // worker never reaches.
  for (const w of report.non_local_workers ?? []) {
    lines.push(`  note:       \`${w.worker}\` runs on target "${w.target}", NOT on this backend`);
  }
  lines.push(
    `  endpoint:   ${report.base_url} — ${report.reachable ? "reachable" : "NOT reachable"} ` +
      `(inference.ollama_base_url, from ${report.base_url_layer})`,
  );
  lines.push(`  hardware:   tier ${report.tier} (${report.tier_name})`);
  if (report.model !== "") {
    // Say whether the model is actually there. "coder model: X" alone read as a
    // promise that X would run, which is how a never-pulled judge model spent
    // three investigations looking like a prompt bug (task `local-models`).
    const state =
      report.model_state === "pulled"
        ? "pulled"
        : report.model_state === "not-pulled"
          ? "NOT pulled"
          : "pulled state unknown";
    lines.push(`  coder model: ${report.model} — ${state}`);
  }

  // Say what to do about it, and be specific about WHICH of the two conditions
  // is unmet — "not active" with no reason is the unhelpful version.
  if (!report.reachable) {
    lines.push("");
    lines.push("The coder tool is unavailable — no local model or target configured");
  }
  if (report.reachable && report.model_state === "not-pulled") {
    lines.push("");
    lines.push(
      `Ollama answers, but ${report.model} is not downloaded — the coder tool ` +
        "will step down a tier or fail. Pull it with: " +
        `ollama pull ${report.model} (or: golem ollama setup)`,
    );
  }
  if (!report.reachable) {
    lines.push("");
    lines.push(
      report.remote
        ? `Nothing answered at ${report.base_url}. Check the other machine is running Ollama ` +
            "and listening on a non-loopback interface (set OLLAMA_HOST=0.0.0.0 there — " +
            "Ollama binds loopback only by default), and that no firewall blocks the port."
        : "Ollama isn't answering locally — check it with: golem ollama status " +
            "(install/pull with: golem ollama setup)",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Human-readable result of `golem local enable|disable`. */
export function renderLocalCoderWrite(result: ConfigWriteResult, enabled: boolean): string {
  const lines: string[] = [
    `local coder ${enabled ? "enabled" : "disabled"}${
      result.scope !== "project" ? ` (${result.scope} scope)` : ""
    }`,
  ];
  if (result.overriddenBy !== undefined) {
    const o = result.overriddenBy;
    lines.push(
      `note: a higher-precedence layer overrides it — the effective value is from ${o.layer}` +
        `${o.source !== undefined ? ` (${o.source})` : ""}`,
    );
  }
  lines.push("Restart Claude Code (or reload) so the MCP server picks up the change.");
  return `${lines.join("\n")}\n`;
}

/** Human-readable result of `golem local url <url>`. */
export function renderLocalUrlWrite(result: LocalUrlResult): string {
  const lines: string[] = [
    `local model endpoint set to ${String(result.write.value)}` +
      `${result.write.scope !== "project" ? ` (${result.write.scope} scope)` : ""}` +
      `${result.remote ? " — LAN offload" : ""}`,
  ];
  if (result.reachable === true) {
    lines.push("Probed it: reachable.");
  } else if (result.reachable === false) {
    lines.push(
      "Probed it: NOT reachable — saved anyway. " +
        (result.remote
          ? "On the other machine, run Ollama with OLLAMA_HOST=0.0.0.0 so it accepts " +
            "connections from the network (it binds loopback only by default)."
          : "Start Ollama, or check the port."),
    );
  }
  if (result.write.overriddenBy !== undefined) {
    const o = result.write.overriddenBy;
    lines.push(
      `note: a higher-precedence layer overrides it — the effective value is from ${o.layer}` +
        `${o.source !== undefined ? ` (${o.source})` : ""}`,
    );
  }
  lines.push("Restart the proxy to apply: golem proxy restart");
  return `${lines.join("\n")}\n`;
}
