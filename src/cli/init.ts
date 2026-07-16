/**
 * WS-E E2 — `golem init` / `golem uninit` engine.
 *
 * Wires an existing Claude Code project to Golem, idempotently:
 *   1. `.claude/settings.json`  — Claude Code → local proxy + ENABLE_TOOL_SEARCH.
 *      Direct Anthropic uses `ANTHROPIC_BASE_URL`; `foundry` uses the Foundry env
 *      (`CLAUDE_CODE_USE_FOUNDRY` + `ANTHROPIC_FOUNDRY_BASE_URL=<proxy>/anthropic`).
 *   1b. `.golem/settings.local.json` — proxy `upstream_base_url` when fronting a
 *      Foundry/generic gateway (Decision 22).
 *   2. `.mcp.json`              — stdio registration of `golem mcp serve` (§9).
 *   3. `.claude/skills/golem/<cmd>/SKILL.md` — namespaced `/golem/*` skills (§11).
 *   4. `.golem/settings.json`   — created with defaults when absent.
 *   5. PostToolUse CCR hook + Golem guidance (in the committed CLAUDE.md);
 *      status line + blocked-state hooks; WebFetch KB-cache hooks.
 *   6. `.vscode/settings.json` — `files.watcherExclude` for Golem's churny
 *      gitignored runtime dirs (telemetry/state/webcache/ccr/knowledge/notes/
 *      distill), so VS Code's Source Control icon doesn't flash on every write.
 *   7. The VS Code panel/status-bar extension — copied into VS Code's global
 *      extensions dir when VS Code is present (dependency-free; `deploy:local` style).
 *
 * `golem uninit` removes exactly what init added (including the Foundry env keys
 * and the installed VS Code extension). The `.golem/` directory (settings + CCR
 * store) is user data and is kept.
 *
 * Everything filesystem-external (Claude Code installed? `headroom wrap` active?
 * VS Code extensions dir?) sits behind {@link InitProbe} so tests inject fakes.
 */

import { access, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeSetting } from "../config/index.js";
import {
  addEventHook,
  addMatcherHook,
  addPostToolUseHook,
  NOTIFICATION_COMMAND,
  PERSONAL_RULES_GITIGNORE,
  PROMPT_SUBMIT_COMMAND,
  removeAllGuidanceRules,
  removeDefaultMode,
  removeEventHook,
  removeMatcherHook,
  removePostToolUseHook,
  removeStatusLine,
  SESSION_START_COMMAND,
  SESSION_START_MATCHER,
  seedDefaultGuidance,
  WEB_FETCH_MATCHER,
  WEB_FETCH_POST_COMMAND,
  WEB_FETCH_PRE_COMMAND,
  writeDefaultMode,
  writeStatusLine,
} from "../hooks/index.js";
import type { SliderLevel } from "../interfaces/index.js";
import { defaultProjectPort } from "./proxy-daemon.js";
import { P0_SKILLS } from "./skills.js";

/** External-state checks, injectable for tests. */
export interface InitProbe {
  /** Is Claude Code present on this machine? */
  claudeCodeInstalled(): Promise<boolean>;
  /** Is a `headroom wrap` proxy configured (mutually exclusive with Golem)? */
  headroomWrapActive(): Promise<boolean>;
  /**
   * The VS Code global extensions dir (`~/.vscode/extensions`) if VS Code is
   * present, else null. Optional so tests that don't exercise the extension
   * install can omit it (init then skips that step, touching no home dir).
   */
  vscodeExtensionsDir?(): Promise<string | null>;
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
    async vscodeExtensionsDir() {
      const dir = path.join(home, ".vscode", "extensions");
      return (await exists(dir)) ? dir : null;
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
  /**
   * Slider level to persist on first activation (when `.golem/settings.json`
   * doesn't exist yet). Default 1 (lossless). Lets a level-setting entry point
   * (e.g. `golem slider <n>`) activate the project at the chosen level instead
   * of always defaulting to 1 and then immediately overwriting it.
   */
  readonly initialLevel?: SliderLevel;
  /**
   * Front an Azure AI Foundry resource: wires Claude Code's Foundry env
   * (`CLAUDE_CODE_USE_FOUNDRY` + `ANTHROPIC_FOUNDRY_BASE_URL=<proxy>/anthropic`)
   * instead of `ANTHROPIC_BASE_URL`, and points the proxy upstream at this
   * resource base URL (e.g. `https://<resource>.services.ai.azure.com`).
   */
  readonly foundry?: string;
  /**
   * Front a generic Anthropic-compatible gateway (e.g. OpenRouter): Claude Code
   * still uses `ANTHROPIC_BASE_URL=<proxy>`, and the proxy upstream is set to
   * this URL. Ignored when `foundry` is set.
   */
  readonly upstream?: string;
  /** Override the VS Code extension source dir (tests). Default: the bundled one. */
  readonly vscodeSourceDir?: string;
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
const ENV_USE_FOUNDRY = "CLAUDE_CODE_USE_FOUNDRY";
const ENV_FOUNDRY_BASE_URL = "ANTHROPIC_FOUNDRY_BASE_URL";
const MCP_SERVER_KEY = "golem";
/**
 * Pre-approve Golem's own MCP tools so they don't prompt on first use. The
 * anchored allow glob covers every current and future Golem tool (Claude Code
 * permissions docs: allow globs are valid only after a literal `mcp__<server>__`
 * prefix). `wiki_upsert` is held on `ask` — it writes committed wiki files, and
 * an `ask` rule prompts even when an `allow` rule also matches (deny → ask →
 * allow precedence). Note: allow rules in a committed `.claude/settings.json`
 * activate only after the one-time Claude Code workspace-trust accept.
 */
const MCP_ALLOW_RULE = `mcp__${MCP_SERVER_KEY}__*`;
const MCP_ASK_RULE = `mcp__${MCP_SERVER_KEY}__wiki_upsert`;
/**
 * Golem's guidance lives in Claude Code project rules — `.claude/rules/golem-*.md`
 * (user decision 2026-07-16). Committed, team-wide, auto-loaded every session;
 * Golem never edits the user's CLAUDE.md. See src/hooks/guidance.ts.
 */
/** The conventional personal, gitignored instructions file (Golem doesn't write it). */
const PERSONAL_INSTRUCTIONS_FILENAME = "CLAUDE.local.md";

/** Runtime files copied into the installed VS Code extension (no tests/tooling). */
const VSCODE_EXTENSION_FILES = ["extension.js", "render.js", "package.json", "README.md", "media"];

/**
 * Golem's own gitignored runtime dirs that churn constantly while a proxy is
 * running (telemetry event log, statusline/dashboard state, webcache, CCR
 * store, knowledge index, notes, distill drafts). VS Code's git extension
 * recomputes repo status on any watched filesystem event — including
 * gitignored ones, since `files.watcherExclude` only excludes `.git`/
 * `node_modules` by default — so these writes make the Source Control sync
 * icon flash continuously. Excluding them from the workspace file watcher is
 * cosmetic (nothing here is ever committed) but stops the noise.
 */
const VSCODE_WATCHER_EXCLUDE_DIRS = [
  "**/.golem/telemetry/**",
  "**/.golem/state/**",
  "**/.golem/webcache/**",
  "**/.golem/ccr/**",
  "**/.golem/knowledge/**",
  "**/.golem/notes/**",
  "**/.golem/distill/**",
] as const;
const VSCODE_WATCHER_EXCLUDE_KEY = "files.watcherExclude";

function proxyBaseUrl(port: number): string {
  return `http://localhost:${port}`;
}

/** Where this package's bundled VS Code extension lives (dist/cli/init.js -> ../../vscode-extension). */
function defaultVscodeSourceDir(): string {
  return fileURLToPath(new URL("../../vscode-extension", import.meta.url));
}

/**
 * Idempotently ensure `entry` is in the project's `.gitignore`. Golem uses it to
 * keep the conventional personal `CLAUDE.local.md` out of version control (even
 * though Golem's own guidance now lives in the committed CLAUDE.md). Creates
 * .gitignore if absent; a no-op if the exact line is already present.
 */
async function ensureGitignored(
  projectDir: string,
  entry: string,
  dryRun: boolean,
): Promise<InitAction> {
  const file = path.join(projectDir, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(entry)) {
    return { kind: "skip", path: ".gitignore", detail: `${entry} already ignored` };
  }
  if (!dryRun) {
    const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
    await writeFile(file, `${existing}${sep}${entry}\n`, "utf8");
  }
  return {
    kind: existing === "" ? "create" : "modify",
    path: ".gitignore",
    detail: `ignore ${entry}`,
  };
}

/** Does a path exist? (module-level; the probe has its own scoped copy.) */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
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

/** Like {@link objectEntry} but for a string[] value (permission allow/ask lists). */
function stringArrayEntry(obj: JsonObject, key: string): string[] {
  const existing = obj[key];
  if (Array.isArray(existing)) return existing as string[];
  const fresh: string[] = [];
  obj[key] = fresh;
  return fresh;
}

/** Push a create/modify/skip action for the .claude/settings.json env block. */
function pushEnvAction(
  actions: InitAction[],
  changed: boolean,
  fileExisted: boolean,
  relPath: string,
  wrote: Readonly<Record<string, string>>,
): void {
  if (!changed) {
    actions.push({ kind: "skip", path: relPath, detail: "already configured" });
    return;
  }
  const detail = Object.entries(wrote)
    .map(([k, v]) => `env.${k}=${v}`)
    .join(", ");
  actions.push({ kind: fileExisted ? "modify" : "create", path: relPath, detail });
}

/** The `.mcp.json` entry init installs (verification-notes §9 schema). */
function golemMcpEntry(): JsonObject {
  return { type: "stdio", command: "golem", args: ["mcp", "serve"] };
}

/** Per-artifact result of the "is this project wired to Golem?" checks (E3). */
export interface InitStatus {
  /** `.claude/settings.json` env.ANTHROPIC_BASE_URL points at the Golem proxy. */
  readonly claudeSettingsWired: boolean;
  /** `.mcp.json` registers the golem MCP server with init's stdio entry. */
  readonly mcpRegistered: boolean;
  /** Every P0 skill file exists under `.claude/skills/golem/`. */
  readonly skillsInstalled: boolean;
  /** `<project>/.golem/settings.json` exists (created by init when absent). */
  readonly golemSettingsPresent: boolean;
  /** All of the above. */
  readonly initialized: boolean;
}

/**
 * Read-only status probe reusing init's own file checks — never throws on
 * malformed files (a broken JSON file simply reads as "not wired").
 */
export async function golemInitStatus(
  projectDir: string,
  proxyPort: number = DEFAULT_PROXY_PORT,
): Promise<InitStatus> {
  const baseUrl = proxyBaseUrl(proxyPort);

  const readSafe = async (file: string): Promise<JsonObject | null> => {
    try {
      return await readJsonObject(file);
    } catch {
      return null;
    }
  };

  const settings = await readSafe(path.join(projectDir, ".claude", "settings.json"));
  const env = settings?.env;
  const claudeSettingsWired =
    typeof env === "object" &&
    env !== null &&
    !Array.isArray(env) &&
    (env as JsonObject)[ENV_BASE_URL] === baseUrl;

  const mcp = await readSafe(path.join(projectDir, ".mcp.json"));
  const servers = mcp?.mcpServers;
  const mcpRegistered =
    typeof servers === "object" &&
    servers !== null &&
    !Array.isArray(servers) &&
    JSON.stringify((servers as JsonObject)[MCP_SERVER_KEY]) === JSON.stringify(golemMcpEntry());

  let skillsInstalled = true;
  for (const name of Object.keys(P0_SKILLS)) {
    try {
      await access(path.join(projectDir, ".claude", "skills", "golem", name, "SKILL.md"));
    } catch {
      skillsInstalled = false;
      break;
    }
  }

  const golemSettingsPresent =
    (await readSafe(path.join(projectDir, ".golem", "settings.json"))) !== null;

  return {
    claudeSettingsWired,
    mcpRegistered,
    skillsInstalled,
    golemSettingsPresent,
    initialized: claudeSettingsWired && mcpRegistered && skillsInstalled && golemSettingsPresent,
  };
}

export async function golemInit(options: InitOptions): Promise<InitReport> {
  const { projectDir } = options;
  const dryRun = options.dryRun ?? false;
  const probe = options.probe ?? defaultProbe();

  // Per-project proxy port: an explicit `proxy.port` in the project's settings
  // wins; then a forced option; else a stable per-project default so multiple
  // projects each get their own proxy without colliding on one port. A newly
  // assigned port is persisted below (step 4) so every surface reads the same one.
  const golemSettingsPath = path.join(projectDir, ".golem", "settings.json");
  const existingGolem = await readJsonObject(golemSettingsPath).catch(() => null);
  const explicitPort = (existingGolem?.proxy as JsonObject | undefined)?.port;
  const portAssigned = typeof explicitPort !== "number";
  const port =
    typeof explicitPort === "number"
      ? explicitPort
      : (options.proxyPort ?? defaultProjectPort(projectDir));
  const baseUrl = proxyBaseUrl(port);
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

  // 1. .claude/settings.json — env block (mode-aware).
  const settingsPath = path.join(projectDir, ".claude", "settings.json");
  const settingsExisting = await readJsonObject(settingsPath);
  const settings = settingsExisting ?? {};
  const settingsExisted = settingsExisting !== null;
  const env = objectEntry(settings, "env");

  // Upstream mode: Foundry (Claude Code Foundry env), a generic Anthropic-compatible
  // gateway, or direct Anthropic. Explicit flags win; otherwise, if the project is
  // ALREADY wired for Foundry (env has CLAUDE_CODE_USE_FOUNDRY), preserve that mode
  // rather than adding a conflicting ANTHROPIC_BASE_URL. `proxyUpstream` (if set) is
  // written to the proxy config; Claude Code always points at the LOCAL proxy.
  const existingFoundry =
    env[ENV_USE_FOUNDRY] === "true" && typeof env[ENV_FOUNDRY_BASE_URL] === "string";
  const useFoundry =
    options.foundry !== undefined || (options.upstream === undefined && existingFoundry);
  const proxyUpstream = options.foundry ?? options.upstream;

  if (useFoundry) {
    // Foundry appends the request path to the Foundry base URL; the proxy exposes
    // Anthropic's `/v1/messages` under `/anthropic` (the fix in §36).
    const foundryBaseUrl = `${baseUrl}/anthropic`;
    const currentFoundry = env[ENV_FOUNDRY_BASE_URL];
    if (typeof currentFoundry === "string" && currentFoundry !== foundryBaseUrl) {
      throw new InitError(
        `${rel(projectDir, settingsPath)} already sets ${ENV_FOUNDRY_BASE_URL}=${currentFoundry}. ` +
          "Remove it before pointing Foundry at the Golem proxy.",
      );
    }
    const changed =
      env[ENV_USE_FOUNDRY] !== "true" ||
      currentFoundry !== foundryBaseUrl ||
      env[ENV_TOOL_SEARCH] !== "true" ||
      env[ENV_BASE_URL] === baseUrl;
    env[ENV_USE_FOUNDRY] = "true";
    env[ENV_FOUNDRY_BASE_URL] = foundryBaseUrl;
    env[ENV_TOOL_SEARCH] = "true";
    // Switching from a prior direct-mode init: drop the now-conflicting base URL.
    if (env[ENV_BASE_URL] === baseUrl) delete env[ENV_BASE_URL];
    pushEnvAction(actions, changed, settingsExisted, rel(projectDir, settingsPath), {
      [ENV_USE_FOUNDRY]: "true",
      [ENV_FOUNDRY_BASE_URL]: foundryBaseUrl,
    });
    if (changed && !dryRun) await writeJsonObject(settingsPath, settings);
  } else {
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
    pushEnvAction(actions, envChanged, settingsExisted, rel(projectDir, settingsPath), {
      [ENV_BASE_URL]: baseUrl,
    });
    if (envChanged && !dryRun) await writeJsonObject(settingsPath, settings);
  }

  // 1c. .claude/settings.json — pre-approve Golem's own MCP tools so they don't
  // prompt on first use (all except wiki_upsert, which writes committed files).
  {
    const permissions = objectEntry(settings, "permissions");
    const allow = stringArrayEntry(permissions, "allow");
    const ask = stringArrayEntry(permissions, "ask");
    let permsChanged = false;
    if (!allow.includes(MCP_ALLOW_RULE)) {
      allow.push(MCP_ALLOW_RULE);
      permsChanged = true;
    }
    if (!ask.includes(MCP_ASK_RULE)) {
      ask.push(MCP_ASK_RULE);
      permsChanged = true;
    }
    actions.push(
      permsChanged
        ? {
            kind: settingsExisted ? "modify" : "create",
            path: rel(projectDir, settingsPath),
            detail: `permissions.allow += ${MCP_ALLOW_RULE}, permissions.ask += ${MCP_ASK_RULE}`,
          }
        : {
            kind: "skip",
            path: rel(projectDir, settingsPath),
            detail: "MCP tool permissions set",
          },
    );
    if (permsChanged && !dryRun) await writeJsonObject(settingsPath, settings);
  }

  // 1b. Proxy upstream (front Foundry / a generic gateway) — .golem/settings.local.json.
  if (proxyUpstream !== undefined) {
    const localPath = path.join(projectDir, ".golem", "settings.local.json");
    const localExisting = await readJsonObject(localPath).catch(() => null);
    const currentUpstream = (localExisting?.proxy as JsonObject | undefined)?.upstream_base_url;
    if (currentUpstream === proxyUpstream) {
      actions.push({ kind: "skip", path: rel(projectDir, localPath), detail: "upstream set" });
    } else {
      actions.push({
        kind: localExisting === null ? "create" : "modify",
        path: rel(projectDir, localPath),
        detail: `proxy.upstream_base_url=${proxyUpstream}`,
      });
      if (!dryRun) {
        await writeSetting("local", "proxy.upstream_base_url", proxyUpstream, { projectDir });
      }
    }
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

  // 4. .golem/settings.json — defaults when absent, plus the assigned proxy port.
  if (existingGolem === null) {
    const initialLevel = options.initialLevel ?? 1;
    actions.push({
      kind: "create",
      path: rel(projectDir, golemSettingsPath),
      detail: `slider.level=${initialLevel}, proxy.port=${port}`,
    });
    if (!dryRun) {
      await writeSetting("project", "slider.level", initialLevel, { projectDir });
      await writeSetting("project", "proxy.port", port, { projectDir });
    }
  } else if (portAssigned) {
    // Existing config but no explicit port yet — pin the per-project one.
    actions.push({
      kind: "modify",
      path: rel(projectDir, golemSettingsPath),
      detail: `proxy.port=${port}`,
    });
    if (!dryRun) await writeSetting("project", "proxy.port", port, { projectDir });
  } else {
    actions.push({
      kind: "skip",
      path: rel(projectDir, golemSettingsPath),
      detail: "already exists",
    });
  }

  // 5. PostToolUse hook + Golem guidance. Guidance is seeded (once) as Claude
  // Code project rules — `.claude/rules/golem-<feature>.md` (committed, team-wide,
  // auto-loaded every session). Golem never edits the user's CLAUDE.md. Defaults
  // are user-owned after seeding: `golem guidance disable <feature>` sticks.
  actions.push(await addPostToolUseHook({ projectDir, dryRun }));
  actions.push(...(await seedDefaultGuidance(projectDir, dryRun)));
  // Keep personal (`--user`) golem rules AND the conventional personal
  // instructions file out of version control.
  actions.push(await ensureGitignored(projectDir, PERSONAL_INSTRUCTIONS_FILENAME, dryRun));
  actions.push(await ensureGitignored(projectDir, PERSONAL_RULES_GITIGNORE, dryRun));

  // 6. Status line (21c) + blocked-state event hooks (21b).
  actions.push(await writeStatusLine({ projectDir, dryRun }));
  actions.push(await writeDefaultMode({ projectDir, dryRun }));
  actions.push(await addEventHook({ projectDir, dryRun }, "Notification", NOTIFICATION_COMMAND));
  actions.push(
    await addEventHook({ projectDir, dryRun }, "UserPromptSubmit", PROMPT_SUBMIT_COMMAND),
  );

  // 6b. WebFetch KB cache: query the KB before fetching (blocking pre-gate), and
  // capture every fetch into the KB (non-blocking post-capture) — §44.
  actions.push(
    await addMatcherHook(
      { projectDir, dryRun },
      {
        event: "PreToolUse",
        matcher: WEB_FETCH_MATCHER,
        command: WEB_FETCH_PRE_COMMAND,
        async: false,
        timeoutSeconds: 15,
      },
    ),
  );
  actions.push(
    await addMatcherHook(
      { projectDir, dryRun },
      {
        event: "PostToolUse",
        matcher: WEB_FETCH_MATCHER,
        command: WEB_FETCH_POST_COMMAND,
        async: true,
        timeoutSeconds: 60,
      },
    ),
  );

  // 6c. SessionStart: auto-start the proxy on project open if it was running (§47).
  actions.push(
    await addMatcherHook(
      { projectDir, dryRun },
      {
        event: "SessionStart",
        matcher: SESSION_START_MATCHER,
        command: SESSION_START_COMMAND,
        async: false,
        timeoutSeconds: 15,
      },
    ),
  );

  // 7. .vscode/settings.json — exclude Golem's churny runtime dirs (telemetry,
  // state, webcache, CCR, knowledge, notes, distill) from VS Code's file
  // watcher, so the Source Control sync icon doesn't flash on every proxy
  // write. Workspace-scoped, independent of whether VS Code itself is present.
  actions.push(await ensureVscodeWatcherExclude(projectDir, dryRun));

  // 8. Install the VS Code panel/status-bar extension (only if VS Code is present).
  const vscodeAction = await installVscodeExtension(options, dryRun);
  if (vscodeAction !== null) actions.push(vscodeAction);

  return { dryRun, actions };
}

/**
 * Idempotently add Golem's churny runtime dirs to `.vscode/settings.json`'s
 * `files.watcherExclude` (workspace-scoped, so it applies whether or not the
 * Golem VS Code extension itself is installed). Never removes or overwrites
 * unrelated keys or other watcherExclude entries the user already has.
 */
async function ensureVscodeWatcherExclude(
  projectDir: string,
  dryRun: boolean,
): Promise<InitAction> {
  const file = path.join(projectDir, ".vscode", "settings.json");
  const existing = await readJsonObject(file);
  const settings = existing ?? {};
  const watcherExclude = objectEntry(settings, VSCODE_WATCHER_EXCLUDE_KEY);

  let changed = false;
  for (const pattern of VSCODE_WATCHER_EXCLUDE_DIRS) {
    if (watcherExclude[pattern] !== true) {
      watcherExclude[pattern] = true;
      changed = true;
    }
  }

  const relPath = rel(projectDir, file);
  if (!changed) {
    return { kind: "skip", path: relPath, detail: "watcher excludes already set" };
  }
  if (!dryRun) await writeJsonObject(file, settings);
  return {
    kind: existing === null ? "create" : "modify",
    path: relPath,
    detail: "exclude Golem's runtime dirs from the file watcher",
  };
}

/** The removal half of {@link ensureVscodeWatcherExclude} — only ever deletes entries init added. */
async function removeVscodeWatcherExclude(
  projectDir: string,
  dryRun: boolean,
): Promise<InitAction> {
  const file = path.join(projectDir, ".vscode", "settings.json");
  const relPath = rel(projectDir, file);
  const settings = await readJsonObject(file);
  const watcherExclude = settings?.[VSCODE_WATCHER_EXCLUDE_KEY];
  if (
    settings === null ||
    typeof watcherExclude !== "object" ||
    watcherExclude === null ||
    Array.isArray(watcherExclude)
  ) {
    return { kind: "skip", path: relPath, detail: "not present" };
  }
  const watcherExcludeObj = watcherExclude as JsonObject;
  let changed = false;
  for (const pattern of VSCODE_WATCHER_EXCLUDE_DIRS) {
    if (watcherExcludeObj[pattern] === true) {
      delete watcherExcludeObj[pattern];
      changed = true;
    }
  }
  if (!changed) return { kind: "skip", path: relPath, detail: "not present" };
  if (Object.keys(watcherExcludeObj).length === 0) delete settings[VSCODE_WATCHER_EXCLUDE_KEY];
  if (!dryRun) await writeJsonObject(file, settings);
  return { kind: "modify", path: relPath, detail: "removed Golem watcher excludes" };
}

/**
 * Install the bundled VS Code extension by copying it into VS Code's global
 * extensions dir (dependency-free, the same mechanism as `deploy:local`). Returns
 * null when VS Code isn't detected (the probe returns no dir) so init stays a
 * no-op on machines without it. Idempotent: an already-installed same-version
 * copy is a skip.
 */
async function installVscodeExtension(
  options: InitOptions,
  dryRun: boolean,
): Promise<InitAction | null> {
  const probe = options.probe ?? defaultProbe();
  const extensionsDir = (await probe.vscodeExtensionsDir?.()) ?? null;
  if (extensionsDir === null) return null;

  const sourceDir = options.vscodeSourceDir ?? defaultVscodeSourceDir();
  const manifest = await readJsonObject(path.join(sourceDir, "package.json")).catch(() => null);
  if (manifest === null) return null; // source not shipped/available — skip quietly
  const id = `${String(manifest.publisher)}.${String(manifest.name)}-${String(manifest.version)}`;
  const target = path.join(extensionsDir, id);

  if (await pathExists(target)) {
    return { kind: "skip", path: `~/.vscode/extensions/${id}`, detail: "already installed" };
  }
  if (!dryRun) {
    await mkdir(target, { recursive: true });
    for (const name of VSCODE_EXTENSION_FILES) {
      const src = path.join(sourceDir, name);
      if (await pathExists(src)) await cp(src, path.join(target, name), { recursive: true });
    }
  }
  return {
    kind: "create",
    path: `~/.vscode/extensions/${id}`,
    detail: "VS Code panel + status bar (reload the window to activate)",
  };
}

/** Remove any installed Golem VS Code extension(s) — matches `golem-run.golem-vscode-*`. */
async function removeVscodeExtensions(
  options: UninitOptions,
  dryRun: boolean,
): Promise<InitAction[]> {
  const probe = options.probe ?? defaultProbe();
  const extensionsDir = (await probe.vscodeExtensionsDir?.()) ?? null;
  if (extensionsDir === null) return [];
  let entries: string[];
  try {
    entries = await readdir(extensionsDir);
  } catch {
    return [];
  }
  const mine = entries.filter((e) => e.startsWith("golem-run.golem-vscode-"));
  const out: InitAction[] = [];
  for (const id of mine) {
    out.push({ kind: "remove", path: `~/.vscode/extensions/${id}`, detail: "VS Code extension" });
    if (!dryRun) await rm(path.join(extensionsDir, id), { recursive: true, force: true });
  }
  return out;
}

export interface UninitOptions {
  readonly projectDir: string;
  readonly dryRun?: boolean;
  readonly proxyPort?: number;
  /** External-state probe; tests inject a fake (VS Code extensions dir). */
  readonly probe?: InitProbe;
}

export async function golemUninit(options: UninitOptions): Promise<InitReport> {
  const { projectDir } = options;
  const dryRun = options.dryRun ?? false;
  // Resolve the SAME per-project port init used, so we remove the right base URL.
  const existingGolem = await readJsonObject(
    path.join(projectDir, ".golem", "settings.json"),
  ).catch(() => null);
  const explicitPort = (existingGolem?.proxy as JsonObject | undefined)?.port;
  const port =
    typeof explicitPort === "number"
      ? explicitPort
      : (options.proxyPort ?? defaultProjectPort(projectDir));
  const baseUrl = proxyBaseUrl(port);
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
    // Foundry env (only if it points at our proxy).
    if (envObj[ENV_FOUNDRY_BASE_URL] === `${baseUrl}/anthropic`) {
      delete envObj[ENV_FOUNDRY_BASE_URL];
      if (envObj[ENV_USE_FOUNDRY] === "true") delete envObj[ENV_USE_FOUNDRY];
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

  // 1b. Remove only the MCP permission rules init added (exact rules only).
  const perms = settings?.permissions;
  if (settings && typeof perms === "object" && perms !== null && !Array.isArray(perms)) {
    const permsObj = perms as JsonObject;
    let changed = false;
    for (const [key, rule] of [
      ["allow", MCP_ALLOW_RULE],
      ["ask", MCP_ASK_RULE],
    ] as const) {
      const arr = permsObj[key];
      if (Array.isArray(arr)) {
        const idx = arr.indexOf(rule);
        if (idx !== -1) {
          arr.splice(idx, 1);
          changed = true;
        }
        if (arr.length === 0) delete permsObj[key];
      }
    }
    if (Object.keys(permsObj).length === 0) delete settings.permissions;
    if (changed) {
      actions.push({
        kind: "modify",
        path: rel(projectDir, settingsPath),
        detail: "removed Golem MCP permission rules",
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

  // 4. Remove the PostToolUse hook entry + the seeded Golem guidance rules
  // (`.claude/rules/golem-*.md`, both scopes) and the seed sentinel.
  actions.push(await removePostToolUseHook({ projectDir, dryRun }));
  actions.push(...(await removeAllGuidanceRules(projectDir, dryRun)));

  // 5. Remove the status line + blocked-state event hooks.
  actions.push(await removeStatusLine({ projectDir, dryRun }));
  actions.push(await removeDefaultMode({ projectDir, dryRun }));
  actions.push(await removeEventHook({ projectDir, dryRun }, "Notification", NOTIFICATION_COMMAND));
  actions.push(
    await removeEventHook({ projectDir, dryRun }, "UserPromptSubmit", PROMPT_SUBMIT_COMMAND),
  );

  // 5b. Remove the WebFetch KB-cache hooks + the SessionStart auto-start hook.
  actions.push(
    await removeMatcherHook({ projectDir, dryRun }, "PreToolUse", WEB_FETCH_PRE_COMMAND),
  );
  actions.push(
    await removeMatcherHook({ projectDir, dryRun }, "PostToolUse", WEB_FETCH_POST_COMMAND),
  );
  actions.push(
    await removeMatcherHook({ projectDir, dryRun }, "SessionStart", SESSION_START_COMMAND),
  );

  // 6. Remove the `.vscode/settings.json` watcher excludes init added.
  actions.push(await removeVscodeWatcherExclude(projectDir, dryRun));

  // 7. Remove the installed VS Code extension (global; only if present).
  actions.push(...(await removeVscodeExtensions(options, dryRun)));

  // .golem/ (settings, CCR store) is user data — deliberately kept.
  const substantive = actions.filter((a) => a.kind !== "skip");
  if (substantive.length === 0) {
    return { dryRun, actions: [{ kind: "skip", path: ".", detail: "nothing to remove" }] };
  }
  return { dryRun, actions };
}
