/**
 * Watching for corrections — the half that makes the guide LEARN.
 *
 * The design rests on one observation: **the user's own edits are not tool
 * calls.** A PostToolUse hook sees everything the agent writes and nothing the
 * human does, so a hook alone can never see the most valuable signal there is —
 * the agent wrote X, the human changed it to Y.
 *
 * So capture is two halves that meet in a small ledger:
 *
 * 1. When the agent writes a file, {@link recordAgentWrite} stores a hash of
 *    what it wrote plus a style reading of it — never the source itself.
 * 2. Later, {@link sweepCorrections} re-reads those files. A file whose hash has
 *    moved was changed by someone who is not the agent, and the difference
 *    between the two readings is a statement of preference.
 *
 * The ledger holds READINGS, not content. That keeps it small, keeps a second
 * copy of the user's source off the disk, and means the redaction question never
 * arises here — there is nothing in it to redact.
 *
 * It lives in the PROJECT (`.golem/state/vibe-pending.json`), not in the guide,
 * because it is per-checkout scaffolding with no meaning once swept. The guide
 * in `~` holds only conclusions.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyObservation, observeSource, type StyleObservation } from "./analyze.js";
import { recordSignal } from "./candidates.js";
import { diffObservations, type StyleSignal } from "./signals.js";
import type { VibeStore } from "./store.js";

/** One file the agent wrote, as it left the agent's hands. */
export interface PendingWrite {
  readonly hash: string;
  readonly observation: StyleObservation;
  readonly at: string;
}

export interface PendingLedger {
  readonly files: Record<string, PendingWrite>;
}

/**
 * How many files the ledger tracks before the oldest is dropped.
 *
 * A bound rather than a sweep-on-exit, because there is no reliable moment to
 * sweep: a session can end by crash, by usage limit, or by the window being
 * closed. An unbounded ledger in a long-running project would grow forever and
 * make every hook read slower.
 */
export const MAX_PENDING = 64;

export function pendingLedgerPath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "vibe-pending.json");
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function loadLedger(projectDir: string): Promise<PendingLedger> {
  try {
    const parsed = JSON.parse(
      await readFile(pendingLedgerPath(projectDir), "utf8"),
    ) as Partial<PendingLedger>;
    return { files: typeof parsed.files === "object" && parsed.files !== null ? parsed.files : {} };
  } catch {
    return { files: {} };
  }
}

async function saveLedger(projectDir: string, ledger: PendingLedger): Promise<void> {
  const file = pendingLedgerPath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

/** Drop the oldest entries until the ledger fits. */
function bound(files: Record<string, PendingWrite>): Record<string, PendingWrite> {
  const entries = Object.entries(files);
  if (entries.length <= MAX_PENDING) return files;
  entries.sort((a, b) => a[1].at.localeCompare(b[1].at));
  return Object.fromEntries(entries.slice(entries.length - MAX_PENDING));
}

/**
 * Record what the agent just wrote to a file.
 *
 * Cheap by construction: one hash and one line-level pass, both proportional to
 * a file the process has already loaded. This runs inside a PostToolUse hook, so
 * it is on the path of every single Edit — it may not be expensive and it may
 * not throw.
 */
export async function recordAgentWrite(
  projectDir: string,
  file: string,
  content: string,
  nowIso: string,
): Promise<void> {
  const ledger = await loadLedger(projectDir);
  const files = {
    ...ledger.files,
    [path.resolve(file)]: {
      hash: contentHash(content),
      observation: observeSource(content, emptyObservation()),
      at: nowIso,
    },
  };
  await saveLedger(projectDir, { files: bound(files) });
}

export interface SweepResult {
  /** Files whose content had moved since the agent wrote them. */
  readonly corrected: readonly string[];
  /** Signals recorded. Usually empty even when `corrected` is not. */
  readonly signals: readonly StyleSignal[];
  /** Entries dropped because the file is gone. */
  readonly dropped: readonly string[];
}

/**
 * Re-read every tracked file and record what the human changed.
 *
 * **Idempotent by design.** After a sweep the ledger holds the reading of the
 * file as it now stands, so running it twice over the same edit records the
 * signal once. That is what keeps a queue of candidates meaningful — a
 * double-counted correction would cross the quiz threshold on its own and the
 * threshold would stop meaning "this recurred".
 *
 * Returns an empty result rather than throwing on any failure. Capture is a
 * convenience; it may never be the reason an edit or a prompt fails.
 */
export async function sweepCorrections(
  projectDir: string,
  store: VibeStore,
  nowIso: string,
  only?: readonly string[],
): Promise<SweepResult> {
  const ledger = await loadLedger(projectDir);
  // A narrowed sweep still walks the whole ledger — entries outside `only` are
  // carried forward untouched rather than dropped. Rebuilding the ledger from
  // the subset would silently forget every other file the agent had written.
  const scope = only === undefined ? null : new Set(only.map((f) => path.resolve(f)));
  const corrected: string[] = [];
  const dropped: string[] = [];
  const signals: StyleSignal[] = [];
  const next: Record<string, PendingWrite> = {};

  for (const [file, pending] of Object.entries(ledger.files)) {
    if (scope !== null && !scope.has(file)) {
      next[file] = pending;
      continue;
    }
    let current: string;
    try {
      current = await readFile(file, "utf8");
    } catch {
      // Deleted, renamed, or on a drive that went away. Nothing to compare.
      dropped.push(file);
      continue;
    }

    const hash = contentHash(current);
    if (hash === pending.hash) {
      next[file] = pending;
      continue;
    }

    corrected.push(file);
    const after = observeSource(current, emptyObservation());
    for (const signal of diffObservations(pending.observation, after)) {
      const recorded = await recordSignal(store, signal, file, nowIso);
      // null means tombstoned — the human already declined this one.
      if (recorded !== null) signals.push(signal);
    }
    // Re-baseline: the human's version is now what "unchanged" means.
    next[file] = { hash, observation: after, at: nowIso };
  }

  if (corrected.length > 0 || dropped.length > 0) {
    await saveLedger(projectDir, { files: next });
  }
  return { corrected, signals, dropped };
}

/** Tool names whose result means a file on disk now holds agent-written text. */
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function isWriteTool(toolName: string | undefined): boolean {
  return toolName !== undefined && WRITE_TOOLS.has(toolName);
}

/**
 * Pull the file path out of a write tool's input.
 *
 * Claude Code spells it `file_path` on Edit/Write and `notebook_path` on
 * NotebookEdit. Unknown shapes return null and are simply not tracked — a
 * schema drift here must cost a missed signal, never an error.
 */
export function writeTargetPath(toolInput: unknown): string | null {
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const o = toolInput as Record<string, unknown>;
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = o[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}
