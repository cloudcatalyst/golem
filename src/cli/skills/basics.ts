/**
 * The four everyday skills: read the slider, read the savings, pull a compressed
 * reference back, and turn the pipeline off for a request.
 *
 * Content, not logic — see `../skills.ts` for why these live as string constants.
 */

const slider = `---
description: Show or set the Golem token-savings slider (0 passthrough … 3 aggressive)
invocationMode: user
---

The user wants to view or change Golem's savings slider.

Arguments: $ARGUMENTS

- If the arguments contain a level (1-3), call the \`level\` MCP tool
  with that level, then confirm the change and briefly say what the new level does.
- If the level is 0, do NOT call the \`level\` tool — it rejects 0 by design, so
  that no tool call can turn redaction off. Warn that redaction is OFF at level 0
  (full bypass) and tell the user to run \`golem slider 0\` in their terminal.
- If no level was given, call \`stats\` and report the current slider level.
- If the Golem MCP tools are unavailable, tell the user the Golem MCP server is
  not connected and suggest running \`golem init\` and restarting Claude Code.
`;

const stats = `---
description: Show Golem token-savings statistics for this project
invocationMode: user
---

Call the \`stats\` MCP tool and present the results: current slider level,
tokens before/after, and per-stage savings. Keep it to a short table. If the
tool is unavailable, say the Golem MCP server is not connected and suggest
running \`golem init\` and restarting Claude Code.
`;

const expand = `---
description: Expand a Golem CCR reference back to its original content
invocationMode: user
---

The user wants to expand a compressed content reference (CCR).

Arguments: $ARGUMENTS

Extract the CCR reference id from the arguments (or from the marker in recent
context, e.g. \`hash=<sha256>\` / \`[golem:ccr ref=...]\`) and call the
\`expand\` MCP tool with it. Show the retrieved original content. If the
reference is unknown, report that and suggest \`golem stats\` to check the store.
`;

const bypass = `---
description: Send the next request(s) untouched — bypass Golem compression
invocationMode: user
---

The user wants to bypass Golem's compression pipeline.

Golem's proxy honors the \`x-golem-bypass\` header for pure passthrough, and
slider level 0 (passthrough) disables all transformation. Note: level 0 ALSO
disables redaction (secrets/PII reach the upstream raw), so prefer \`level 1\`
(redaction on, byte-faithful) unless a true full bypass is intended.

- For level 1 (the usual answer), call the \`level\` MCP tool with \`1\`.
- For a **true full bypass**, do NOT call the \`level\` tool — it rejects 0 by
  design, so that no tool call can turn redaction off. Tell the user redaction
  would be off and that they must run \`golem slider 0\` in their own terminal.

Then remind them to run \`/golem/slider 1\` (or their previous level) to
re-enable savings when done.
`;

/** Skill name -> SKILL.md content, keyed as `/golem/<name>`. */
export const BASICS_SKILLS: Readonly<Record<string, string>> = {
  slider,
  stats,
  expand,
  bypass,
};
