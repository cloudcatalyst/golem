/**
 * R13.12 — the agents half of `golem init` / `golem uninit`.
 *
 * Writes `.claude/agents/golem-coder.md` when `inference.default_coder` names a
 * MODEL, and takes it away again when it does not — including when the user
 * switches `default_coder` from a model to a registry target, which is the case a
 * pure install step would miss. A stale agent definition is worse than a missing
 * one: it names a model the config no longer selects, and nothing about the file
 * says it is out of date. `/golem/slider` outliving R11.1 is the precedent, and
 * `pruneRetiredSkills` is the shape of the answer.
 *
 * Provenance-aware throughout (R9.5), reusing `managed-files.ts` exactly as
 * `init-skills.ts` does: a definition the user has edited is reported as a
 * `conflict` and KEPT, never silently overwritten or deleted. That matters more
 * here than for a skill — this file is a prompt someone is expected to tune, and
 * `golem init` runs on every version bump.
 *
 * `.claude/agents/` is a SHARED namespace (the user's own subagents live there
 * too), so init only ever touches the one basename Golem owns. `uninit` follows
 * the same rule and removes that file rather than the directory — unlike
 * `.claude/skills/golem/`, which is a Golem-owned namespace directory and may be
 * taken whole.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CODER_AGENT_NAME, coderAgentDefinition } from "./agents.js";
import type { InitAction } from "./init.js";
import { rel } from "./json-file.js";
import {
  classifyManaged,
  forgetManaged,
  isUnmodifiedManaged,
  ownedDetail,
  rememberManaged,
} from "./managed-files.js";

/** Where the generated definition lives. */
export function coderAgentPath(projectDir: string): string {
  return path.join(projectDir, ".claude", "agents", `${CODER_AGENT_NAME}.md`);
}

export interface CoderAgentSettings {
  /** `inference.default_coder`, already resolved to a MODEL id, or undefined. */
  readonly model?: string | undefined;
  /** `inference.coder_prompt`. */
  readonly coderPrompt?: string | undefined;
}

/**
 * Init step 3c: write (or refresh, or remove) the `golem-coder` agent definition.
 *
 * `model` undefined means "no harness coder is configured" — either
 * `default_coder` is unset, or it names a registry target that Golem dispatches
 * to itself. Both cases must leave no agent definition behind, so this function
 * owns removal as well as writing; splitting them would let a stale file survive
 * a config change.
 */
export async function installCoderAgent(
  projectDir: string,
  dryRun: boolean,
  settings: CoderAgentSettings,
): Promise<InitAction[]> {
  const agentPath = coderAgentPath(projectDir);
  if (settings.model === undefined || settings.model === "") {
    return await removeStaleCoderAgent(projectDir, dryRun);
  }

  const content = coderAgentDefinition({
    model: settings.model,
    ...(settings.coderPrompt === undefined ? {} : { coderPrompt: settings.coderPrompt }),
  });

  let existing: string | null = null;
  try {
    existing = await readFile(agentPath, "utf8");
  } catch {
    existing = null;
  }

  const disposition = await classifyManaged(projectDir, agentPath, content, existing);
  if (disposition === "current") {
    return [{ kind: "skip", path: rel(projectDir, agentPath), detail: "up to date" }];
  }
  if (disposition === "owned") {
    return [
      {
        kind: "conflict",
        path: rel(projectDir, agentPath),
        detail: ownedDetail(`${CODER_AGENT_NAME} subagent`),
      },
    ];
  }

  const actions: InitAction[] = [
    {
      kind: disposition === "absent" ? "create" : "modify",
      path: rel(projectDir, agentPath),
      detail:
        disposition === "absent"
          ? `${CODER_AGENT_NAME} subagent on ${settings.model}`
          : `${CODER_AGENT_NAME} subagent — now ${settings.model} (unmodified since Golem wrote it)`,
    },
  ];
  if (!dryRun) {
    await mkdir(path.dirname(agentPath), { recursive: true });
    await writeFile(agentPath, content, "utf8");
    await rememberManaged(projectDir, agentPath, content);
  }
  return actions;
}

/**
 * Remove a definition that config no longer calls for — the `default_coder`
 * switched to a target, or was unset.
 *
 * Provenance decides, as on the install side: a file still byte-identical to what
 * Golem last wrote is Golem's to delete; an edited one, or one Golem has no record
 * of writing, is reported and LEFT ALONE.
 */
async function removeStaleCoderAgent(projectDir: string, dryRun: boolean): Promise<InitAction[]> {
  const agentPath = coderAgentPath(projectDir);
  let onDisk: string;
  try {
    onDisk = await readFile(agentPath, "utf8");
  } catch {
    return []; // nothing there — the common case
  }
  if (!(await isUnmodifiedManaged(projectDir, agentPath, onDisk))) {
    return [
      {
        kind: "conflict",
        path: rel(projectDir, agentPath),
        detail: ownedDetail(`${CODER_AGENT_NAME} subagent (no longer configured)`),
      },
    ];
  }
  const actions: InitAction[] = [
    {
      kind: "remove",
      path: rel(projectDir, agentPath),
      detail: `${CODER_AGENT_NAME} subagent — inference.default_coder no longer names a model`,
    },
  ];
  if (!dryRun) {
    await rm(agentPath, { force: true });
    await forgetManaged(projectDir, agentPath);
    await pruneEmptyAgentsDir(projectDir);
  }
  return actions;
}

/**
 * Drop `.claude/agents/` if Golem's file was the only thing in it.
 *
 * The directory is shared, so this checks rather than assumes — leaving an empty
 * directory behind is untidy, deleting someone else's agents would be a bug.
 */
async function pruneEmptyAgentsDir(projectDir: string): Promise<void> {
  const dir = path.join(projectDir, ".claude", "agents");
  try {
    if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true, force: true });
  } catch {
    // already gone, or not readable — nothing to tidy
  }
}

/** Uninit step 3c: remove Golem's agent definition (only ours, never the directory). */
export async function removeCoderAgent(projectDir: string, dryRun: boolean): Promise<InitAction[]> {
  const agentPath = coderAgentPath(projectDir);
  try {
    await readFile(agentPath, "utf8");
  } catch {
    return []; // not installed
  }
  const actions: InitAction[] = [
    { kind: "remove", path: rel(projectDir, agentPath), detail: `${CODER_AGENT_NAME} subagent` },
  ];
  if (!dryRun) {
    await rm(agentPath, { force: true });
    await forgetManaged(projectDir, agentPath);
    await pruneEmptyAgentsDir(projectDir);
  }
  return actions;
}
