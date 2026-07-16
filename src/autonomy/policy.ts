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

const levelSchema = z.enum(AUTONOMY_LEVELS);
const fileSchema = z.object({ level: levelSchema, ts: z.string().optional() }).passthrough();

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
 * Read the effective level. Missing file → `manual`. A present-but-invalid file
 * ALSO → `manual` (fail closed), never throws.
 */
export async function readAutonomyLevel(projectDir: string): Promise<AutonomyLevel> {
  try {
    const raw = await readFile(autonomyStatePath(projectDir), "utf8");
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = fileSchema.safeParse(JSON.parse(stripped));
    return parsed.success ? parsed.data.level : DEFAULT_AUTONOMY_LEVEL;
  } catch {
    return DEFAULT_AUTONOMY_LEVEL;
  }
}

/** Persist a level atomically (temp + rename). Best-effort; throws only on write failure. */
export async function writeAutonomyLevel(
  projectDir: string,
  level: AutonomyLevel,
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  const file = autonomyStatePath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ level, ts: nowIso }, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

/** Validate a user-supplied level string, or throw a helpful error. */
export function parseAutonomyLevel(raw: string): AutonomyLevel {
  const parsed = levelSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid autonomy level "${raw}" (use: ${AUTONOMY_LEVELS.join(", ")})`);
  }
  return parsed.data;
}
