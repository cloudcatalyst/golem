/**
 * R9.5 — the two managed-file bugs, in mirror image.
 *
 * Skills were content-compared and overwritten, so a hand-edited skill was
 * silently destroyed. Guidance was seed-once, so an improved rule never reached
 * an already-initialized project. These tests pin both directions AND the thing
 * that must not regress: a rule the user disabled is never resurrected.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rememberManaged } from "../../src/cli/managed-files.js";
import {
  GUIDANCE_FEATURES,
  guidanceRuleBody,
  guidanceRulePath,
  removeGuidanceRule,
  seedDefaultGuidance,
  writeGuidanceRule,
} from "../../src/hooks/index.js";
import { rmTemp } from "../helpers/tmp.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-managed-refresh-"));
});
afterEach(async () => {
  await rm(projectDir, rmTemp);
});

const read = (p: string) => readFile(p, "utf8");
const exists = async (p: string) =>
  read(p)
    .then(() => true)
    .catch(() => false);

const FEATURE = GUIDANCE_FEATURES.find((g) => g.seededByDefault && g.name === "ccr-refs");
if (FEATURE === undefined) throw new Error("expected a seeded ccr-refs feature");

const rulePath = (): string => guidanceRulePath(projectDir, FEATURE.name, "project");

describe("guidance refresh (R9.5)", () => {
  it("refreshes a rule whose text Golem has improved, once already seeded", async () => {
    await seedDefaultGuidance(projectDir);
    expect(await read(rulePath())).toBe(guidanceRuleBody(FEATURE));

    // Simulate Golem having shipped OLDER text: the file holds v1 and the
    // provenance record says Golem wrote exactly that.
    await writeFile(rulePath(), "old shipped text\n", "utf8");
    await rememberManaged(projectDir, rulePath(), "old shipped text\n");

    const actions = await seedDefaultGuidance(projectDir);
    // The bug this fixes: before R9.5 this returned a single blanket "already
    // seeded" skip and the stale text survived forever.
    expect(await read(rulePath())).toBe(guidanceRuleBody(FEATURE));
    const mine = actions.find((a) => a.path.endsWith(`golem-${FEATURE.name}.md`));
    expect(mine?.kind).toBe("modify");
    expect(mine?.detail).toMatch(/refreshed/);
  });

  it("does NOT resurrect a rule the user disabled — the sentinel's real job", async () => {
    await seedDefaultGuidance(projectDir);
    await removeGuidanceRule(projectDir, FEATURE.name, "project");
    expect(await exists(rulePath())).toBe(false);

    const actions = await seedDefaultGuidance(projectDir);
    expect(await exists(rulePath())).toBe(false);
    expect(actions.some((a) => /disabled — not re-seeded/.test(a.detail))).toBe(true);
  });

  it("keeps an edited rule and reports a conflict rather than overwriting it", async () => {
    await seedDefaultGuidance(projectDir);
    const edited = `${guidanceRuleBody(FEATURE)}\nMy own extra paragraph.\n`;
    await writeFile(rulePath(), edited, "utf8");

    // Golem ships different text than what is on disk now.
    const action = await writeGuidanceRule(projectDir, FEATURE, "project");
    expect(action.kind).toBe("conflict");
    expect(action.detail).toMatch(/kept your version/);
    expect(action.detail).toMatch(/re-run `golem init`/);
    expect(await read(rulePath())).toBe(edited);
  });

  it("a first seed still creates every default rule", async () => {
    const actions = await seedDefaultGuidance(projectDir);
    const seeded = GUIDANCE_FEATURES.filter((g) => g.seededByDefault);
    expect(actions.filter((a) => a.kind === "create")).toHaveLength(seeded.length);
    for (const f of seeded) {
      expect(await exists(guidanceRulePath(projectDir, f.name, "project"))).toBe(true);
    }
  });

  it("dry-run reports the refresh without writing it", async () => {
    await seedDefaultGuidance(projectDir);
    await writeFile(rulePath(), "old shipped text\n", "utf8");
    await rememberManaged(projectDir, rulePath(), "old shipped text\n");

    const actions = await seedDefaultGuidance(projectDir, true);
    expect(actions.some((a) => a.kind === "modify")).toBe(true);
    expect(await read(rulePath())).toBe("old shipped text\n");
  });
});

describe("skill refresh (R9.5)", () => {
  // The skills path runs inside `runInit`, which needs a whole project; these
  // cover the same classification through the guidance writer, which shares the
  // mechanism. The end-to-end skill behaviour is asserted in cli-init.test.ts.
  it("treats a file Golem has no record of as owned, not as stale", async () => {
    const skill = path.join(projectDir, ".claude", "skills", "golem", "ship", "SKILL.md");
    await mkdir(path.dirname(skill), { recursive: true });
    await writeFile(skill, "a user's own skill\n", "utf8");
    const { classifyManaged } = await import("../../src/cli/managed-files.js");
    expect(await classifyManaged(projectDir, skill, "golem's text", "a user's own skill\n")).toBe(
      "owned",
    );
  });
});
