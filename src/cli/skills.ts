/**
 * WS-E E2 — the P0 skill files `golem init` installs.
 *
 * Installed FLAT as `.claude/skills/golem-<name>/SKILL.md`, surfacing as
 * `/golem-<name>`. The old nested `.claude/skills/golem/<name>/` layout
 * (verification-notes §11) was never discoverable — Claude Code reads one level
 * only, so the whole namespace was silently absent (§150, §152).
 * Each skill delegates to the frozen MCP tool names (plan §2.5); the
 * `/mcp__golem__*` prompt twins come from the MCP server directly.
 *
 * The bodies themselves live in `./skills/`, grouped by what they are for. They
 * are string constants rather than loose `.md` assets because the build compiles
 * TypeScript and copies a fixed asset list — a markdown file would need new build
 * plumbing to reach `dist/`, and a skill that fails to install is worse than a
 * skill that is awkward to read in source.
 */

import { BASICS_SKILLS } from "./skills/basics.js";
import { CLOSE_OUT_SKILLS } from "./skills/close-out.js";
import { DEVELOP_SKILLS } from "./skills/develop.js";
import { FOOTGUN_SKILLS } from "./skills/footguns.js";
import { HYGIENE_SKILLS } from "./skills/hygiene.js";
import { RESEARCH_SKILLS } from "./skills/research.js";

/** command -> SKILL.md content; installed under .claude/skills/golem-<command>/. */
export const P0_SKILLS: Readonly<Record<string, string>> = {
  ...BASICS_SKILLS,
  ...RESEARCH_SKILLS,
  ...DEVELOP_SKILLS,
  ...CLOSE_OUT_SKILLS,
  ...FOOTGUN_SKILLS,
  ...HYGIENE_SKILLS,
};
