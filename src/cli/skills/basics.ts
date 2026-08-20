/**
 * The four everyday skills: read or set the compression dial, read the savings,
 * pull a compressed reference back, and turn the pipeline off for a request.
 *
 * Content, not logic — see `../skills.ts` for why these live as string constants.
 */

const compression = `---
description: Show or set the Golem compression dial (off | 1 lossless | 2 balanced | 3 aggressive)
invocationMode: user
---

The user wants to view or change how much of Golem's pipeline runs.

Arguments: $ARGUMENTS

R11.1 retired the savings slider (ADR-0004): compression and brevity are set
directly, and there is no \`level\` MCP tool any more — no tool call can change
how much of the pipeline runs.

- If the arguments contain a value (\`off\`, \`1\`, \`2\`, \`3\`), tell the user to
  run \`golem compression <value>\` in their terminal, and say what it does. It
  takes effect within a second; no proxy restart is needed.
- \`off\` means compression off — **redaction still runs**. Say so, because the
  word invites the opposite reading.
- If the user is asking to disable redaction entirely, that is
  \`golem config set proxy.bypass_all true\`, NOT a compression value. Warn that
  secrets and PII then reach the upstream unredacted, and let them decide.
- If no value was given, call \`stats\` and report the current compression level.
- If the Golem MCP tools are unavailable, tell the user the Golem MCP server is
  not connected and suggest running \`golem init\` and restarting Claude Code.
`;

const stats = `---
description: Show Golem token-savings statistics for this project
invocationMode: user
---

Call the \`stats\` MCP tool and present the results: current compression level,
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
reference is unknown, report that and call the \`stats\` MCP tool to check the
store — it reports \`ccr_refs_stored\`, which answers whether anything is there.
`;

const bypass = `---
description: Send the next request(s) untouched — bypass Golem compression
invocationMode: user
---

<!-- golem:layering-exception config — a true full bypass turns REDACTION off, so
     by design no tool call can reach it (R11.1/ADR-0004 moved it to a CLI-only
     setting). Naming the command for the user to run in their OWN terminal is the
     point, not a shortcut around a tool. -->

The user wants to bypass Golem's compression pipeline.

Three different things, in increasing order of what they switch off:

1. **One request** — Golem's proxy honours the \`x-golem-bypass\` header for a
   pure passthrough of that request. Nothing is configured; nothing persists.
2. **Compression off, redaction still on** — \`golem compression off\`. This is
   the usual answer: byte-faithful forwarding with secrets still redacted.
3. **A true full bypass, redaction included** —
   \`golem config set proxy.bypass_all true\`. Tell the user plainly that secrets
   and PII then reach the upstream unredacted, and that they must run it in their
   own terminal: no tool call can turn redaction off.

Then remind them to run \`golem compression 1\` (or their previous value) to
re-enable savings when done, and \`golem config set proxy.bypass_all false\` if
they used option 3.
`;

/** Skill name -> SKILL.md content, keyed as `/golem/<name>`. */
export const BASICS_SKILLS: Readonly<Record<string, string>> = {
  // R11.1: was `slider`. `golem init` prunes a managed skill that is no longer
  // in this table, so the old /golem/slider directory is removed on the next
  // init rather than lingering as a command that names a retired control.
  compression,
  stats,
  expand,
  bypass,
};
