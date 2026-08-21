/**
 * Task `subagent-park` — refuse a subagent SPAWN there is not enough headroom to
 * finish (spec Decisions 20a / 38 / 45).
 *
 * ## Why this is a spawn gate and not a child gate
 *
 * The usage-limit park (`snooze-nudge.ts`) is a **tool-call gate**: `PreToolUse`
 * denies calls and redirects the agent to `mcp__golem__snooze`. A subagent never
 * reaches it. The limit is hit on a **model request**, so the child's turn fails
 * upstream (`Agent terminated early due to an API error: You've hit your session
 * limit`) before it ever proposes a tool call — there is nothing to deny and no
 * opportunity for the child to write a note. Observed 2026-08-22: two of three
 * dispatched R12 agents died exactly this way, one word after "All green.
 * Committing." They survived only because they had already committed.
 *
 * Making the gate stricter inside the child cannot work — the child never gets a
 * turn to be gated. What the parent DOES see as an ordinary tool call is the
 * spawn itself. So: refuse to start a subagent when the window cannot pay for
 * it, and say what was measured. Everything already in place stays in place — the
 * gate is still a tool-call gate, the decision is still local, nothing new
 * touches the request path.
 *
 * ## The threshold is not the park threshold
 *
 * A spawn at 60% that runs twenty minutes can still die at 100%; a spawn at 85%
 * that takes a minute will not. So a spawn is priced as a *span of burn*, not as
 * one call: {@link DEFAULT_SPAWN_COST_FRACTION} is grounded in measurement — the
 * three agents of 2026-08-22 consumed ~171k, ~186k and ~186k subagent tokens over
 * 85–94 tool calls each, roughly 15–20% of a session window apiece.
 *
 * ## In-flight spawns the reading cannot see yet
 *
 * Utilization already includes what running children have spent, so their cost is
 * never double-counted. What it does NOT include is a sibling dispatched *since*
 * the reading was taken — the three-at-once fan-out, where every spawn in the
 * batch reads the same pre-batch utilization and each looks affordable alone.
 * Spawns are therefore recorded as they are allowed, and any recorded after
 * `observedAtIso` is charged at the same estimate.
 *
 * ## Never silently allow
 *
 * Fail-closed, per ADR-0002: if utilization cannot be read (no reading yet) or the
 * header feed has gone cold (the `stale` case Golem already warns about once),
 * the honest answer is to warn on the spawn rather than assume headroom. That
 * warning is one-shot per reading, so it informs without deadlocking — re-issuing
 * the spawn proceeds.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LimitPrediction } from "../proxy/limit-prediction.js";
import { STALE_AFTER_MS } from "./snooze-nudge.js";

/**
 * Claude Code's subagent-spawn tool, under both names it has shipped with
 * (`Task` classically, `Agent` in current builds). Matching both is deliberate:
 * missing the live name would silently disable the gate, which is the failure
 * this task exists to prevent.
 */
export const SPAWN_TOOLS: readonly string[] = ["Task", "Agent"];

/** Whether a pending tool call is a subagent spawn. */
export function isSpawnTool(toolName: string): boolean {
  return SPAWN_TOOLS.includes(toolName);
}

/**
 * Estimated share of a session (5h) window one subagent costs. Measured, not
 * guessed — see the module header. Overridable via `snooze.spawn_cost_fraction`.
 */
export const DEFAULT_SPAWN_COST_FRACTION = 0.18;

/** How long a recorded spawn stays in the ledger before pruning (one window + slack). */
export const SPAWN_RECORD_TTL_MS = 6 * 60 * 60 * 1000;

/** Persisted spawn ledger, `.golem/state/spawn-gate.json`. */
export interface SpawnGateState {
  /** ISO timestamps of spawns this gate ALLOWED, newest last. */
  readonly spawnsAtIso?: readonly string[];
  /** `observedAtIso` (or the {@link NO_READING} sentinel) of the blind reading last warned for. */
  readonly blindWarnedForReading?: string;
}

/** Sentinel reading id used when no prediction has ever been observed. */
export const NO_READING = "none";

/**
 * Outcome of a spawn decision.
 * - `allow`  — fresh reading, the projected total fits inside the window.
 * - `refuse` — fresh reading, spawning would project past the limit.
 * - `blind`  — no reading or a cold feed; warn once rather than assume headroom.
 */
export type SpawnGateDecision =
  | { readonly kind: "allow" }
  | {
      readonly kind: "refuse";
      readonly utilization: number;
      readonly projected: number;
      readonly costFraction: number;
      readonly inFlight: number;
      readonly resetAtIso: string | null;
    }
  | {
      readonly kind: "blind";
      readonly reading: string;
      readonly reason: "no-reading" | "stale";
      readonly costFraction: number;
      /** Age of the stale reading in minutes; absent when there is no reading at all. */
      readonly ageMinutes?: number;
    };

export interface SpawnGateOptions {
  /** Share of a window one subagent is assumed to cost. */
  readonly costFraction?: number;
  /** Reading age past which the feed counts as cold. Defaults to the park's threshold. */
  readonly staleAfterMs?: number;
}

/** Spawns recorded after the reading was taken — spend the reading cannot include. */
function countInFlight(state: SpawnGateState, observedAtIso: string): number {
  const observedMs = Date.parse(observedAtIso);
  if (!Number.isFinite(observedMs)) return 0;
  let n = 0;
  for (const iso of state.spawnsAtIso ?? []) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms) && ms > observedMs) n += 1;
  }
  return n;
}

/**
 * Decide whether a subagent spawn may start. Pure.
 *
 * Order mirrors `decideSnoozeNudge`: a cold feed is resolved before any
 * arithmetic, because a projection built on a frozen utilization is a statement
 * about a window that no longer exists.
 */
export function decideSpawnGate(
  prediction: LimitPrediction | null,
  state: SpawnGateState,
  nowMs: number,
  options: SpawnGateOptions = {},
): SpawnGateDecision {
  const costFraction = options.costFraction ?? DEFAULT_SPAWN_COST_FRACTION;
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;

  if (prediction === null) {
    if (state.blindWarnedForReading === NO_READING) return { kind: "allow" };
    return { kind: "blind", reading: NO_READING, reason: "no-reading", costFraction };
  }

  const observedMs = Date.parse(prediction.observedAtIso);
  if (!Number.isFinite(observedMs) || nowMs - observedMs > staleAfterMs) {
    if (state.blindWarnedForReading === prediction.observedAtIso) return { kind: "allow" };
    const ageMinutes = Number.isFinite(observedMs)
      ? Math.round((nowMs - observedMs) / 60_000)
      : undefined;
    return {
      kind: "blind",
      reading: prediction.observedAtIso,
      reason: "stale",
      costFraction,
      ...(ageMinutes !== undefined ? { ageMinutes } : {}),
    };
  }

  const { utilization, resetAtIso } = prediction.fiveHour;
  const inFlight = countInFlight(state, prediction.observedAtIso);
  const projected = utilization + costFraction * (inFlight + 1);
  if (projected <= 1) return { kind: "allow" };
  return { kind: "refuse", utilization, projected, costFraction, inFlight, resetAtIso };
}

const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`;

/**
 * The REFUSAL shown to the agent (as the PreToolUse deny reason). States what was
 * measured — a refusal that does not say what it measured will be worked around.
 * Pure.
 */
export function spawnRefusalReason(d: Extract<SpawnGateDecision, { kind: "refuse" }>): string {
  const siblings =
    d.inFlight > 0
      ? `, plus ${d.inFlight} spawn${d.inFlight === 1 ? "" : "s"} dispatched since that reading ` +
        "(whose spend is not in it yet)"
      : "";
  const reset = d.resetAtIso !== null ? ` The window resets at ${d.resetAtIso}.` : "";
  return (
    "**Golem** Not enough headroom to spawn a subagent. The session (5h) window is " +
    `~${pct(d.utilization)} used and a subagent has historically cost ~${pct(d.costFraction)} of a ` +
    "window (measured: three agents at ~171k–186k tokens each, 2026-08-22)" +
    `${siblings} — so starting this one projects to ~${pct(d.projected)}, past the limit.${reset} ` +
    'A child that hits the limit dies mid-turn ("Agent terminated early due to an API error: ' +
    "You've hit your session limit\") and the park CANNOT reach it — the failure is on a model " +
    "request, so the child never gets a turn to be gated, and its uncommitted work is lost. Do " +
    "this work INLINE instead, or park now with `mcp__golem__snooze` " +
    '(`note="<where you\'re up to>"`) and spawn after the reset. To override: `snooze.spawn_gate` ' +
    "false (env `GOLEM_SNOOZE_SPAWN_GATE=false`), or lower `snooze.spawn_cost_fraction` if " +
    `${pct(d.costFraction)} overstates your subagents.`
  );
}

/**
 * The BLIND warning shown to the agent (as the PreToolUse deny reason) when
 * utilization cannot be read. One-shot per reading: re-issuing the spawn proceeds,
 * so this informs rather than deadlocks. Pure.
 */
export function spawnBlindReason(d: Extract<SpawnGateDecision, { kind: "blind" }>): string {
  const cause =
    d.reason === "no-reading"
      ? "Golem has never seen `anthropic-ratelimit-unified-*` headers for this project, so " +
        "there is no utilization to check"
      : "Golem hasn't seen fresh `anthropic-ratelimit-unified-*` headers for " +
        `~${d.ageMinutes ?? "?"} min, so the last reading no longer describes the live window`;
  return (
    `**Golem** Spawning a subagent BLIND. ${cause}. A subagent costs roughly ` +
    `${pct(d.costFraction)} of a session window, and a child that runs out dies on a model ` +
    "request where the park cannot reach it — its uncommitted work is lost. Golem will not " +
    "assume headroom it cannot measure (ADR-0002 fail-closed), so this is a one-time notice for " +
    "this reading: decide deliberately, then re-issue the spawn to proceed. Watch Claude Code's " +
    "own limit indicator, check `golem status` (Limits line), and tell the subagent to COMMIT " +
    "working increments early on its own branch so a death is recoverable."
  );
}

/** `.golem/state/spawn-gate.json` for a project. */
export function spawnGateStatePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "spawn-gate.json");
}

const stateSchema = z.object({
  spawnsAtIso: z.array(z.string()).optional(),
  blindWarnedForReading: z.string().optional(),
});

/** Read the spawn ledger, or `{}` (missing/corrupt → fail-open). */
export async function readSpawnGateState(projectDir: string): Promise<SpawnGateState> {
  let raw: string;
  try {
    raw = await readFile(spawnGateStatePath(projectDir), "utf8");
  } catch {
    return {};
  }
  try {
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = stateSchema.safeParse(JSON.parse(stripped));
    if (!parsed.success) return {};
    const { spawnsAtIso, blindWarnedForReading } = parsed.data;
    return {
      ...(spawnsAtIso !== undefined ? { spawnsAtIso } : {}),
      ...(blindWarnedForReading !== undefined ? { blindWarnedForReading } : {}),
    };
  } catch {
    return {};
  }
}

/** Persist the spawn ledger (atomic temp+rename in the state dir). */
export async function writeSpawnGateState(
  projectDir: string,
  state: SpawnGateState,
): Promise<void> {
  const file = spawnGateStatePath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

/**
 * Append an allowed spawn to the ledger, pruning entries older than
 * {@link SPAWN_RECORD_TTL_MS}. Pure on the state value; the caller persists.
 */
export function recordSpawn(state: SpawnGateState, nowMs: number, nowIso: string): SpawnGateState {
  const kept = (state.spawnsAtIso ?? []).filter((iso) => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) && nowMs - ms <= SPAWN_RECORD_TTL_MS;
  });
  return { ...state, spawnsAtIso: [...kept, nowIso] };
}
