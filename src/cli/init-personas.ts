/**
 * R14.3 — the agents half of `golem init`, generalised from one definition to N.
 *
 * R13.12 solved the hard parts for a single file and every rule carries over:
 * generation implies de-generation, provenance decides (never the filesystem),
 * content is deterministic, and the body says where it came from. What changes
 * at N is the DELETE path, and that is what this module is careful about.
 *
 * ## The delete path is the dangerous half
 *
 * With one hardcoded basename, `golem-coder.md`, "is this file mine?" was almost
 * a constant. With a user-authored roster, `golem-<id>` is whatever the user
 * named a persona — and the user may already have a hand-written agent at that
 * exact path. `.claude/agents/` is a SHARED namespace: their own subagents live
 * there too.
 *
 * So the prefix is only ever a **scan filter**, and the **managed-file ledger
 * decides deletion**. Golem removes a file only when it holds a record of having
 * written it and the bytes still match. A hand-authored `golem-writer.md` Golem
 * never wrote is reported as a conflict and left exactly where it is. Reaching
 * for a prefix scan to decide removal — because enumerating is easier than
 * remembering — is precisely the mistake this comment exists to prevent.
 *
 * (There is a live fixture for this: `.claude/agents/golem-scribe.md` was
 * hand-authored on 2026-08-30 with no managed record, specifically so the
 * never-delete-what-we-did-not-write property has something real to hold.)
 *
 * Contrast `.claude/skills/golem/`, which is a Golem-OWNED namespace directory
 * and may be taken whole — the asymmetry R13.12 recorded and this inherits.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { personaAgentDefinition, personaAgentName } from "./agents.js";
import type { InitAction } from "./init.js";
import { rel } from "./json-file.js";
import {
  classifyManaged,
  forgetManaged,
  isUnmodifiedManaged,
  ownedDetail,
  rememberManaged,
} from "./managed-files.js";

/** One persona that should have a generated definition on disk. */
export interface DesiredAgent {
  readonly id: string;
  readonly model: string;
  readonly prompt: string;
  readonly description?: string | undefined;
  readonly tools?: readonly string[] | undefined;
}

/** `.claude/agents/golem-<id>.md`. */
export function personaAgentPath(projectDir: string, id: string): string {
  return path.join(projectDir, ".claude", "agents", `${personaAgentName(id)}.md`);
}

function agentsDir(projectDir: string): string {
  return path.join(projectDir, ".claude", "agents");
}

/** Basenames Golem could plausibly own — the SCAN filter, never the delete rule. */
function isGolemAgentFile(name: string): boolean {
  return name.startsWith("golem-") && name.endsWith(".md");
}

/**
 * Write, refresh, or leave alone one persona's definition.
 *
 * Provenance decides: a definition the user has edited is a `conflict` and is
 * KEPT. These are prompts people are meant to tune, and `golem init` runs on
 * every version bump.
 */
async function installOne(
  projectDir: string,
  dryRun: boolean,
  agent: DesiredAgent,
): Promise<InitAction[]> {
  const file = personaAgentPath(projectDir, agent.id);
  const content = personaAgentDefinition(agent);

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
        detail: ownedDetail(`${personaAgentName(agent.id)} subagent`),
      },
    ];
  }

  const actions: InitAction[] = [
    {
      kind: disposition === "absent" ? "create" : "modify",
      path: rel(projectDir, file),
      detail:
        disposition === "absent"
          ? `${personaAgentName(agent.id)} subagent on ${agent.model}`
          : `${personaAgentName(agent.id)} subagent — now ${agent.model} (unmodified since Golem wrote it)`,
    },
  ];
  if (!dryRun) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
    await rememberManaged(projectDir, file, content);
  }
  return actions;
}

/**
 * Remove definitions config no longer calls for.
 *
 * "No longer calls for" covers every case a pure install step would miss: the
 * persona was deleted, unstaffed, restaffed to a worker-lane target, or marked
 * `owner: user`. A stale definition names a model the config no longer selects
 * and nothing about the file says it is out of date — worse than a missing one.
 */
async function pruneUndesired(
  projectDir: string,
  dryRun: boolean,
  desiredIds: ReadonlySet<string>,
): Promise<InitAction[]> {
  const dir = agentsDir(projectDir);
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && isGolemAgentFile(e.name))
      .map((e) => e.name);
  } catch {
    return []; // no directory yet — nothing to prune
  }

  const actions: InitAction[] = [];
  for (const name of entries.sort()) {
    const id = name.slice("golem-".length, -".md".length);
    if (desiredIds.has(id)) continue;

    const file = path.join(dir, name);
    let onDisk: string;
    try {
      onDisk = await readFile(file, "utf8");
    } catch {
      continue;
    }
    // THE rule: the ledger decides, not the prefix. A file Golem never wrote —
    // or one the user has since edited — is reported and left alone.
    if (!(await isUnmodifiedManaged(projectDir, file, onDisk))) {
      actions.push({
        kind: "conflict",
        path: rel(projectDir, file),
        detail: ownedDetail(`golem-${id} subagent (no longer configured)`),
      });
      continue;
    }
    actions.push({
      kind: "remove",
      path: rel(projectDir, file),
      detail: `golem-${id} subagent — no longer configured, and unmodified since Golem wrote it`,
    });
    if (!dryRun) {
      await rm(file, { force: true });
      await forgetManaged(projectDir, file);
    }
  }
  return actions;
}

/** Remove the agents directory when Golem has emptied it. Never removes a non-empty one. */
async function pruneEmptyAgentsDir(projectDir: string): Promise<void> {
  const dir = agentsDir(projectDir);
  try {
    if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true, force: true });
  } catch {
    // already gone, or not readable — nothing to tidy
  }
}

/**
 * Init step: bring `.claude/agents/` into line with the persona registry.
 *
 * Owns removal as well as writing, deliberately. Splitting them would let a
 * stale definition survive a config change, which is the failure `/golem/slider`
 * outliving R11.1 is the precedent for.
 */
export async function installPersonaAgents(
  projectDir: string,
  dryRun: boolean,
  desired: readonly DesiredAgent[],
): Promise<InitAction[]> {
  const actions: InitAction[] = [];
  for (const agent of [...desired].sort((a, b) => a.id.localeCompare(b.id))) {
    actions.push(...(await installOne(projectDir, dryRun, agent)));
  }
  actions.push(...(await pruneUndesired(projectDir, dryRun, new Set(desired.map((d) => d.id)))));
  if (!dryRun && desired.length === 0) await pruneEmptyAgentsDir(projectDir);
  return actions;
}

/**
 * Uninit: remove every definition Golem wrote, and only those.
 *
 * The same ledger rule as the prune path — an edited or hand-authored
 * `golem-*.md` survives `golem uninit`, because it was never Golem's to remove.
 */
export async function removePersonaAgents(
  projectDir: string,
  dryRun: boolean,
): Promise<InitAction[]> {
  const actions = await pruneUndesired(projectDir, dryRun, new Set<string>());
  if (!dryRun) await pruneEmptyAgentsDir(projectDir);
  return actions;
}
