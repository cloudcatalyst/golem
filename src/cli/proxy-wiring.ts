/**
 * Claude Code ↔ Golem proxy WIRING — the `.claude/settings.json` `env` entries
 * that point Claude Code at the local proxy, and the ownership rule that decides
 * when Golem may remove them.
 *
 * Split out of `init.ts` for Decision 56: `golem proxy unwire`/`wire` need the
 * same ownership-guarded edit that `golem uninit` performs, and re-deriving that
 * guard is how a third party's `ANTHROPIC_BASE_URL` eventually gets clobbered.
 * `init.ts` imports the constants and {@link removeGolemEnv} from here so there
 * is exactly one definition of "is this wiring ours?".
 *
 * **The ownership rule.** Golem removes an env key only when it holds *Golem's
 * own* value for this project — `ANTHROPIC_BASE_URL === http://localhost:<our
 * port>`. A base URL naming any other host belongs to another proxy or gateway
 * and is never touched, only reported (verification-notes §112(d)).
 *
 * **Why unwiring alone is not a fix.** `env` in `settings.json` is NOT
 * hot-reloaded by Claude Code (verification-notes §13/§112(b)) — only
 * `permissions`, `hooks` and `apiKeyHelper` are. Removing the key takes effect on
 * the next session, so every caller must surface the required reload rather than
 * report success and leave a broken editor. {@link UnwireResult.needsReload} is
 * that signal.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const ENV_BASE_URL = "ANTHROPIC_BASE_URL";
export const ENV_TOOL_SEARCH = "ENABLE_TOOL_SEARCH";
export const ENV_USE_FOUNDRY = "CLAUDE_CODE_USE_FOUNDRY";
export const ENV_FOUNDRY_BASE_URL = "ANTHROPIC_FOUNDRY_BASE_URL";

type JsonObject = Record<string, unknown>;

/** `http://localhost:<port>` — the base URL init writes for a given proxy port. */
export function proxyBaseUrl(port: number): string {
  return `http://localhost:${port}`;
}

export function claudeSettingsPath(projectDir: string): string {
  return path.join(projectDir, ".claude", "settings.json");
}

/**
 * Delete the env entries Golem owns, in place, and report whether anything
 * changed. Pure apart from the mutation of `envObj`, so the ownership rule is
 * unit-testable without a filesystem.
 *
 * Only removes a key when it holds Golem's value for `baseUrl`: a foreign
 * `ANTHROPIC_BASE_URL`, or a Foundry base URL pointing somewhere else, is left
 * exactly as found. `ENABLE_TOOL_SEARCH` is removed only when it is the `"true"`
 * init wrote (notes §12 — init sets it *because* a non-first-party base URL
 * disables tool search, so it is Golem's key while our wiring is present).
 */
export function removeGolemEnv(envObj: JsonObject, baseUrl: string): boolean {
  let changed = false;
  if (envObj[ENV_BASE_URL] === baseUrl) {
    delete envObj[ENV_BASE_URL];
    changed = true;
  }
  if (envObj[ENV_FOUNDRY_BASE_URL] === `${baseUrl}/anthropic`) {
    delete envObj[ENV_FOUNDRY_BASE_URL];
    if (envObj[ENV_USE_FOUNDRY] === "true") delete envObj[ENV_USE_FOUNDRY];
    changed = true;
  }
  if (envObj[ENV_TOOL_SEARCH] === "true") {
    delete envObj[ENV_TOOL_SEARCH];
    changed = true;
  }
  return changed;
}

/** What a base URL found in `.claude/settings.json` belongs to. */
export type WiringOwner = "golem" | "foreign" | "none";

export interface WiringState {
  readonly owner: WiringOwner;
  /** The `ANTHROPIC_BASE_URL` actually present, if any. */
  readonly baseUrl: string | null;
}

async function readJson(file: string): Promise<JsonObject | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: JsonObject): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function envOf(settings: JsonObject | null): JsonObject | null {
  const env = settings?.env;
  return typeof env === "object" && env !== null && !Array.isArray(env)
    ? (env as JsonObject)
    : null;
}

/** Is this project currently wired to OUR proxy, someone else's, or nothing? */
export async function readWiringState(projectDir: string, baseUrl: string): Promise<WiringState> {
  const env = envOf(await readJson(claudeSettingsPath(projectDir)));
  const current = env?.[ENV_BASE_URL];
  if (typeof current !== "string") return { owner: "none", baseUrl: null };
  return { owner: current === baseUrl ? "golem" : "foreign", baseUrl: current };
}

export interface UnwireResult {
  /** Did the file change? False when already unwired, or when the wiring is foreign. */
  readonly changed: boolean;
  /** Set when an `ANTHROPIC_BASE_URL` we do NOT own was found and deliberately left alone. */
  readonly foreignBaseUrl?: string;
  /**
   * True whenever the file changed — Claude Code does not hot-reload `env`
   * (§13/§112b), so the running session keeps the old value until it restarts.
   * Callers MUST surface this; reporting a bare success is the defect Decision 56
   * exists to remove.
   */
  readonly needsReload: boolean;
}

/**
 * Remove Golem's wiring from `.claude/settings.json`, leaving a foreign base URL
 * untouched. Idempotent: unwiring an already-unwired project is a no-op.
 */
export async function unwireProxyEnv(
  projectDir: string,
  baseUrl: string,
  opts: { readonly dryRun?: boolean } = {},
): Promise<UnwireResult> {
  const file = claudeSettingsPath(projectDir);
  const settings = await readJson(file);
  const env = envOf(settings);
  if (settings === null || env === null) return { changed: false, needsReload: false };

  const current = env[ENV_BASE_URL];
  if (typeof current === "string" && current !== baseUrl) {
    return { changed: false, foreignBaseUrl: current, needsReload: false };
  }

  const changed = removeGolemEnv(env, baseUrl);
  if (!changed) return { changed: false, needsReload: false };
  if (Object.keys(env).length === 0) delete settings.env;
  if (opts.dryRun !== true) await writeJson(file, settings);
  return { changed: true, needsReload: true };
}

export interface WireResult {
  readonly changed: boolean;
  /** A foreign base URL blocks re-wiring — we refuse rather than overwrite it. */
  readonly foreignBaseUrl?: string;
  readonly needsReload: boolean;
}

/**
 * Point Claude Code back at the local proxy — the inverse of
 * {@link unwireProxyEnv}. Refuses when a foreign `ANTHROPIC_BASE_URL` is present,
 * matching `golem init`'s conflict rule: another gateway owning this project's
 * traffic is a decision for the human, not something to overwrite.
 */
export async function wireProxyEnv(
  projectDir: string,
  baseUrl: string,
  opts: { readonly dryRun?: boolean } = {},
): Promise<WireResult> {
  const file = claudeSettingsPath(projectDir);
  const settings = (await readJson(file)) ?? {};
  const existing = envOf(settings);
  const env: JsonObject = existing ?? {};

  const current = env[ENV_BASE_URL];
  if (typeof current === "string" && current !== baseUrl) {
    return { changed: false, foreignBaseUrl: current, needsReload: false };
  }
  if (current === baseUrl && env[ENV_TOOL_SEARCH] === "true") {
    return { changed: false, needsReload: false };
  }

  env[ENV_BASE_URL] = baseUrl;
  env[ENV_TOOL_SEARCH] = "true"; // notes §12: re-enable tool search behind a gateway
  settings.env = env;
  if (opts.dryRun !== true) await writeJson(file, settings);
  return { changed: true, needsReload: true };
}
