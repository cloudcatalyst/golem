/**
 * `golem local` — enable/disable and configure the local (or LAN) model.
 *
 * The two levers that decide whether Golem is a local+upstream hybrid already
 * existed as settings leaves; what was missing was one place to see and set
 * them. This is that place:
 *
 * - `inference.local_coder_enabled` — whether the `coder` MCP tool (the only
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
  listedState,
  type ModelSource,
  OllamaNativeClient,
  OpenAiModelsClient,
  type PulledState,
  resolveChatModel,
  validateProviders,
} from "../inference/index.js";
import type { HardwareTier } from "../interfaces/inference.js";
import { type ConfigWriteResult, setConfig } from "./config.js";
import { InitError } from "./init.js";
import { probeInferenceEndpoint, probeLocalModel } from "./local-model.js";

const TIER_NAMES: Readonly<Record<HardwareTier, string>> = {
  0: "P_CPU",
  1: "P_MIN",
  2: "P_MID",
  3: "P_MAX",
};

const CODER_KEY = "inference.local_coder_enabled";
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
  /** Whether the `coder` tool is offered (`inference.local_coder_enabled`). */
  readonly coder_enabled: boolean;
  /** Which config layer supplied `coder_enabled`. */
  readonly coder_enabled_layer: string;
  readonly base_url: string;
  readonly base_url_layer: string;
  /** Whether that endpoint answered a bounded probe just now. */
  readonly reachable: boolean;
  /** True when `base_url` names another machine (LAN offload). */
  readonly remote: boolean;
  readonly tier: HardwareTier;
  readonly tier_name: string;
  /** The model the coder/drafter role runs at this tier. */
  readonly coder_model: string;
  /**
   * Whether `coder_model` is actually pulled on `base_url` (task `local-models`).
   * `"unknown"` when the endpoint didn't answer — reporting "not pulled" for a
   * model we could not look up would be a fabricated fact, and a not-pulled
   * drafter is precisely what made `coder --refine` silently do nothing (§89/§100).
   */
  readonly coder_model_state: PulledState;
  /** R8.15 — which provider serves the drafter (`"ollama"` when it came from the catalog). */
  readonly coder_provider: string;
  /** R8.15 — the endpoint that actually serves the drafter; may differ from `base_url`. */
  readonly coder_endpoint: string;
  /** R8.15 — whether `coder_model` came from the user's table or the tier catalog. */
  readonly coder_model_source: ModelSource;
  /** R8.15 — the declared context window, when the user declared one. */
  readonly coder_context_window?: number;
  /** R8.15 — provider-table problems worth printing. Never fatal. */
  readonly problems: readonly string[];
  /**
   * The effective state the status surfaces show: the local model counts as
   * ACTIVE only when it is both enabled and reachable. Neither alone is enough —
   * which is the distinction the VS Code status bar previously lost.
   */
  readonly active: boolean;
}

export interface LocalModelOptions {
  readonly projectDir: string;
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
  const coderEnabled = settings.inference.local_coder_enabled;
  const providers = settings.inference.providers;

  const detect = opts.detect ?? detectTierAndModel;
  // Guarded here rather than inside the defaults: a status command must not throw
  // because hardware detection or a network probe failed, and that has to hold for
  // an injected implementation too.
  const detected = await detect().catch(() => ({ tier: 0 as HardwareTier, coderModel: "" }));
  const { tier } = detected;

  // R8.15 — the drafter may not live on Ollama any more, so every question below
  // is asked of the endpoint that actually serves it. Probing `ollama_base_url`
  // and reporting THAT as the coder's reachability was correct only while there
  // was exactly one possible backend.
  const routed = resolveChatModel("drafter", { providers, tier, ollamaBaseUrl: baseUrl });
  const coderModel = routed.source === "provider" ? routed.model : detected.coderModel;

  const probe =
    opts.probe ?? ((url: string) => probeInferenceEndpoint(url, routed.api, URL_PROBE_TIMEOUT_MS));
  const listModels =
    opts.listModels ??
    (async () => {
      if (routed.api === "ollama") {
        return new OllamaNativeClient({
          baseUrl: routed.baseUrl,
          requestTimeoutMs: URL_PROBE_TIMEOUT_MS,
        }).listModels();
      }
      const ids = await new OpenAiModelsClient({
        baseUrl: routed.baseUrl,
        requestTimeoutMs: URL_PROBE_TIMEOUT_MS,
      }).listModels();
      return ids.map((name) => ({ name }));
    });

  const [reachable, listedNames] = await Promise.all([
    probe(routed.baseUrl).catch(() => false),
    listModels()
      .then((models) => models.map((m) => m.name))
      .catch(() => null),
  ]);

  // Three states, not two: an endpoint we couldn't list tells us nothing about what
  // it can serve, and saying "not pulled" there would invent a fact. `listedState`
  // additionally refuses to say "not-pulled" for a non-Ollama backend at all — a
  // llama.cpp server answers for whatever GGUF it loaded, whatever id you send.
  const coderModelState: PulledState =
    listedNames === null || coderModel === ""
      ? "unknown"
      : listedState(routed.api, listedNames, coderModel);

  return {
    coder_enabled: coderEnabled,
    coder_enabled_layer: provenance[CODER_KEY]?.layer ?? "default",
    base_url: baseUrl,
    base_url_layer: provenance[BASE_URL_KEY]?.layer ?? "default",
    reachable,
    remote: isRemoteEndpoint(routed.baseUrl),
    tier,
    tier_name: TIER_NAMES[tier],
    coder_model: coderModel,
    coder_model_state: coderModelState,
    coder_provider: routed.providerId,
    coder_endpoint: routed.baseUrl,
    coder_model_source: routed.source,
    ...(routed.contextWindow !== undefined ? { coder_context_window: routed.contextWindow } : {}),
    problems: validateProviders(providers),
    active: coderEnabled && reachable,
  };
}

/** Enable or disable the local coder in one scope. */
export async function setLocalCoderEnabled(
  enabled: boolean,
  scope: SettingsScope,
  opts: { readonly projectDir: string },
): Promise<ConfigWriteResult> {
  return setConfig(scope, CODER_KEY, enabled ? "true" : "false", { projectDir: opts.projectDir });
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
    `  coder tool: ${report.coder_enabled ? "enabled" : "DISABLED"} ` +
      `(inference.local_coder_enabled, from ${report.coder_enabled_layer})`,
  );
  // R8.15 — when the drafter is routed to a declared provider, the endpoint on this
  // line is that provider's, not `ollama_base_url`. Say which key it came from so the
  // two cases are never confused: "reachable" against the wrong server is the exact
  // fabricated fact this workstream is about.
  lines.push(
    report.coder_model_source === "provider"
      ? `  endpoint:   ${report.coder_endpoint} — ${report.reachable ? "reachable" : "NOT reachable"} ` +
          `(inference.providers → ${report.coder_provider})`
      : `  endpoint:   ${report.base_url} — ${report.reachable ? "reachable" : "NOT reachable"} ` +
          `(inference.ollama_base_url, from ${report.base_url_layer})`,
  );
  lines.push(`  hardware:   tier ${report.tier} (${report.tier_name})`);
  if (report.coder_model !== "") {
    // Say whether the model is actually there. "coder model: X" alone read as a
    // promise that X would run, which is how a never-pulled judge model spent
    // three investigations looking like a prompt bug (task `local-models`).
    // "pulled" is Ollama's word for it and stays Ollama's word for it; a llama.cpp
    // server does not pull anything, so the same three states are spelled for the
    // backend actually in play.
    const ollamaWords =
      report.coder_provider === "ollama" || report.coder_model_source === "catalog";
    const state =
      report.coder_model_state === "pulled"
        ? ollamaWords
          ? "pulled"
          : "available"
        : report.coder_model_state === "not-pulled"
          ? "NOT pulled"
          : ollamaWords
            ? "pulled state unknown"
            : "availability unknown";
    const window =
      report.coder_context_window === undefined
        ? ""
        : ` (${report.coder_context_window.toLocaleString("en-US")}-token window)`;
    lines.push(`  coder model: ${report.coder_model} — ${state}${window}`);
  }

  // Say what to do about it, and be specific about WHICH of the two conditions
  // is unmet — "not active" with no reason is the unhelpful version.
  if (!report.coder_enabled) {
    lines.push("");
    lines.push("The coder tool is disabled — enable it with: golem local enable");
  }
  if (report.reachable && report.coder_model_state === "not-pulled") {
    lines.push("");
    lines.push(
      `Ollama answers, but ${report.coder_model} is not downloaded — the coder tool ` +
        "will step down a tier or fail. Pull it with: " +
        `ollama pull ${report.coder_model} (or: golem ollama setup)`,
    );
  }
  if (!report.reachable) {
    lines.push("");
    lines.push(
      report.coder_model_source === "provider"
        ? `Nothing answered at ${report.coder_endpoint} (provider "${report.coder_provider}"). ` +
            "Check the server is running and that `base_url` matches the port it listens on — " +
            "for llama.cpp that is the `--host`/`--port` you launched `llama-server` with, and " +
            "a LAN box must bind a non-loopback interface with no firewall in the way."
        : report.remote
          ? `Nothing answered at ${report.base_url}. Check the other machine is running Ollama ` +
            "and listening on a non-loopback interface (set OLLAMA_HOST=0.0.0.0 there — " +
            "Ollama binds loopback only by default), and that no firewall blocks the port."
          : "Ollama isn't answering locally — check it with: golem ollama status " +
            "(install/pull with: golem ollama setup)",
    );
  }
  for (const problem of report.problems) {
    lines.push("");
    lines.push(problem);
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
