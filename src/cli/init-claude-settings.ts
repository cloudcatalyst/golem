/**
 * The `.claude` settings half of `golem init` / `golem uninit`.
 *
 * Everything that owns a key inside Claude Code's own settings files:
 *   * the `env` block and the upstream mode it encodes — direct Anthropic
 *     (`ANTHROPIC_BASE_URL`), Azure AI Foundry (`CLAUDE_CODE_USE_FOUNDRY` +
 *     `ANTHROPIC_FOUNDRY_BASE_URL`), or a generic Anthropic-compatible gateway;
 *   * the loopback-CA trust (`NODE_EXTRA_CA_CERTS`), which lives in the
 *     gitignored `.claude/settings.local.json` whatever the scope says — the path
 *     is machine-absolute (R9.22);
 *   * the `permissions` pre-approval of Golem's own MCP tools.
 *
 * WHICH file gets the rest is `claude.settings_scope` (claude-settings-target.ts):
 * `.claude/settings.local.json` by default, `.claude/settings.json` when the
 * project wants the wiring committed. Init writes one file and sweeps the other;
 * uninit sweeps both. Readers consult both, always.
 *
 * `configureClaudeSettings` and `removeClaudeSettings` are exact inverses and
 * must be changed together — split them and `golem uninit` stops undoing what
 * `golem init` did. Both share one governing rule: init only ever touches env
 * keys it owns, and only while they hold init's own values; anything the user
 * (or another tool) put there is left alone.
 *
 * The `InitAction`/`InitOptions` imports are type-only, so they are erased at
 * build time and create no runtime cycle back to init.ts. The one value that
 * travels the other way is {@link MCP_SERVER_KEY}: the permission rules below
 * are derived from it at module scope (so it cannot be imported from init.ts
 * without a temporal-dead-zone cycle), and init.ts imports it back for
 * `.mcp.json`. The dependency is therefore one-directional: init.ts → here.
 */

import { ensureLoopbackCert, loopbackCaPath } from "../proxy/loopback-cert.js";
import {
  claudeLocalSettingsPath,
  claudeProjectSettingsPath,
  claudeSettingsFiles,
  claudeSettingsReadOrder,
} from "./claude-settings-target.js";
import type { InitAction, InitOptions } from "./init.js";
import { InitError } from "./init-error.js";
import {
  type JsonObject,
  objectEntry,
  readJsonObject,
  rel,
  stringArrayEntry,
  writeJsonObject,
} from "./json-file.js";
import {
  ENV_BASE_URL,
  ENV_EXTRA_CA,
  ENV_FOUNDRY_BASE_URL,
  ENV_TOOL_SEARCH,
  ENV_USE_FOUNDRY,
  samePath,
  sweepGolemEnvFrom,
  writeLocalCaTrust,
} from "./proxy-wiring.js";

export const MCP_SERVER_KEY = "golem";
/**
 * Pre-approve Golem's own MCP tools so they don't prompt on first use. Uses the
 * anchored wildcard `mcp__<server>__*` — the documented "all tools from this
 * server" form (Claude Code permissions docs, "MCP" section). Switched to it
 * from the bare `mcp__<server>` rule (2026-07-18) after observing that the bare
 * form does NOT reliably auto-approve tools in practice: golem tools kept
 * prompting on first use and had to be added one-by-one via "always allow"
 * (`delegate`, then the new `snooze`). The `__*` is anchored to the server —
 * only fully-unanchored globs like `mcp__*` are skipped as allow rules — so it
 * is valid and covers every current and future golem tool at once — including
 * `wiki_upsert`.
 *
 * **`wiki_upsert` is no longer held on `ask` (USER decision 2026-07-30).** It used
 * to be, on the grounds that it writes committed wiki files. That was the pre-
 * Decision-44 posture and it outlived the decision: Decision 44 un-gated wiki
 * authoring precisely because every write lands in git — reviewable and revertible
 * — so a per-write prompt bought nothing and taught people to click through
 * prompts. Every living surface already says "author wiki pages freely"; this rule
 * was the last place still disagreeing, and a fresh `golem init` now matches. ADRs
 * are unaffected: they live at `docs/decisions/`, outside the wiki, and keep the
 * stricter human-driven rule.
 *
 * `uninit` still knows about the old `ask` entry so it cleans up projects
 * initialized before this change.
 *
 * Note: these rules are read at Claude Code session start (and activate only after
 * the one-time workspace-trust accept), so a running session must be restarted to
 * pick up a newly-added rule — mid-session edits/`always allow` don't apply live.
 */
const MCP_ALLOW_RULE = `mcp__${MCP_SERVER_KEY}__*`;
/** Legacy `ask` entry, removed by `uninit` but never written by `init`. */
const LEGACY_MCP_ASK_RULE = `mcp__${MCP_SERVER_KEY}__wiki_upsert`;

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

/**
 * Init steps 1, 1b-bis and 1c: the env block (mode-aware), the loopback-CA
 * trust, and the MCP permission pre-approval. They share one in-memory
 * `settings` object on purpose — the CA heal in 1b-bis deletes a key that 1c
 * would otherwise write straight back.
 */
export async function configureClaudeSettings(
  options: InitOptions,
  baseUrl: string,
  dryRun: boolean,
): Promise<InitAction[]> {
  const { projectDir } = options;
  const actions: InitAction[] = [];

  // 1. The `.claude` settings file `claude.settings_scope` names (local by
  // default) — env block (mode-aware). The other file is swept at the end of the
  // step so a scope flip MOVES the wiring instead of shadowing it.
  const { target: settingsPath, other: otherSettingsPath } = await claudeSettingsFiles(
    projectDir,
    options.claudeSettingsScope,
  );
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
    // Both files, not just the target: Claude Code reads the pair (local shadows
    // committed), so another gateway's base URL in EITHER of them owns this
    // project's traffic. Writing "past" it into the higher-precedence file would
    // be the silent overwrite the ownership rule exists to prevent.
    const foreign = await foreignBaseUrlIn(projectDir, baseUrl);
    if (foreign !== undefined) {
      throw new InitError(
        `${rel(projectDir, foreign.file)} already sets ${ENV_BASE_URL}=${foreign.value}. ` +
          "Another proxy or gateway owns this project's Claude Code traffic — remove that " +
          "setting (or `headroom unwrap`) before running golem init.",
      );
    }
    // Against the TARGET file: our own base URL sitting in the other scope is a
    // scope flip, not "already configured", and step 1d moves it here.
    const envChanged = env[ENV_BASE_URL] !== baseUrl || env[ENV_TOOL_SEARCH] !== "true";
    env[ENV_BASE_URL] = baseUrl;
    env[ENV_TOOL_SEARCH] = "true"; // notes §12: re-enable tool search behind a gateway
    pushEnvAction(actions, envChanged, settingsExisted, rel(projectDir, settingsPath), {
      [ENV_BASE_URL]: baseUrl,
    });
    if (envChanged && !dryRun) await writeJsonObject(settingsPath, settings);
  }

  // 1b-bis. R9.12 — trust the loopback CA so a cache-served WebFetch renders
  // GREEN rather than as a denied tool call. Four rules, all from measurements:
  //   * set it ONLY when nothing else owns the variable (§121-C): a user behind a
  //     TLS-inspection proxy already has it, and concatenating bundles creates a
  //     copy that goes stale when theirs rotates.
  //   * the anchor is a CA, because BoringSSL refuses a bare leaf (§123), but it
  //     carries a dNSName name constraint so it CANNOT issue a certificate for
  //     api.anthropic.com (§124, measured: `permitted subtree violation`).
  //   * it goes in `.claude/settings.local.json`, NOT the committed settings.json
  //     (R9.22): the path is machine-absolute, so a committed one resolves on no
  //     other clone and Claude Code warns about it twice at every start. A Golem
  //     path left in the committed file by an older init is healed away here, so
  //     a clone self-heals on its first `golem init`.
  //   * it takes effect only after a restart (§112), so say so.
  // Declining with `--no-loopback-cert` costs nothing: the hook falls back to the
  // deny-and-serve path R9.7 shipped, which is what every un-wired session uses.
  if (options.noLoopbackCert !== true) {
    const localPath = claudeLocalSettingsPath(projectDir);
    const localExisted = (await readJsonObject(localPath).catch(() => null)) !== null;
    const caPath = dryRun
      ? loopbackCaPath(projectDir)
      : (await ensureLoopbackCert(projectDir)).caPath;
    const trust = await writeLocalCaTrust(projectDir, caPath, { dryRun });
    const targetIsLocal = samePath(settingsPath, localPath);

    // When the local file IS the target, `writeLocalCaTrust` just wrote the CA
    // into the same file `settings` describes — but through its own read, so the
    // in-memory copy does not know. Step 1c writes `settings` again; without this
    // line that write would drop the key that was just added.
    if (targetIsLocal && trust.foreign === undefined) env[ENV_EXTRA_CA] = caPath;

    if (trust.healedCommitted) {
      // The heal was performed against writeLocalCaTrust's own read of the
      // COMMITTED file. When that file is also our target, `settings` is still
      // live here and is written again below (step 1c), so the key has to go from
      // the in-memory copy too — otherwise that write puts the machine-absolute
      // path straight back.
      if (!targetIsLocal) delete env[ENV_EXTRA_CA];
      actions.push({
        kind: "modify",
        path: rel(projectDir, claudeProjectSettingsPath(projectDir)),
        detail: `${ENV_EXTRA_CA} moved to ${rel(projectDir, localPath)} — a machine-absolute path does not belong in a committed file`,
      });
    }

    if (trust.foreign !== undefined) {
      actions.push({
        kind: "skip",
        path: rel(projectDir, localPath),
        detail: `${ENV_EXTRA_CA} is already set to ${trust.foreign} — left alone; served WebFetches stay on the deny path`,
      });
    } else if (trust.wrote) {
      pushEnvAction(actions, true, localExisted, rel(projectDir, localPath), {
        [ENV_EXTRA_CA]: caPath,
      });
    } else {
      actions.push({
        kind: "skip",
        path: rel(projectDir, localPath),
        detail: `${ENV_EXTRA_CA} already trusts Golem's loopback CA`,
      });
    }
  }

  // 1c. The target file — pre-approve Golem's own MCP tools so they don't
  // prompt on first use. All of them, wiki_upsert included (Decision 44 / USER
  // 2026-07-30): wiki writes are un-gated because git makes them reviewable.
  {
    const permissions = objectEntry(settings, "permissions");
    const allow = stringArrayEntry(permissions, "allow");
    let permsChanged = false;
    let allowAdded = false;
    if (!allow.includes(MCP_ALLOW_RULE)) {
      allow.push(MCP_ALLOW_RULE);
      allowAdded = true;
      permsChanged = true;
    }
    // Drop the legacy wiki_upsert `ask` rule if an earlier init left one: an `ask`
    // entry prompts even when an `allow` rule also matches (deny → ask → allow
    // precedence), so leaving it would silently keep the gate this change removes.
    // Read in place rather than through `stringArrayEntry` — that would *create* an
    // empty `ask: []`, which is footprint init no longer has any reason to add.
    const existingAsk = permissions.ask;
    let legacyRemoved = false;
    if (Array.isArray(existingAsk)) {
      const index = existingAsk.indexOf(LEGACY_MCP_ASK_RULE);
      if (index >= 0) {
        existingAsk.splice(index, 1);
        if (existingAsk.length === 0) delete permissions.ask;
        legacyRemoved = true;
        permsChanged = true;
      }
    }
    actions.push(
      permsChanged
        ? {
            kind: settingsExisted ? "modify" : "create",
            path: rel(projectDir, settingsPath),
            // Report only what actually moved: on an already-configured project the
            // only change is dropping the legacy `ask` entry.
            detail: [
              ...(allowAdded ? [`permissions.allow += ${MCP_ALLOW_RULE}`] : []),
              ...(legacyRemoved ? [`permissions.ask -= ${LEGACY_MCP_ASK_RULE}`] : []),
            ].join(", "),
          }
        : {
            kind: "skip",
            path: rel(projectDir, settingsPath),
            detail: "MCP tool permissions set",
          },
    );
    if (permsChanged && !dryRun) await writeJsonObject(settingsPath, settings);
  }

  // 1d. Sweep the OTHER `.claude` settings file. Flipping `claude.settings_scope`
  // and re-running init has to MOVE the wiring, not duplicate it: a leftover copy
  // in the shadowed file is dead weight that still shows up in `git diff`, and a
  // leftover copy in the SHADOWING one silently wins over the file the user just
  // chose. Ownership-guarded throughout (our base URL, our rule), so a file we
  // never wrote comes back untouched. The CA trust is excluded — it lives in the
  // local scope whatever the scope key says (R9.22).
  {
    const envMoved = await sweepGolemEnvFrom(otherSettingsPath, baseUrl, undefined, { dryRun });
    const permsMoved = await removeMcpPermissions(otherSettingsPath, { dryRun });
    if (envMoved || permsMoved) {
      actions.push({
        kind: "modify",
        path: rel(projectDir, otherSettingsPath),
        detail: `moved Golem's Claude Code wiring to ${rel(projectDir, settingsPath)} (claude.settings_scope)`,
      });
    }
  }

  return actions;
}

/**
 * The first `ANTHROPIC_BASE_URL` in Claude Code's precedence order that is NOT
 * ours, with the file that sets it; undefined when nothing foreign is wired.
 * Loud reader — this runs on the write path, where a malformed settings file must
 * stop init rather than read as "nothing there".
 */
async function foreignBaseUrlIn(
  projectDir: string,
  baseUrl: string,
): Promise<{ readonly file: string; readonly value: string } | undefined> {
  for (const file of claudeSettingsReadOrder(projectDir)) {
    const env = (await readJsonObject(file))?.env;
    if (typeof env !== "object" || env === null || Array.isArray(env)) continue;
    const value = (env as JsonObject)[ENV_BASE_URL];
    if (typeof value === "string" && value !== baseUrl) return { file, value };
  }
  return undefined;
}

/**
 * Remove exactly the MCP permission rules init writes from ONE settings file
 * (plus the legacy `ask` entry older inits left). Returns whether it changed.
 * Emptied containers are pruned — an orphan `permissions: {}` is footprint.
 */
async function removeMcpPermissions(
  file: string,
  opts: { readonly dryRun?: boolean } = {},
): Promise<boolean> {
  const settings = await readJsonObject(file);
  const perms = settings?.permissions;
  if (settings === null || typeof perms !== "object" || perms === null || Array.isArray(perms)) {
    return false;
  }
  const permsObj = perms as JsonObject;
  let changed = false;
  for (const [key, rule] of [
    ["allow", MCP_ALLOW_RULE],
    ["ask", LEGACY_MCP_ASK_RULE],
  ] as const) {
    const arr = permsObj[key];
    if (!Array.isArray(arr)) continue;
    const idx = arr.indexOf(rule);
    if (idx !== -1) {
      arr.splice(idx, 1);
      changed = true;
    }
    if (arr.length === 0) delete permsObj[key];
  }
  if (!changed) return false;
  if (Object.keys(permsObj).length === 0) delete settings.permissions;
  if (opts.dryRun !== true) await writeJsonObject(file, settings);
  return true;
}

/**
 * Uninit steps 1, 1a-bis and 1b — the exact inverse of
 * {@link configureClaudeSettings}: the env keys, the local-scope CA trust, and
 * the MCP permission rules, each removed only where it still holds init's value.
 */
export async function removeClaudeSettings(
  projectDir: string,
  baseUrl: string,
  dryRun: boolean,
): Promise<InitAction[]> {
  const actions: InitAction[] = [];

  // BOTH files, always — `claude.settings_scope` says where init WRITES, and a
  // project that has been through a flip (or through an older Golem) can hold our
  // keys in either. Removal is ownership-guarded per key, so visiting a file we
  // never wrote is a no-op, and uninit must not be the command that leaves half
  // the wiring behind.
  for (const settingsPath of claudeSettingsReadOrder(projectDir)) {
    // 1. Remove only the env keys init set, and only if they hold init's values.
    // Ownership-guarded: ANTHROPIC_BASE_URL / the Foundry pair /
    // ENABLE_TOOL_SEARCH / our own CA path only (proxy-wiring.ts). R9.22: the CA
    // trust lives in the local file, which this loop reaches too.
    if (await sweepGolemEnvFrom(settingsPath, baseUrl, loopbackCaPath(projectDir), { dryRun })) {
      actions.push({
        kind: "modify",
        path: rel(projectDir, settingsPath),
        detail: "removed Golem env entries",
      });
    }

    // 2. Remove only the MCP permission rules init added (exact rules only). The
    // `ask` rule is legacy — init no longer writes it — but a project initialized
    // before 2026-07-30 still has one, so uninit must still clean it up.
    if (await removeMcpPermissions(settingsPath, { dryRun })) {
      actions.push({
        kind: "modify",
        path: rel(projectDir, settingsPath),
        detail: "removed Golem MCP permission rules",
      });
    }
  }

  return actions;
}
