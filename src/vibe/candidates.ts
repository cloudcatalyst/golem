/**
 * The candidate queue: things noticed, not yet things believed.
 *
 * `~/.golem/vibe/candidates.jsonl` never reaches a prompt. It is a ledger of
 * corrections the capture layer saw, counted, so the quiz can ask about a
 * preference that RECURRED rather than one that happened once. A pattern seen
 * once is an edit; a pattern seen three times across three files is a
 * preference, and that distinction is the only thing standing between a useful
 * question and a nag.
 *
 * Three states, and the third is what makes the quiz bearable:
 *
 * - `open` — seen, never asked about
 * - `confirmed` — the human said yes; it is now in the guide
 * - `rejected` — the human said no. A TOMBSTONE, kept forever, because the
 *   alternative is asking the same declined question every week.
 *
 * JSONL rather than JSON: this file is appended to from a hook that may run
 * concurrently with another, and an append of one line survives interleaving in
 * a way that a read-modify-write of a whole document does not. Rows are folded
 * by key on read, last write winning, so a re-append is a legal update.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { type SignalKind, type StyleSignal, signalKey } from "./signals.js";
import type { VibeStore } from "./store.js";

export type CandidateState = "open" | "confirmed" | "rejected";

export interface Candidate {
  readonly key: string;
  readonly kind: SignalKind;
  readonly from: string;
  readonly to: string;
  /** How many distinct corrections produced this signal. */
  readonly seen: number;
  /** Distinct files it was seen in — breadth is stronger evidence than count. */
  readonly files: readonly string[];
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly state: CandidateState;
  /** Present on a confirmed candidate: what the human said, in their words. */
  readonly note?: string;
}

/** How many sightings before the quiz is allowed to ask. */
export const QUIZ_THRESHOLD = 2;

/**
 * Read the ledger, folded by key.
 *
 * A malformed line is SKIPPED rather than fatal. This file is appended to by a
 * hook; a partial write from a killed process must not make the whole guide
 * unreadable.
 */
export async function loadCandidates(store: VibeStore): Promise<Candidate[]> {
  let raw: string;
  try {
    raw = await readFile(store.paths.candidates, "utf8");
  } catch {
    return [];
  }
  const byKey = new Map<string, Candidate>();
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as Candidate;
      if (typeof row.key !== "string") continue;
      byKey.set(row.key, row);
    } catch {
      // A torn line is not a reason to lose the other 400.
    }
  }
  return [...byKey.values()].sort((a, b) => b.seen - a.seen || a.key.localeCompare(b.key));
}

async function append(store: VibeStore, row: Candidate): Promise<void> {
  await mkdir(path.dirname(store.paths.candidates), { recursive: true });
  await appendFile(store.paths.candidates, `${JSON.stringify(row)}\n`, "utf8");
}

/**
 * Record one observed correction.
 *
 * Returns the candidate as it now stands, or null when the signal is tombstoned
 * — a rejected preference is never resurrected by seeing it again, which is the
 * whole value of the tombstone.
 */
export async function recordSignal(
  store: VibeStore,
  signal: StyleSignal,
  file: string,
  nowIso: string,
): Promise<Candidate | null> {
  const key = signalKey(signal);
  const existing = (await loadCandidates(store)).find((c) => c.key === key);
  if (existing?.state === "rejected") return null;

  const files = existing === undefined ? [file] : [...new Set([...existing.files, file])];
  const row: Candidate = {
    key,
    kind: signal.kind,
    from: signal.from,
    to: signal.to,
    seen: (existing?.seen ?? 0) + 1,
    files,
    firstSeen: existing?.firstSeen ?? nowIso,
    lastSeen: nowIso,
    state: existing?.state ?? "open",
    ...(existing?.note === undefined ? {} : { note: existing.note }),
  };
  await append(store, row);
  return row;
}

/**
 * What the quiz may ask about: open, and seen enough times to be a preference
 * rather than an edit.
 */
export async function quizzable(
  store: VibeStore,
  threshold = QUIZ_THRESHOLD,
): Promise<Candidate[]> {
  return (await loadCandidates(store)).filter((c) => c.state === "open" && c.seen >= threshold);
}

/** Mark a candidate confirmed. The caller writes it into the guide. */
export async function confirmCandidate(
  store: VibeStore,
  key: string,
  nowIso: string,
  note?: string,
): Promise<Candidate | null> {
  return await transition(store, key, "confirmed", nowIso, note);
}

/** Tombstone a candidate, so it is never asked about again. */
export async function rejectCandidate(
  store: VibeStore,
  key: string,
  nowIso: string,
): Promise<Candidate | null> {
  return await transition(store, key, "rejected", nowIso);
}

async function transition(
  store: VibeStore,
  key: string,
  state: CandidateState,
  nowIso: string,
  note?: string,
): Promise<Candidate | null> {
  const existing = (await loadCandidates(store)).find((c) => c.key === key);
  if (existing === undefined) return null;
  const row: Candidate = {
    ...existing,
    state,
    lastSeen: nowIso,
    ...(note === undefined ? {} : { note }),
  };
  await append(store, row);
  return row;
}
