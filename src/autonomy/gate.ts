/**
 * R5.4 — the gate decision: (autonomy level, action class) → PreToolUse output.
 *
 * The decision matrix and its safety proofs are ADR-0002. `emit: null` means
 * write NOTHING (exit 0, no stdout) so Claude Code's native permission flow —
 * i.e. the human — governs. `allow` is the ONLY value that removes a prompt and
 * is emitted narrowly; `ask` forces a human prompt even past an allow-list.
 */

import type { ActionClass } from "./classify.js";
import type { AutonomyLevel } from "./policy.js";

/** A decision the hook can emit (or `null` = stay silent / defer to native). */
export type GateEmission = "allow" | "ask" | null;

export interface GateDecision {
  readonly emit: GateEmission;
  /** Shown to Claude as `permissionDecisionReason` when `emit` is non-null. */
  readonly reason?: string;
}

/**
 * Decide what the PreToolUse hook emits. Pure + total over the matrix; the
 * irreversible/outward gates (`ask`) hold at EVERY level — there is no path that
 * auto-allows destructive or outward actions.
 */
export function decideGate(level: AutonomyLevel, action: ActionClass): GateDecision {
  // Never-auto set: destructive/outward force a human decision at all levels.
  if (action === "outward") {
    return { emit: "ask", reason: gateReason("outward") };
  }
  if (action === "destructive") {
    return { emit: "ask", reason: gateReason("destructive") };
  }

  switch (level) {
    case "manual":
      // Golem adds no auto-approval; native prompt governs everything else.
      return { emit: null };
    case "assisted":
      return action === "read" ? { emit: "allow", reason: autoReason("read") } : { emit: null };
    case "outcome":
      if (action === "read") return { emit: "allow", reason: autoReason("read") };
      if (action === "write") return { emit: "allow", reason: autoReason("write") };
      // unknown at the top level: gate to the human rather than auto-run.
      return { emit: "ask", reason: gateReason("unknown") };
  }
}

function autoReason(action: ActionClass): string {
  return `Golem autonomy: auto-approved (${action} action within the current autonomy level).`;
}

function gateReason(action: ActionClass): string {
  switch (action) {
    case "outward":
      return "Golem autonomy: this action leaves the machine / is hard to reverse — approval required (no autonomy level auto-approves it).";
    case "destructive":
      return "Golem autonomy: destructive step — approval required; prefer a dry-run first.";
    default:
      return "Golem autonomy: unrecognized action — approval required (fail-closed).";
  }
}

/**
 * R12.12 — the same never-auto set, decided one event EARLIER.
 *
 * {@link decideGate}'s `ask` for `destructive`/`outward` forces a question; it
 * does not answer one, so a permission dialog still opens — and a connected
 * channel's permission relay is triggered by the dialog existing at all
 * (verification-notes §141). `PermissionRequest` is the event that can resolve
 * the request instead of deferring it, so for those two classes Golem returns a
 * real `deny` there. Level-independent, exactly like the `ask` above it: no
 * autonomy level auto-approves either class.
 *
 * `null` means return NOTHING (exit 0, no stdout) — the native permission flow
 * governs, unchanged. Deliberately narrower than {@link decideGate}: `unknown`
 * at `outcome` level still only earns an `ask`, because fail-closed there means
 * "make the human decide", not "decide for them".
 */
export function decidePermissionRequest(action: ActionClass): PermissionRequestDecision | null {
  if (action === "outward" || action === "destructive") {
    return { behavior: "deny", message: gateReason(action) };
  }
  return null;
}

/** A `PermissionRequest` decision Golem is willing to make on the human's behalf. */
export interface PermissionRequestDecision {
  /** Only ever `deny`: Golem never grants a permission the human was about to be asked for. */
  readonly behavior: "deny";
  /** Shown to Claude as `decision.message` — the same text `decideGate` puts on the `ask`. */
  readonly message: string;
}
