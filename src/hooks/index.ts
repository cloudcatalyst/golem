/**
 * WS-B task B2 — Claude Code PostToolUse hook: swap oversized tool outputs
 * for Golem CCR references (spec Decision 10). Owned by agent-mcp.
 *
 * Public surface:
 *   - runPostToolUseHook(io, options?) — the handler (stdin/stdout injectable).
 *   - buildHookCommand(options?)       — commander `Command` for the CLI.
 *   - addPostToolUseHook / removePostToolUseHook — `.claude/settings.json`
 *     writers for the E2 init/uninit flows.
 *   - writeGuidanceSection             — CLAUDE.md guidance-section writer.
 *   - RedactFn / stripKnownSecrets     — redaction seam (TODO T-C3).
 *
 * ## Integrator wiring (files owned by other agents — do NOT edit them here)
 *
 * src/cli/main.ts — register the CLI command:
 *     import { buildHookCommand } from "../hooks/index.js";
 *     program.addCommand(buildHookCommand());
 *
 * src/cli/init.ts — inside golemInit(), after the skills step, append the
 * returned actions:
 *     import { addPostToolUseHook, writeGuidanceSection } from "../hooks/index.js";
 *     actions.push(await addPostToolUseHook({ projectDir, dryRun }));
 *     actions.push(await writeGuidanceSection({ projectDir, dryRun }));
 *
 * src/cli/init.ts — inside golemUninit():
 *     import { removePostToolUseHook } from "../hooks/index.js";
 *     actions.push(await removePostToolUseHook({ projectDir, dryRun }));
 *   (The guidance section is left in CLAUDE.md on uninit — it is user-editable
 *    prose; removePostToolUseHook is the reversible half.)
 */

export { buildHookCommand } from "./command.js";
export type { GuidanceWriteOptions } from "./guidance.js";
export {
  GUIDANCE_BEGIN_MARKER,
  GUIDANCE_END_MARKER,
  golemGuidanceSection,
  upsertGuidance,
  writeGuidanceSection,
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
export type { HookSettingsOptions } from "./settings-writer.js";
export {
  addPostToolUseHook,
  golemPostToolUseEntry,
  POST_TOOL_USE_COMMAND,
  POST_TOOL_USE_MATCHER,
  POST_TOOL_USE_TIMEOUT_SECONDS,
  removePostToolUseHook,
} from "./settings-writer.js";
