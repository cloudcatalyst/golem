/**
 * Self-update check + install-method detection (spec Decision 41e).
 *
 * Golem can be installed three ways (Decision 41b): as a global npm package, as a
 * Bun-compiled standalone binary, or (rare) something unknown. `golem update`
 * checks the npm registry for a newer `golem-run` and either performs the upgrade
 * or prints the right command for how this copy was installed.
 *
 * Everything here is fail-soft: the registry may be unreachable, the package may
 * not be published yet (404), or the cache file may be missing/corrupt. None of
 * that is an error — it just means "no update known right now". Nothing throws.
 *
 * The check result is cached under `<cacheDir>/update-check.json` so the hot
 * paths (status line, VS Code poll) can read a recent verdict WITHOUT a network
 * call — only an explicit `golem update --check` (or a stale cache) hits the net.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const PACKAGE_NAME = "golem-run";
const REGISTRY_URL = "https://registry.npmjs.org";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export type InstallMethod = "npm" | "binary" | "unknown";

/** The verdict of an update check — safe to serialize and cache. */
export interface UpdateCheck {
  readonly current: string;
  readonly latest: string | null;
  readonly updateAvailable: boolean;
  readonly method: InstallMethod;
  /** The exact command that upgrades this install. */
  readonly command: string;
  readonly checkedAt: string;
  /** Present when the latest version couldn't be determined (offline / not published). */
  readonly error?: string;
}

/**
 * How was this copy of golem installed?
 *  - running under a Bun standalone binary → "binary" (no npm to upgrade through);
 *  - main script under a node_modules dir  → "npm" (global package install);
 *  - otherwise                             → "unknown".
 * Args are injectable for testing.
 */
export function detectInstallMethod(opts?: { argv1?: string; bun?: boolean }): InstallMethod {
  const bun =
    opts?.bun ?? typeof (process as { versions?: { bun?: string } }).versions?.bun === "string";
  if (bun) return "binary";
  const argv1 = opts?.argv1 ?? process.argv[1] ?? "";
  // node_modules as a path segment (either separator) → npm-managed.
  if (/[\\/]node_modules[\\/]/.test(argv1)) return "npm";
  return "unknown";
}

/** Parse "X.Y.Z" (ignoring any -prerelease/+build suffix) → [major, minor, patch]. */
function parseSemver(v: string): [number, number, number] | null {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True iff semver `a` is strictly greater than `b`. Unparseable → false. */
export function semverGt(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) return false;
  for (let i = 0; i < 3; i++) {
    const x = pa[i] as number;
    const y = pb[i] as number;
    if (x !== y) return x > y;
  }
  return false;
}

/** The command that upgrades a given install method on a given platform. */
export function upgradeCommand(method: InstallMethod, platform: NodeJS.Platform): string {
  if (method === "npm") return `npm install -g ${PACKAGE_NAME}@latest`;
  // binary / unknown → re-run the installer (it detects and replaces in place).
  return platform === "win32" ? "irm https://golem.run | iex" : "curl -fsSL https://golem.run | sh";
}

/**
 * Fetch the latest published version of `pkg` from the npm registry. Returns null
 * on ANY problem (404 = not published yet, network error, timeout, bad JSON).
 * Never throws.
 */
export async function fetchLatestVersion(
  pkg: string = PACKAGE_NAME,
  timeoutMs = 3000,
): Promise<string | null> {
  try {
    const res = await fetch(`${REGISTRY_URL}/${pkg}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const parsed = z.object({ version: z.string() }).safeParse(body);
    return parsed.success ? parsed.data.version : null;
  } catch {
    return null;
  }
}

const cacheSchema = z
  .object({
    current: z.string(),
    latest: z.string().nullable(),
    updateAvailable: z.boolean(),
    method: z.enum(["npm", "binary", "unknown"]),
    command: z.string(),
    checkedAt: z.string(),
    error: z.string().optional(),
  })
  .passthrough();

function cachePath(cacheDir: string): string {
  return path.join(cacheDir, "update-check.json");
}

/**
 * Read a previously cached verdict without any network call. Missing/invalid →
 * null. For status line + VS Code poll (the hot paths). Never throws.
 */
export async function readCachedUpdateCheck(cacheDir: string): Promise<UpdateCheck | null> {
  try {
    const raw = await readFile(cachePath(cacheDir), "utf8");
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = cacheSchema.safeParse(JSON.parse(stripped));
    if (!parsed.success) return null;
    const d = parsed.data;
    return {
      current: d.current,
      latest: d.latest,
      updateAvailable: d.updateAvailable,
      method: d.method,
      command: d.command,
      checkedAt: d.checkedAt,
      ...(d.error !== undefined ? { error: d.error } : {}),
    };
  } catch {
    return null;
  }
}

async function writeCache(cacheDir: string, check: UpdateCheck): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
    const file = cachePath(cacheDir);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(check, null, 2)}\n`, "utf8");
    await rename(tmp, file);
  } catch {
    // Best-effort cache; a write failure must never break the check.
  }
}

export interface CheckForUpdateOptions {
  readonly current: string;
  readonly method?: InstallMethod;
  readonly platform?: NodeJS.Platform;
  /** Directory for the cached verdict (usually `<project>/.golem/state`). */
  readonly cacheDir?: string;
  /** Ignore a fresh cache and re-query the registry. */
  readonly force?: boolean;
  readonly now?: () => Date;
  readonly fetchLatest?: (pkg: string) => Promise<string | null>;
}

/**
 * Determine whether a newer golem-run exists. Uses the cache when it's fresh
 * (< 24h) unless `force`; otherwise queries the registry, caches, and returns.
 * The `updateAvailable`/`command` are always recomputed against the CURRENT
 * running version, so a cached "latest" stays correct after a manual upgrade.
 * Never throws.
 */
export async function checkForUpdate(opts: CheckForUpdateOptions): Promise<UpdateCheck> {
  const now = opts.now ?? (() => new Date());
  const method = opts.method ?? detectInstallMethod();
  const platform = opts.platform ?? process.platform;
  const command = upgradeCommand(method, platform);

  const build = (latest: string | null, error?: string): UpdateCheck => ({
    current: opts.current,
    latest,
    updateAvailable: latest !== null && semverGt(latest, opts.current),
    method,
    command,
    checkedAt: now().toISOString(),
    ...(error !== undefined ? { error } : {}),
  });

  // Fresh cache short-circuit (recompute the verdict against the live version).
  if (opts.cacheDir !== undefined && opts.force !== true) {
    const cached = await readCachedUpdateCheck(opts.cacheDir);
    if (cached !== null) {
      const age = now().getTime() - Date.parse(cached.checkedAt);
      if (Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS) {
        return {
          ...cached,
          current: opts.current,
          method,
          command,
          updateAvailable: cached.latest !== null && semverGt(cached.latest, opts.current),
        };
      }
    }
  }

  const fetchLatest = opts.fetchLatest ?? ((p: string) => fetchLatestVersion(p));
  const latest = await fetchLatest(PACKAGE_NAME);
  const result =
    latest === null
      ? build(null, "could not reach the npm registry (offline, or golem-run not published yet)")
      : build(latest);

  if (opts.cacheDir !== undefined) await writeCache(opts.cacheDir, result);
  return result;
}
