/**
 * The skills half of `golem init` / `golem uninit`.
 *
 * Installs the P0 `/golem/<cmd>` skills as
 * `.claude/skills/golem/<cmd>/SKILL.md` (§11) and removes the namespace again.
 * `skills.ts` owns what the skills SAY; this owns where they land and how an
 * existing file on disk is treated.
 *
 * The two functions are exact inverses and must be changed together. Install is
 * provenance-aware (R9.5): a skill the user has edited is reported as a
 * `conflict` and kept, never silently overwritten. Removal is not, because the
 * whole `golem` namespace directory is ours.
 *
 * The `InitAction` import is type-only, so it is erased at build time and
 * creates no runtime cycle back to init.ts.
 */

import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InitAction } from "./init.js";
import { rel } from "./json-file.js";
import { classifyManaged, ownedDetail, rememberManaged } from "./managed-files.js";
import { P0_SKILLS } from "./skills.js";

/** Init step 3: skills — .claude/skills/golem/<cmd>/SKILL.md -> /golem/<cmd>. */
export async function installSkills(projectDir: string, dryRun: boolean): Promise<InitAction[]> {
  const actions: InitAction[] = [];
  for (const [name, content] of Object.entries(P0_SKILLS)) {
    const skillPath = path.join(projectDir, ".claude", "skills", "golem", name, "SKILL.md");
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
        detail: ownedDetail(`/golem/${name} skill`),
      });
      continue;
    }
    actions.push({
      kind: disposition === "absent" ? "create" : "modify",
      path: rel(projectDir, skillPath),
      detail:
        disposition === "absent"
          ? `/golem/${name} skill`
          : `/golem/${name} skill — refreshed (unmodified since Golem wrote it)`,
    });
    if (!dryRun) {
      await mkdir(path.dirname(skillPath), { recursive: true });
      await writeFile(skillPath, content, "utf8");
      await rememberManaged(projectDir, skillPath, content);
    }
  }
  return actions;
}

/** Uninit step 3: remove the whole golem skills namespace (all files in it are ours). */
export async function removeSkills(projectDir: string, dryRun: boolean): Promise<InitAction[]> {
  const actions: InitAction[] = [];
  const skillsDir = path.join(projectDir, ".claude", "skills", "golem");
  try {
    await access(skillsDir);
    actions.push({ kind: "remove", path: rel(projectDir, skillsDir), detail: "Golem skills" });
    if (!dryRun) await rm(skillsDir, { recursive: true, force: true });
  } catch {
    // not installed
  }
  return actions;
}
