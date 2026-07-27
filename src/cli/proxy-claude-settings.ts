/**
 * Runtime helpers for toggling Claude Code's proxy URL in `.claude/settings.json`
 * when the Golem proxy daemon starts and stops.
 *
 * This is intentionally narrower than `golem init`/`golem uninit`: it only
 * touches the `env` block, and only the keys that point at this project's
 * Golem proxy. The last used mode (direct Anthropic vs Azure AI Foundry) is
 * remembered in `.golem/state/proxy-claude-mode.json` so `start`/`restart`
 * can restore the same wiring `stop` cleared.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/index.js";
import { InitError } from "./init.js";

const ENV_BASE_URL = "ANTHROPIC_BASE_URL";
const ENV_TOOL_SEARCH = "ENABLE_TOOL_SEARCH";
const ENV_USE_FOUNDRY = "CLAUDE_CODE_USE_FOUNDRY";
const ENV_FOUNDRY_BASE_URL = "ANTHROPIC_FOUNDRY_BASE_URL";

type JsonObject = Record<string, unknown>;
type ProxyClaudeMode = "direct" | "foundry";

function claudeSettingsPath(projectDir: string): string {
  return path.join(projectDir, ".claude", "settings.json");
}

function modeStatePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "proxy-claude-mode.json");
}

function proxyBaseUrl(port: number): string {
  return `http://localhost:${port}`;
}

async function readJsonObject(file: string): Promise<JsonObject | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InitError(`${file} is not valid JSON — fix or remove it, then retry`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InitError(`${file} must contain a JSON object`);
  }
  return parsed as JsonObject;
}

async function writeJsonObject(file: string, value: JsonObject): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Resolve the effective proxy port for a project from the config layer. */
async function resolveProjectPort(projectDir: string): Promise<number> {
  const { settings } = await loadConfig({ projectDir });
  return settings.proxy.port;
}

/** The local proxy base URL for this project (`http://localhost:<port>`). */
export async function proxyBaseUrlForProject(projectDir: string): Promise<string> {
  return proxyBaseUrl(await resolveProjectPort(projectDir));
}

async function readMode(projectDir: string): Promise<ProxyClaudeMode | null> {
  try {
    const raw = await readFile(modeStatePath(projectDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const mode = (parsed as JsonObject).mode;
      if (mode === "direct" || mode === "foundry") return mode;
    }
  } catch {
    // missing or unreadable → unknown
  }
  return null;
}

async function writeMode(projectDir: string, mode: ProxyClaudeMode | null): Promise<void> {
  const file = modeStatePath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  if (mode === null) {
    await rm(file, { force: true });
  } else {
    await writeFile(file, `${JSON.stringify({ mode }, null, 2)}\n`, "utf8");
  }
}

/**
 * Remove the Golem proxy URL from `.claude/settings.json` env, but only if it
 * points at this project's proxy. Foreign URLs and unrelated env keys are
 * preserved. The last active mode (direct/Foundry) is remembered so
 * `restoreClaudeProxyUrl` can recreate the same wiring.
 *
 * @returns true when the file was modified.
 */
export async function clearClaudeProxyUrl(projectDir: string): Promise<boolean> {
  const baseUrl = await proxyBaseUrlForProject(projectDir);
  const foundryBaseUrl = `${baseUrl}/anthropic`;
  const settings = await readJsonObject(claudeSettingsPath(projectDir));
  if (settings === null) return false;

  const envValue = settings.env;
  if (typeof envValue !== "object" || envValue === null || Array.isArray(envValue)) {
    return false;
  }
  const env = envValue as JsonObject;

  const directMatches = env[ENV_BASE_URL] === baseUrl;
  const foundryMatches =
    env[ENV_FOUNDRY_BASE_URL] === foundryBaseUrl && env[ENV_USE_FOUNDRY] === "true";
  if (!directMatches && !foundryMatches) return false;

  const mode: ProxyClaudeMode = foundryMatches ? "foundry" : "direct";
  let changed = false;

  if (directMatches) {
    delete env[ENV_BASE_URL];
    changed = true;
  }
  if (foundryMatches) {
    delete env[ENV_FOUNDRY_BASE_URL];
    if (env[ENV_USE_FOUNDRY] === "true") {
      delete env[ENV_USE_FOUNDRY];
    }
    changed = true;
  }
  if (ENV_TOOL_SEARCH in env && env[ENV_TOOL_SEARCH] === "true") {
    delete env[ENV_TOOL_SEARCH];
    changed = true;
  }
  if (!changed) return false;

  await writeMode(projectDir, mode);
  if (Object.keys(env).length === 0) delete settings.env;
  await writeJsonObject(claudeSettingsPath(projectDir), settings);
  return true;
}

/**
 * Restore the Golem proxy URL in `.claude/settings.json` env. Reuses the mode
 * last cleared (direct Anthropic by default), or defaults to direct if no mode
 * has been recorded. Creates `.claude/settings.json` if absent.
 *
 * @returns true when the file was modified.
 */
export async function restoreClaudeProxyUrl(projectDir: string): Promise<boolean> {
  const baseUrl = await proxyBaseUrlForProject(projectDir);
  const foundryBaseUrl = `${baseUrl}/anthropic`;
  const mode = (await readMode(projectDir)) ?? "direct";

  const settings = (await readJsonObject(claudeSettingsPath(projectDir))) ?? {};
  const envValue = settings.env;
  const env: JsonObject =
    typeof envValue === "object" && envValue !== null && !Array.isArray(envValue)
      ? (envValue as JsonObject)
      : {};
  settings.env = env;

  let changed = false;
  if (mode === "foundry") {
    if (env[ENV_USE_FOUNDRY] !== "true") {
      env[ENV_USE_FOUNDRY] = "true";
      changed = true;
    }
    if (env[ENV_FOUNDRY_BASE_URL] !== foundryBaseUrl) {
      env[ENV_FOUNDRY_BASE_URL] = foundryBaseUrl;
      changed = true;
    }
    if (env[ENV_BASE_URL] === baseUrl) {
      delete env[ENV_BASE_URL];
      changed = true;
    }
  } else {
    if (env[ENV_BASE_URL] !== baseUrl) {
      env[ENV_BASE_URL] = baseUrl;
      changed = true;
    }
    if (env[ENV_FOUNDRY_BASE_URL] === foundryBaseUrl) {
      delete env[ENV_FOUNDRY_BASE_URL];
      changed = true;
    }
    if (env[ENV_USE_FOUNDRY] === "true") {
      delete env[ENV_USE_FOUNDRY];
      changed = true;
    }
  }
  if (env[ENV_TOOL_SEARCH] !== "true") {
    env[ENV_TOOL_SEARCH] = "true";
    changed = true;
  }

  if (!changed) return false;
  await writeJsonObject(claudeSettingsPath(projectDir), settings);
  return true;
}

/**
 * Drop the cached mode record used by restore. Handy for tests and for
 * `golem uninit`, which removes the settings file entirely.
 */
export async function forgetClaudeProxyMode(projectDir: string): Promise<void> {
  await rm(modeStatePath(projectDir), { force: true });
}
