/**
 * WS-E T4 (spec Decision 20f) — `golem note` capture engine.
 *
 * Frictionless idea/note capture into a zone-1 (raw, local, gitignored)
 * append-only log: `<project>/.golem/notes/notes.jsonl`, one JSON object per
 * line, newest-appended-last — the same shape/robustness contract as A4's
 * telemetry JSONL store (src/telemetry/jsonl-store.ts): a corrupt/partial
 * trailing line is skipped on read, never thrown.
 *
 * Capture must be instant and dependency-free (no inference on the capture
 * path) — this module only redacts (pure, sync) and appends. Distillation
 * (T3's engine) is what later shapes captured notes into draft `questions/`
 * or `artifacts/` wiki pages, plan-gated like every other wiki write.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pipelineRedact, stripKnownSecrets } from "../hooks/redact.js";

export interface NoteEntry {
  readonly ts: string;
  readonly text: string;
}

/** Notes log location for a project. */
export function notesFilePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "notes", "notes.jsonl");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse one JSONL line into a NoteEntry, or null if malformed. */
function parseNote(line: string): NoteEntry | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null; // partial/corrupt trailing line — skip, don't throw
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.ts !== "string" || typeof parsed.text !== "string") return null;
  return { ts: parsed.ts, text: parsed.text };
}

/**
 * Redact and append a note. Redaction order matches the PostToolUse hook's
 * hard rule (CLAUDE.md: never weaken, never reorder): the pipeline redaction
 * stage runs first, the built-in secret-strip floor always on top.
 */
export async function appendNote(
  projectDir: string,
  rawText: string,
  nowIso: string,
): Promise<NoteEntry> {
  const entry: NoteEntry = { ts: nowIso, text: stripKnownSecrets(pipelineRedact(rawText)) };
  const file = notesFilePath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

/** Most recent `limit` notes, newest first. */
export async function listNotes(projectDir: string, limit = 20): Promise<NoteEntry[]> {
  let raw: string;
  try {
    raw = await readFile(notesFilePath(projectDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const entries: NoteEntry[] = [];
  for (const line of raw.split("\n")) {
    const note = parseNote(line);
    if (note !== null) entries.push(note);
  }
  return entries.slice(-limit).reverse();
}

/**
 * R3.5 — find one captured note by its exact `ts` (its unique key). Null if
 * no note has that timestamp, or the log doesn't exist yet.
 */
export async function findNoteByTs(projectDir: string, ts: string): Promise<NoteEntry | null> {
  let raw: string;
  try {
    raw = await readFile(notesFilePath(projectDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  for (const line of raw.split("\n")) {
    const note = parseNote(line);
    if (note !== null && note.ts === ts) return note;
  }
  return null;
}

/**
 * R3.4 — every note captured at or after `sinceIso` (inclusive), newest
 * first. ISO 8601 timestamps compare correctly as plain strings, so this
 * needs no date parsing.
 */
export async function listNotesSince(projectDir: string, sinceIso: string): Promise<NoteEntry[]> {
  let raw: string;
  try {
    raw = await readFile(notesFilePath(projectDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const entries: NoteEntry[] = [];
  for (const line of raw.split("\n")) {
    const note = parseNote(line);
    if (note !== null && note.ts >= sinceIso) entries.push(note);
  }
  return entries.reverse();
}

/** Human-readable rendering (the default, non---json output). */
export function renderNotes(entries: readonly NoteEntry[]): string {
  if (entries.length === 0) return 'No notes captured yet. Try: golem note "some idea"\n';
  const lines = entries.map((e) => `[${e.ts}] ${e.text}`);
  return `${lines.join("\n")}\n`;
}
