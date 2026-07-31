/**
 * R8.9 — `golem checkpoint`: the CLI half of the change ledger.
 *
 * Rendering plus the consent gate. Two things live here rather than in
 * `src/checkpoint/`:
 *
 * - **The preview.** A restore is destructive, so it prints exactly what it
 *   will write and what it will delete *before* asking. "Loud about what it
 *   will do before it does it" is the task's gate, not a nicety.
 * - **Consent.** Same convention as `golem wiki promote` (Decision 26): in a
 *   TTY, show and ask; non-interactive, refuse unless `--yes`. The autonomy
 *   gate is the *other* half — `golem checkpoint restore` is classified
 *   `destructive`, so an agent running it through Bash is gated to a human at
 *   every autonomy level (ADR-0002).
 *
 * Named `checkpoint`, not `ledger`: `golem stats --context` already ships a
 * "context ledger" (R8.4), and two ledgers would be one too many.
 */

import readline from "node:readline/promises";
import type { Checkpoint, RestorePlan, RestoreResult } from "../checkpoint/index.js";

/** How many paths a preview lists before it summarises the rest. */
const PREVIEW_PATHS = 12;

function ageLabel(createdIso: string, nowIso: string): string {
  const created = Date.parse(createdIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(created) || Number.isNaN(now)) return "";
  const minutes = Math.max(0, Math.round((now - created) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function renderCheckpointList(
  checkpoints: readonly Checkpoint[],
  nowIso: string,
  keep: number,
): string {
  if (checkpoints.length === 0) {
    return [
      "No checkpoints. Take one before a risky attempt:",
      "",
      '  golem checkpoint create --note "before refactoring the parser"',
      "",
      "Checkpoints are shadow git refs (refs/golem/ledger/*) — never commits on your",
      "branch, never staged, never pushed.",
      "",
    ].join("\n");
  }

  const lines = ["Golem change ledger — shadow refs, newest first:", ""];
  for (const [i, c] of checkpoints.entries()) {
    const marker = i === 0 ? "*" : " ";
    const kind = c.kind === "pre-restore" ? " [auto: pre-restore]" : "";
    lines.push(`${marker} ${c.id}  ${ageLabel(c.createdIso, nowIso)}${kind}`);
    lines.push(`    ${c.note}`);
    lines.push(`    ${c.commit.slice(0, 12)} · diff it with: git diff ${c.ref}`);
  }
  lines.push("");
  lines.push(
    `${checkpoints.length} checkpoint${checkpoints.length === 1 ? "" : "s"} · keeping the ${keep} newest · restore with: golem checkpoint restore <id|latest>`,
  );
  return `${lines.join("\n")}\n`;
}

function pathBlock(label: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const shown = paths.slice(0, PREVIEW_PATHS);
  const rest = paths.length - shown.length;
  const lines = [`${label} (${paths.length}):`];
  for (const p of shown) lines.push(`    ${p}`);
  if (rest > 0) lines.push(`    … and ${rest} more`);
  return lines;
}

/** The "here is what I am about to do" block, printed before the prompt. */
export function renderRestorePlan(plan: RestorePlan): string {
  const lines = [
    `Restore checkpoint ${plan.target.id} — "${plan.target.note}"`,
    `  ${plan.target.commit.slice(0, 12)} · taken ${plan.target.createdIso}`,
    "",
  ];
  if (plan.restore.length === 0 && plan.delete.length === 0) {
    lines.push("The working tree already matches this checkpoint — nothing to do.");
    return `${lines.join("\n")}\n`;
  }
  lines.push(...pathBlock("  overwrite with the checkpoint's copy", plan.restore));
  lines.push(...pathBlock("  DELETE (created after the checkpoint)", plan.delete));
  lines.push("");
  lines.push("Your branch, your index and your commits are NOT touched — worktree files only.");
  lines.push("A pre-restore checkpoint is taken first, so this is itself undoable.");
  return `${lines.join("\n")}\n`;
}

export function renderRestoreResult(result: RestoreResult): string {
  if (result.restored === 0 && result.deleted === 0) {
    return `Nothing to restore — the working tree already matches ${result.plan.target.id}.\n`;
  }
  const lines = [
    `Restored checkpoint ${result.plan.target.id}: ${result.restored} file(s) written, ${result.deleted} deleted.`,
  ];
  if (result.safety !== null) {
    lines.push(`Undo this restore with: golem checkpoint restore ${result.safety.id}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Thrown when a destructive ledger act can't get consent (non-TTY, no `--yes`). */
export class CheckpointRefusedError extends Error {}

export interface ConsentOptions {
  /** Skip the interactive confirmation (required in non-interactive use). */
  readonly yes: boolean;
  /** Test/override seam — defaults to `process.stdin.isTTY`. */
  readonly isTTY?: boolean;
  /** Test/override seam — defaults to a readline y/N prompt. */
  readonly confirm?: (question: string) => Promise<boolean>;
  /** Where the preview goes (defaults to stdout). */
  readonly onPreview?: (text: string) => void;
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

/**
 * Show `preview`, then get a yes.
 *
 * `--yes` skips the prompt but NOT the preview: a scripted restore should still
 * leave a record in the log of what it discarded.
 */
export async function confirmDestructive(
  preview: string,
  question: string,
  opts: ConsentOptions,
): Promise<boolean> {
  (opts.onPreview ?? ((t) => process.stdout.write(t)))(preview);
  if (opts.yes) return true;
  const isTTY = opts.isTTY ?? process.stdin.isTTY === true;
  if (!isTTY) {
    throw new CheckpointRefusedError(
      "refusing a destructive ledger action without confirmation in a non-interactive " +
        "session — re-run with --yes (nothing was changed)",
    );
  }
  return (opts.confirm ?? defaultConfirm)(question);
}
