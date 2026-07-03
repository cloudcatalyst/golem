/**
 * WS-E E2 — `golem init` / `golem uninit` engine.
 *
 * Wires an existing Claude Code project to Golem, idempotently:
 *   1. `.claude/settings.json`  — env.ANTHROPIC_BASE_URL -> local proxy, plus
 *      ENABLE_TOOL_SEARCH=true (verification-notes §12: tool search is
 *      disabled by default behind a non-first-party base URL).
 *   2. `.mcp.json`              — project-scope stdio registration of the
 *      unified MCP server (`golem mcp serve`; verification-notes §9).
 *   3. `.claude/skills/golem/<cmd>/SKILL.md` — directory-namespaced skills
 *      (`/golem/slider` etc.; verification-notes §11). MCP prompt twins
 *      (`/mcp__golem__*`) come from the server itself and need no files.
 *   4. `.golem/settings.json`   — created with defaults when absent.
 *
 * `golem uninit` removes exactly what init added and nothing else. The
 * `.golem/` directory (settings + CCR store) is user data and is kept.
 *
 * Everything filesystem-external (is Claude Code installed? is a
 * `headroom wrap` proxy active?) sits behind {@link InitProbe} so tests
 * inject fakes; the real probe uses file markers only — no child processes.
 */

import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { writeSetting } from "../config/index.js";
import { P0_SKILLS } from "./skills.js";

/** External-state checks, injectable for tests. */
export interface InitProbe {
  /** Is Claude Code present on this machine? */
  claudeCodeInstalled(): Promise<boolean>;
  /** Is a `headroom wrap` proxy configured (mutually exclusive with Golem)? */
  headroomWrapActive(): Promise<boolean>;
}

/** File-marker probe: `~/.claude`(.json) for Claude Code, `~/.headroom` for wrap state. */
export function defaultProbe(home: string = homedir()): InitProbe {
  const exists = async (p: string): Promise<boolean> => {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  };
  return {
    async claudeCodeInstalled() {
      return (
        (await exists(path.join(home, ".claude"))) ||
        (await exists(path.join(home, ".claude.json")))
      );
    },
    async headroomWrapActive() {
      // verification-notes §5: wrap state lives under ~/.headroom. Any wrap*
      // entry (or a running-proxy marker) means Headroom owns the base URL.
      const dir = path.join(home, ".headroom");
      if (!(await exists(dir))) return false;
      try {
        const entries = await readdir(dir);
        return entries.some((e) => e.startsWith("wrap") || e === "proxy.pid");
      } catch {
        return false;
      }
    },
  };
}

export interface InitOptions {
  /** Project root to configure. */
  readonly projectDir: string;
  /** Compute and report actions without writing anything. */
  readonly dryRun?: boolean;
  /** Proxy port the base URL should point at (from Golem config; default 4653). */
  readonly proxyPort?: number;
  /** External-state probe; tests inject a fake. */
  readonly probe?: InitProbe;
}

export type ActionKind = "create" | "modify" | "skip" | "remove";

export interface InitAction {
  readonly kind: ActionKind;
  /** Path relative to the project root (POSIX separators for stable output). */
  readonly path: string;
  readonly detail: string;
}

export interface InitReport {
  readonly dryRun: boolean;
  readonly actions: readonly InitAction[];
}

/** A conflict or precondition failure with a user-actionable message. */
export class InitError extends Error {}

const DEFAULT_PROXY_PORT = 4653;
const ENV_BASE_URL = "ANTHROPIC_BASE_URL";
const ENV_TOOL_SEARCH = "ENABLE_TOOL_SEARCH";
const MCP_SERVER_KEY = "golem";

function proxyBaseUrl(port: number): string {
  return `http://localhost:${port}`;
}

function rel(projectDir: string, abs: string): string {
  return path.relative(projectDir, abs).split(path.sep).join("/");
}

type JsonObject = Record<string, unknown>;

/** Read a JSON object file; missing -> null; malformed -> InitError (never clobber). */
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
    throw new InitError(`${file} is not valid JSON — fix or remove it, then re-run golem init`);
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

function objectEntry(obj: JsonObject, key: string): JsonObject {
  const existing = obj[key];
  if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
    return existing as JsonObject;
  }
  const fresh: JsonObject = {};
  obj[key] = fresh;
  return fresh;
}

/** The `.mcp.json` entry init installs (verification-notes §9 schema). */
function golemMcpEntry(): JsonObject {
  return { type: "stdio", command: "golem", args: ["mcp", "serve"] };
}

export async function golemInit(options: InitOptions): Promise<InitReport> {
  const { projectDir } = options;
  const dryRun = options.dryRun ?? false;
  const port = options.proxyPort ?? DEFAULT_PROXY_PORT;
  const baseUrl = proxyBaseUrl(port);
  const probe = options.probe ?? defaultProbe();
  const actions: InitAction[] = [];

  if (!(await probe.claudeCodeInstalled())) {
    throw new InitError(
      "Claude Code was not detected on this machine (no ~/.claude or ~/.claude.json). " +
        "Install it first: https://claude.com/claude-code",
    );
  }
  if (await probe.headroomWrapActive()) {
    throw new InitError(
      "An active `headroom wrap` configuration was detected (~/.headroom). " +
        "Golem and `headroom wrap` both need to own ANTHROPIC_BASE_URL and are " +
        "mutually exclusive — run `headroom unwrap`, then re-run `golem init`.",
    );
  }

  // 1. .claude/settings.json — env block.
  const settingsPath = path.join(projectDir, ".claude", "settings.json");
  const settingsExisting = await readJsonObject(settingsPath);
  const settings = settingsExisting ?? {};
  const settingsExisted = settingsExisting !== null;
  const env = objectEntry(settings, "env");
  const currentBaseUrl = env[ENV_BASE_URL];
  if (typeof currentBaseUrl === "string" && currentBaseUrl !== baseUrl) {
    throw new InitError(
      `${rel(projectDir, settingsPath)} already sets ${ENV_BASE_URL}=${currentBaseUrl}. ` +
        "Another proxy or gateway owns this project's Claude Code traffic — remove that " +
        "setting (or `headroom unwrap`) before running golem init.",
    );
  }
  const envChanged = currentBaseUrl !== baseUrl || env[ENV_TOOL_SEARCH] !== "true";
  env[ENV_BASE_URL] = baseUrl;
  env[ENV_TOOL_SEARCH] = "true"; // notes §12: re-enable tool search behind a gateway
  if (envChanged) {
    actions.push({
      kind: settingsExisted ? "modify" : "create",
      path: rel(projectDir, settingsPath),
      detail: `env.${ENV_BASE_URL}=${baseUrl}, env.${ENV_TOOL_SEARCH}=true`,
    });
    if (!dryRun) await writeJsonObject(settingsPath, settings);
  } else {
    actions.push({
      kind: "skip",
      path: rel(projectDir, settingsPath),
      detail: "already configured",
    });
  }

  // 2. .mcp.json — project-scope MCP registration.
  const mcpPath = path.join(projectDir, ".mcp.json");
  const mcpExisting = await readJsonObject(mcpPath);
  const mcp = mcpExisting ?? {};
  const servers = objectEntry(mcp, "mcpServers");
  const desired = golemMcpEntry();
  if (JSON.stringify(servers[MCP_SERVER_KEY]) === JSON.stringify(desired)) {
    actions.push({ kind: "skip", path: rel(projectDir, mcpPath), detail: "already registered" });
  } else {
    servers[MCP_SERVER_KEY] = desired;
    actions.push({
      kind: mcpExisting === null ? "create" : "modify",
      path: rel(projectDir, mcpPath),
      detail: 'mcpServers.golem = stdio "golem mcp serve"',
    });
    if (!dryRun) await writeJsonObject(mcpPath, mcp);
  }

  // 3. Skills: .claude/skills/golem/<cmd>/SKILL.md -> /golem/<cmd>.
  for (const [name, content] of Object.entries(P0_SKILLS)) {
    const skillPath = path.join(projectDir, ".claude", "skills", "golem", name, "SKILL.md");
    let existing: string | null = null;
    try {
      existing = await readFile(skillPath, "utf8");
    } catch {
      existing = null;
    }
    if (existing === content) {
      actions.push({ kind: "skip", path: rel(projectDir, skillPath), detail: "up to date" });
      continue;
    }
    actions.push({
      kind: existing === null ? "create" : "modify",
      path: rel(projectDir, skillPath),
      detail: `/golem/${name} skill`,
    });
    if (!dryRun) {
      await mkdir(path.dirname(skillPath), { recursive: true });
      await writeFile(skillPath, content, "utf8");
    }
  }

  // 4. .golem/settings.json with defaults, only when absent.
  const golemSettingsPath = path.join(projectDir, ".golem", "settings.json");
  if ((await readJsonObject(golemSettingsPath)) === null) {
    actions.push({
      kind: "create",
      path: rel(projectDir, golemSettingsPath),
      detail: "slider.level=1 (lossless)",
    });
    if (!dryRun) await writeSetting("project", "slider.level", 1, { projectDir });
  } else {
    actions.push({
      kind: "skip",
      path: rel(projectDir, golemSettingsPath),
      detail: "already exists",
    });
  }

  return { dryRun, actions };
}

export interface UninitOptions {
  readonly projectDir: string;
  readonly dryRun?: boolean;
  readonly proxyPort?: number;
}

export async function golemUninit(options: UninitOptions): Promise<InitReport> {
  const { projectDir } = options;
  const dryRun = options.dryRun ?? false;
  const baseUrl = proxyBaseUrl(options.proxyPort ?? DEFAULT_PROXY_PORT);
  const actions: InitAction[] = [];

  // 1. Remove only the env keys init set, and only if they hold init's values.
  const settingsPath = path.join(projectDir, ".claude", "settings.json");
  const settings = await readJsonObject(settingsPath);
  const env = settings?.env;
  if (settings && typeof env === "object" && env !== null && !Array.isArray(env)) {
    const envObj = env as JsonObject;
    let changed = false;
    if (envObj[ENV_BASE_URL] === baseUrl) {
      delete envObj[ENV_BASE_URL];
      changed = true;
    }
    if (ENV_TOOL_SEARCH in envObj && envObj[ENV_TOOL_SEARCH] === "true") {
      delete envObj[ENV_TOOL_SEARCH];
      changed = true;
    }
    if (Object.keys(envObj).length === 0) delete settings.env;
    if (changed) {
      actions.push({
        kind: "modify",
        path: rel(projectDir, settingsPath),
        detail: "removed Golem env entries",
      });
      if (!dryRun) await writeJsonObject(settingsPath, settings);
    }
  }

  // 2. Remove the MCP registration.
  const mcpPath = path.join(projectDir, ".mcp.json");
  const mcp = await readJsonObject(mcpPath);
  const servers = mcp?.mcpServers;
  if (mcp && typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
    const serversObj = servers as JsonObject;
    if (MCP_SERVER_KEY in serversObj) {
      delete serversObj[MCP_SERVER_KEY];
      if (Object.keys(serversObj).length === 0) delete mcp.mcpServers;
      actions.push({
        kind: "modify",
        path: rel(projectDir, mcpPath),
        detail: "removed mcpServers.golem",
      });
      if (!dryRun) await writeJsonObject(mcpPath, mcp);
    }
  }

  // 3. Remove the whole golem skills namespace (all files in it are ours).
  const skillsDir = path.join(projectDir, ".claude", "skills", "golem");
  try {
    await access(skillsDir);
    actions.push({ kind: "remove", path: rel(projectDir, skillsDir), detail: "Golem skills" });
    if (!dryRun) await rm(skillsDir, { recursive: true, force: true });
  } catch {
    // not installed
  }

  // .golem/ (settings, CCR store) is user data — deliberately kept.
  if (actions.length === 0) {
    actions.push({ kind: "skip", path: ".", detail: "nothing to remove" });
  }
  return { dryRun, actions };
}
