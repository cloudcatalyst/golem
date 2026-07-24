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

  it("wiki-ingest authors the note directly, no prior approval (de-gated per Decision 44)", () => {
    const skill = P0_SKILLS["wiki-ingest"];
    if (skill === undefined) throw new Error("expected a wiki-ingest skill");
    expect(skill).toContain("wiki_upsert");
    expect(skill).toContain("Decision 44");
    // De-gated: authored directly, no prior approval required.
    expect(skill.toLowerCase()).toContain("no prior approval");
    expect(skill.toLowerCase()).not.toContain("wait for approval");
  });

  it("wiki-ingest prefers an existing distill draft over re-distilling (T3)", () => {
    const skill = P0_SKILLS["wiki-ingest"];
    if (skill === undefined) throw new Error("expected a wiki-ingest skill");
    expect(skill).toContain("golem wiki distill");
    // The distill step must come before the write step.
    expect(skill.indexOf("golem wiki distill")).toBeLessThan(skill.indexOf("wiki_upsert"));
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
