import { describe, expect, it } from "vitest";
import { P0_SKILLS } from "../../../src/cli/skills.js";

describe("wiki skills (T2, W2 leftover)", () => {
  it("research reads the wiki before falling back to search", () => {
    const skill = P0_SKILLS.research;
    if (skill === undefined) throw new Error("expected a research skill");
    expect(skill).toContain("wiki_read");
    expect(skill).toContain("search");
    expect(skill).toMatch(/\$ARGUMENTS/);
  });

  it("research puts the wiki + local KB strictly before any external WebFetch", () => {
    const skill = P0_SKILLS.research;
    if (skill === undefined) throw new Error("expected a research skill");
    // The whole point: never hit the network before checking the KB.
    expect(skill).toContain("WebFetch");
    expect(skill.indexOf("wiki_read")).toBeLessThan(skill.indexOf("WebFetch"));
    expect(skill.indexOf("search")).toBeLessThan(skill.indexOf("WebFetch"));
    // Re-check the KB before each fetch, and capture durable findings back.
    expect(skill.toLowerCase()).toContain("re-run `search` before each new fetch".toLowerCase());
    expect(skill).toContain("/golem/wiki-ingest");
  });

  it("wiki-ingest requires approval before writing (plan-gated per Decision 29)", () => {
    const skill = P0_SKILLS["wiki-ingest"];
    if (skill === undefined) throw new Error("expected a wiki-ingest skill");
    expect(skill).toContain("wiki_upsert");
    expect(skill.toLowerCase()).toContain("approval");
    // The write must come strictly after the approval instruction, not before it.
    expect(skill.indexOf("approval")).toBeLessThan(skill.indexOf("wiki_upsert"));
  });

  it("wiki-ingest prefers an existing distill draft over re-distilling (T3)", () => {
    const skill = P0_SKILLS["wiki-ingest"];
    if (skill === undefined) throw new Error("expected a wiki-ingest skill");
    expect(skill).toContain("golem wiki distill");
    // The distill step must come before the approval/write steps.
    expect(skill.indexOf("golem wiki distill")).toBeLessThan(skill.indexOf("approval"));
  });
});

describe("plan skill (R4.1 — planning-collaboration surface)", () => {
  const skill = P0_SKILLS.plan;

  it("is installed as a user-invoked skill", () => {
    if (skill === undefined) throw new Error("expected a plan skill");
    expect(skill).toContain("invocationMode: user");
    expect(skill).toMatch(/\$ARGUMENTS/);
  });

  it("reads every second-brain source before proposing tasks", () => {
    if (skill === undefined) throw new Error("expected a plan skill");
    // Notes, open questions, distill drafts, the backlog, and the roadmap.
    expect(skill).toContain("golem note list");
    expect(skill).toContain("questions/");
    expect(skill).toContain(".golem/distill/");
    expect(skill).toContain("BACKLOG.md");
    expect(skill).toContain("ROADMAP.md");
  });

  it("plan-gates writes: gather (read) comes before any approved edit", () => {
    if (skill === undefined) throw new Error("expected a plan skill");
    expect(skill.toLowerCase()).toContain("approval");
    // The read-only gather step must precede the plan-gated write step.
    expect(skill.indexOf("read-only")).toBeLessThan(skill.indexOf("Plan-gate every write"));
  });

  it("states the planning contract: cite sources, flag inference, admit gaps", () => {
    if (skill === undefined) throw new Error("expected a plan skill");
    expect(skill.toLowerCase()).toContain("cite");
    expect(skill.toLowerCase()).toContain("inference");
    expect(skill.toLowerCase()).toContain("admit gaps");
  });
});
