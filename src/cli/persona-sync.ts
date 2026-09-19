/**
 * R14.x — resolve `inference.personas` into the two generated artifacts that
 * mirror the roster (`.claude/agents/golem-<id>.md` and
 * `.claude/rules/golem-prefer-persona-agents.md`), WITHOUT dragging in
 * everything else `golem init` touches.
 *
 * ## Why this is its own module, not exported from `init.ts`
 *
 * `golem proxy` — the always-running daemon — needs to re-run this sync
 * (unconditionally on version-sync, and live on a settings-file watcher) but
 * must NOT load `init.ts` at runtime to get it: that module also pulls in the
 * credential store, the skills table, team-init, and every other `golem init`
 * step, just to regenerate two files. `init-personas.ts` is also the wrong
 * home — its own header establishes it as "given a desired list, write/prune",
 * with no config knowledge; adding `loadConfig` there would invert that
 * boundary. So this module sits between the two: it owns the config read and
 * the `DesiredAgent` resolution, and calls straight through to
 * `installPersonaAgents` / `installPersonaPreferenceRule` to do the writing.
 *
 * `InitAction` is imported TYPE-ONLY from `init.ts` — the same trick
 * `init-personas.ts` and `persona-preference-rule.ts` already use — so this
 * file costs nothing at runtime to whoever imports it.
 */

import path from "node:path";
import { loadConfig } from "../config/index.js";
import { resolveCoderPrompt } from "../inference/coder-prompt.js";
import { resolvePersonaLane } from "../inference/persona-lane.js";
import { effectivePersonas, resolvePersonaPrompt } from "../inference/personas.js";
import { withDefaultTarget } from "../providers/index.js";
import type { InitAction } from "./init.js";
import { type DesiredAgent, installPersonaAgents, personaAgentPath } from "./init-personas.js";
import { rel } from "./json-file.js";
import { installPersonaPreferenceRule } from "./persona-preference-rule.js";

/**
 * Resolve `inference.personas` into the `DesiredAgent[]` the two generated
 * artifacts are built from, plus any per-persona `conflict` actions.
 *
 * A malformed persona must not stop the ones configured correctly — the same
 * discipline `workerTarget` applies to a typo'd worker key — and an unreadable
 * config must not abort the caller either: reported as one `conflict` at the
 * agents directory, with an empty `desired` list, rather than thrown.
 *
 * `userDir` is an escape hatch for tests only — omitted, `loadConfig` resolves
 * the REAL `~/.golem` (correct for every real caller: `golem init`, every
 * session start, and the daemon watcher all mean to read the actual user
 * layer). Passing it is how a test proves it isn't ALSO reading the real one.
 */
export async function resolveDesiredAgents(
  projectDir: string,
  userDir?: string,
): Promise<{ desired: DesiredAgent[]; problems: InitAction[] }> {
  let settings: Awaited<ReturnType<typeof loadConfig>>["settings"];
  try {
    ({ settings } = await loadConfig({ projectDir, ...(userDir !== undefined && { userDir }) }));
  } catch (err) {
    // Config itself is unreadable — nothing can be resolved, so report once at
    // the directory. Init still wires everything else: refusing to repair a
    // project because one optional section is malformed would be the cure being
    // worse than the disease.
    return {
      desired: [],
      problems: [
        {
          kind: "conflict",
          path: rel(projectDir, path.join(projectDir, ".claude", "agents")),
          detail: `no agent definitions written — ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  const personas = settings.inference.personas;
  const registry = withDefaultTarget(settings);
  const desired: DesiredAgent[] = [];
  const problems: InitAction[] = [];

  for (const persona of effectivePersonas(personas)) {
    const config = personas[persona.id] ?? {};
    try {
      const lane = resolvePersonaLane({
        settings: registry,
        personas,
        personaId: persona.id,
        workerTargets: settings.inference.worker_targets,
      });
      // Only the AGENT lane produces a definition. A worker-lane persona is
      // dispatched to by Golem itself; an unstaffed or `owner: user` one is not
      // dispatched at all. Each of those must also REMOVE an existing file,
      // which `installPersonaAgents` does by pruning everything not listed here.
      if (lane.kind !== "agent") continue;

      // R13.12's `inference.coder_prompt` still frames the coder. Both
      // mechanisms that deliver a coder task — the `coder` MCP tool and this
      // definition — must read the SAME prompt, which is the entire reason
      // `coder-prompt.ts` exists. An explicit per-persona prompt wins over it.
      const prompt =
        persona.id === "coder" &&
        config.prompt === undefined &&
        config.prompt_file === undefined &&
        settings.inference.coder_prompt !== undefined
          ? resolveCoderPrompt(settings.inference.coder_prompt)
          : (await resolvePersonaPrompt(persona.id, config, projectDir)).text;

      desired.push({
        id: persona.id,
        model: lane.model,
        prompt,
        ...(persona.description === undefined ? {} : { description: persona.description }),
        ...(persona.discipline === undefined ? {} : { discipline: persona.discipline }),
        ...(persona.tools === undefined ? {} : { tools: persona.tools }),
      });
    } catch (err) {
      // One malformed persona must not stop the ones configured correctly —
      // the same discipline `workerTarget` applies to a typo'd worker key.
      problems.push({
        kind: "conflict",
        path: rel(projectDir, personaAgentPath(projectDir, persona.id)),
        detail: `not written — ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { desired, problems };
}

/**
 * Bring `.claude/agents/golem-<id>.md` and
 * `.claude/rules/golem-prefer-persona-agents.md` into line with
 * `inference.personas`, in one call. The entire delivery mechanism for the
 * agent-lane bench: an MCP server cannot invoke its client's own tools, so
 * Golem cannot spawn a subagent — what it CAN do is keep the definition on
 * disk current, which is what this function exists to make automatic (init,
 * every Claude Code session, and — live — a settings-file watcher, so a
 * config edit reaches disk without any of those needing to run first).
 *
 * `userDir` — see {@link resolveDesiredAgents}: a test-only override, never
 * set by a real caller.
 */
export async function syncPersonaArtifacts(
  projectDir: string,
  dryRun: boolean,
  userDir?: string,
): Promise<InitAction[]> {
  const { desired, problems } = await resolveDesiredAgents(projectDir, userDir);
  return [
    ...(await installPersonaAgents(projectDir, dryRun, desired)),
    // The sibling rule that tells a session to reach for these definitions
    // instead of the built-in `fork` subagent type. Fed the SAME `desired`
    // array rather than re-resolving config, so the two can never disagree
    // about which personas are agent-lane-dispatchable.
    ...(await installPersonaPreferenceRule(projectDir, dryRun, desired)),
    ...problems,
  ];
}
