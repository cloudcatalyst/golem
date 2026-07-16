/**
 * Golem guidance as Claude Code project rules (`.claude/rules/golem-*.md`):
 * registry, rule read/write, seed-once, and removal.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GUIDANCE_FEATURES,
  guidanceFeature,
  guidanceRuleBody,
  guidanceRulePath,
  promptTranslationGuidanceSnippet,
  removeAllGuidanceRules,
  removeGuidanceRule,
  seedDefaultGuidance,
  writeGuidanceRule,
} from "../../../src/hooks/index.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-guidance-"));
});
afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

const read = (p: string) => readFile(p, "utf8");
const exists = async (p: string) =>
  read(p)
    .then(() => true)
    .catch(() => false);

describe("guidance feature registry", () => {
  it("covers base defaults (seeded) and opt-in features", () => {
    const byName = new Map(GUIDANCE_FEATURES.map((g) => [g.name, g]));
    for (const n of ["ccr-refs", "wiki-kb-first", "local-coder"]) {
      expect(byName.get(n)?.seededByDefault).toBe(true);
    }
    for (const n of ["prompt-translation", "durable-tasks"]) {
      expect(byName.get(n)?.seededByDefault).toBe(false);
    }
  });

  it("wiki-kb-first directs wiki → KB → web, and frames it as proactive", () => {
    const snip = guidanceFeature("wiki-kb-first")?.snippet ?? "";
    expect(snip).toContain("Check the wiki first");
    expect(snip.indexOf("`search` MCP tool")).toBeGreaterThan(snip.indexOf("Check the wiki first"));
    expect(snip.indexOf("Then WebFetch")).toBeGreaterThan(snip.indexOf("`search` MCP tool"));
    expect(snip).toContain("proactively");
  });

  it("prompt-translation directs show-first, never-silent use", () => {
    const snip = promptTranslationGuidanceSnippet();
    expect(snip).toBe(guidanceFeature("prompt-translation")?.snippet);
    expect(snip).toContain("golem prompt translate");
    expect(snip).toContain("NEVER silently rewrite");
  });

  it("durable-tasks directs explicit (never silent) escalation", () => {
    const snip = guidanceFeature("durable-tasks")?.snippet ?? "";
    expect(snip).toContain("golem task escalate");
    expect(snip.toLowerCase()).toContain("never escalate silently");
  });

  it("returns null for an unknown feature", () => {
    expect(guidanceFeature("nope")).toBeNull();
  });
});

describe("rule file paths + body", () => {
  it("uses .claude/rules/golem-<name>.md for project, .local.md for user", () => {
    expect(guidanceRulePath("/proj", "wiki-kb-first", "project").replace(/\\/g, "/")).toBe(
      "/proj/.claude/rules/golem-wiki-kb-first.md",
    );
    expect(guidanceRulePath("/proj", "wiki-kb-first", "user").replace(/\\/g, "/")).toBe(
      "/proj/.claude/rules/golem-wiki-kb-first.local.md",
    );
  });

  it("body carries a managed banner + the snippet", () => {
    const f = guidanceFeature("ccr-refs");
    if (f === undefined || f === null) throw new Error("expected ccr-refs");
    const body = guidanceRuleBody(f);
    expect(body).toContain("Managed by Golem");
    expect(body).toContain("golem guidance disable ccr-refs");
    expect(body).toContain(f.snippet);
  });
});

describe("writeGuidanceRule / removeGuidanceRule", () => {
  it("creates a rule file, then skips when identical", async () => {
    const f = guidanceFeature("prompt-translation");
    if (f === undefined || f === null) throw new Error("expected feature");
    const first = await writeGuidanceRule(projectDir, f, "project");
    expect(first.kind).toBe("create");
    expect(await exists(guidanceRulePath(projectDir, f.name, "project"))).toBe(true);

    const second = await writeGuidanceRule(projectDir, f, "project");
    expect(second.kind).toBe("skip");
  });

  it("user scope writes the .local.md variant", async () => {
    const f = guidanceFeature("durable-tasks");
    if (f === undefined || f === null) throw new Error("expected feature");
    await writeGuidanceRule(projectDir, f, "user");
    expect(await exists(guidanceRulePath(projectDir, f.name, "user"))).toBe(true);
    expect(await exists(guidanceRulePath(projectDir, f.name, "project"))).toBe(false);
  });

  it("removes both scopes by default; no-op when absent", async () => {
    const f = guidanceFeature("prompt-translation");
    if (f === undefined || f === null) throw new Error("expected feature");
    await writeGuidanceRule(projectDir, f, "project");
    await writeGuidanceRule(projectDir, f, "user");
    const removed = await removeGuidanceRule(projectDir, f.name, "both");
    expect(removed.kind).toBe("remove");
    expect(await exists(guidanceRulePath(projectDir, f.name, "project"))).toBe(false);
    expect(await exists(guidanceRulePath(projectDir, f.name, "user"))).toBe(false);
    expect((await removeGuidanceRule(projectDir, f.name, "both")).kind).toBe("skip");
  });
});

describe("seedDefaultGuidance (seed-once)", () => {
  it("writes only the default features on first init", async () => {
    const actions = await seedDefaultGuidance(projectDir);
    expect(actions.every((a) => a.kind === "create")).toBe(true);
    expect(await exists(guidanceRulePath(projectDir, "wiki-kb-first", "project"))).toBe(true);
    expect(await exists(guidanceRulePath(projectDir, "local-coder", "project"))).toBe(true);
    // Opt-in features are NOT seeded.
    expect(await exists(guidanceRulePath(projectDir, "prompt-translation", "project"))).toBe(false);
  });

  it("does not restore a user-disabled default on re-seed", async () => {
    await seedDefaultGuidance(projectDir);
    // User disables a default.
    await removeGuidanceRule(projectDir, "wiki-kb-first", "both");
    expect(await exists(guidanceRulePath(projectDir, "wiki-kb-first", "project"))).toBe(false);

    // Re-seeding is a no-op (sentinel present) — the disable sticks.
    const again = await seedDefaultGuidance(projectDir);
    expect(again).toHaveLength(1);
    expect(again[0]?.kind).toBe("skip");
    expect(await exists(guidanceRulePath(projectDir, "wiki-kb-first", "project"))).toBe(false);
  });

  it("dry-run writes nothing", async () => {
    await seedDefaultGuidance(projectDir, true);
    expect(await exists(guidanceRulePath(projectDir, "wiki-kb-first", "project"))).toBe(false);
  });
});

describe("removeAllGuidanceRules (uninit)", () => {
  it("removes every seeded + opt-in golem rule and the sentinel", async () => {
    await seedDefaultGuidance(projectDir);
    const pt = guidanceFeature("prompt-translation");
    if (pt === undefined || pt === null) throw new Error("expected feature");
    await writeGuidanceRule(projectDir, pt, "user");

    await removeAllGuidanceRules(projectDir);
    for (const g of GUIDANCE_FEATURES) {
      expect(await exists(guidanceRulePath(projectDir, g.name, "project"))).toBe(false);
      expect(await exists(guidanceRulePath(projectDir, g.name, "user"))).toBe(false);
    }
    // Sentinel gone → a later init would seed defaults afresh.
    const reseed = await seedDefaultGuidance(projectDir);
    expect(reseed.some((a) => a.kind === "create")).toBe(true);
    // A leftover write in this dir keeps lints happy about writeFile import.
    await writeFile(path.join(projectDir, ".keep"), "", "utf8");
  });
});
