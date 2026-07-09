/**
 * WS-E E2 — the P0 skill files `golem init` installs.
 *
 * Directory-namespaced per verification-notes §11:
 * `.claude/skills/golem/<name>/SKILL.md` surfaces as `/golem/<name>`.
 * Each skill delegates to the frozen MCP tool names (plan §2.5); the
 * `/mcp__golem__*` prompt twins come from the MCP server directly.
 */

const slider = `---
description: Show or set the Golem token-savings slider (0 passthrough … 5 max savings)
invocationMode: user
---

The user wants to view or change Golem's savings slider.

Arguments: $ARGUMENTS

- If the arguments contain a level (0-5), call the \`level\` MCP tool
  with that level, then confirm the change and briefly say what the new level does.
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
slider level 0 disables all transformation. Call the \`level\` MCP
tool with level 0 to switch to passthrough now, tell the user compression is
off, and remind them to run \`/golem/slider 1\` (or their previous level) to
re-enable savings when done.
`;

/** name -> SKILL.md content; installed under .claude/skills/golem/<name>/. */
export const P0_SKILLS: Readonly<Record<string, string>> = {
  slider,
  stats,
  expand,
  bypass,
};
