/**
 * R13.3 — the SESSION HOST's decision, which is not the hook gate's decision.
 *
 * `src/autonomy/gate.ts` exposes `GateEmission = "allow" | "ask" | null`. That
 * union is not a limitation to be fixed; it is an honest description of what a
 * *guest* hook can do. Golem does not own the loop in that case — it is a
 * bystander on someone else's session, and the strongest thing a bystander can
 * do is insist a question be asked. `null` means "say nothing, the human's own
 * permission flow governs", which only makes sense when there IS a human at a
 * terminal.
 *
 * A hosted session is a different relationship. Golem spawned the process, owns
 * its lifetime, chose its settings, and is the only thing standing between it
 * and the machine. There is no human at that terminal — nobody to defer to —
 * so `null` has no meaning and `ask` has no answerer unless somebody is
 * attached. What the host CAN do, and the guest cannot, is refuse.
 *
 * Hence a separate type. **Do not widen `GateEmission` to add `deny`**: that
 * would silently tell every existing hook call site that refusal is now on the
 * table for the guest path, which is exactly the confusion ADR-0002's threat
 * model depends on not existing. Two relationships, two enums, one shared
 * classifier (`src/autonomy/classify.ts`) — the classification of an action
 * never varies by who is asking, only the authority to act on it does.
 */

import type { ActionClass } from "../autonomy/classify.js";
import { decideGate } from "../autonomy/gate.js";
import type { AutonomyLevel } from "../autonomy/policy.js";

/**
 * What the host does about a pending tool call.
 *
 * - `allow` — let it run; Golem says nothing and the runner's own flow governs.
 * - `ask` — somebody must answer. In a hosted session that somebody is whoever
 *   is attached; see {@link resolveHostGate}, which turns an unanswered `ask`
 *   into a refusal rather than a wait (invariant 3).
 * - `deny` — refuse outright, with a reason the conversation is told.
 */
export type HostDecision = "allow" | "ask" | "deny";

export interface HostGateDecision {
  readonly decision: HostDecision;
  /** Shown to the conversation. Always present — a refusal with no reason is a bug report. */
  readonly reason: string;
}

/**
 * Decide, by DERIVING from `decideGate` rather than restating it.
 *
 * ADR-0002's matrix is one policy. Writing it twice would mean two policies that
 * happen to agree today, so the host asks the guest gate what it would emit and
 * translates, and the never-auto set is the only place the two differ.
 *
 * The translation, and why each arm is what it is:
 *
 * | `decideGate` | host | why |
 * |---|---|---|
 * | `ask` on destructive/outward | **`deny`** | the whole point: Golem owns this loop and can refuse |
 * | `allow` | `allow` | the matrix auto-approved it |
 * | `null` (defer) | `allow` | `null` means "Golem adds nothing; the runner's own permission flow governs" — and the host hook expresses `allow` by emitting NOTHING, which is literally that. It does **not** mean "ask a human": at `manual` the guest defers to a human who is *there*, and translating that to `ask` in a session with nobody attached would deny every read and make a hosted session useless at the default level |
 * | `ask` on `unknown` | `ask` | the one genuine question — fail-closed at the top level, and with nobody attached {@link resolveHostGate} turns it into a refusal |
 *
 * The runner keeps its own guards either way: `allow` here is not a grant, it is
 * Golem declining to add a restriction. Measured (§147): Claude Code still
 * refused an out-of-cwd `rm` on its own while the host gate was silent.
 */
export function decideHostGate(level: AutonomyLevel, action: ActionClass): HostGateDecision {
  if (action === "outward") {
    return {
      decision: "deny",
      reason:
        "Refused by the Golem session host: this action leaves the machine or is hard to reverse. A hosted session never performs it, at any autonomy level.",
    };
  }
  if (action === "destructive") {
    return {
      decision: "deny",
      reason:
        "Refused by the Golem session host: destructive step. A hosted session never performs it, at any autonomy level — do a dry run, or ask the developer to run it themselves.",
    };
  }

  const guest = decideGate(level, action);
  if (guest.emit === "ask") return { decision: "ask", reason: askReason(action) };
  return { decision: "allow", reason: allowReason(action, guest.emit) };
}

function allowReason(action: ActionClass, emit: "allow" | null): string {
  return emit === "allow"
    ? `Golem session host: auto-approved (${action} action within the current autonomy level).`
    : `Golem session host: no restriction added (${action} action) — the runner's own permission flow governs.`;
}

function askReason(action: ActionClass): string {
  return `Golem session host: a ${action} action needs a human decision at the current autonomy level.`;
}

/**
 * Who, if anyone, can answer an `ask` right now.
 *
 * R13.3 ships only the `none` case — there is no device transport yet (R13.5)
 * and no chat surface (R13.6). The seam exists so those tasks add an answerer
 * rather than rewriting the decision.
 */
export interface HostAttachment {
  /** Something that can be asked and will answer. */
  readonly attached: boolean;
  /** Who — a device id, or `"local"` for the dashboard/CLI. */
  readonly who?: string;
}

export const NOBODY_ATTACHED: HostAttachment = { attached: false };

/**
 * Turn a decision into what the host actually does, given who is attached.
 *
 * **An unanswered `ask` is a denial, not a wait** (ADR-0007 invariant 3). This
 * is the whole reason this function exists separately from
 * {@link decideHostGate}: a hosted session with nobody watching must not sit on
 * a tool call until a timeout, because "blocked forever" and "refused" look the
 * same to the developer and only one of them stops burning a session.
 */
export function resolveHostGate(
  decision: HostGateDecision,
  attachment: HostAttachment = NOBODY_ATTACHED,
): HostGateDecision {
  if (decision.decision !== "ask") return decision;
  if (attachment.attached) return decision;
  return {
    decision: "deny",
    reason: `${decision.reason} Nobody is attached to this hosted session, so there is no one to ask — refused rather than left waiting (ADR-0007 invariant 3). Attach a device or answer locally, then retry.`,
  };
}
