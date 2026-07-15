/**
 * Local-model reachability probe + short-TTL cache (Decision 30, "local+upstream"
 * status). A reachable local model (Ollama) means Golem is a local+upstream
 * hybrid at ANY slider level — `coder` works at every level, and level 3
 * auto-drafts / can answer locally — so the status surfaces render
 * "local+upstream" whenever this reports the local model up.
 *
 * The probe is a bounded GET /api/tags that never throws. The cache lets the
 * per-turn status line reflect availability without a network call on every
 * turn (the doc's "cache slow ops" guidance, verification-notes §28).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface LocalModelState {
  readonly reachable: boolean;
  readonly ts: string;
}

/** Statusline treats a cache entry older than this as stale and re-probes. */
export const LOCAL_CACHE_TTL_MS = 60_000;

export function localModelCachePath(projectDir: string): string {
  return join(projectDir, ".golem", "state", "local-model.json");
}

/** Bounded, never-throwing probe of an Ollama-style endpoint. */
export async function probeLocalModel(baseUrl: string, timeoutMs = 800): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL("/api/tags", baseUrl), { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { models?: unknown };
    return Array.isArray(body.models) && body.models.length > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function readLocalModelCache(projectDir: string): Promise<LocalModelState | null> {
  try {
    const raw = await readFile(localModelCachePath(projectDir), "utf8");
    const parsed = JSON.parse(raw) as LocalModelState;
    if (typeof parsed.reachable === "boolean" && typeof parsed.ts === "string") return parsed;
  } catch {
    // missing/corrupt cache — treat as "unknown"
  }
  return null;
}

export async function writeLocalModelCache(projectDir: string, reachable: boolean): Promise<void> {
  const path = localModelCachePath(projectDir);
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    const payload = { reachable, ts: new Date().toISOString() };
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  } catch {
    // best-effort cache; never fail the caller
  }
}

export function localCacheFresh(
  state: LocalModelState,
  nowMs: number = Date.now(),
  ttlMs: number = LOCAL_CACHE_TTL_MS,
): boolean {
  const t = Date.parse(state.ts);
  return Number.isFinite(t) && nowMs - t >= 0 && nowMs - t < ttlMs;
}

/**
 * Live probe that also refreshes the cache — for surfaces that can afford a
 * network call (`golem status`, the dashboard). Never throws.
 */
export async function probeAndCacheLocalModel(
  projectDir: string,
  baseUrl: string,
): Promise<boolean> {
  const reachable = await probeLocalModel(baseUrl);
  await writeLocalModelCache(projectDir, reachable);
  return reachable;
}

/**
 * Reachability for the per-turn status line: use a fresh cache if present, else
 * probe once (bounded) and refresh the cache. Never throws.
 */
export async function localModelReachableCached(
  projectDir: string,
  baseUrl: string,
): Promise<boolean> {
  const cached = await readLocalModelCache(projectDir);
  if (cached && localCacheFresh(cached)) return cached.reachable;
  return probeAndCacheLocalModel(projectDir, baseUrl);
}
