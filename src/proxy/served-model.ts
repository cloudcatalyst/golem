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
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** The last model the proxy served, and when. */
export interface ServedModel {
  /** Upstream model id, e.g. `kimi-k3`. */
  readonly model: string;
  /** When the proxy last served this model (ISO). */
  readonly servedAtIso: string;
}

const servedModelSchema = z.object({
  model: z.string(),
  servedAtIso: z.string(),
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
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
