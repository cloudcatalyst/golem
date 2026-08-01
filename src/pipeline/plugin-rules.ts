/**
 * R8.11 seam A, the installation point — where plugin redaction rules live and
 * the ONLY way they reach the redaction stage (ADR-0004 §2).
 *
 * ## Why this is a separate list rather than an entry in REDACTION_RULES
 *
 * `REDACTION_RULES` is a frozen module const and stays one. Plugin rules are
 * appended here, and `redactText` applies the built-in table, then this list,
 * then the high-entropy sweep. The ordering property the built-ins already
 * document therefore survives unchanged: provider-specific built-ins win the
 * placeholder kind for anything two rules both match.
 *
 * The CLAUDE.md hard rule ("never weaken the redaction stage") is enforced by
 * the shape of this module, not by a check inside it: there is **no function
 * here that removes, replaces, reorders or disables a built-in rule.** A plugin
 * can only ever add. That is why the API is `install`/`clear` over a private
 * list and not a mutable exported array.
 *
 * ## Module-level state, and why it does not break purity
 *
 * The installed list is process-global and written exactly once, at startup,
 * before the proxy accepts a request (`clear` exists for tests). Redaction
 * stays a pure function of (text, installed rules) for the entire life of the
 * process, so prefix stability — and every prompt-cache hit that depends on it
 * (verification-notes §14) — is preserved.
 */

import type { RedactionRule } from "./redaction-rules.js";

/**
 * If plugin rules match more than this fraction of a string's characters, their
 * whole contribution is dropped **for that string** and the built-ins alone
 * apply (ADR-0004 threat 5). A rule consuming essentially everything is
 * over-redacting: it destroys the request rather than protecting it.
 *
 * Measured as **matched input characters**, not as a length change. A
 * placeholder is usually longer than the secret it replaces, so a greedy rule
 * can grow the string while a total swallow can leave its length alone — the
 * first version of this cap used length and got both cases wrong, which is why
 * `applyRule` now reports matched characters.
 *
 * Set high on purpose. A string that IS a secret (one API key in one message) is
 * a legitimate 100% match, and clamping that would break the seam's main use.
 * The cap exists for the rule that eats prose, so it fires only when a string is
 * both long enough to be content ({@link MIN_CAPPED_STRING_CHARS}) and almost
 * entirely consumed.
 *
 * Evaluated against the single string being redacted, using only that string —
 * no cross-request state, so the stage stays a pure function and the same input
 * always produces the same output.
 */
export const MAX_PLUGIN_MATCH_FRACTION = 0.9;

/**
 * Strings shorter than this are never capped: a short string that a plugin rule
 * matches entirely is the seam working, not failing.
 */
export const MIN_CAPPED_STRING_CHARS = 200;

/** Per-rule cost, so `golem plugin list` can report a slow rule (ADR-0004 threat 4). */
export interface PluginRuleTiming {
  /** How many strings this rule has been applied to. */
  readonly applications: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

let installed: readonly RedactionRule[] = [];
const timings = new Map<string, { applications: number; totalMs: number; maxMs: number }>();

/**
 * Install the compiled plugin rules. Called once by the loader at startup.
 * Replaces any previous set wholesale — there is deliberately no incremental
 * add, so the installed set is always exactly what the loader resolved.
 */
export function installPluginRedactionRules(rules: readonly RedactionRule[]): void {
  installed = rules;
}

/** The installed plugin rules, in application order. Empty by default. */
export function pluginRedactionRules(): readonly RedactionRule[] {
  return installed;
}

/** Drop every installed rule and its timings. For tests and `golem plugin` reloads. */
export function clearPluginRedactionRules(): void {
  installed = [];
  timings.clear();
}

/** Record one rule application's elapsed time. */
export function recordPluginRuleTime(id: string, ms: number): void {
  const current = timings.get(id);
  if (current === undefined) {
    timings.set(id, { applications: 1, totalMs: ms, maxMs: ms });
    return;
  }
  current.applications += 1;
  current.totalMs += ms;
  if (ms > current.maxMs) current.maxMs = ms;
}

/** Measured cost per plugin rule so far this process. */
export function pluginRuleTimings(): ReadonlyMap<string, PluginRuleTiming> {
  return new Map(timings);
}
