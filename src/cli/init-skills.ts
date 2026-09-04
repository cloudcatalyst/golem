/**
 * The skills half of `golem init` / `golem uninit`.
 *
 * Installs the P0 skills as `.claude/skills/golem-<cmd>/SKILL.md`, surfacing as
 * `/golem-<cmd>`, and removes them again. `skills.ts` owns what the skills SAY;
 * this owns where they land and how an existing file on disk is treated.
 *
 * **The layout changed on 2026-09-04, and the old one never worked.** Skills used
 * to be written to `.claude/skills/golem/<cmd>/SKILL.md`, from verification-notes
 * §11 (2026-07-03), when directory nesting was how a command got namespaced.
 * Claude Code discovers exactly one level — `.claude/skills/<name>/SKILL.md` — so
 * `golem/` was inspected for a `SKILL.md` that was not there and the whole
 * namespace was silently absent. Not an error; simply missing. Evidence and the
 * naming rule: verification-notes §150 and §152.
 *
 * A `:` namespace (`/golem:ship`) is available only to PLUGINS, and a plugin
 * means `plugin.json` and `marketplace.json`, which are Claude Code's alone.
 * `SKILL.md` is an Agent Skills spec artifact. Flat directories were chosen
 * deliberately (USER, 2026-09-04) to keep the portable unit and drop the
 * harness-specific manifests, at the cost of renaming every command.
 *
 * The three functions are exact inverses and must be changed together. Install
 * and prune are provenance-aware (R9.5): a skill the user has edited is reported
 * as a `conflict` and kept, never silently overwritten or deleted.
 *
 * The `InitAction` import is type-only, so it is erased at build time and
 * creates no runtime cycle back to init.ts.
 */

import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InitAction } from "./init.js";
import { rel } from "./json-file.js";
import {
  classifyManaged,
  forgetManaged,
  isUnmodifiedManaged,
  ownedDetail,
  rememberManaged,
} from "./managed-files.js";
import { P0_SKILLS } from "./skills.js";

/** The directory one skill lives in: `golem-<cmd>`, directly under .claude/skills. */
export function skillDirName(command: string): string {
  return `golem-${command}`;
}

/**
 * Team skills arrive as `golem-team-<cmd>` and are NOT ours to prune or remove.
 * Golem's own commands never contain a `team-` prefix, so this is unambiguous.
 */
function isTeamSkillDir(dirName: string): boolean {
  return dirName.startsWith("golem-team-");
}

/** Every `golem-*` directory under .claude/skills that is not a team skill. */
async function ourSkillDirs(projectDir: string): Promise<string[]> {
  const skillsRoot = path.join(projectDir, ".claude", "skills");
  try {
    return (await readdir(skillsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith("golem-") && !isTeamSkillDir(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Init step 3: skills — .claude/skills/golem-<cmd>/SKILL.md -> /golem-<cmd>. */
export async function installSkills(projectDir: string, dryRun: boolean): Promise<InitAction[]> {
  const actions: InitAction[] = [];
  for (const [name, content] of Object.entries(P0_SKILLS)) {
    const skillPath = path.join(projectDir, ".claude", "skills", skillDirName(name), "SKILL.md");
    let existing: string | null = null;
    try {
      existing = await readFile(skillPath, "utf8");
    } catch {
      existing = null;
    }
    // R9.5: "differs from what Golem ships" cannot tell a stale file from an
    // edited one. Ask the provenance record which it is — an edited skill is
    // reported and kept, not silently replaced.
    const disposition = await classifyManaged(projectDir, skillPath, content, existing);
    if (disposition === "current") {
      actions.push({ kind: "skip", path: rel(projectDir, skillPath), detail: "up to date" });
      continue;
    }
    if (disposition === "owned") {
      actions.push({
        kind: "conflict",
        path: rel(projectDir, skillPath),
        detail: ownedDetail(`/golem-${name} skill`),
      });
      continue;
    }
    actions.push({
      kind: disposition === "absent" ? "create" : "modify",
      path: rel(projectDir, skillPath),
      detail:
        disposition === "absent"
          ? `/golem-${name} skill`
          : `/golem-${name} skill — refreshed (unmodified since Golem wrote it)`,
    });
    if (!dryRun) {
      await mkdir(path.dirname(skillPath), { recursive: true });
      await writeFile(skillPath, content, "utf8");
      await rememberManaged(projectDir, skillPath, content);
    }
  }
  return actions;
}

/**
 * Init step 3a: retire the pre-2026-09-04 `.claude/skills/golem/<cmd>/SKILL.md`
 * namespace.
 *
 * Those files are not merely stale, they are **unreachable** — Claude Code never
 * listed them (§150). Leaving them behind would be worse than a normal stale
 * file: a user reading their project would see a `golem/` directory full of
 * skills and reasonably conclude the new flat ones are duplicates.
 *
 * Provenance still decides, exactly as everywhere else: a file Golem wrote and
 * nobody touched is Golem's to remove; an edited one is reported and KEPT, so a
 * user who customised a skill under the old layout can port it themselves.
 */
export async function migrateNestedSkills(
  projectDir: string,
  dryRun: boolean,
): Promise<InitAction[]> {
  const actions: InitAction[] = [];
  const nsDir = path.join(projectDir, ".claude", "skills", "golem");
  let entries: string[];
  try {
    entries = (await readdir(nsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return actions; // never installed, or already migrated
  }
  let keptSomething = false;
  for (const name of entries.sort()) {
    const skillPath = path.join(nsDir, name, "SKILL.md");
    let onDisk: string;
    try {
      onDisk = await readFile(skillPath, "utf8");
    } catch {
      keptSomething = true;
      continue; // a directory with no SKILL.md is not ours to interpret
    }
    if (!(await isUnmodifiedManaged(projectDir, skillPath, onDisk))) {
      keptSomething = true;
      actions.push({
        kind: "conflict",
        path: rel(projectDir, skillPath),
        detail: ownedDetail(`unreachable /golem/${name} skill from the old layout`),
      });
      continue;
    }
    actions.push({
      kind: "remove",
      path: rel(projectDir, skillPath),
      detail: `old nested layout — never discoverable by Claude Code, replaced by /golem-${name}`,
    });
    if (!dryRun) {
      await rm(path.join(nsDir, name), { recursive: true, force: true });
      await forgetManaged(projectDir, skillPath);
    }
  }
  // Only take the namespace directory itself when nothing of the user's is left
  // in it. `rm` with `recursive` would happily remove an edited skill we just
  // promised to keep.
  if (!keptSomething && !dryRun) {
    await rm(nsDir, { recursive: true, force: true });
  }
  return actions;
}

/**
 * Init step 3b: remove a `/golem-<cmd>` skill that Golem no longer ships.
 *
 * A retired skill is worse than a missing one: `/golem-slider` survived R11.1
 * still telling an agent to run a command that no longer exists. Install alone
 * cannot fix that — it only ever writes the names in the table, so anything
 * dropped from it lingers forever.
 *
 * Provenance decides, exactly as it does on the install side (R9.5): a file
 * still byte-identical to what Golem last wrote is Golem's to delete; one the
 * user has edited, or that Golem has no record of writing, is reported as a
 * `conflict` and LEFT ALONE. `.claude/skills/` is shared with the user's own
 * skills and with a team's — `uninit` may take what is ours, init may not guess.
 */
export async function pruneRetiredSkills(
  projectDir: string,
  dryRun: boolean,
): Promise<InitAction[]> {
  const actions: InitAction[] = [];
  const skillsRoot = path.join(projectDir, ".claude", "skills");
  for (const dirName of await ourSkillDirs(projectDir)) {
    const command = dirName.slice("golem-".length);
    if (command in P0_SKILLS) continue;
    const skillPath = path.join(skillsRoot, dirName, "SKILL.md");
    let onDisk: string;
    try {
      onDisk = await readFile(skillPath, "utf8");
    } catch {
      continue; // a directory with no SKILL.md is not ours to interpret
    }
    if (!(await isUnmodifiedManaged(projectDir, skillPath, onDisk))) {
      actions.push({
        kind: "conflict",
        path: rel(projectDir, skillPath),
        detail: ownedDetail(`retired /golem-${command} skill`),
      });
      continue;
    }
    actions.push({
      kind: "remove",
      path: rel(projectDir, skillPath),
      detail: `/golem-${command} skill — retired, and unmodified since Golem wrote it`,
    });
    if (!dryRun) {
      await rm(path.join(skillsRoot, dirName), { recursive: true, force: true });
      await forgetManaged(projectDir, skillPath);
    }
  }
  return actions;
}

/**
 * Uninit step 3: remove Golem's skills.
 *
 * The flat layout shares `.claude/skills/` with the user's own skills and with a
 * team's, so this can no longer delete one directory and be done. It takes every
 * `golem-*` directory that is not a team skill — those are Golem's namespace by
 * construction — plus the pre-2026-09-04 nested `golem/` directory if it is
 * still there.
 */
export async function removeSkills(projectDir: string, dryRun: boolean): Promise<InitAction[]> {
  const actions: InitAction[] = [];
  const skillsRoot = path.join(projectDir, ".claude", "skills");
  for (const dirName of await ourSkillDirs(projectDir)) {
    const dir = path.join(skillsRoot, dirName);
    actions.push({
      kind: "remove",
      path: rel(projectDir, dir),
      detail: `/${dirName} skill`,
    });
    if (!dryRun) {
      await rm(dir, { recursive: true, force: true });
      await forgetManaged(projectDir, path.join(dir, "SKILL.md"));
    }
  }
  const nested = path.join(skillsRoot, "golem");
  try {
    await access(nested);
    actions.push({
      kind: "remove",
      path: rel(projectDir, nested),
      detail: "Golem skills (old nested layout)",
    });
    if (!dryRun) await rm(nested, { recursive: true, force: true });
  } catch {
    // not installed
  }
  return actions;
}
