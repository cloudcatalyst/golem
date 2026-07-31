/**
 * `golem devices` — detected hardware tier plus, for each role the tier defines,
 * whether that model is actually **pulled** on the inference endpoint.
 *
 * Task `local-models`: the old output listed `modelsForTier(...)` as a flat list,
 * which reads as "these are available" when it only ever meant "these are what
 * the catalog would pick". On this machine that was wrong for four of seven slots,
 * and it cost three separate investigations (the LE2 judge bug, §89, §100 — see
 * `src/inference/availability.ts` for the history).
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
  OllamaNativeClient,
  resolveTierAvailability,
  type TierAvailability,
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
  readonly availability: TierAvailability;
}

export interface DeviceOptions {
  readonly projectDir: string;
  readonly userDir?: string;
  /** Test seam: hardware detection. */
  readonly detect?: () => Promise<CapabilityFacts>;
  /** Test seam: what the endpoint reports as pulled. */
  readonly listModels?: () => Promise<readonly { readonly name: string }[]>;
  /** Test seam: skip the config read (and so the endpoint) — used by the MCP surface. */
  readonly endpoint?: string;
}

/** Detect the tier and resolve every slot's pulled state. Never throws. */
export async function collectDevices(opts: DeviceOptions): Promise<DeviceReport> {
  const endpoint =
    opts.endpoint ??
    (
      await loadConfig({
        projectDir: opts.projectDir,
        ...(opts.userDir !== undefined ? { userDir: opts.userDir } : {}),
      })
    ).settings.inference.ollama_base_url;

  const facts = await (opts.detect ?? (() => detectCapability(createProbeRunner())))();
  const listModels =
    opts.listModels ??
    (() =>
      new OllamaNativeClient({
        baseUrl: endpoint,
        requestTimeoutMs: LIST_TIMEOUT_MS,
      }).listModels());
  const availability = await resolveTierAvailability(facts.tier, { endpoint, listModels });
  return { facts, tierName: TIER_NAMES[facts.tier], availability };
}

/** The marker shown beside a slot's model. */
function stateMark(state: TierAvailability["models"][number]["state"]): string {
  switch (state) {
    case "pulled":
      return "pulled";
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

  // The point of the whole task: the catalog column and the reality column, side
  // by side. Never one list that implies both.
  lines.push(
    `  models for this tier (endpoint ${availability.endpoint}` +
      `${availability.reachable ? "" : " — NOT reachable"}):`,
  );
  const width = Math.max(...availability.models.map((m) => m.slot.length));
  for (const m of availability.models) {
    lines.push(`    ${m.slot.padEnd(width)}  ${m.model} — ${stateMark(m.state)}`);
  }
  if (availability.reachable) {
    const pulled = availability.models.filter((m) => m.state === "pulled").length;
    lines.push(`  ${pulled}/${availability.models.length} of this tier's slots are runnable.`);
    if (availability.missing.length > 0) {
      const pulls = [...new Set(availability.missing.map((m) => m.model))];
      lines.push("");
      lines.push(
        "A role whose model is NOT pulled cannot run: the service steps down a tier " +
          "(a smaller model) or fails, so read the concrete model in any output rather " +
          "than assuming this table.",
      );
      lines.push(`Pull what you want with: ${pulls.map((m) => `ollama pull ${m}`).join("; ")}`);
    }
  } else {
    lines.push("");
    lines.push(
      "Nothing answered at that endpoint, so which models are pulled is UNKNOWN — " +
        "this table is the catalog only. Check `golem ollama status`.",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Machine-readable `golem devices --json`. */
export function devicesJson(report: DeviceReport): Record<string, unknown> {
  return {
    ...report.facts,
    tier_name: report.tierName,
    endpoint: report.availability.endpoint,
    endpoint_reachable: report.availability.reachable,
    // Kept for compatibility with the previous shape: the flat catalog list.
    models: [...new Set(report.availability.models.map((m) => m.model))],
    // The new, honest view — one entry per slot with its pulled state.
    model_slots: report.availability.models.map((m) => ({
      slot: m.slot,
      model: m.model,
      state: m.state,
    })),
    pulled: report.availability.pulled,
    // Deduplicated: this is the list of models to pull, and three roles sharing
    // one absent model is still one download.
    missing: [...new Set(report.availability.missing.map((m) => m.model))],
  };
}
