/**
 * R14.6 — the delegation ledger: what was dispatched, and whether anyone has
 * looked at what came back.
 *
 * ## Why this exists
 *
 * R14.1 staffed a real bench and used it three times. The coder (Sonnet) was
 * correct. The scribe (Haiku) produced good prose with **two** factual errors on
 * its first run and **five** on its second — an invented ADR filename, an
 * invented config value, a stale model id, a dispatch mechanism that does not
 * exist, and the config layer precedence inverted. All fluent, all confident.
 * The role file was tightened between the runs and the second still produced
 * five, so this is a property of the tier rather than a prompt bug.
 *
 * The conclusion (USER, 2026-08-30) is that **review is a gate, not a phase**.
 * Workers are dispatched to PRODUCE artefacts; a gate runs OVER what they
 * produced, at the quality of the planner, across every artefact rather than
 * just code. And the manager holding that gate is the interactive session —
 * the only thing that can spawn a subagent at all.
 *
 * Reviewing already happens; it just happens by luck. This makes it recorded, so
 * `golem task done` can refuse while anything is outstanding.
 *
 * ## Why the ledger records DELEGATIONS and not artefacts
 *
 * The brief asked for per-artefact provenance. That is not observable, and
 * saying so is better than approximating it:
 *
 * - A subagent's file writes go through the HARNESS's own tools, not through
 *   Golem. Golem never sees them as its own operations.
 * - `PostToolUse` fires for a child's calls, but nothing in the payload reliably
 *   distinguishes a child's call from the parent's. The one existing subagent
 *   signal is a `cwd` heuristic for `isolation: "worktree"`, which is a special
 *   case, not a general answer.
 * - The proxy sees model requests, so it can tell that a cheaper model ran — that
 *   is how verification-notes §148 proved the subagent route works — but it
 *   cannot attribute a request to a file path.
 *
 * What IS reliably observable is the **spawn**, because the parent proposes it as
 * a tool call and `pre-tool-use.ts` already intercepts exactly that to gate
 * headroom. So the ledger records the dispatch: when, what agent, what for. The
 * gate then asks the manager to confirm the output was reviewed, rather than
 * pretending to know which bytes came from where.
 *
 * That is a weaker claim than per-file attribution and an honest one. Per-file
 * would need a harness-side signal that does not exist today.
 *
 * ## Not the spawn-gate state
 *
 * `spawn-gate.ts` already records spawn timestamps, but it prunes them on a
 * 6-hour TTL because it is answering "how much of this window have I already
 * committed?". A review obligation must not expire because six hours passed —
 * that would let the gate be waited out, which is the one failure mode a gate
 * must not have. Separate file, separate lifetime.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** One dispatched subagent, and whether its output has been reviewed. */
export interface DelegationRecord {
  /** Short stable id, used by `golem task review <id>`. */
  readonly id: string;
  /** ISO time of the spawn. */
  readonly at: string;
  /** The agent that was dispatched (`subagent_type`), e.g. `golem-scribe`. */
  readonly agentType: string;
  /** The spawn's own one-line description, when it gave one. */
  readonly description?: string;
  /** The parent session that dispatched it. */
  readonly sessionId?: string;
  /** Set once a human or the managing session has reviewed the output. */
  readonly reviewedAt?: string;
  /** Set when the obligation was explicitly waived rather than met. */
  readonly waivedAt?: string;
  /** Why it was waived — required, so a waiver leaves a reason behind. */
  readonly waivedReason?: string;
}

export interface DelegationLedger {
  readonly delegations: readonly DelegationRecord[];
}

const EMPTY: DelegationLedger = { delegations: [] };

/** `<project>/.golem/state/delegations.json` — local state, never committed. */
export function delegationLedgerPath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "delegations.json");
}

/**
 * Read the ledger. A missing or corrupt file is an EMPTY ledger, never an error:
 * this is read from a hook on the critical path of every tool call, and failing
 * there would break the session over a bookkeeping file.
 */
export async function readDelegationLedger(projectDir: string): Promise<DelegationLedger> {
  try {
    const raw = await readFile(delegationLedgerPath(projectDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as DelegationLedger).delegations)
    ) {
      return EMPTY;
    }
    const rows = (parsed as DelegationLedger).delegations.filter(
      (d): d is DelegationRecord =>
        typeof d === "object" &&
        d !== null &&
        typeof d.id === "string" &&
        typeof d.at === "string" &&
        typeof d.agentType === "string",
    );
    return { delegations: rows };
  } catch {
    return EMPTY;
  }
}

export async function writeDelegationLedger(
  projectDir: string,
  ledger: DelegationLedger,
): Promise<void> {
  const file = delegationLedgerPath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

/** A short, collision-resistant-enough id for one delegation. */
export function delegationId(at: string, agentType: string, seq: number): string {
  const stamp = at.replace(/[^0-9]/gu, "").slice(8, 14); // HHMMSS
  const slug = agentType
    .replace(/[^a-z0-9]+/giu, "-")
    .toLowerCase()
    .slice(0, 12);
  return `${slug}-${stamp}-${seq}`;
}

/** Append one delegation. Pure on the ledger value; the caller persists. */
export function appendDelegation(
  ledger: DelegationLedger,
  entry: Omit<DelegationRecord, "id">,
): DelegationLedger {
  const id = delegationId(entry.at, entry.agentType, ledger.delegations.length + 1);
  return { delegations: [...ledger.delegations, { ...entry, id }] };
}

/** Delegations still owing a review — neither reviewed nor waived. */
export function unreviewedDelegations(ledger: DelegationLedger): readonly DelegationRecord[] {
  return ledger.delegations.filter((d) => d.reviewedAt === undefined && d.waivedAt === undefined);
}

/**
 * Mark one delegation reviewed, or every outstanding one when `id` is undefined.
 * Returns the updated ledger and how many it actually changed, so a caller can
 * tell "marked 3" from "there was nothing to mark" — reporting success for a
 * no-op is the dishonest-signal class this repo keeps closing.
 */
export function markReviewed(
  ledger: DelegationLedger,
  nowIso: string,
  id?: string,
): { readonly ledger: DelegationLedger; readonly changed: number } {
  let changed = 0;
  const delegations = ledger.delegations.map((d) => {
    if (d.reviewedAt !== undefined || d.waivedAt !== undefined) return d;
    if (id !== undefined && d.id !== id) return d;
    changed += 1;
    return { ...d, reviewedAt: nowIso };
  });
  return { ledger: { delegations }, changed };
}

/**
 * Waive the review obligation, loudly and with a reason.
 *
 * The escape hatch exists because on a solo repo an unskippable gate becomes
 * friction, and friction gets bypassed in ways that leave no record at all. This
 * leaves a record. It follows `proxy.bypass_all`'s posture: never a default,
 * always deliberate, and the reason is not optional.
 */
export function waiveReview(
  ledger: DelegationLedger,
  nowIso: string,
  reason: string,
  id?: string,
): { readonly ledger: DelegationLedger; readonly changed: number } {
  let changed = 0;
  const delegations = ledger.delegations.map((d) => {
    if (d.reviewedAt !== undefined || d.waivedAt !== undefined) return d;
    if (id !== undefined && d.id !== id) return d;
    changed += 1;
    return { ...d, waivedAt: nowIso, waivedReason: reason };
  });
  return { ledger: { delegations }, changed };
}

/** The refusal `golem task done` prints while reviews are outstanding. */
export function unreviewedRefusal(outstanding: readonly DelegationRecord[]): string {
  const lines = [
    `${outstanding.length} delegated ${outstanding.length === 1 ? "run has" : "runs have"} not been reviewed:`,
    "",
  ];
  for (const d of outstanding) {
    const what = d.description !== undefined ? ` — ${d.description}` : "";
    lines.push(`  ${d.id}  ${d.agentType}  ${d.at}${what}`);
  }
  lines.push("");
  lines.push(
    "A delegated model is good at the shape of the work and unreliable on its " +
      "specifics, so its output is reviewed by the session that dispatched it " +
      "before a task closes (R14.6).",
  );
  lines.push("");
  lines.push("  golem task review <id>          mark one reviewed");
  lines.push("  golem task review --all         mark every outstanding run reviewed");
  lines.push('  golem task review --waive "why" close without reviewing (recorded)');
  return lines.join("\n");
}
