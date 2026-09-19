/**
 * R14.x — the sibling rule to `.claude/agents/golem-<id>.md`: a generated nudge
 * that tells a session to reach for the persona bench before reaching for the
 * built-in `fork` subagent type.
 *
 * ## Why this is generated code, not a seeded-once guidance rule
 *
 * `src/hooks/guidance.ts`'s `GUIDANCE_FEATURES` table seeds a rule file ONCE and
 * then leaves it user-owned forever (`seedDefaultGuidance`) — right for static
 * prose like `golem-wiki-kb-first.md`, wrong here: this file's CONTENT is the
 * current roster of agent-lane personas, and that roster changes every time
 * `inference.personas` does. A seed-once file would go stale the first time a
 * persona was staffed, restaffed, or unstaffed after the file was born.
 *
 * So it follows `init-personas.ts`'s discipline instead: same managed-file
 * provenance (`classifyManaged` / `rememberManaged` / `forgetManaged` /
 * `isUnmodifiedManaged` / `ownedDetail`), same content-is-deterministic
 * constraint, same "presence follows staffing, no separate toggle" rule that
 * governs `.claude/agents/golem-<id>.md`. There is deliberately no
 * `golem guidance enable/disable` switch for this file: it exists iff at least
 * one persona resolves to the agent lane, exactly like the definitions it
 * points at.
 *
 * ## Why `fork` needs calling out at all
 *
 * The `Agent` tool's own description says a fork "always runs on the parent's
 * model" and a `model` override "is ignored" for it. A fork carries no persona
 * identity — no routed model, no persona prompt, no persona tool allow-list —
 * so defaulting to it for coding/review/write-up/planning work silently skips
 * the routing this bench exists to provide. `fork` is still the right call when
 * sharing the parent conversation's context and cache IS the point (an
 * open-ended question over prior turns, a side-investigation not worth a
 * separate identity) — this file says so, so the guidance does not read as
 * "never use fork".
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InitAction } from "./init.js";
import type { DesiredAgent } from "./init-personas.js";
import { rel } from "./json-file.js";
import {
  classifyManaged,
  forgetManaged,
  isUnmodifiedManaged,
  ownedDetail,
  rememberManaged,
} from "./managed-files.js";

/** `.claude/rules/golem-prefer-persona-agents.md`. */
export function personaPreferenceRulePath(projectDir: string): string {
  return path.join(projectDir, ".claude", "rules", "golem-prefer-persona-agents.md");
}

function rosterLine(agent: DesiredAgent): string {
  const model =
    agent.discipline === undefined ? agent.model : `${agent.model} (${agent.discipline})`;
  return agent.description === undefined
    ? `- \`golem-${agent.id}\` — ${model}`
    : `- \`golem-${agent.id}\` — ${model} — ${agent.description}`;
}

/**
 * Render `.claude/rules/golem-prefer-persona-agents.md` for the currently
 * agent-lane-dispatchable personas.
 *
 * Deterministic in its inputs, same constraint `personaAgentDefinition`
 * documents: no timestamps, no machine paths, and the roster is sorted by id
 * so two callers building the same `desired` set produce identical bytes
 * regardless of the order `installPersonaAgentsStep` happened to resolve them
 * in.
 *
 * Callers decide presence, not this function — it renders whatever roster it
 * is given, even if that is empty. `installPersonaPreferenceRule` is the one
 * that turns an empty roster into "remove the file".
 */
export function personaPreferenceRuleContent(desired: readonly DesiredAgent[]): string {
  const roster = [...desired]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(rosterLine)
    .join("\n");

  return `## Golem: prefer the persona bench over the built-in \`fork\` subagent

This project staffs one or more personas in \`inference.personas\` onto the agent
lane, each generated into its own subagent definition at
\`.claude/agents/golem-<id>.md\` (see [[Persona Registry]]). Reach for one of
THOSE, by name, before reaching for the built-in \`fork\` subagent type when the
work matches one of the roles below — that is what this bench exists to route.

Currently dispatchable:

${roster}

\`fork\` always runs on the parent model and carries no persona identity — the
\`Agent\` tool's own description says a \`model\` override on a fork call "is
ignored". A fork never gets the routing, prompt, or tool allow-list a staffed
persona gets; it is the parent session wearing a different hat, not a
different worker. Reserve \`fork\` for when sharing the parent conversation's
context and cache is the actual point — an open-ended question over prior
turns, or a side-investigation not worth a separate identity of its own — not
as the default for work the roster above already names a persona for: that
persona should get it instead.

The same rule applies to the orchestrating session itself, not only to
\`fork\`: when a request's shape matches a staffed persona's description above
— most often planning/breakdown work matching the \`plan\`-discipline persona
— dispatch to that persona rather than doing the work inline and reporting
back. Grilling the user for the decisions a plan depends on is not itself
planning work and stays in the orchestrating session (a dispatched persona has
no channel back to ask); once those decisions are settled, the write-up and
breakdown that follows is exactly the shape this bench exists to route.

## How this file got here

\`golem init\` generated it from the personas currently staffed on the agent lane
in \`inference.personas\`. It is rewritten when that roster changes and removed
entirely once no persona resolves to the agent lane — mirroring
\`.claude/agents/golem-<id>.md\`, which disappears the same way. There is no
separate on/off switch: presence follows staffing.
`;
}

/** Write, refresh, or leave alone the rule for the current roster. */
async function installRuleFile(
  projectDir: string,
  dryRun: boolean,
  desired: readonly DesiredAgent[],
): Promise<InitAction[]> {
  const file = personaPreferenceRulePath(projectDir);
  const content = personaPreferenceRuleContent(desired);

  let existing: string | null = null;
  try {
    existing = await readFile(file, "utf8");
  } catch {
    existing = null;
  }

  const disposition = await classifyManaged(projectDir, file, content, existing);
  if (disposition === "current") {
    return [{ kind: "skip", path: rel(projectDir, file), detail: "up to date" }];
  }
  if (disposition === "owned") {
    return [
      {
        kind: "conflict",
        path: rel(projectDir, file),
        detail: ownedDetail("prefer-persona-agents rule"),
      },
    ];
  }

  const actions: InitAction[] = [
    {
      kind: disposition === "absent" ? "create" : "modify",
      path: rel(projectDir, file),
      detail:
        disposition === "absent"
          ? `prefer-persona-agents rule for ${desired.length} staffed persona(s)`
          : "prefer-persona-agents rule — roster changed (unmodified since Golem wrote it)",
    },
  ];
  if (!dryRun) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
    await rememberManaged(projectDir, file, content);
  }
  return actions;
}

/** Remove the rule file when nothing calls for it any more. */
async function removeRuleFile(projectDir: string, dryRun: boolean): Promise<InitAction[]> {
  const file = personaPreferenceRulePath(projectDir);
  let onDisk: string;
  try {
    onDisk = await readFile(file, "utf8");
  } catch {
    return []; // not on disk — nothing to remove
  }

  // THE rule, same as `pruneUndesired`: the ledger decides, never presence
  // alone. A hand-edited or hand-authored file at this path is left in place
  // and reported, not deleted.
  if (!(await isUnmodifiedManaged(projectDir, file, onDisk))) {
    return [
      {
        kind: "conflict",
        path: rel(projectDir, file),
        detail: ownedDetail("prefer-persona-agents rule (no personas staffed on the agent lane)"),
      },
    ];
  }

  const actions: InitAction[] = [
    {
      kind: "remove",
      path: rel(projectDir, file),
      detail:
        "prefer-persona-agents rule — no personas staffed on the agent lane, and unmodified since Golem wrote it",
    },
  ];
  if (!dryRun) {
    await rm(file, { force: true });
    await forgetManaged(projectDir, file);
  }
  return actions;
}

/**
 * Init step: bring `.claude/rules/golem-prefer-persona-agents.md` into line
 * with the same `desired` array `installPersonaAgentsStep` already resolved —
 * this never re-resolves config itself, so the two can never disagree about
 * which personas are agent-lane-dispatchable.
 *
 * Presence is tied purely to staffing (no `golem guidance enable/disable`
 * toggle, by design): an empty `desired` means "no personas on the agent lane"
 * and removes the file, exactly like `installPersonaAgents` empties
 * `.claude/agents/` when nothing is staffed.
 */
export async function installPersonaPreferenceRule(
  projectDir: string,
  dryRun: boolean,
  desired: readonly DesiredAgent[],
): Promise<InitAction[]> {
  if (desired.length === 0) return removeRuleFile(projectDir, dryRun);
  return installRuleFile(projectDir, dryRun, desired);
}

/** Uninit: remove the rule file Golem wrote, if it's still unmodified. */
export async function removePersonaPreferenceRule(
  projectDir: string,
  dryRun: boolean,
): Promise<InitAction[]> {
  return removeRuleFile(projectDir, dryRun);
}
