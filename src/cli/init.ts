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

import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { removeVersionStamp, writeSetting } from "../config/index.js";
import type { CompressionLevel } from "../interfaces/index.js";
import type { ClaudeSettingsScope } from "./claude-settings-target.js";
// `.claude/settings.json` — the env block, the loopback-CA trust and the MCP
// permission rules, plus their uninit mirrors. MCP_SERVER_KEY lives there
// because the permission rules are built from it at module scope.
import {
  configureClaudeSettings,
  MCP_SERVER_KEY,
  removeClaudeSettings,
} from "./init-claude-settings.js";
import { InitError } from "./init-error.js";
import { unwireHooks, wireHooks } from "./init-hooks.js";
import { installSkills, removeSkills } from "./init-skills.js";
import {
  ensureVscodeWatcherExclude,
  installVscodeExtension,
  removeVscodeExtensions,
  removeVscodeWatcherExclude,
} from "./init-vscode.js";
import { type JsonObject, objectEntry, readJsonObject, rel, writeJsonObject } from "./json-file.js";
import { removeManagedState } from "./managed-files.js";
import { defaultProjectPort } from "./proxy-daemon.js";
// Decision 56: the env keys and the "is this wiring ours?" guard live in one
// place, shared with `golem proxy unwire`/`wire`.
import { proxyBaseUrl, readWiredBaseUrl } from "./proxy-wiring.js";
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
   * Compression level to persist on first activation (when `.golem/settings.json`
   * doesn't exist yet). Default 1 (lossless). Lets a level-setting entry point
   * (e.g. `golem compression <v>`) activate the project at the chosen level instead
   * of always defaulting to 1 and then immediately overwriting it.
   */
  readonly initialLevel?: CompressionLevel;
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
  /**
   * R9.12: skip generating the loopback CA and trusting it via
   * `NODE_EXTRA_CA_CERTS`. Cache-served WebFetches then keep rendering as denied
   * (red) tool calls — the behaviour R9.7 shipped — instead of green.
   */
  readonly noLoopbackCert?: boolean;
  /**
   * Which `.claude` settings file to write: `local`
   * (`.claude/settings.local.json`, gitignored) or `project`
   * (`.claude/settings.json`, committed). Omitted, it comes from
   * `claude.settings_scope` — local by default. See claude-settings-target.ts.
   */
  readonly claudeSettingsScope?: ClaudeSettingsScope;
  /** Override the VS Code extension source dir (tests). Default: the bundled one. */
  readonly vscodeSourceDir?: string;
  /** External-state probe; tests inject a fake. */
  readonly probe?: InitProbe;
}

export type ActionKind =
  | "create"
  | "modify"
  | "skip"
  | "remove"
  /**
   * R9.5 — Golem has newer content for a managed file, but the file has been
   * edited since Golem wrote it (or Golem has no record of writing it), so it
   * was left alone. Distinct from `modify` on purpose: "refreshing stale text"
   * and "replacing your edit" must not render the same.
   */
  | "conflict";

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
// Re-exported (not declared here) so `json-file.ts` can throw it without
// importing init.ts — see init-error.ts. Every existing
// `import { InitError } from "../init.js"` keeps working.
export { InitError };

const DEFAULT_PROXY_PORT = 4653;
/**
 * Per-server wall-clock cap (ms) for the golem MCP server in `.mcp.json`. Sized
 * above `snooze`'s own 6h cap (src/mcp/snooze.ts) so a full park completes
 * (default MCP_TOOL_TIMEOUT is ~28h, so this is a tighter backstop); a stuck
 * golem tool is bounded to this. Fast tools finish well under it. Per-server —
 * NOT the invasive global auto-background override (removed; the snooze design
 * embraces backgrounding + document-and-hold rather than foreground-blocking).
 */
const GOLEM_MCP_TIMEOUT_MS = 23_400_000; // 6.5h
/** Runtime files copied into the installed VS Code extension (no tests/tooling). */

/** Where this package's bundled VS Code extension lives (dist/cli/init.js -> ../../vscode-extension). */

/** The `.mcp.json` entry init installs (verification-notes §9 schema). */
export function golemMcpEntry(): JsonObject {
  return {
    type: "stdio",
    command: "golem",
    args: ["mcp", "serve"],
    timeout: GOLEM_MCP_TIMEOUT_MS,
  };
}

/** Per-artifact result of the "is this project wired to Golem?" checks (E3). */
export interface InitStatus {
  /** `env.ANTHROPIC_BASE_URL` in EITHER `.claude` settings file points at the Golem proxy. */
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

  // Either `.claude` settings file counts: `claude.settings_scope` decides which
  // one init WRITES, and Claude Code reads both (local shadows committed). A
  // probe that only looked at one would call a wired project un-wired the moment
  // the scope changed.
  const claudeSettingsWired = (await readWiredBaseUrl(projectDir)) === baseUrl;

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
  const golemLocalPath = path.join(projectDir, ".golem", "settings.local.json");
  const existingGolem = await readJsonObject(golemSettingsPath).catch(() => null);
  const existingLocal = await readJsonObject(golemLocalPath).catch(() => null);
  // The per-project port lives in the gitignored local file (Decision 43); still
  // honor a legacy project-scoped `proxy.port` from an older init for back-compat.
  const explicitPort =
    (existingLocal?.proxy as JsonObject | undefined)?.port ??
    (existingGolem?.proxy as JsonObject | undefined)?.port;
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

  // 1 / 1b-bis / 1c. `.claude/settings.json`: the mode-aware env block (direct
  // Anthropic / Foundry / generic gateway), the loopback-CA trust in the
  // gitignored local scope, and the MCP tool pre-approval. See
  // init-claude-settings.ts — `golem uninit` mirrors all three from there too.
  actions.push(...(await configureClaudeSettings(options, baseUrl, dryRun)));

  // 1b. Proxy upstream (front Foundry / a generic gateway) — .golem/settings.local.json.
  // Which of the two flags is set decides the Claude Code env mode (step 1, in
  // init-claude-settings.ts); either one points the PROXY upstream at the URL.
  const proxyUpstream = options.foundry ?? options.upstream;
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
  actions.push(...(await installSkills(projectDir, dryRun)));

  // 4. .golem/settings.json (committed marker) + .golem/settings.local.json
  // (gitignored). The compression level and per-project proxy port are personal /
  // machine-local and transient, so they live in the local file; settings.json
  // stays a stable, content-free "this project uses Golem" marker so the file's
  // presence still signals init without churning on every dial/port change
  // (spec Decision 43).
  if (existingGolem === null) {
    if (!dryRun) await writeJsonObject(golemSettingsPath, {});
    actions.push({
      kind: "create",
      path: rel(projectDir, golemSettingsPath),
      detail: "Golem project marker",
    });
  }
  // Re-read: step 1b (--foundry/--gateway) may have created the local file above.
  const localBeforeStep4 = dryRun
    ? existingLocal
    : await readJsonObject(golemLocalPath).catch(() => null);
  if (localBeforeStep4 === null) {
    const initialLevel = options.initialLevel ?? 1;
    actions.push({
      kind: "create",
      path: rel(projectDir, golemLocalPath),
      detail: `compression.level=${initialLevel}, proxy.port=${port}`,
    });
    if (!dryRun) {
      await writeSetting("local", "compression.level", String(initialLevel), { projectDir });
      await writeSetting("local", "proxy.port", port, { projectDir });
    }
  } else if (portAssigned) {
    // Local file exists (e.g. --foundry just created it) but no explicit port yet
    // — pin the per-project one, and the compression baseline if it's missing too.
    actions.push({
      kind: "modify",
      path: rel(projectDir, golemLocalPath),
      detail: `proxy.port=${port}`,
    });
    if (!dryRun) {
      await writeSetting("local", "proxy.port", port, { projectDir });
      if ((localBeforeStep4.compression as JsonObject | undefined)?.level === undefined) {
        await writeSetting("local", "compression.level", String(options.initialLevel ?? 1), {
          projectDir,
        });
      }
    }
  } else {
    actions.push({
      kind: "skip",
      path: rel(projectDir, golemLocalPath),
      detail: "already exists",
    });
  }

  // 5 / 6 / 6b / 6c. Hooks: the PostToolUse CCR hook + seeded guidance rules
  // (and the `.gitignore` lines for personal instruction files), the status line
  // and blocked-state event hooks, the WebFetch KB-cache pre/post hooks, and the
  // SessionStart proxy auto-start. See init-hooks.ts.
  actions.push(...(await wireHooks(projectDir, dryRun, options.claudeSettingsScope)));

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

  // 1 / 1a-bis / 1b. `.claude/settings.json` (+ the gitignored local scope): the
  // env keys, the loopback-CA trust and the MCP permission rules — each removed
  // only where it still holds init's own value. See init-claude-settings.ts.
  actions.push(...(await removeClaudeSettings(projectDir, baseUrl, dryRun)));

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
  actions.push(...(await removeSkills(projectDir, dryRun)));

  // 4 / 5 / 5b. Every hook init installed: the PostToolUse CCR hook + the seeded
  // guidance rules, the status line and blocked-state event hooks, the WebFetch
  // KB-cache hooks and the SessionStart auto-start. See init-hooks.ts.
  actions.push(...(await unwireHooks(projectDir, dryRun)));
  // R9.5: the managed-file provenance record is something init added, so uninit
  // takes it away. Silent — it is internal bookkeeping under .golem/state/, and
  // the files it described have their own removal actions above.
  if (!dryRun) await removeManagedState(projectDir);
  // R9.13: same reasoning for the version stamp. The config backups beside it
  // stay — those are copies of the user's own settings, not our bookkeeping.
  if (!dryRun) await removeVersionStamp(projectDir);

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
