/**
 * R5.4 (WS-F4 / spec 20d) — autonomy level policy + persistence.
 *
 * The level is project-scoped state (like the slider), stored at
 * `<project>/.golem/state/autonomy.json`, read by the PreToolUse gate hook and
 * surfaced loudly (session-state report, status line, `golem autonomy`). Threat
 * model + full rationale: docs/wiki/decisions/ADR-0002-autonomy-approval-gates.md.
 *
 * Safety invariant: an unreadable/invalid file resolves to the MOST restrictive
 * level (`manual`), never the least — default-deny by construction.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** Autonomy levels, least→most permissive. There is deliberately no "full auto". */
export const AUTONOMY_LEVELS = ["manual", "assisted", "outcome"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** The safe default: approve every step (Golem adds no auto-approval). */
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "manual";

/**
 * Whether the PreToolUse gate is active at all. ON by default (safe): a fresh
 * project gets the gate. It is a SEPARATE toggle from the hook wiring, because
 * the PreToolUse hook is now shared with the snooze/coder-first nudges (spec
 * Decision 38/39) — wiring the hook must not force the gate on anyone who only
 * wanted snooze. `golem autonomy disable` sets this false (a loud, deliberate
 * opt-out, like slider level 0 — Decision 30); the nudges keep working.
 */
export const DEFAULT_AUTONOMY_GATE_ENABLED = true;

const levelSchema = z.enum(AUTONOMY_LEVELS);
const fileSchema = z
  .object({ level: levelSchema, enabled: z.boolean().optional(), ts: z.string().optional() })
  .passthrough();

/** The persisted autonomy state: the level + whether the gate is active. */
export interface AutonomyState {
  readonly level: AutonomyLevel;
  readonly enabled: boolean;
}

/** One-line human description of what each level does. */
export const AUTONOMY_LEVEL_HELP: Readonly<Record<AutonomyLevel, string>> = {
  manual: "approve every step (default — Golem never auto-approves)",
  assisted: "auto-approve read-only actions; writes/destructive/outward → you",
  outcome: "auto-approve reads and writes; destructive/outward always → you",
};

export function autonomyStatePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "autonomy.json");
}

/**
 * Read the full state. Missing OR present-but-invalid file → the most
 * restrictive default (`manual`, gate ENABLED) — fail closed. Never throws.
 */
export async function readAutonomyState(projectDir: string): Promise<AutonomyState> {
  try {
    const raw = await readFile(autonomyStatePath(projectDir), "utf8");
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = fileSchema.safeParse(JSON.parse(stripped));
    if (!parsed.success)
      return { level: DEFAULT_AUTONOMY_LEVEL, enabled: DEFAULT_AUTONOMY_GATE_ENABLED };
    return {
      level: parsed.data.level,
      enabled: parsed.data.enabled ?? DEFAULT_AUTONOMY_GATE_ENABLED,
    };
  } catch {
    return { level: DEFAULT_AUTONOMY_LEVEL, enabled: DEFAULT_AUTONOMY_GATE_ENABLED };
  }
}

/**
 * Read the effective level. Missing file → `manual`. A present-but-invalid file
 * ALSO → `manual` (fail closed), never throws.
 */
export async function readAutonomyLevel(projectDir: string): Promise<AutonomyLevel> {
  return (await readAutonomyState(projectDir)).level;
}

/**
 * Whether the gate is active. Missing/invalid → ON (fail closed to the safe,
 * most-restrictive state); only an explicit `"enabled": false` turns it off.
 */
export async function readAutonomyGateEnabled(projectDir: string): Promise<boolean> {
  return (await readAutonomyState(projectDir)).enabled;
}

/** Write the full state atomically (temp + rename). Throws only on write failure. */
async function writeAutonomyState(
  projectDir: string,
  state: AutonomyState,
  nowIso: string,
): Promise<void> {
  const file = autonomyStatePath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body = { level: state.level, enabled: state.enabled, ts: nowIso };
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

/** Persist a level, preserving the current gate-enabled flag. */
export async function writeAutonomyLevel(
  projectDir: string,
  level: AutonomyLevel,
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  const cur = await readAutonomyState(projectDir);
  await writeAutonomyState(projectDir, { level, enabled: cur.enabled }, nowIso);
}

/** Enable/disable the gate, preserving the current level. */
export async function setAutonomyGateEnabled(
  projectDir: string,
  enabled: boolean,
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  const cur = await readAutonomyState(projectDir);
  await writeAutonomyState(projectDir, { level: cur.level, enabled }, nowIso);
}

/** Validate a user-supplied level string, or throw a helpful error. */
export function parseAutonomyLevel(raw: string): AutonomyLevel {
  const parsed = levelSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid autonomy level "${raw}" (use: ${AUTONOMY_LEVELS.join(", ")})`);
  }
  return parsed.data;
}
