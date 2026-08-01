/**
 * `golem devices` — detected hardware tier plus, for each role the tier defines,
 * which model serves it, on which backend, and whether that model is actually
 * available there.
 *
 * Task `local-models`: the old output listed `modelsForTier(...)` as a flat list,
 * which reads as "these are available" when it only ever meant "these are what
 * the catalog would pick". On this machine that was wrong for four of seven slots,
 * and it cost three separate investigations (the LE2 judge bug, §89, §100 — see
 * `src/inference/availability.ts` for the history).
 *
 * R8.15 adds the second half of the same honesty problem. Once `inference.providers`
 * exists, "which model" has a per-role answer that the tier catalog does not know,
 * the endpoint is no longer necessarily Ollama, and `ollama pull …` is advice that
 * cannot help at a llama.cpp server. So every row now carries its own provider, and
 * remediation is offered only where Golem has something useful to say.
 *
 * Kept out of `program.ts` so the rendering is unit-testable without spawning a
 * CLI, and shared with the `devices` MCP tool so both surfaces tell the same
 * story.
 */

import { loadConfig } from "../config/index.js";
import {
  type CapabilityFacts,
  createProbeRunner,
  detectCapability,
  type EndpointLister,
  type EndpointPropsReader,
  OllamaNativeClient,
  OpenAiModelsClient,
  type ProviderApi,
  type ProviderEntry,
  type PulledState,
  type ResolvedAvailability,
  resolveAvailability,
  validateProviders,
} from "../inference/index.js";
import type { HardwareTier } from "../interfaces/inference.js";

const TIER_NAMES: Readonly<Record<HardwareTier, string>> = {
  0: "P_CPU",
  1: "P_MIN",
  2: "P_MID",
  3: "P_MAX",
};

/**
 * Bounded: `devices` is an interactive status command and a dead LAN endpoint must
 * cost a moment, not a hang. Timing out is reported as `reachable: false` →
 * every slot `unknown`, never as "not pulled".
 */
const LIST_TIMEOUT_MS = 2500;

export interface DeviceReport {
  readonly facts: CapabilityFacts;
  readonly tierName: string;
  readonly availability: ResolvedAvailability;
  /** Config problems worth printing — never fatal (see `validateProviders`). */
  readonly problems: readonly string[];
}

export interface DeviceOptions {
  readonly projectDir: string;
  readonly userDir?: string;
  /** Test seam: hardware detection. */
  readonly detect?: () => Promise<CapabilityFacts>;
  /** Test seam: what an endpoint reports it can serve. */
  readonly listEndpoint?: EndpointLister;
  /** Test seam: the live window an endpoint reports (llama.cpp `/props`). */
  readonly readProps?: EndpointPropsReader;
  /** Test seam: skip the config read — used by the MCP surface and the tests. */
  readonly endpoint?: string;
  /** Test seam: the provider table, when not read from config. */
  readonly providers?: readonly ProviderEntry[];
}

/**
 * The default lister: each endpoint asked over its own native surface. Ollama gets
 * `/api/tags` (richer, and `matchesPulledName`'s tag semantics depend on it);
 * everything else gets `/v1/models`.
 */
const defaultLister: EndpointLister = async (endpoint) => {
  if (endpoint.api === "ollama") {
    const pulled = await new OllamaNativeClient({
      baseUrl: endpoint.baseUrl,
      requestTimeoutMs: LIST_TIMEOUT_MS,
    }).listModels();
    return pulled.map((m) => m.name);
  }
  return new OpenAiModelsClient({
    baseUrl: endpoint.baseUrl,
    requestTimeoutMs: LIST_TIMEOUT_MS,
  }).listModels();
};

/**
 * The live window, read from the server rather than assumed. `-c 16384` and
 * `-c 262144` are the same config file and wildly different budgets, so the only
 * honest source for this number is the running process. `props()` already swallows
 * a missing endpoint into `{}`.
 */
const defaultPropsReader: EndpointPropsReader = (endpoint) =>
  new OpenAiModelsClient({
    baseUrl: endpoint.baseUrl,
    requestTimeoutMs: LIST_TIMEOUT_MS,
  }).props();

/** Detect the tier and resolve every slot through the provider table. Never throws. */
export async function collectDevices(opts: DeviceOptions): Promise<DeviceReport> {
  let endpoint = opts.endpoint;
  let providers = opts.providers;
  if (endpoint === undefined || providers === undefined) {
    const { settings } = await loadConfig({
      projectDir: opts.projectDir,
      ...(opts.userDir !== undefined ? { userDir: opts.userDir } : {}),
    });
    endpoint ??= settings.inference.ollama_base_url;
    providers ??= settings.inference.providers;
  }

  const facts = await (opts.detect ?? (() => detectCapability(createProbeRunner())))();
  const availability = await resolveAvailability(
    { providers, tier: facts.tier, ollamaBaseUrl: endpoint },
    opts.listEndpoint ?? defaultLister,
    opts.readProps ?? defaultPropsReader,
  );
  return {
    facts,
    tierName: TIER_NAMES[facts.tier],
    availability,
    problems: validateProviders(providers),
  };
}

/**
 * The marker shown beside a slot's model.
 *
 * "pulled" is Ollama's word and stays Ollama's word — a llama.cpp server does not
 * pull anything, it serves whatever GGUF was loaded. `golem local status` makes the
 * same distinction, and the two surfaces have to agree or the difference reads as a
 * different state rather than a different backend.
 */
function stateMark(state: PulledState, api: ProviderApi): string {
  switch (state) {
    case "pulled":
      return api === "ollama" ? "pulled" : "available";
    case "not-pulled":
      return "NOT pulled";
    default:
      return "unknown";
  }
}

/** Human-readable `golem devices`. */
export function renderDevices(report: DeviceReport): string {
  const { facts, availability } = report;
  const lines: string[] = [
    `Hardware tier: ${facts.tier} (${report.tierName}) — via ${facts.source}`,
  ];
  if (facts.device !== undefined) lines.push(`  device: ${facts.device}`);
  if (facts.memoryMiB !== undefined) lines.push(`  memory: ${facts.memoryMiB} MiB`);
  lines.push(`  ${facts.detail}`);

  // One backend is the common case and reads best as a header. Several is the
  // R8.15 case, and then the endpoint belongs on the row rather than above it —
  // otherwise the table silently implies they all came from the same server.
  const single = availability.providers.length === 1 ? availability.providers[0] : undefined;
  lines.push(
    single !== undefined
      ? `  models for this tier (endpoint ${single.endpoint}${single.reachable ? "" : " — NOT reachable"}):`
      : "  models for this tier:",
  );

  // The point of the whole task: the catalog column and the reality column, side
  // by side. Never one list that implies both.
  const width = Math.max(...availability.slots.map((s) => s.slot.length));
  const modelWidth = Math.max(...availability.slots.map((s) => s.resolved.model.length));
  for (const s of availability.slots) {
    const where = single !== undefined ? "" : `  [${s.resolved.providerId} ${s.resolved.baseUrl}]`;
    lines.push(
      `    ${s.slot.padEnd(width)}  ${s.resolved.model.padEnd(single === undefined ? modelWidth : 0)} — ${stateMark(s.state, s.resolved.api)}${where}`,
    );
  }

  // The live window, where the server told us. Reported per endpoint rather than
  // per slot because that is what it is a fact about — the running server, not the
  // model id — and a declared `context_window` that disagrees is worth seeing.
  for (const p of availability.providers) {
    if (p.liveContextWindow === undefined) continue;
    lines.push(
      `  ${p.providerId}: serving with a ${p.liveContextWindow.toLocaleString("en-US")}-token ` +
        "context window (read live from the server).",
    );
  }

  const reachable = availability.providers.filter((p) => p.reachable);
  if (reachable.length > 0) {
    const pulled = availability.slots.filter((s) => s.state === "pulled").length;
    lines.push(`  ${pulled}/${availability.slots.length} of this tier's slots are runnable.`);
  }
  if (availability.missing.length > 0) {
    // Pull advice only where it can work. At a llama.cpp server `ollama pull` is
    // not merely unhelpful, it sends the reader off to fix the wrong machine.
    const pulls = [
      ...new Set(
        availability.missing
          .filter((s) => s.resolved.api === "ollama")
          .map((s) => s.resolved.model),
      ),
    ];
    lines.push("");
    lines.push(
      "A role whose model is NOT available cannot run: the service steps down a tier " +
        "(a smaller model) or fails, so read the concrete model in any output rather " +
        "than assuming this table.",
    );
    if (pulls.length > 0) {
      lines.push(`Pull what you want with: ${pulls.map((m) => `ollama pull ${m}`).join("; ")}`);
    }
  }
  const unreachable = availability.providers.filter((p) => !p.reachable);
  if (unreachable.length > 0) {
    lines.push("");
    lines.push(
      `Nothing answered at ${unreachable.map((p) => `${p.providerId} (${p.endpoint})`).join(", ")}, ` +
        "so which models are available there is UNKNOWN — those rows are the catalog only. " +
        "Check `golem ollama status`.",
    );
  }
  for (const problem of report.problems) {
    lines.push("");
    lines.push(problem);
  }
  return `${lines.join("\n")}\n`;
}

/** Machine-readable `golem devices --json`. */
export function devicesJson(report: DeviceReport): Record<string, unknown> {
  const { availability } = report;
  const primary = availability.providers[0];
  return {
    ...report.facts,
    tier_name: report.tierName,
    // Kept for compatibility with the pre-R8.15 shape, which assumed one endpoint.
    endpoint: primary?.endpoint ?? "",
    endpoint_reachable: primary?.reachable ?? false,
    // Kept for compatibility: the flat list of distinct models in play.
    models: [...new Set(availability.slots.map((s) => s.resolved.model))],
    // The honest view — one entry per slot, with where it resolved from.
    model_slots: availability.slots.map((s) => ({
      slot: s.slot,
      model: s.resolved.model,
      state: s.state,
      provider: s.resolved.providerId,
      source: s.resolved.source,
      endpoint: s.resolved.baseUrl,
      ...(s.resolved.contextWindow !== undefined
        ? { context_window: s.resolved.contextWindow }
        : {}),
    })),
    providers: availability.providers.map((p) => ({
      id: p.providerId,
      api: p.api,
      endpoint: p.endpoint,
      reachable: p.reachable,
      listed: p.listed,
      ...(p.liveContextWindow !== undefined ? { live_context_window: p.liveContextWindow } : {}),
    })),
    pulled: primary?.listed ?? [],
    // Deduplicated: this is the list of models to obtain, and three roles sharing
    // one absent model is still one download.
    missing: [...new Set(availability.missing.map((s) => s.resolved.model))],
    ...(report.problems.length > 0 ? { problems: report.problems } : {}),
  };
}
