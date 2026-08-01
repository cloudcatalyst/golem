/**
 * Contract tests for the frozen plugin surface (R8.11, ADR-0004).
 *
 * `src/interfaces/plugin.ts` is a promise to third-party code, so these assert
 * the properties the ADR says are structural — the ones that must hold because
 * of how the code is shaped, not because someone remembered to check:
 *
 *   1. seam A executes no plugin code (a supplied function is refused);
 *   2. a plugin cannot remove, replace or reorder a built-in redaction rule;
 *   3. a plugin cannot impersonate a built-in placeholder kind;
 *   4. redaction stays deterministic, and a non-deterministic rule is refused.
 *
 * If a change here is needed, the frozen contract is changing — flag every
 * dependent workstream in the PR (CLAUDE.md hard rule).
 */

import { describe, expect, it } from "vitest";
import { PLUGIN_SEAMS, type RedactionRuleDescriptor } from "../../src/interfaces/plugin.js";
import {
  clearPluginRedactionRules,
  installPluginRedactionRules,
  MAX_PLUGIN_MATCH_FRACTION,
  MIN_CAPPED_STRING_CHARS,
  pluginRedactionRules,
} from "../../src/pipeline/plugin-rules.js";
import { redactStandaloneText } from "../../src/pipeline/redaction.js";
import { compileRedactionRules, lintPattern } from "../../src/plugins/index.js";

/** A rule that catches a made-up org key format — the seam's motivating case. */
const BADGE_RULE: RedactionRuleDescriptor = {
  id: "badge-id",
  description: "ACME internal badge ids (BADGE- followed by 8 digits)",
  pattern: "BADGE-\\d{8}",
};

function install(descriptors: readonly RedactionRuleDescriptor[], plugin = "acme"): void {
  const compiled = compileRedactionRules(plugin, descriptors);
  installPluginRedactionRules(compiled.rules);
}

describe("plugin seams — the frozen list", () => {
  it("names exactly three seams, in the documented order", () => {
    expect(PLUGIN_SEAMS).toEqual(["redaction", "stage", "tool"]);
  });
});

describe("seam A — a plugin supplies data, never code (ADR-0004 §1)", () => {
  it("compiles a well-formed descriptor into a working rule", () => {
    const compiled = compileRedactionRules("acme", [BADGE_RULE]);
    expect(compiled.rejected).toEqual([]);
    expect(compiled.rules).toHaveLength(1);
  });

  it("REFUSES a descriptor that supplies a validate FUNCTION", () => {
    // The type forbids it; a plugin is untyped JavaScript at runtime, and this
    // is the one check standing between third-party code and unredacted text.
    let called = false;
    const hostile = {
      ...BADGE_RULE,
      validate: (): boolean => {
        called = true;
        return true;
      },
    } as unknown as RedactionRuleDescriptor;

    const compiled = compileRedactionRules("acme", [hostile]);
    expect(compiled.rules).toEqual([]);
    expect(compiled.rejected[0]?.reason).toMatch(/must NAME one of Golem's validators/);
    expect(called).toBe(false);
  });

  it("refuses an unknown validator name rather than ignoring it", () => {
    const compiled = compileRedactionRules("acme", [
      { ...BADGE_RULE, validate: "always-true" as never },
    ]);
    expect(compiled.rules).toEqual([]);
    expect(compiled.rejected[0]?.reason).toMatch(/unknown validator/);
  });

  it("accepts Golem's own validators by name", () => {
    const compiled = compileRedactionRules("acme", [
      { id: "card", description: "cards", pattern: "\\d{13,19}", validate: "credit-card" },
    ]);
    expect(compiled.rejected).toEqual([]);
    expect(compiled.rules).toHaveLength(1);
  });

  it("refuses g and d flags — those are Golem's to add, and applyRule depends on both", () => {
    const compiled = compileRedactionRules("acme", [{ ...BADGE_RULE, flags: ["g"] as never }]);
    expect(compiled.rejected[0]?.reason).toMatch(/not allowed/);
  });
});

describe("seam A — a plugin cannot weaken redaction (ADR-0004 §2)", () => {
  it("exposes no API that could remove, replace or reorder a built-in rule", async () => {
    // The guarantee is the ABSENCE of a mechanism (ADR-0004 §2), so assert the
    // module's exported surface rather than a behaviour — a future export named
    // `removeBuiltinRule` should fail this test on the day it is written.
    const surface = Object.keys(await import("../../src/pipeline/plugin-rules.js"));
    expect(surface.sort()).toEqual([
      "MAX_PLUGIN_MATCH_FRACTION",
      "MIN_CAPPED_STRING_CHARS",
      "clearPluginRedactionRules",
      "installPluginRedactionRules",
      "pluginRedactionRules",
      "pluginRuleTimings",
      "recordPluginRuleTime",
    ]);
    for (const name of surface) {
      expect(name).not.toMatch(/remove|replace|reorder|disable|unshift|splice/i);
    }
  });

  it("keeps every built-in rule working while plugin rules are installed", () => {
    clearPluginRedactionRules();
    const key = "AKIAIOSFODNN7EXAMPLE";
    const before = redactStandaloneText(`aws ${key}`);
    install([BADGE_RULE]);
    const after = redactStandaloneText(`aws ${key}`);
    expect(after).toBe(before);
    expect(after).not.toContain(key);
    clearPluginRedactionRules();
  });

  it("applies plugin rules AFTER the built-ins, so a built-in wins the placeholder kind", () => {
    clearPluginRedactionRules();
    // A greedy plugin rule that would also match an AWS key. The built-in must
    // still be the one that claims it.
    install([{ id: "greedy", description: "anything uppercase", pattern: "[A-Z0-9]{16,}" }]);
    const out = redactStandaloneText("aws AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("[REDACTED:aws-key:");
    expect(out).not.toContain("[REDACTED:acme/greedy:");
    clearPluginRedactionRules();
  });

  it("namespaces every plugin rule id, so a plugin cannot impersonate a built-in", () => {
    const compiled = compileRedactionRules("acme", [
      { id: "aws-key", description: "impersonation attempt", pattern: "NOPE-\\d+" },
    ]);
    expect(compiled.rules[0]?.id).toBe("acme/aws-key");
    installPluginRedactionRules(compiled.rules);
    expect(redactStandaloneText("NOPE-1")).toContain("[REDACTED:acme/aws-key:1]");
    clearPluginRedactionRules();
  });
});

describe("seam A — determinism, because prefix stability depends on it (§14)", () => {
  it("redacts the same input identically across passes", () => {
    clearPluginRedactionRules();
    install([BADGE_RULE]);
    const text = "badge BADGE-12345678 and BADGE-12345678 again, plus BADGE-87654321";
    expect(redactStandaloneText(text)).toBe(redactStandaloneText(text));
    // Per-VALUE numbering: the repeat reuses index 1, the distinct value gets 2.
    const out = redactStandaloneText(text);
    expect(out).toContain("[REDACTED:acme/badge-id:1]");
    expect(out).toContain("[REDACTED:acme/badge-id:2]");
    clearPluginRedactionRules();
  });

  it("is idempotent — redacting already-redacted text changes nothing", () => {
    clearPluginRedactionRules();
    install([BADGE_RULE]);
    const once = redactStandaloneText("BADGE-12345678");
    expect(redactStandaloneText(once)).toBe(once);
    clearPluginRedactionRules();
  });
});

describe("seam A — the load-time lint (ADR-0004 threat 4)", () => {
  it("rejects nested unbounded quantifiers", () => {
    expect(lintPattern("(a+)+b")).toMatch(/catastrophic backtracking/);
    expect(lintPattern("(\\d*)*x")).toMatch(/catastrophic backtracking/);
    expect(lintPattern("(?:x+)+y")).toMatch(/catastrophic backtracking/);
    expect(lintPattern("(a+){2,}")).toMatch(/catastrophic backtracking/);
  });

  it("rejects a quantified alternation of identical branches", () => {
    expect(lintPattern("(a|a)*")).toMatch(/catastrophic backtracking/);
  });

  it("rejects an over-long pattern, because an unreviewable rule is a defect", () => {
    expect(lintPattern("a".repeat(500))).toMatch(/over the .* cap/);
  });

  it("passes the ordinary patterns a real org rule is made of", () => {
    expect(lintPattern("BADGE-\\d{8}")).toBeNull();
    expect(lintPattern("acme_(?:live|test)_[A-Za-z0-9]{24}")).toBeNull();
    expect(lintPattern("\\bINT-[0-9]{4}-[A-Z]{3}\\b")).toBeNull();
  });
});

describe("seam A — the over-redaction cap (ADR-0004 threat 5)", () => {
  it("drops the plugin contribution for a long string it would swallow, keeping the built-ins", () => {
    clearPluginRedactionRules();
    install([{ id: "everything", description: "matches the whole world", pattern: "[a-z ]+" }]);
    const text = "the quick brown fox jumps over the lazy dog ".repeat(10);
    expect(text.length).toBeGreaterThan(MIN_CAPPED_STRING_CHARS);
    expect(redactStandaloneText(text)).toBe(text);
    clearPluginRedactionRules();
  });

  it("does NOT cap a short string that is entirely a secret — that is the seam working", () => {
    clearPluginRedactionRules();
    install([BADGE_RULE]);
    expect(redactStandaloneText("BADGE-12345678")).toBe("[REDACTED:acme/badge-id:1]");
    clearPluginRedactionRules();
  });

  it("still applies a rule whose effect is under the cap in a long string", () => {
    clearPluginRedactionRules();
    install([BADGE_RULE]);
    const text = `a badge BADGE-12345678 among ${"plenty of other perfectly ordinary words ".repeat(6)}`;
    expect(text.length).toBeGreaterThan(MIN_CAPPED_STRING_CHARS);
    expect(redactStandaloneText(text)).toContain("[REDACTED:acme/badge-id:1]");
    clearPluginRedactionRules();
  });

  it("measures MATCHED characters, not the length change (a placeholder is longer than its secret)", () => {
    clearPluginRedactionRules();
    // Three badge ids in a mostly-badge string: the replacement GROWS the text,
    // which the original length-delta cap misread as over-redaction.
    install([BADGE_RULE]);
    const text = "badge BADGE-12345678 and BADGE-12345678 again, plus BADGE-87654321";
    const out = redactStandaloneText(text);
    expect(out.length).toBeGreaterThan(text.length);
    expect(out).toContain("[REDACTED:acme/badge-id:1]");
    expect(out).toContain("[REDACTED:acme/badge-id:2]");
    clearPluginRedactionRules();
  });

  it("states the cap as a fraction, so the rule is reviewable", () => {
    expect(MAX_PLUGIN_MATCH_FRACTION).toBeGreaterThan(0);
    expect(MAX_PLUGIN_MATCH_FRACTION).toBeLessThanOrEqual(1);
  });
});

describe("seam A — the default is nothing", () => {
  it("installs no rules until asked, and clearing restores that", () => {
    clearPluginRedactionRules();
    expect(pluginRedactionRules()).toEqual([]);
    install([BADGE_RULE]);
    expect(pluginRedactionRules()).toHaveLength(1);
    clearPluginRedactionRules();
    expect(pluginRedactionRules()).toEqual([]);
  });
});
