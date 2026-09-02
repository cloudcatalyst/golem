/**
 * R13.12 — what the generated `golem-coder` subagent definition SAYS.
 *
 * Split from `init-agents.ts` on the same line `skills.ts` splits from
 * `init-skills.ts`: this owns the content, that owns where it lands and how an
 * existing file on disk is treated.
 *
 * ## Why Golem generates this at all
 *
 * A subagent on a routed model already gets everything a delegated coding task
 * wants — a full agentic loop, real tool use, its own context — and, because its
 * traffic goes through `ANTHROPIC_BASE_URL`, it stays inside Golem's proxy, so
 * redaction, compression and telemetry all still apply. The proposal
 * (`multi-target-routing.md`) recorded that as "zero new Golem machinery" and it
 * was right about the mechanism. What was missing was the WIRING: nothing turned
 * `inference.default_coder` into an agent definition, so a user had to hand-author
 * one and keep it in step with their Golem config by hand.
 *
 * ## Why a plain model id, not `golem/<target>`
 *
 * Both are documented shapes and R9.2 shipped the proxy half of the virtual id.
 * But verification-notes §114 **caveat 5 is still open** — the slash in
 * `golem/<id>` was never confirmed Claude Code-side, and R9.2 closed with that
 * check outstanding. A plain id (`claude-sonnet-5`) is a documented "full model
 * ID" per the frontmatter table §114 quotes, and sidesteps the unverified part
 * entirely. Reach for the virtual id only for a target with no plain model id of
 * its own, and close caveat 5 first if you do.
 *
 * ## Tools: inherited, and said out loud
 *
 * The definition declares no `tools:` restriction, so the subagent inherits the
 * session's. That is a deliberate choice with a stated reason rather than a
 * default nobody picked: the task is to *complete* work, a drafter that cannot
 * read the codebase is the blind one-shot this replaces, and ADR-0002's gate is a
 * PreToolUse hook that still fires on the subagent's own calls. The generated
 * body says how to narrow it, so the decision stays visible to whoever reads the
 * file rather than living only here.
 */

import { resolveCoderPrompt } from "../inference/coder-prompt.js";
import { CODER_AGENT_NAME } from "../inference/coder-route.js";

export { CODER_AGENT_NAME };

export interface CoderAgentInput {
  /** The model id for the frontmatter — a plain id, see the header. */
  readonly model: string;
  /** `inference.coder_prompt`, or undefined for Golem's default. */
  readonly coderPrompt?: string | undefined;
}

/**
 * Render `.claude/agents/golem-coder.md`.
 *
 * Deterministic in its inputs — no timestamps, no machine paths — because the
 * managed-file provenance record (R9.5) compares content to decide whether the
 * user has edited it. A generated file that changed on every `init` would report
 * a conflict against itself forever.
 */
export function coderAgentDefinition(input: CoderAgentInput): string {
  const prompt = resolveCoderPrompt(input.coderPrompt);
  return `---
name: ${CODER_AGENT_NAME}
description: Golem's delegated coder. Use for a self-contained coding task — a first implementation, a test, a focused refactor — that you want done on a different model from this session, with its own context. Returns the work for you to review.
model: ${input.model}
---

${prompt}

## How this file got here

\`golem init\` generated it from \`inference.personas.coder.model = "${input.model}"\`. Edit
it freely — Golem records what it wrote and will report a conflict rather than
overwrite your changes. To change the model, set \`inference.personas.coder.model\` and
re-run \`golem init\`; to change the prose above, set \`inference.coder_prompt\` so
the \`coder\` MCP tool is framed identically.

## What you have here

Your traffic goes through Golem's proxy like the parent session's, so redaction,
compression and telemetry all still apply — you are not outside the pipeline.

Tools are inherited from the session rather than narrowed, because a coder that
cannot read the codebase is no better than a one-shot completion. If you want this
agent read-only, add a \`tools:\` line to the frontmatter naming only what it may
use.

Report what you changed and why. Do not commit, push, or open a PR unless the
task explicitly asked for it — the session that delegated to you is reviewing your
work.
`;
}
