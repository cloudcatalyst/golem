/**
 * `guidance-new-default-never-seeds` — one mechanism, two facts it must not
 * confuse.
 *
 * The seed record has to serve both of these at once:
 *
 * - a default the user turned OFF stays off, across any number of re-inits
 * - a default that did not EXIST last time is delivered on the next init
 *
 * With a bare `seeded: true` sentinel both look identical on disk — "sentinel
 * set, rule file absent" — and the second silently lost. Every guidance rule
 * shipped after a project's first init reached new projects and no established
 * one, which is invisible from the author's side because their fresh test
 * project always gets it. So both are pinned here, and the pair is the point:
 * a fix that delivers new rules by re-seeding everything would pass half of
 * this file and undo the user's choices.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GUIDANCE_FEATURES,
  guidanceRulePath,
  removeGuidanceRule,
  seedDefaultGuidance,
} from "../../../src/hooks/guidance.js";
import { useTempDirs } from "../../helpers/tmp.js";

const newTempDir = useTempDirs("golem-gsr");

const DEFAULTS = GUIDANCE_FEATURES.filter((g) => g.seededByDefault).map((g) => g.name);

/** Two real shipped defaults: one to disable, one to stand in for "new". */
const [DISABLED, NEWCOMER] = DEFAULTS;
if (DISABLED === undefined || NEWCOMER === undefined) {
  throw new Error("expected at least two default guidance features");
}

describe("the guidance seed record", () => {
  let projectDir: string;

  const statePath = (): string => path.join(projectDir, ".golem", "state", "guidance.json");
  const rulePath = (name: string): string => guidanceRulePath(projectDir, name, "project");

  const readState = async (): Promise<{ seeded?: boolean; features?: string[] }> =>
    JSON.parse(await readFile(statePath(), "utf8"));

  const ruleExists = async (name: string): Promise<boolean> =>
    await readFile(rulePath(name), "utf8").then(
      () => true,
      () => false,
    );

  beforeEach(async () => {
    projectDir = await newTempDir();
  });

  it("records WHICH defaults it offered, not merely that it ran", async () => {
    await seedDefaultGuidance(projectDir, false);

    const state = await readState();
    expect(state.seeded).toBe(true);
    expect(state.features).toEqual([...DEFAULTS].sort());
  });

  it("leaves a default the user disabled disabled, across repeated inits", async () => {
    await seedDefaultGuidance(projectDir, false);
    await rm(rulePath(DISABLED));

    await seedDefaultGuidance(projectDir, false);
    await seedDefaultGuidance(projectDir, false);

    expect(await ruleExists(DISABLED)).toBe(false);
    // Still recorded as offered — that is what keeps it from coming back.
    expect((await readState()).features).toContain(DISABLED);
  });

  it("delivers a default the project was never offered", async () => {
    // A project seeded before NEWCOMER existed: the record names every other
    // default, and its rule file is absent for the innocent reason.
    await seedDefaultGuidance(projectDir, false);
    await rm(rulePath(NEWCOMER));
    await writeFile(
      statePath(),
      JSON.stringify({ seeded: true, features: DEFAULTS.filter((n) => n !== NEWCOMER) }),
      "utf8",
    );

    const actions = await seedDefaultGuidance(projectDir, false);

    expect(await ruleExists(NEWCOMER)).toBe(true);
    expect(actions.some((a) => a.path.includes(NEWCOMER) && a.kind !== "skip")).toBe(true);
  });

  describe("migrating an old-format record", () => {
    /** The pre-fix sentinel: a bare boolean, no feature names. */
    async function legacySentinel(present: readonly string[]): Promise<void> {
      await seedDefaultGuidance(projectDir, false);
      for (const name of DEFAULTS) {
        if (!present.includes(name)) await rm(rulePath(name));
      }
      await mkdir(path.dirname(statePath()), { recursive: true });
      await writeFile(statePath(), JSON.stringify({ seeded: true }), "utf8");
    }

    it("infers what was offered from the rules on disk, and seeds the rest once", async () => {
      // The names are not recoverable from the old format, so the rules present
      // are the only evidence available.
      await legacySentinel([DISABLED]);

      const actions = await seedDefaultGuidance(projectDir, false);

      expect(await ruleExists(NEWCOMER)).toBe(true);
      expect((await readState()).features).toEqual([...DEFAULTS].sort());
      // And it SAYS it upgraded rather than doing it quietly.
      expect(actions.some((a) => a.detail.includes("guidance record upgraded"))).toBe(true);
    });

    it("re-offers a genuinely disabled rule exactly ONCE, never again", async () => {
      // The cost of the migration, bounded and stated: a rule the user had
      // turned off comes back one time, visibly. After the record is upgraded,
      // disabling it again sticks forever.
      await legacySentinel([DISABLED]);
      await seedDefaultGuidance(projectDir, false);
      expect(await ruleExists(NEWCOMER)).toBe(true);

      await rm(rulePath(NEWCOMER));
      await seedDefaultGuidance(projectDir, false);
      await seedDefaultGuidance(projectDir, false);

      expect(await ruleExists(NEWCOMER)).toBe(false);
    });

    it("does not announce an upgrade on a record that is already current", async () => {
      await seedDefaultGuidance(projectDir, false);

      const actions = await seedDefaultGuidance(projectDir, false);

      expect(actions.some((a) => a.detail.includes("guidance record upgraded"))).toBe(false);
    });
  });

  it("forgets the provenance record when a rule is disabled", async () => {
    // Otherwise `.golem/managed-files.json` accumulates a hash per rule anybody
    // ever turned off — files that do not exist, in the file whose whole job is
    // saying what Golem wrote. Observed on this repo during the migration.
    await seedDefaultGuidance(projectDir, false);
    const managed = path.join(projectDir, ".golem", "managed-files.json");
    expect(await readFile(managed, "utf8")).toContain(`golem-${DISABLED}.md`);

    await removeGuidanceRule(projectDir, DISABLED, "both", false);

    expect(await readFile(managed, "utf8")).not.toContain(`golem-${DISABLED}.md`);
  });

  it("writes nothing on a dry run", async () => {
    await seedDefaultGuidance(projectDir, true);

    await expect(readFile(statePath(), "utf8")).rejects.toThrow();
    expect(await ruleExists(NEWCOMER)).toBe(false);
  });
});
