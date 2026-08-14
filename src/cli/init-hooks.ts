/**
 * The Claude Code hooks half of `golem init` / `golem uninit`.
 *
 * Everything init wires into Claude Code's event surface, plus the two
 * `.gitignore` lines that keep personal instruction files out of git:
 *   * the PostToolUse CCR hook and the seeded Golem guidance rules;
 *   * the status line, the default permission mode and the blocked-state
 *     Notification / UserPromptSubmit / PreToolUse event hooks;
 *   * the WebFetch KB-cache pre/post matcher hooks and the SessionStart
 *     proxy auto-start hook.
 *
 * `wireHooks` and `unwireHooks` are exact inverses and must be changed
 * together — add a hook to one without the other and `golem uninit` leaves it
 * behind, still firing at every tool call in a project that thinks it is clean.
 *
 * The `InitAction` import is type-only, so it is erased at build time and
 * creates no runtime cycle back to init.ts.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  addEventHook,
  addMatcherHook,
  addPostToolUseHook,
  type HookSettingsOptions,
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
  WEB_FETCH_PRE_TIMEOUT_SECONDS,
  writeDefaultMode,
  writeStatusLine,
} from "../hooks/index.js";
import {
  CLAUDE_SETTINGS_SCOPES,
  type ClaudeSettingsScope,
  otherClaudeSettingsScope,
  resolveClaudeSettingsScope,
} from "./claude-settings-target.js";
import type { InitAction } from "./init.js";

/**
 * The PreToolUse hook command — the same one `golem autonomy wire` installs. It
 * runs THREE things (in order): the snooze document-and-hold nudge (P2b), the
 * coder-first enforcement (Decision 39), and the autonomy gate (Decision 40).
 * `golem init` wires it so snooze's near-limit redirect is active by default
 * (USER decision 2026-07-18). NOTE: the autonomy gate is ON by default and, even
 * at the default `manual` level, forces an `ask` for outward/destructive actions
 * (ADR-0002) — it is NOT fully silent at `manual`. It is a SEPARATE toggle from
 * this wiring: `golem autonomy disable` turns the gate off (keeping the snooze +
 * coder-first nudges). Matcher-less → fires on every tool call (each stage
 * self-filters).
 */
const PRE_TOOL_USE_HOOK_COMMAND = "golem hook pre-tool-use";
/**
 * Golem's guidance lives in Claude Code project rules — `.claude/rules/golem-*.md`
 * (user decision 2026-07-16). Committed, team-wide, auto-loaded every session;
 * Golem never edits the user's CLAUDE.md. See src/hooks/guidance.ts.
 */
/** The conventional personal, gitignored instructions file (Golem doesn't write it). */
const PERSONAL_INSTRUCTIONS_FILENAME = "CLAUDE.local.md";

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

/**
 * Init steps 5, 6, 6b and 6c: every hook init installs, in report order.
 *
 * Everything lands in the `.claude` settings file `claude.settings_scope` names
 * (local by default). The other file is swept afterwards so flipping the scope
 * and re-running init MOVES the hooks rather than leaving a duplicate set that
 * Claude Code would either shadow or — worse — run twice.
 */
export async function wireHooks(
  projectDir: string,
  dryRun: boolean,
  scope?: ClaudeSettingsScope,
): Promise<InitAction[]> {
  const target = scope ?? (await resolveClaudeSettingsScope(projectDir));
  const options = { projectDir, dryRun, scope: target };
  const actions: InitAction[] = [];

  // 5. PostToolUse hook + Golem guidance. Guidance is seeded (once) as Claude
  // Code project rules — `.claude/rules/golem-<feature>.md` (committed, team-wide,
  // auto-loaded every session). Golem never edits the user's CLAUDE.md. Defaults
  // are user-owned after seeding: `golem guidance disable <feature>` sticks.
  actions.push(await addPostToolUseHook(options));
  actions.push(...(await seedDefaultGuidance(projectDir, dryRun)));
  // Keep personal (`--user`) golem rules AND the conventional personal
  // instructions file out of version control.
  actions.push(await ensureGitignored(projectDir, PERSONAL_INSTRUCTIONS_FILENAME, dryRun));
  actions.push(await ensureGitignored(projectDir, PERSONAL_RULES_GITIGNORE, dryRun));

  // 6. Status line (21c) + blocked-state event hooks (21b).
  actions.push(await writeStatusLine(options));
  actions.push(await writeDefaultMode(options));
  actions.push(await addEventHook(options, "Notification", NOTIFICATION_COMMAND));
  actions.push(await addEventHook(options, "UserPromptSubmit", PROMPT_SUBMIT_COMMAND));
  // PreToolUse: the snooze document-and-hold nudge + autonomy gate (inert at the
  // default `manual` level). See PRE_TOOL_USE_HOOK_COMMAND.
  actions.push(await addEventHook(options, "PreToolUse", PRE_TOOL_USE_HOOK_COMMAND));

  // 6b. WebFetch KB cache: query the KB before fetching (blocking pre-gate), and
  // capture every fetch into the KB (non-blocking post-capture) — §44.
  actions.push(
    await addMatcherHook(options, {
      event: "PreToolUse",
      matcher: WEB_FETCH_MATCHER,
      command: WEB_FETCH_PRE_COMMAND,
      async: false,
      // R9.21 — the SAME constant the hook budgets itself against. The hook
      // cannot read this value out of its payload, so a literal here would be a
      // second number that has to agree with the first by hand. It did not: the
      // raw fetch's own timeout was also 15s, which let it spend the entire
      // window and get killed before it could serve what it had downloaded.
      timeoutSeconds: WEB_FETCH_PRE_TIMEOUT_SECONDS,
    }),
  );
  actions.push(
    await addMatcherHook(options, {
      event: "PostToolUse",
      matcher: WEB_FETCH_MATCHER,
      command: WEB_FETCH_POST_COMMAND,
      async: true,
      timeoutSeconds: 60,
    }),
  );

  // 6c. SessionStart: auto-start the proxy on project open if it was running (§47).
  actions.push(
    await addMatcherHook(options, {
      event: "SessionStart",
      matcher: SESSION_START_MATCHER,
      command: SESSION_START_COMMAND,
      async: false,
      timeoutSeconds: 15,
    }),
  );

  // 6d. Sweep the other scope's file (see the note on this function). Only the
  // removals that actually did something are reported — a project that has never
  // used the other scope would otherwise get nine "not installed" lines.
  const swept = await removeHookSettings({
    projectDir,
    dryRun,
    scope: otherClaudeSettingsScope(target),
  });
  actions.push(...swept.filter((action) => action.kind !== "skip"));

  return actions;
}

/**
 * Uninit steps 4 (hooks half), 5 and 5b — the exact inverse of
 * {@link wireHooks}. The `.gitignore` lines are deliberately NOT taken back:
 * they name files Golem never wrote, and un-ignoring a personal instructions
 * file would push it towards a commit.
 */
export async function unwireHooks(projectDir: string, dryRun: boolean): Promise<InitAction[]> {
  const actions: InitAction[] = [];

  // Both `.claude` settings files, always. `claude.settings_scope` says where
  // init WRITES; it says nothing about where an older init, or the same project
  // before a scope flip, left a hook. A hook uninit misses keeps firing at every
  // tool call in a project that reports itself clean — the exact failure the
  // "wireHooks and unwireHooks are exact inverses" rule above exists to prevent.
  for (const scope of CLAUDE_SETTINGS_SCOPES) {
    actions.push(...(await removeHookSettings({ projectDir, dryRun, scope })));
  }

  // The seeded Golem guidance rules (`.claude/rules/golem-*.md`, both scopes)
  // and the seed sentinel — files, not settings, so they are swept once.
  actions.push(...(await removeAllGuidanceRules(projectDir, dryRun)));

  return actions;
}

/**
 * Uninit steps 4 (hooks half), 5 and 5b against ONE settings file: the
 * PostToolUse CCR hook, the status line, the default mode, the blocked-state
 * event hooks, the WebFetch KB-cache pair and the SessionStart auto-start.
 *
 * Split out because it is needed twice — once per scope by {@link unwireHooks},
 * and once against the non-target scope by {@link wireHooks}, which is what makes
 * a `claude.settings_scope` flip move the hooks instead of duplicating them.
 */
async function removeHookSettings(options: HookSettingsOptions): Promise<InitAction[]> {
  return [
    await removePostToolUseHook(options),
    await removeStatusLine(options),
    await removeDefaultMode(options),
    await removeEventHook(options, "Notification", NOTIFICATION_COMMAND),
    await removeEventHook(options, "UserPromptSubmit", PROMPT_SUBMIT_COMMAND),
    await removeEventHook(options, "PreToolUse", PRE_TOOL_USE_HOOK_COMMAND),
    await removeMatcherHook(options, "PreToolUse", WEB_FETCH_PRE_COMMAND),
    await removeMatcherHook(options, "PostToolUse", WEB_FETCH_POST_COMMAND),
    await removeMatcherHook(options, "SessionStart", SESSION_START_COMMAND),
  ];
}
