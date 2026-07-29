/**
 * WS-B task B2 — Claude Code PostToolUse hook: swap oversized tool outputs
 * for Golem CCR references (spec Decision 10). Owned by agent-mcp.
 *
 * Public surface:
 *   - runPostToolUseHook(io, options?) — the handler (stdin/stdout injectable).
 *   - buildHookCommand(options?)       — commander `Command` for the CLI.
 *   - addPostToolUseHook / removePostToolUseHook — `.claude/settings.json`
 *     writers for the E2 init/uninit flows.
 *   - seedDefaultGuidance / writeGuidanceRule / removeGuidanceRule — Claude Code
 *     `.claude/rules/golem-*.md` guidance writers (init/uninit + `golem guidance`).
 *   - RedactFn / pipelineRedact / stripKnownSecrets — redaction seam (T-C3).
 *
 * ## Integrator wiring (files owned by other agents — do NOT edit them here)
 *
 * src/cli/main.ts — register the CLI command:
 *     import { buildHookCommand } from "../hooks/index.js";
 *     program.addCommand(buildHookCommand());
 *
 * src/cli/init.ts — inside golemInit(), after the skills step, append the
 * returned actions:
 *     import { addPostToolUseHook, seedDefaultGuidance } from "../hooks/index.js";
 *     actions.push(await addPostToolUseHook({ projectDir, dryRun }));
 *     actions.push(...(await seedDefaultGuidance(projectDir, dryRun)));
 *
 * src/cli/init.ts — inside golemUninit():
 *     import { removePostToolUseHook, removeAllGuidanceRules } from "../hooks/index.js";
 *     actions.push(await removePostToolUseHook({ projectDir, dryRun }));
 *     actions.push(...(await removeAllGuidanceRules(projectDir, dryRun)));
 */

export { buildHookCommand, type HookCommandOptions } from "./command.js";
export {
  GUIDANCE_FEATURES,
  type GuidanceFeature,
  type GuidanceScope,
  guidanceEnabled,
  guidanceFeature,
  guidanceRuleBody,
  guidanceRuleExists,
  guidanceRulePath,
  PERSONAL_RULES_GITIGNORE,
  promptTranslationGuidanceSnippet,
  removeAllGuidanceRules,
  removeGuidanceRule,
  seedDefaultGuidance,
  writeGuidanceRule,
} from "./guidance.js";
export type { HookIo, PostToolUseOptions, PostToolUsePayload } from "./post-tool-use.js";
export {
  buildDigest,
  DEFAULT_MAX_INLINE_CHARS,
  DIGEST_HEAD_CHARS,
  DIGEST_TAIL_CHARS,
  HOOK_EVENT_NAME,
  runPostToolUseHook,
} from "./post-tool-use.js";
export type { RedactFn } from "./redact.js";
export {
  identityRedact,
  pipelineRedact,
  REDACTED_PEM_PLACEHOLDER,
  REDACTED_SK_ANT_PLACEHOLDER,
  stripKnownSecrets,
} from "./redact.js";
export { runNotificationHook, runUserPromptSubmitHook } from "./session-hooks.js";
export type { SessionState } from "./session-state.js";
export {
  markBlocked,
  markUnblocked,
  readSessionState,
  sessionStatePath,
  writeSessionState,
} from "./session-state.js";
export {
  addEventHook,
  GOLEM_DEFAULT_MODE,
  NOTIFICATION_COMMAND,
  PROMPT_SUBMIT_COMMAND,
  removeDefaultMode,
  removeEventHook,
  removeStatusLine,
  STATUS_LINE_COMMAND,
  STATUS_LINE_REFRESH_INTERVAL_SEC,
  writeDefaultMode,
  writeStatusLine,
} from "./settings-extras.js";
export type { HookSettingsOptions, MatcherHookSpec } from "./settings-writer.js";
export {
  addMatcherHook,
  addPostToolUseHook,
  golemPostToolUseEntry,
  POST_TOOL_USE_COMMAND,
  POST_TOOL_USE_MATCHER,
  POST_TOOL_USE_TIMEOUT_SECONDS,
  removeMatcherHook,
  removePostToolUseHook,
  SESSION_START_COMMAND,
  SESSION_START_MATCHER,
  WEB_FETCH_MATCHER,
  WEB_FETCH_POST_COMMAND,
  WEB_FETCH_PRE_COMMAND,
} from "./settings-writer.js";
export type {
  RevalidateFn,
  RevalidateResponse,
  WebFetchHookOptions,
} from "./web-fetch.js";
export {
  DEFAULT_WEB_CACHE_TTL_HOURS,
  defaultRevalidate,
  runWebFetchPost,
  runWebFetchPre,
} from "./web-fetch.js";
