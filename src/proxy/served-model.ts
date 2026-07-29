/**
 * Last-served upstream model (R6.2 display support).
 *
 * The proxy is the only component that knows which model actually fronted a
 * request. For a translating provider (openai/ollama/gemini) that is the
 * configured `proxy.upstream_model` (e.g. `kimi-k3`); the client's own
 * `claude-*` model never reaches the upstream. This module persists that model
 * to a small `.golem/state/served-model.json` snapshot so `golem status`,
 * `golem statusline`, and the VS Code extension can show the *current* model
 * without depending on the proxy being reachable or parsing telemetry.
 *
 * Observe-only and fail-open, exactly like {@link ./limit-prediction.ts}: it
 * never alters the forwarded response (CLAUDE.md proxy-fidelity), the write is
 * atomic (temp + rename), and a missing/corrupt file reads back as `null`.
 *
 * **It records WHICH upstream served the model.** A snapshot is only meaningful
 * for the account that produced it: after `golem account use <other>` the file
 * still described the previous account, so every display surface kept showing the
 * old model name until the new upstream happened to serve a request. The
 * `accountId` field makes that detectable — see {@link servedModelFor}, which is
 * what display surfaces should call.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** The last model the proxy served, and when. */
export interface ServedModel {
  /** Upstream model id, e.g. `kimi-k3`. */
  readonly model: string;
  /** When the proxy last served this model (ISO). */
  readonly servedAtIso: string;
  /**
   * The active account id when this model was served, or `null` for the
   * top-level (default) upstream config. Absent in snapshots written before this
   * field existed — treated as "unknown provenance" (see {@link servedModelFor}).
   */
  readonly accountId?: string | null;
}

const servedModelSchema = z.object({
  model: z.string(),
  servedAtIso: z.string(),
  accountId: z.string().nullable().optional(),
});

/** `.golem/state/served-model.json` for a project. */
export function servedModelPath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "served-model.json");
}

/** Persist the last-served model (atomic temp+rename). Fail-open — caller ignores errors. */
export async function writeServedModel(projectDir: string, state: ServedModel): Promise<void> {
  const file = servedModelPath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

/** Read the last-served model, or null (missing/corrupt). */
export async function readServedModel(projectDir: string): Promise<ServedModel | null> {
  let raw: string;
  try {
    raw = await readFile(servedModelPath(projectDir), "utf8");
  } catch {
    return null;
  }
  try {
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = servedModelSchema.safeParse(JSON.parse(stripped));
    if (!parsed.success) return null;
    const { model, servedAtIso, accountId } = parsed.data;
    // Spread-free rebuild: under exactOptionalPropertyTypes an optional key must
    // be absent, not present-and-undefined (a legacy snapshot has no accountId).
    return { model, servedAtIso, ...(accountId !== undefined ? { accountId } : {}) };
  } catch {
    return null;
  }
}

/**
 * Delete the snapshot. Called when the upstream changes (`golem account use`),
 * because the recorded model belongs to the account being switched away from —
 * keeping it would make every display surface claim the new upstream is serving
 * the old model. Fail-open: a missing file is success.
 */
export async function clearServedModel(projectDir: string): Promise<void> {
  await rm(servedModelPath(projectDir), { force: true });
}

/**
 * The last-served model **only if it belongs to `activeAccountId`** — the read
 * every display surface should use.
 *
 * A snapshot from another account is worse than no snapshot: it renders as a
 * confident, wrong "current model". So a mismatch returns `null`, letting the
 * caller fall back to the configured `upstream_model` (or show nothing) until the
 * new upstream actually serves something.
 *
 * A snapshot with no `accountId` (written before the field existed) is accepted
 * only when the top-level config is active — the case it was almost certainly
 * written under, and the one where being wrong is least likely.
 */
export async function servedModelFor(
  projectDir: string,
  activeAccountId: string | null,
): Promise<ServedModel | null> {
  const state = await readServedModel(projectDir);
  if (state === null) return null;
  const recorded = state.accountId ?? null;
  return recorded === activeAccountId ? state : null;
}
