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

/** Init steps 5, 6, 6b and 6c: every hook init installs, in report order. */
export async function wireHooks(projectDir: string, dryRun: boolean): Promise<InitAction[]> {
  const actions: InitAction[] = [];

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
  // PreToolUse: the snooze document-and-hold nudge + autonomy gate (inert at the
  // default `manual` level). See PRE_TOOL_USE_HOOK_COMMAND.
  actions.push(await addEventHook({ projectDir, dryRun }, "PreToolUse", PRE_TOOL_USE_HOOK_COMMAND));

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
        // R9.21 — the SAME constant the hook budgets itself against. The hook
        // cannot read this value out of its payload, so a literal here would be a
        // second number that has to agree with the first by hand. It did not: the
        // raw fetch's own timeout was also 15s, which let it spend the entire
        // window and get killed before it could serve what it had downloaded.
        timeoutSeconds: WEB_FETCH_PRE_TIMEOUT_SECONDS,
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
  actions.push(
    await removeEventHook({ projectDir, dryRun }, "PreToolUse", PRE_TOOL_USE_HOOK_COMMAND),
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

  return actions;
}
