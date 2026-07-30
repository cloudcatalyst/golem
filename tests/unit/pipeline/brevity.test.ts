/**
 * Decision 52 — brevity stage unit tests.
 *
 * The properties under test are the safety ones, not the wording: byte
 * stability (prompt-cache survival), `messages` never touched, idempotence,
 * cache-friendly placement, and fail-open on odd shapes.
 */

import { describe, expect, it } from "vitest";
import { BREVITY_LEVELS } from "../../../src/interfaces/policy.js";
import {
  applyBrevity,
  brevityDirective,
  hasExistingBrevityDirective,
} from "../../../src/pipeline/brevity.js";

const ACTIVE_LEVELS = ["lite", "full", "ultra"] as const;

describe("brevityDirective", () => {
  it("is byte-stable per level — prompt-cache hits depend on it", () => {
    for (const level of ACTIVE_LEVELS) {
      expect(brevityDirective(level)).toBe(brevityDirective(level));
    }
  });

  it("is distinct per level and marker-fenced with the level named", () => {
    const seen = new Set<string>();
    for (const level of ACTIVE_LEVELS) {
      const directive = brevityDirective(level);
      expect(directive).toContain(`level="${level}"`);
      expect(directive.startsWith("<golem-brevity")).toBe(true);
      expect(directive.endsWith("</golem-brevity>")).toBe(true);
      seen.add(directive);
    }
    expect(seen.size).toBe(ACTIVE_LEVELS.length);
  });

  it("always carries the verbatim-payload and prose-style-only guards", () => {
    // These clauses are what keep the directive safe: they must never be
    // dropped from a profile, at any level.
    for (const level of ACTIVE_LEVELS) {
      const directive = brevityDirective(level);
      expect(directive).toContain("reproduce those verbatim");
      expect(directive).toContain("prose style ONLY");
      expect(directive).toContain("Never change the language");
      expect(directive).toContain("Omit\nwords, never substance");
    }
  });

  it("covers every non-off level in BREVITY_LEVELS", () => {
    expect([...BREVITY_LEVELS].filter((l) => l !== "off")).toEqual([...ACTIVE_LEVELS]);
  });
});

describe("applyBrevity", () => {
  it("level off is a no-op and returns the SAME body reference", () => {
    const body = { model: "claude-opus-5", system: "You are helpful." };
    const result = applyBrevity(body, "off");
    expect(result.injected).toBe(false);
    expect(result.body).toBe(body);
    expect(result.directiveTokens).toBe(0);
  });

  it("never touches `messages` — the byte-faithfulness guarantee", () => {
    const messages = [{ role: "user", content: [{ type: "tool_result", content: "x" }] }];
    const body = { system: "S", messages };
    const result = applyBrevity(body, "full");
    expect(result.injected).toBe(true);
    // Same array reference: not copied, not rewritten, not re-serialised.
    expect(result.body.messages).toBe(messages);
  });

  it("appends to a string system, preserving the original text as a prefix", () => {
    const body = { system: "You are helpful." };
    const result = applyBrevity(body, "lite");
    expect(typeof result.body.system).toBe("string");
    expect(result.body.system as string).toContain("You are helpful.");
    expect((result.body.system as string).startsWith("You are helpful.")).toBe(true);
    expect(result.body.system as string).toContain("<golem-brevity");
    expect(result.directiveTokens).toBeGreaterThan(0);
  });

  it("creates a system block when the request has none", () => {
    const result = applyBrevity({ model: "m" }, "ultra");
    expect(result.injected).toBe(true);
    expect(result.body.system as string).toContain('level="ultra"');
  });

  it("appends INTO the last text block, preserving its cache_control", () => {
    // Property 3 in the module doc: a NEW block after the client's breakpoint
    // would sit outside the cached prefix and be re-billed every turn.
    const body = {
      system: [
        { type: "text", text: "First." },
        { type: "text", text: "Cached preamble.", cache_control: { type: "ephemeral" } },
      ],
    };
    const result = applyBrevity(body, "full");
    const system = result.body.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2); // no block added
    expect(system[0]?.text).toBe("First."); // earlier blocks untouched
    expect(system[1]?.text as string).toContain("Cached preamble.");
    expect(system[1]?.text as string).toContain("<golem-brevity");
    expect(system[1]?.cache_control).toEqual({ type: "ephemeral" }); // breakpoint kept
  });

  it("adds a text block when the system array has none to extend", () => {
    const body = { system: [{ type: "image", source: { type: "url", url: "u" } }] };
    const result = applyBrevity(body, "lite");
    const system = result.body.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2);
    expect(system[1]?.type).toBe("text");
  });

  it("is idempotent — re-processing an already-injected body changes nothing", () => {
    const once = applyBrevity({ system: "S" }, "full");
    const twice = applyBrevity(once.body, "full");
    expect(twice.injected).toBe(false);
    expect(twice.body).toBe(once.body);
  });

  it("is idempotent across the array shape too", () => {
    const once = applyBrevity({ system: [{ type: "text", text: "S" }] }, "lite");
    const twice = applyBrevity(once.body, "lite");
    expect(twice.injected).toBe(false);
  });

  it("does not stack on top of a user's own Caveman install", () => {
    // Caveman's Claude Code hook activates its skill invisibly via a per-session
    // flag file (verification-notes §87), so the user may not know it is on.
    // Two stacked brevity directives is worse than none.
    const body = { system: "You are a helpful assistant.\n\nTalk like caveman. Brain big." };
    expect(applyBrevity(body, "ultra").injected).toBe(false);
    expect(hasExistingBrevityDirective("CAVEMAN mode")).toBe(true);
    expect(hasExistingBrevityDirective("ordinary system prompt")).toBe(false);
  });

  it("fails open on an unrecognised system shape rather than corrupting it", () => {
    for (const system of [42, true, { nested: "object" }]) {
      const body = { system };
      const result = applyBrevity(body, "full");
      expect(result.injected).toBe(false);
      expect(result.body).toBe(body);
      expect(result.body.system).toBe(system);
    }
  });

  it("produces byte-identical output across repeated calls at the same level", () => {
    // The prefix-stability requirement, stated end-to-end.
    const build = () => JSON.stringify(applyBrevity({ system: "S", messages: [] }, "full").body);
    expect(build()).toBe(build());
  });
});
