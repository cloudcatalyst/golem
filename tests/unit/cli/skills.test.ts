import { describe, expect, it } from "vitest";
import { P0_SKILLS } from "../../../src/cli/skills.js";

describe("wiki skills (T2, W2 leftover)", () => {
  it("wiki-query reads the wiki before falling back to search", () => {
    const skill = P0_SKILLS["wiki-query"];
    if (skill === undefined) throw new Error("expected a wiki-query skill");
    expect(skill).toContain("wiki_read");
    expect(skill).toContain("search");
    expect(skill).toMatch(/\$ARGUMENTS/);
  });

  it("wiki-ingest requires approval before writing (plan-gated per Decision 29)", () => {
    const skill = P0_SKILLS["wiki-ingest"];
    if (skill === undefined) throw new Error("expected a wiki-ingest skill");
    expect(skill).toContain("wiki_upsert");
    expect(skill.toLowerCase()).toContain("approval");
    // The write must come strictly after the approval instruction, not before it.
    expect(skill.indexOf("approval")).toBeLessThan(skill.indexOf("wiki_upsert"));
  });
});
