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
    expect(skill).toContain("/golem-wiki-ingest");
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

describe("close-out skills (verify + ship)", () => {
  it("verify judges by exit code and runs the full check gate", () => {
    const skill = P0_SKILLS.verify;
    if (skill === undefined) throw new Error("expected a verify skill");
    expect(skill).toContain("invocationMode: user");
    expect(skill.toLowerCase()).toContain("exit code");
    expect(skill).toContain("npm run check");
    expect(skill).toContain("golem wiki check");
  });

  it("ship runs the checklist in order: verify green before commit/PR", () => {
    const skill = P0_SKILLS.ship;
    if (skill === undefined) throw new Error("expected a ship skill");
    // The verify step must precede the commit/PR step.
    expect(skill.indexOf("Verify green")).toBeGreaterThanOrEqual(0);
    expect(skill.indexOf("Verify green")).toBeLessThan(skill.indexOf("Commit + PR"));
    // Uses the gh CLI and never commits straight to main.
    expect(skill).toContain("gh pr create");
    expect(skill).toContain("never commit to");
  });
});

describe("footgun-guard skills (upstream + park)", () => {
  it("upstream switches via golem gateway, not the model picker", () => {
    const skill = P0_SKILLS.upstream;
    if (skill === undefined) throw new Error("expected an upstream skill");
    expect(skill).toContain("golem gateway use");
    expect(skill.toLowerCase()).toContain("not the claude code model picker");
  });

  // Task `snooze-taskadd`: documenting and parking are ONE call. The old
  // document-then-park ordering was unreachable — enforcement denies the `Bash`
  // running `golem task add`, so the skill must ask for snooze's `note` instead.
  it("park documents via snooze's own note, in the same call", () => {
    const skill = P0_SKILLS.park;
    if (skill === undefined) throw new Error("expected a park skill");
    expect(skill).toContain("snooze");
    expect(skill).toContain("note=");
    expect(skill).toContain("ONE call");
    // It may still MENTION `golem task add` — but only to warn against it.
    const add = skill.indexOf("golem task add");
    if (add !== -1) expect(skill.slice(add - 40, add)).toMatch(/Don't reach for/);
  });
});

describe("P0 skill registry", () => {
  it("registers every expected skill under a stable name", () => {
    for (const name of [
      // R11.1: was "slider" — retired with the control it named (ADR-0004).
      "compression",
      "stats",
      "expand",
      "bypass",
      "research",
      "wiki-ingest",
      "develop",
      "plan",
      "verify",
      "ship",
      "promote",
      "upstream",
      "debrief",
      "park",
      "triage",
      "cache-health",
      "context-hygiene",
      "fresh-eyes",
      "checkpoint",
      "first-pancake",
    ]) {
      expect(P0_SKILLS[name], `missing skill: ${name}`).toBeDefined();
    }
  });

  // R8.9: the ledger is only worth its tool surface if the model reaches for it
  // BEFORE the risky attempt — and never auto-accepts the destructive half.
  it("checkpoint teaches create-before-attempt and never --yes on restore", () => {
    const skill = P0_SKILLS.checkpoint;
    if (skill === undefined) throw new Error("expected a checkpoint skill");
    expect(skill).toContain("golem checkpoint create");
    expect(skill).toContain("golem checkpoint show");
    expect(skill).toMatch(/never pass\s+\\?`--yes\\?` on the user's behalf/);
    // The promises that make it safe to run at all.
    expect(skill).toContain("refs/golem/ledger");
    expect(skill).toContain("detached HEAD");
  });

  it("fresh-eyes reads code before docs and sorts findings into three buckets", () => {
    const skill = P0_SKILLS["fresh-eyes"];
    if (skill === undefined) throw new Error("expected a fresh-eyes skill");
    // Code-only pass must come strictly before the comments/docs pass.
    expect(skill.indexOf("Pass 1 — code only")).toBeLessThan(
      skill.indexOf("Pass 2 — reveal comments"),
    );
    // The three actionable buckets.
    expect(skill).toContain("Code should change");
    expect(skill).toContain("Comment/doc should change");
    expect(skill).toContain("Agree / confirmed");
    // Read-only: it proposes, never writes.
    expect(skill.toLowerCase()).toContain("writes nothing");
  });

  it("first-pancake keeps recipe, scraps the throwaway, and resets for the real release", () => {
    const skill = P0_SKILLS["first-pancake"];
    if (skill === undefined) throw new Error("expected a first-pancake skill");
    // Keep list (recipe + ingredients) comes first, before the scrap pass.
    expect(skill.indexOf("settle what the recipe actually is")).toBeLessThan(
      skill.indexOf("eat the first pancake critically"),
    );
    // Scrap pass precedes cleaning the pan / preparing pancake #2.
    expect(skill.indexOf("eat the first pancake critically")).toBeLessThan(
      skill.indexOf("## Pass 3 — clean the pan"),
    );
    // The three actioned labels.
    expect(skill).toContain("KEEP");
    expect(skill).toContain("SCRAP");
    expect(skill).toContain("REFACTOR");
    // Review-first: it sorts and proposes, it does not edit on its own.
    expect(skill.toLowerCase()).toContain("writes nothing");
  });

  it("every skill has a description and an invocationMode", () => {
    for (const [name, body] of Object.entries(P0_SKILLS)) {
      expect(body, `${name} description`).toContain("description:");
      expect(body, `${name} invocationMode`).toMatch(/invocationMode: (user|auto)/);
    }
  });
});
