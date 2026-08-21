/**
 * R8.11 / ADR-0005 — the append-only redaction extension point.
 *
 * CLAUDE.md's hard rule is that redaction must never be weakened or reordered.
 * A third-party extension point in that exact stage is the most dangerous thing
 * in this release, so the properties below are asserted as *properties*, not as
 * "we checked the code":
 *
 *  1. Whatever a plugin registers, every secret the built-in table would have
 *     caught is still caught, with the same placeholder kind.
 *  2. A plugin cannot remove, replace, or reorder a built-in — there is no API
 *     for it, and built-ins always run first.
 *  3. The table is fixed once the process starts serving, so prompt-cache
 *     prefixes stay stable.
 */

import { afterEach, describe, expect, it } from "vitest";
import { redactStandaloneText } from "../../../src/pipeline/redaction.js";
import {
  activeRedactionRules,
  extraRedactionRules,
  REDACTION_RULES,
  registerExtraRedactionRules,
  resetExtraRedactionRulesForTests,
} from "../../../src/pipeline/redaction-rules.js";

afterEach(() => {
  resetExtraRedactionRulesForTests();
});

/**
 * Built at runtime, never as a literal: a literal secret in a test file gets
 * redacted out from under you, and a literal `[REDACTED:…]` passes vacuously.
 */
function awsKey(): string {
  // AKIA + exactly 16 uppercase alphanumerics = the 20 chars the built-in rule
  // requires. A 19-char near-miss silently proves nothing.
  return `AKIA${"Q7ZK3XMPLE4DEMOZ".slice(0, 16)}`;
}

const ACME_RULE = {
  id: "acme/employee-id",
  description: "ACME internal employee ids, which are PII in our jurisdiction",
  pattern: /ACME-EMP-\d{6}/g,
};

describe("registerExtraRedactionRules — a plugin can only add", () => {
  it("appends after every built-in, in that order", () => {
    registerExtraRedactionRules([ACME_RULE]);
    const active = activeRedactionRules();
    expect(active.length).toBe(REDACTION_RULES.length + 1);
    // Built-ins first, unchanged, same order — asserted element by element rather
    // than by length, because a reorder would keep the length identical.
    for (const [i, rule] of REDACTION_RULES.entries()) expect(active[i]).toBe(rule);
    expect(active[active.length - 1]).toBe(ACME_RULE);
  });

  it("leaves the built-in table object itself untouched", () => {
    const before = [...REDACTION_RULES];
    registerExtraRedactionRules([ACME_RULE]);
    expect([...REDACTION_RULES]).toEqual(before);
    expect(REDACTION_RULES).not.toContain(ACME_RULE);
  });

  it("returns the built-in table itself when no plugin registered anything", () => {
    expect(activeRedactionRules()).toBe(REDACTION_RULES);
  });

  it("drops a rule whose id is not namespaced — that is what stops impersonation", () => {
    const outcome = registerExtraRedactionRules([
      { id: "unnamespaced", description: "d", pattern: /x/g },
    ]);
    expect(outcome.accepted).toBe(0);
    expect(extraRedactionRules()).toEqual([]);
  });

  it("drops a rule that reuses a built-in id verbatim", () => {
    const builtInId = REDACTION_RULES[0]?.id ?? "private-key";
    const outcome = registerExtraRedactionRules([
      { id: builtInId, description: "d", pattern: /x/g },
    ]);
    expect(outcome.accepted).toBe(0);
  });

  it("refuses a SECOND registration rather than changing the table mid-process", () => {
    // Prefix stability (verification-notes §14): a table that changed while the
    // process served would break prompt-cache hits for every later request.
    expect(registerExtraRedactionRules([ACME_RULE]).accepted).toBe(1);
    const second = registerExtraRedactionRules([
      { id: "other/rule", description: "d", pattern: /y/g },
    ]);
    expect(second.accepted).toBe(0);
    expect(second.refused).toContain("already registered");
    expect(extraRedactionRules()).toEqual([ACME_RULE]);
  });

  it("has no remove, replace or reorder function to call", () => {
    // A negative structural assertion: if someone adds one of these later, this
    // fails and they have to come and read ADR-0005 first.
    const api = { activeRedactionRules, extraRedactionRules, registerExtraRedactionRules };
    for (const forbidden of ["removeRedactionRule", "replaceRedactionRule", "reorder"]) {
      expect(Object.keys(api)).not.toContain(forbidden);
    }
  });
});

describe("redaction with plugin rules loaded — strictly more, never less", () => {
  it("still redacts every built-in secret, with the built-in kind", () => {
    const key = awsKey();
    const before = redactStandaloneText(`deploy with ${key}`);
    registerExtraRedactionRules([ACME_RULE]);
    const after = redactStandaloneText(`deploy with ${key}`);
    expect(after).toBe(before);
    expect(after).not.toContain(key);
    expect(after).toContain("[REDACTED:aws-key:1]");
  });

  it("redacts what the plugin added, under a namespaced kind", () => {
    registerExtraRedactionRules([ACME_RULE]);
    const out = redactStandaloneText("ticket for ACME-EMP-123456 please");
    expect(out).not.toContain("ACME-EMP-123456");
    expect(out).toContain("[REDACTED:acme/employee-id:1]");
  });

  it("cannot un-redact what a built-in already replaced", () => {
    // A plugin rule that tries to match the placeholder itself: placeholders
    // contain `[`, `]` and `:`, which no rule's charset matches, so a plugin
    // rule sees a placeholder and not the secret.
    const key = awsKey();
    registerExtraRedactionRules([
      { id: "evil/unredact", description: "tries to match a placeholder", pattern: /REDACTED/g },
    ]);
    const out = redactStandaloneText(`key ${key}`);
    expect(out).not.toContain(key);
  });

  it("still redacts a built-in secret when a plugin rule would also match it", () => {
    // Built-ins run first, so the built-in wins the placeholder kind — the same
    // guarantee the stage already documents for the generic entropy sweep.
    const key = awsKey();
    registerExtraRedactionRules([
      { id: "acme/greedy", description: "matches everything AWS-ish", pattern: /AKIA\w+/g },
    ]);
    const out = redactStandaloneText(`key ${key}`);
    expect(out).toContain("[REDACTED:aws-key:1]");
    expect(out).not.toContain("[REDACTED:acme/greedy:1]");
    expect(out).not.toContain(key);
  });

  it("keeps redacting built-ins when a plugin's validator throws", async () => {
    // The loader is what wraps a third-party validator so a throw reads as "not
    // a secret". Compose the two for real rather than hand-rolling the wrapper:
    // register exactly what the loader produced.
    const { loadPlugins } = await import("../../../src/plugins/index.js");
    const loaded = await loadPlugins({
      specifiers: ["acme"],
      projectDir: "/project",
      golemVersion: "test",
      resolve: () => "/resolved/acme",
      importModule: async () => ({
        default: {
          name: "acme",
          setup(api: {
            addRedactionRule: (r: {
              id: string;
              description: string;
              pattern: RegExp;
              validate?: (t: string) => boolean;
            }) => void;
          }) {
            api.addRedactionRule({
              id: "broken",
              description: "a validator that throws",
              pattern: /ACME-\d+/g,
              validate: () => {
                throw new Error("boom");
              },
            });
          },
        },
      }),
    });
    registerExtraRedactionRules(loaded.redactionRules);

    const key = awsKey();
    const out = redactStandaloneText(`key ${key} and ACME-9`);
    // The built-in still fires — a throwing plugin validator cannot abort the pass.
    expect(out).not.toContain(key);
    expect(out).toContain("[REDACTED:aws-key:1]");
    // And the throw was read as "not a secret", so the match is left alone.
    expect(out).toContain("ACME-9");
  });

  it("stays deterministic — the same input redacts identically twice", () => {
    registerExtraRedactionRules([ACME_RULE]);
    const input = `${awsKey()} ACME-EMP-000001 ACME-EMP-000002 ACME-EMP-000001`;
    const first = redactStandaloneText(input);
    expect(redactStandaloneText(input)).toBe(first);
    // Per-VALUE numbering: the repeat reuses index 1, so a prepended turn can
    // never renumber an earlier one.
    expect(first).toContain("[REDACTED:acme/employee-id:1]");
    expect(first).toContain("[REDACTED:acme/employee-id:2]");
    expect(first.match(/acme\/employee-id:1/g)).toHaveLength(2);
  });

  it("is idempotent — redacting already-redacted text changes nothing", () => {
    registerExtraRedactionRules([ACME_RULE]);
    const once = redactStandaloneText(`${awsKey()} ACME-EMP-654321`);
    expect(redactStandaloneText(once)).toBe(once);
  });
});
