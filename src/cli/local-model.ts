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

import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chatModelFor, createProbeRunner, detectCapability } from "../inference/index.js";

export interface LocalModelState {
  readonly reachable: boolean;
  /**
   * The concrete local model the `coder`/`drafter` role runs at this machine's
   * hardware tier (e.g. `qwen2.5-coder:7b`), when the local model is reachable.
   * Absent when unreachable or not yet resolved.
   */
  readonly coderModel?: string;
  readonly ts: string;
}

/** Reachability plus the resolved coder model — the info the status surfaces show. */
export interface LocalModelInfo {
  readonly reachable: boolean;
  readonly coderModel?: string;
}

/** Statusline treats a cache entry older than this as stale and re-probes. */
export const LOCAL_CACHE_TTL_MS = 60_000;

export function localModelCachePath(projectDir: string): string {
  return join(projectDir, ".golem", "state", "local-model.json");
}

/**
 * True iff `<projectDir>/.golem` already exists — i.e. the project opted into
 * Golem (`golem init` creates it). The status line runs in EVERY Claude Code
 * project (it may be a global `statusLine`), so best-effort writers must gate on
 * this: never bootstrap a `.golem/` folder in a repo that never used Golem.
 * Cheap single stat; never throws.
 */
export async function golemDirExists(projectDir: string): Promise<boolean> {
  try {
    await access(join(projectDir, ".golem"));
    return true;
  } catch {
    return false;
  }
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

/**
 * The concrete model the `coder`/`drafter` role runs at this machine's hardware
 * tier (e.g. `qwen2.5-coder:7b`). `detectCapability` never throws and degrades
 * to the CPU tier, so this always resolves; `""` only if the probe path itself
 * fails unexpectedly (guarded so callers never see a throw).
 */
export async function resolveCoderModel(): Promise<string> {
  try {
    const facts = await detectCapability(createProbeRunner());
    return chatModelFor(facts.tier, "drafter");
  } catch {
    return "";
  }
}

export async function writeLocalModelCache(
  projectDir: string,
  reachable: boolean,
  coderModel?: string,
): Promise<void> {
  // Never create `.golem/` from a best-effort cache write. Only write when the
  // project already opted into Golem (has `.golem/`); otherwise the status line —
  // which runs in every project — would litter non-Golem repos with a `.golem/`.
  if (!(await golemDirExists(projectDir))) return;
  const path = localModelCachePath(projectDir);
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    const payload = {
      reachable,
      ...(coderModel !== undefined && coderModel !== "" ? { coderModel } : {}),
      ts: new Date().toISOString(),
    };
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
/**
 * Live probe (reachability + coder model) that also refreshes the cache — for
 * surfaces that can afford a network call (`golem status`, the dashboard). The
 * coder model is resolved only when the local model is reachable. Never throws.
 */
export async function probeAndCacheLocalModelInfo(
  projectDir: string,
  baseUrl: string,
): Promise<LocalModelInfo> {
  const reachable = await probeLocalModel(baseUrl);
  const coderModel = reachable ? await resolveCoderModel() : "";
  await writeLocalModelCache(projectDir, reachable, coderModel);
  return { reachable, ...(coderModel !== "" ? { coderModel } : {}) };
}

export async function probeAndCacheLocalModel(
  projectDir: string,
  baseUrl: string,
): Promise<boolean> {
  return (await probeAndCacheLocalModelInfo(projectDir, baseUrl)).reachable;
}

/**
 * Reachability + coder model for the per-turn status line: use a fresh cache if
 * present, else probe once (bounded) and refresh the cache. Never throws.
 */
export async function localModelInfoCached(
  projectDir: string,
  baseUrl: string,
): Promise<LocalModelInfo> {
  const cached = await readLocalModelCache(projectDir);
  if (cached && localCacheFresh(cached)) {
    return {
      reachable: cached.reachable,
      ...(cached.coderModel !== undefined ? { coderModel: cached.coderModel } : {}),
    };
  }
  return probeAndCacheLocalModelInfo(projectDir, baseUrl);
}

/**
 * Reachability for the per-turn status line: use a fresh cache if present, else
 * probe once (bounded) and refresh the cache. Never throws.
 */
export async function localModelReachableCached(
  projectDir: string,
  baseUrl: string,
): Promise<boolean> {
  return (await localModelInfoCached(projectDir, baseUrl)).reachable;
}
