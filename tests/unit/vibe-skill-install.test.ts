/**
 * `/vibe` installs unprefixed — and stays removable.
 *
 * Every other skill Golem ships lands as `.claude/skills/golem-<cmd>/`, and that
 * prefix is what `ourSkillDirs` uses to decide which directories are Golem's to
 * refresh, prune and delete. `vibe` is deliberately outside that convention
 * (USER, 2026-09-13), which is exactly how a skill becomes installable but never
 * uninstallable: install writes it, and every other step stops seeing it.
 *
 * So the round trip is the test. Widening the glob instead of using the
 * allowlist would pass the install half of this file and hand Golem authority
 * over directories a user or a team created — the last case here pins that.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  installSkills,
  pruneRetiredSkills,
  removeSkills,
  skillDirName,
  UNPREFIXED_SKILLS,
} from "../../src/cli/init-skills.js";
import { P0_SKILLS } from "../../src/cli/skills.js";
import { useTempDirs } from "../helpers/tmp.js";

const newTempDir = useTempDirs("golem-vibe-skill-");

let projectDir: string;

beforeEach(async () => {
  projectDir = await newTempDir();
});

const vibeSkillPath = (dir: string): string =>
  path.join(dir, ".claude", "skills", "vibe", "SKILL.md");

describe("the vibe skill", () => {
  it("is shipped, and maps to a bare directory name", () => {
    expect(P0_SKILLS).toHaveProperty("vibe");
    expect(UNPREFIXED_SKILLS.has("vibe")).toBe(true);
    expect(skillDirName("vibe")).toBe("vibe");
    expect(skillDirName("ship")).toBe("golem-ship");
  });

  it("installs to .claude/skills/vibe/SKILL.md", async () => {
    const actions = await installSkills(projectDir, false);

    expect(await readFile(vibeSkillPath(projectDir), "utf8")).toBe(P0_SKILLS.vibe);
    expect(actions.some((a) => a.path === ".claude/skills/vibe/SKILL.md")).toBe(true);
  });

  it("is removed again by uninit — the half a prefix-only glob would miss", async () => {
    await installSkills(projectDir, false);

    const removed = await removeSkills(projectDir, false);

    expect(removed.map((a) => a.path)).toContain(".claude/skills/vibe");
    await expect(readFile(vibeSkillPath(projectDir), "utf8")).rejects.toThrow();
  });

  it("survives a prune, because it is a skill Golem still ships", async () => {
    await installSkills(projectDir, false);

    await pruneRetiredSkills(projectDir, false);

    expect(await readFile(vibeSkillPath(projectDir), "utf8")).toBe(P0_SKILLS.vibe);
  });

  it("leaves a stranger's skill directory completely alone", async () => {
    // The reason this is an allowlist and not a widened glob: `.claude/skills/`
    // is shared with the user's own skills and with a team's.
    const mine = path.join(projectDir, ".claude", "skills", "my-own-thing");
    await mkdir(mine, { recursive: true });
    await writeFile(path.join(mine, "SKILL.md"), "mine\n", "utf8");

    await installSkills(projectDir, false);
    await pruneRetiredSkills(projectDir, false);
    await removeSkills(projectDir, false);

    expect(await readFile(path.join(mine, "SKILL.md"), "utf8")).toBe("mine\n");
  });
});
