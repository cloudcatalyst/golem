/**
 * R13.12 — the coder instruction prompt, in ONE place.
 *
 * Two mechanisms deliver a coder task and they must be framed identically:
 *
 *  - the `coder` MCP tool, which puts this in the `system` field of a dispatch;
 *  - the generated `golem-coder` subagent, whose definition BODY is a system
 *    prompt by construction.
 *
 * Before this module the framing existed only as a `const` inside
 * `src/mcp/coder-tools.ts` (R13.11), reachable by exactly one of those two. A
 * second copy in the agent generator would have drifted the moment either was
 * edited, and the whole point of the setting is that the user edits it once.
 *
 * ## Why it lives under `src/inference/`
 *
 * Both `src/mcp/` and `src/cli/` need it and neither is upstream of the other,
 * while `src/inference/` is upstream of both and imports from neither — the same
 * placement argument `reply-parsing.ts` records.
 *
 * ## Why it is not a skill
 *
 * The user asked. R9.11's recorded layering rule answers it: *"skills orchestrate,
 * tools execute. A skill never reimplements a tool."* A system prompt is neither,
 * and three concrete properties rule a skill out:
 *
 * 1. **Direction.** A skill's body is injected into the context of the session
 *    that invokes it. This text has to reach the DRAFTER — an HTTP `system`
 *    field, or a subagent definition — so a skill would load it into the wrong
 *    context entirely.
 * 2. **Portability.** `SKILL.md` is one client's file format. R9.11's first
 *    argument for keeping tools as tools is that R6.1 extends this pipeline past
 *    Claude Code, and the MCP server must read this prompt in a process that may
 *    have no Claude Code at all.
 * 3. **Semantics.** Skill frontmatter's `description` drives *when to invoke*,
 *    which is meaningless for a system prompt and becomes misleading once stale.
 *
 * The skill that DOES belong nearby is a different artifact: guidance about *when*
 * to delegate rather than work inline. That is R9.11's converse test — "rare,
 * procedural, and needs prose about when" — and it is not this setting.
 */

/**
 * The default framing, used when `inference.coder_prompt` is unset.
 *
 * **Concise is a requirement, not a preference.** The same text frames a
 * qwen2.5-coder:7b local drafter and a frontier subagent, and the whole argument
 * for `coder` existing (multi-target-routing.md) is that a small model needs
 * "three tools and a tight prompt" — hand it a long preamble and it fails. So
 * this says only what changes the output shape, and says nothing a capable model
 * would already do.
 */
export const DEFAULT_CODER_PROMPT =
  "You are a coding assistant producing a first draft for another engineer to " +
  "review. Answer with the code or text asked for and nothing else: no preamble, " +
  "no restatement of the task, no offer to help further. If the request cannot be " +
  "completed from what you were given, say precisely what is missing in one line " +
  "instead of guessing.";

/**
 * The effective coder prompt: the configured one when it has content, else
 * {@link DEFAULT_CODER_PROMPT}.
 *
 * A whitespace-only value resolves to the default rather than to an empty system
 * message. Sending an empty `system` is not a neutral act — it costs a field and
 * frames nothing — and a user who wants no framing at all is better served by a
 * one-line prompt saying so than by a setting that silently means two things.
 */
export function resolveCoderPrompt(configured: string | undefined): string {
  return configured !== undefined && configured.trim() !== ""
    ? configured.trim()
    : DEFAULT_CODER_PROMPT;
}
