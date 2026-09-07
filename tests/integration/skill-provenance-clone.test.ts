/**
 * skill-provenance-on-clone — the gate, end to end through `installSkills`.
 *
 * The failure this pins: Golem's skills are committed
 * (`.claude/skills/golem-<cmd>/SKILL.md`) and the record that decides whether
 * one may be refreshed was not — it lived under gitignored `.golem/state/`. On
 * a teammate's clone there was no record, so "no record → owned" fired and
 * every skill was a permanent conflict whose advice was to delete a
 * version-controlled file. It only looked fine while the clone happened to run
 * the same Golem version, because then `onDisk === shipped` short-circuits.
 *
 * Both halves matter and both are asserted here: the stale committed skill
 * refreshes, and a hand-edited one in the SAME project is still kept and
 * reported. A fix that refreshes everything has broken the guard R9.5 exists
 * to provide.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { installSkills, skillDirName } from "../../src/cli/init-skills.js";
import {
  classifyManaged,
  hashManaged,
  managedKey,
  managedRecordPath,
  managedStatePath,
} from "../../src/cli/managed-files.js";
import { P0_SKILLS } from "../../src/cli/skills.js";
import { useTempDirs } from "../helpers/tmp.js";

let projectDir: string;

const newTempDir = useTempDirs("golem-skill-clone-");

beforeEach(async () => {
  projectDir = await newTempDir();
});

/** Three real shipped skills: one stale, one edited, one Golem never wrote. */
const [STALE, EDITED, UNKNOWN] = Object.keys(P0_SKILLS).sort();
if (STALE === undefined || EDITED === undefined || UNKNOWN === undefined) {
  throw new Error("expected at least three shipped skills");
}

const skillPath = (command: string): string =>
  path.join(projectDir, ".claude", "skills", skillDirName(command), "SKILL.md");

const read = (file: string): Promise<string> => readFile(file, "utf8");

const exists = (file: string): Promise<boolean> =>
  read(file).then(
    () => true,
    () => false,
  );

async function put(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

/**
 * Build what `git clone` actually hands a teammate: the committed skill files
 * plus the committed provenance record, and NOTHING under `.golem/state/`.
 */
async function cloneWith(files: Record<string, string>, record: Record<string, string>) {
  for (const [command, content] of Object.entries(files)) await put(skillPath(command), content);
  const keyed: Record<string, string> = {};
  for (const [command, content] of Object.entries(record)) {
    keyed[managedKey(projectDir, skillPath(command))] = hashManaged(content);
  }
  await put(managedRecordPath(projectDir), `${JSON.stringify(keyed, null, 2)}\n`);
}

const OLD_STALE = "# /golem-x\n\nWhat an older Golem shipped.\n";
const OLD_EDITED = "# /golem-y\n\nWhat an older Golem shipped.\n";

describe("a cloned project refreshes its Golem skills", () => {
  it("refreshes stale committed skills while keeping the edited one", async () => {
    await cloneWith(
      {
        [STALE]: OLD_STALE,
        [EDITED]: `${OLD_EDITED}\nMy own paragraph, which is the point.\n`,
        [UNKNOWN]: "a skill Golem never wrote\n",
      },
      { [STALE]: OLD_STALE, [EDITED]: OLD_EDITED },
    );
    expect(await exists(managedStatePath(projectDir))).toBe(false);

    const actions = await installSkills(projectDir, false);
    const forCommand = (command: string) =>
      actions.find((a) => a.path === `.claude/skills/${skillDirName(command)}/SKILL.md`);

    // The bug: this was a `conflict` on every machine but the one that ran init.
    expect(forCommand(STALE)?.kind).toBe("modify");
    expect(forCommand(STALE)?.detail).toMatch(/refreshed/);
    expect(await read(skillPath(STALE))).toBe(P0_SKILLS[STALE]);

    // The guard that must survive the fix, in the same project, same run.
    expect(forCommand(EDITED)?.kind).toBe("conflict");
    expect(forCommand(EDITED)?.detail).toMatch(/kept your version/);
    expect(await read(skillPath(EDITED))).toBe(
      `${OLD_EDITED}\nMy own paragraph, which is the point.\n`,
    );

    // And a file Golem has no record of at all is still nobody's to overwrite.
    expect(forCommand(UNKNOWN)?.kind).toBe("conflict");
    expect(await read(skillPath(UNKNOWN))).toBe("a skill Golem never wrote\n");
  });

  it("reports the refresh without writing it on a dry run", async () => {
    await cloneWith({ [STALE]: OLD_STALE }, { [STALE]: OLD_STALE });
    const actions = await installSkills(projectDir, true);
    expect(actions.some((a) => a.kind === "modify")).toBe(true);
    expect(await read(skillPath(STALE))).toBe(OLD_STALE);
  });

  it("records what it refreshed, so the NEXT version is stale rather than owned", async () => {
    await cloneWith({ [STALE]: OLD_STALE }, { [STALE]: OLD_STALE });
    await installSkills(projectDir, false);
    expect(
      await classifyManaged(
        projectDir,
        skillPath(STALE),
        "a future Golem's text",
        P0_SKILLS[STALE] as string,
      ),
    ).toBe("stale");
  });
});

describe("a project whose skills were committed before the record was portable", () => {
  it("records provenance for a skill that is byte-identical to what Golem ships", async () => {
    // No record of any kind — the state every existing project is in today.
    for (const [command, content] of Object.entries(P0_SKILLS)) {
      await put(skillPath(command), content);
    }
    expect(await exists(managedRecordPath(projectDir))).toBe(false);

    const actions = await installSkills(projectDir, false);
    expect(actions.every((a) => a.kind === "skip")).toBe(true);

    // Identical bytes are proof of authorship whoever put them there, so the
    // record can be written honestly — and THAT is what reaches the teammate.
    const record = JSON.parse(await readFile(managedRecordPath(projectDir), "utf8")) as Record<
      string,
      string
    >;
    for (const [command, content] of Object.entries(P0_SKILLS)) {
      expect(record[managedKey(projectDir, skillPath(command))]).toBe(hashManaged(content));
    }
  });

  it("writes nothing on a dry run", async () => {
    for (const [command, content] of Object.entries(P0_SKILLS)) {
      await put(skillPath(command), content);
    }
    await installSkills(projectDir, true);
    expect(await exists(managedRecordPath(projectDir))).toBe(false);
  });
});
