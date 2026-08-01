/**
 * R8.11 seam A — compile a plugin's declarative redaction rules (ADR-0004 §1).
 *
 * A plugin supplies {@link RedactionRuleDescriptor} **data**; this module turns
 * it into Golem's internal {@link RedactionRule} and is the only place that
 * conversion happens. The conversion is where the ADR's guarantees are actually
 * enforced, so each one is a named check below rather than a comment:
 *
 *  - **No third-party code reaches unredacted text.** `pattern` is a string we
 *    compile; `validate` is a NAME resolved against {@link VALIDATORS}, Golem's
 *    own pure functions. A descriptor carrying a function is rejected — the
 *    type says it cannot, but a plugin is untyped JavaScript at runtime.
 *  - **A plugin cannot impersonate a built-in.** Every id is namespaced to
 *    `<plugin>/<id>`, so placeholders read `[REDACTED:acme/badge-id:1]` and no
 *    plugin rule can claim `aws-key` or `high-entropy`.
 *  - **Determinism** (verification-notes §14 — prefix stability, and therefore
 *    every prompt-cache hit): the compiled rule is a pure regex plus a pure
 *    Golem validator. {@link probeDeterminism} additionally applies each rule
 *    twice to a fixed corpus and rejects it if the two passes differ.
 *  - **Backtracking** (ADR-0004 threat 4, the knowingly-incomplete one): a
 *    static lint rejects the shapes that blow up, and the caller measures
 *    elapsed time per rule. Node cannot interrupt a running regex, so a lint is
 *    all a load-time check can be — see {@link lintPattern}'s note.
 *
 * Every rejection is a no-op with a reason, never a throw: a bad rule is
 * dropped and reported, and redaction proceeds with the rules that passed.
 */

import type { PluginValidatorName, RedactionRuleDescriptor } from "../interfaces/plugin.js";
import {
  isCreditCardLike,
  isHighEntropyToken,
  luhnValid,
  type RedactionRule,
} from "../pipeline/redaction-rules.js";

/**
 * The named validators a descriptor may select. Golem's own functions, reached
 * by name — this table is the reason seam A needs no sandbox.
 */
const VALIDATORS: Readonly<Record<PluginValidatorName, (target: string) => boolean>> = {
  luhn: luhnValid,
  "credit-card": isCreditCardLike,
  "high-entropy": isHighEntropyToken,
};

/** Flags a plugin may ask for. `g` and `d` are Golem's to add (redaction.ts relies on both). */
const ALLOWED_FLAGS = new Set(["i", "m", "s", "u"]);

/**
 * Cap on `pattern` length. Long patterns are not inherently dangerous, but they
 * are unreviewable, and an unreviewable pattern in the redaction path is a
 * defect waiting for someone else's incident.
 */
export const MAX_PATTERN_CHARS = 400;

/** A rule that failed a check, with the reason `golem plugin list` prints. */
export interface RejectedRule {
  readonly id: string;
  readonly reason: string;
}

export interface CompiledRules {
  readonly rules: readonly RedactionRule[];
  readonly rejected: readonly RejectedRule[];
}

/**
 * Static backtracking lint. Catches the classic catastrophic shapes — a
 * quantified group whose body is itself unboundedly quantified, `(a+)+`,
 * `(a*)*`, `(a|a)*` — which is where real ReDoS lives.
 *
 * **This is a lint, not a guarantee.** Deciding whether an arbitrary regex
 * backtracks catastrophically is not something a pattern-matcher can settle,
 * and Node offers no way to time-limit a regex once it is running. ADR-0004
 * threat 4 accepts the residual risk explicitly and names the real fix (an
 * out-of-process host) as not-built. Do not let this function's existence read
 * as safety.
 *
 * Returns a reason string when the pattern is rejected, `null` when it passes.
 */
export function lintPattern(pattern: string): string | null {
  if (pattern.length === 0) {
    return "pattern is empty";
  }
  if (pattern.length > MAX_PATTERN_CHARS) {
    return `pattern is ${pattern.length} chars, over the ${MAX_PATTERN_CHARS} cap`;
  }
  // A group closed by `)` and immediately quantified, whose body contains its
  // own unbounded quantifier: (a+)+, (a*)*, (\d+)*, (?:x+)+ …
  if (/\([^()]*[+*][^()]*\)\s*[+*]/.test(pattern)) {
    return "nested unbounded quantifier — catastrophic backtracking risk";
  }
  // An alternation of the same shape under a quantifier: (a|a)*, (\d|\d)+
  if (/\((?:\?:)?([^()|]+)\|\1\)\s*[+*]/.test(pattern)) {
    return "quantified alternation of identical branches — catastrophic backtracking risk";
  }
  // {n,} on a group is the same hazard written differently.
  if (/\([^()]*[+*][^()]*\)\s*\{\d+,\}/.test(pattern)) {
    return "nested unbounded quantifier via {n,} — catastrophic backtracking risk";
  }
  return null;
}

/**
 * Text the determinism probe runs every rule against. Deliberately mixed: the
 * point is to execute the rule twice on identical input, so the content only
 * needs to be varied enough that most rules match something.
 */
const PROBE_CORPUS =
  "user=admin token=sk-ABCDEF0123456789 card 4111 1111 1111 1111 " +
  "path=/var/tmp/x.log url=https://example.test/a?b=c 2026-08-01T00:00:00Z " +
  'AKIAIOSFODNN7EXAMPLE {"k":"v"} 192.168.0.1 +44 7700 900123 ';

/**
 * Apply `rule` to the probe corpus twice and report whether the two passes
 * agree. A rule reaching for a clock, `Math.random`, `lastIndex` state, or any
 * other impurity fails here — and impurity in the redaction stage does not
 * merely produce odd output, it breaks prefix stability and with it every
 * prompt-cache hit for the session (§14).
 */
export function probeDeterminism(rule: RedactionRule): boolean {
  const run = (): string => {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    const out: string[] = [];
    for (const m of PROBE_CORPUS.matchAll(re)) {
      const target = rule.group !== undefined ? m[rule.group] : m[0];
      if (target === undefined) continue;
      out.push(`${m.index ?? -1}:${target}:${rule.validate?.(target) ?? true}`);
    }
    return out.join("|");
  };
  try {
    // Two separate passes over identical input — not a self-comparison. The
    // whole point is that a pure rule must produce the same string twice.
    const first = run();
    const second = run();
    return first === second;
  } catch {
    return false;
  }
}

function isPlainDescriptor(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate and compile one descriptor. Returns the rule, or a reason string.
 *
 * `pluginName` namespaces the id. The input is typed as
 * {@link RedactionRuleDescriptor} for authors' benefit but treated as `unknown`
 * here — it arrives from a package Golem did not compile.
 */
function compileOne(
  pluginName: string,
  descriptor: RedactionRuleDescriptor,
): { rule: RedactionRule } | { reason: string } {
  if (!isPlainDescriptor(descriptor)) {
    return { reason: "not an object" };
  }
  const { id, description, pattern, flags, group, validate } = descriptor as Record<
    string,
    unknown
  >;

  if (typeof id !== "string" || id.length === 0) {
    return { reason: "missing `id`" };
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    return { reason: `id "${id}" must be lower-kebab-case` };
  }
  if (typeof description !== "string" || description.length === 0) {
    return {
      reason: "missing `description` — an unexplained rule in the redaction path is a defect",
    };
  }
  if (typeof pattern !== "string") {
    return {
      reason: "`pattern` must be a string — Golem compiles it, a plugin never supplies a RegExp",
    };
  }

  const lint = lintPattern(pattern);
  if (lint !== null) {
    return { reason: lint };
  }

  let extraFlags = "";
  if (flags !== undefined) {
    if (!Array.isArray(flags)) {
      return { reason: "`flags` must be an array" };
    }
    for (const flag of flags) {
      if (typeof flag !== "string" || !ALLOWED_FLAGS.has(flag)) {
        return { reason: `flag "${String(flag)}" is not allowed (i, m, s, u only)` };
      }
      if (!extraFlags.includes(flag)) extraFlags += flag;
    }
  }

  if (group !== undefined && (typeof group !== "number" || !Number.isInteger(group) || group < 1)) {
    return { reason: "`group` must be a positive integer" };
  }

  // The check the type system cannot make: a plugin is untyped at runtime, and
  // a function here would be third-party code running on unredacted text —
  // exactly what ADR-0004 §1 exists to prevent.
  if (typeof validate === "function") {
    return {
      reason: "`validate` must NAME one of Golem's validators, not supply a function (ADR-0004 §1)",
    };
  }
  let validator: ((target: string) => boolean) | undefined;
  if (validate !== undefined) {
    if (typeof validate !== "string" || !(validate in VALIDATORS)) {
      return {
        reason: `unknown validator "${String(validate)}" — expected ${Object.keys(VALIDATORS).join(", ")}`,
      };
    }
    validator = VALIDATORS[validate as PluginValidatorName];
  }

  let compiled: RegExp;
  try {
    // `g` so every occurrence is replaced, `d` so a group rule redacts the
    // captured span precisely — both are required by applyRule() and are
    // therefore Golem's to add, never the plugin's to choose.
    compiled = new RegExp(pattern, `gd${extraFlags}`);
  } catch (error) {
    return {
      reason: `pattern does not compile: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const rule: RedactionRule = {
    id: `${pluginName}/${id}`,
    description,
    pattern: compiled,
    ...(group !== undefined ? { group } : {}),
    ...(validator !== undefined ? { validate: validator } : {}),
  };

  if (!probeDeterminism(rule)) {
    return { reason: "rule is not deterministic — two identical passes produced different output" };
  }
  return { rule };
}

/**
 * Compile every descriptor a plugin offers. Bad rules are dropped with a
 * reason; good ones are returned. Never throws — a plugin cannot break
 * redaction by shipping nonsense, it can only fail to extend it.
 */
export function compileRedactionRules(
  pluginName: string,
  descriptors: readonly RedactionRuleDescriptor[],
): CompiledRules {
  const rules: RedactionRule[] = [];
  const rejected: RejectedRule[] = [];
  const seen = new Set<string>();

  for (const [index, descriptor] of descriptors.entries()) {
    const outcome = compileOne(pluginName, descriptor);
    if ("reason" in outcome) {
      const id =
        isPlainDescriptor(descriptor) && typeof descriptor.id === "string"
          ? `${pluginName}/${descriptor.id}`
          : `${pluginName}/#${index}`;
      rejected.push({ id, reason: outcome.reason });
      continue;
    }
    if (seen.has(outcome.rule.id)) {
      rejected.push({ id: outcome.rule.id, reason: "duplicate id within the same plugin" });
      continue;
    }
    seen.add(outcome.rule.id);
    rules.push(outcome.rule);
  }
  return { rules, rejected };
}
