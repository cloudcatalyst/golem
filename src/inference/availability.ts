/**
 * Task `local-models` — what the tier WOULD use vs what is actually pulled.
 *
 * `catalog.ts` is a table of advisory defaults (Decision 6): for a detected
 * hardware tier it names a concrete Ollama model per role. Nothing checked those
 * names against the endpoint, so `golem devices` presented a tier's full role map
 * as though every model were downloaded and callable. That gap has cost three
 * times:
 *
 * 1. **2026-07-17, the judge bug.** `coder --refine` reported `rounds: 0` on all
 *    five LE2 tasks and looked like a prompt/threshold problem. The judge model
 *    (`qwen2.5:14b`) had never been pulled, so every judge call failed into a
 *    silent catch. Fixed at the symptom, not the cause.
 * 2. **verification-notes §89.** The tools-block A/B had to run `--role drafter`
 *    because the tier's `classifier` model is not pulled — recorded as a
 *    hand-written caveat afterwards.
 * 3. **§100.** The same substitution, the same hand-written caveat, again. Two
 *    measurements that decided a workstream now both carry it.
 *
 * So this module answers the question BEFORE a run: for each slot the tier
 * defines, is that model present on the endpoint?
 *
 * **Three states, not two.** An unreachable endpoint yields `"unknown"`, never
 * `"not-pulled"`: claiming a model is missing when we could not look is exactly
 * the dishonest-zero failure the R4.4 lesson is about. Reporting is read-only —
 * nothing here pulls anything (a multi-GB download is the user's decision, and
 * `golem ollama setup` is the only place that asks).
 */

import type { HardwareTier, Role } from "../interfaces/inference.js";
import { chatModelFor, embedModelFor } from "./catalog.js";

/** Whether a slot's model is present, absent, or unknowable right now. */
export type PulledState = "pulled" | "not-pulled" | "unknown";

/** The chat roles a tier defines, in the order they are reported. */
export const CHAT_ROLE_SLOTS: readonly Role[] = [
  "summarizer",
  "extractor",
  "classifier",
  "drafter",
  "judge",
];

/**
 * Does an Ollama `/api/tags` name satisfy a catalog model id?
 *
 * Pure. Ollama reports fully-tagged names (`bge-m3:latest`, `qwen2.5-coder:7b`)
 * while the catalog sometimes omits the tag (`bge-m3`), so an untagged id matches
 * any tag of the same base. A *tagged* id must match exactly — the loose
 * `startsWith` used elsewhere would let `qwen2.5:3b` be "satisfied" by
 * `qwen2.5:32b`, which is a different model on a different tier.
 */
export function matchesPulledName(pulledName: string, wanted: string): boolean {
  if (pulledName === wanted) return true;
  if (wanted.includes(":")) return false; // tagged → exact only
  return pulledName.startsWith(`${wanted}:`);
}

/** One slot (a chat role, or an embedding kind) and the state of its model. */
export interface ModelAvailability {
  /** `"drafter"`, `"judge"`, …, `"text-embed"`, `"code-embed"`. */
  readonly slot: string;
  readonly model: string;
  readonly state: PulledState;
}

/** Every slot a tier defines, resolved against one endpoint. */
export interface TierAvailability {
  readonly tier: HardwareTier;
  readonly endpoint: string;
  /** False when the endpoint could not be listed — then every state is `unknown`. */
  readonly reachable: boolean;
  /** Names the endpoint actually reports, as it reports them. */
  readonly pulled: readonly string[];
  readonly models: readonly ModelAvailability[];
  /** The subset that is definitely absent (never includes `unknown`). */
  readonly missing: readonly ModelAvailability[];
}

/** How this tier's model list is named, in report order. */
function slotsForTier(tier: HardwareTier): ReadonlyArray<{ slot: string; model: string }> {
  return [
    ...CHAT_ROLE_SLOTS.map((role) => ({ slot: role, model: chatModelFor(tier, role) })),
    { slot: "text-embed", model: embedModelFor(tier, "text") },
    { slot: "code-embed", model: embedModelFor(tier, "code") },
  ];
}

/**
 * Resolve every slot's state against `opts.listModels()`.
 *
 * Never throws: a rejection (daemon down, LAN box asleep, a timeout) is reported
 * as `reachable: false` with every state `unknown`. Callers are status commands
 * and pre-run checks, and neither may fail because Ollama is off.
 *
 * Slots are NOT deduplicated — two roles sharing a model each get a line, because
 * the question being answered is "can this role run", one role at a time.
 */
export async function resolveTierAvailability(
  tier: HardwareTier,
  opts: {
    readonly endpoint: string;
    readonly listModels: () => Promise<readonly { readonly name: string }[]>;
  },
): Promise<TierAvailability> {
  let pulled: readonly string[] | null;
  try {
    pulled = (await opts.listModels()).map((m) => m.name);
  } catch {
    pulled = null;
  }
  const reachable = pulled !== null;
  const names = pulled ?? [];
  const models: ModelAvailability[] = slotsForTier(tier).map(({ slot, model }) => ({
    slot,
    model,
    state: !reachable
      ? "unknown"
      : names.some((n) => matchesPulledName(n, model))
        ? "pulled"
        : "not-pulled",
  }));
  return {
    tier,
    endpoint: opts.endpoint,
    reachable,
    pulled: names,
    models,
    missing: models.filter((m) => m.state === "not-pulled"),
  };
}

/** The state of one chat role, or undefined if it is not a known slot. */
export function roleState(a: TierAvailability, role: Role): PulledState | undefined {
  return a.models.find((m) => m.slot === role)?.state;
}

/**
 * A single line to print BEFORE a run that depends on a local model — the warning
 * that was missing when §89 and §100 silently substituted a role and had to be
 * caveated by hand afterwards. `null` when there is nothing to say.
 */
export function availabilityWarning(a: TierAvailability): string | null {
  if (!a.reachable) {
    return (
      `Local models: UNKNOWN — nothing answered at ${a.endpoint}, so Golem cannot tell ` +
      "which of this tier's models are pulled. Check `golem ollama status`."
    );
  }
  if (a.missing.length === 0) return null;
  const list = a.missing.map((m) => `${m.slot} (${m.model})`).join(", ");
  const pulls = [...new Set(a.missing.map((m) => m.model))]
    .map((m) => `ollama pull ${m}`)
    .join("; ");
  return (
    `Local models NOT pulled for this tier: ${list}. Those roles cannot run — a caller ` +
    `may substitute another role, so read the concrete model in the output. Pull with: ${pulls}`
  );
}

/**
 * The same warning, scoped to the ONE role a run is about to use. Keeps a
 * pre-flight check from shouting about roles the run never touches.
 */
export function roleWarning(a: TierAvailability, role: Role): string | null {
  const entry = a.models.find((m) => m.slot === role);
  if (entry === undefined) return null;
  if (entry.state === "pulled") return null;
  if (entry.state === "unknown") {
    return (
      `Role "${role}" would use ${entry.model}, but nothing answered at ${a.endpoint} — ` +
      "whether it is pulled is UNKNOWN. The run may fail or fall back."
    );
  }
  return (
    `Role "${role}" would use ${entry.model}, which is NOT pulled on ${a.endpoint}. ` +
    `The service will step down a tier (or fail) rather than run it — pull it first ` +
    `(\`ollama pull ${entry.model}\`) or pass a role that is available.`
  );
}
