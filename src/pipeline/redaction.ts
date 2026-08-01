/**
 * WS-A A3 — the redaction stage: strip secrets/PII from request content
 * BEFORE anything is transformed, stored, or forwarded (CLAUDE.md hard rule).
 *
 * ## Determinism & prefix stability (verification-notes §14)
 * Redaction MUST be a pure function of the input text: same input prefix ->
 * same output prefix, forever. If it were not, prompt-cache hits would break
 * on every request. Two design choices enforce this:
 *
 *  1. Placeholder numbering is per-VALUE, not per-occurrence. Each distinct
 *     secret string maps to a stable index the first time it is seen within a
 *     single redaction pass, counted per placeholder kind; repeats of the
 *     same secret reuse the same placeholder. Because messages are redacted
 *     in order, prepending later turns can never renumber an earlier one.
 *  2. No clock, randomness, or config feeds a placeholder — only the rule id
 *     and the running per-kind counter.
 *
 * Placeholders look like `[REDACTED:aws-key:1]`. The brackets/colon are
 * outside every rule's charset and the entropy candidate charset, so the
 * stage is idempotent: redacting already-redacted text is a no-op.
 *
 * The stage reports a TokenDelta so telemetry (A4) can attribute how much a
 * request was reduced by redaction (usually a small increase — placeholders
 * are longer than short keys — but never a fidelity risk).
 */

import { estimateTokens } from "../compression/index.js";
import type { TokenDelta } from "../interfaces/compression.js";
import {
  MAX_PLUGIN_MATCH_FRACTION,
  MIN_CAPPED_STRING_CHARS,
  pluginRedactionRules,
  recordPluginRuleTime,
} from "./plugin-rules.js";
import {
  ENTROPY_CANDIDATE_RE,
  ENTROPY_RULE_ID,
  isHighEntropyToken,
  REDACTION_RULES,
  type RedactionRule,
} from "./redaction-rules.js";

/** Outcome of redacting one string. */
export interface RedactionResult {
  readonly text: string;
  /** Number of individual secret occurrences replaced. */
  readonly count: number;
}

/**
 * Per-pass placeholder allocator. Assigns each distinct (kind, value) a
 * stable 1-based index within the pass, so the same secret always renders the
 * same placeholder and re-numbering is impossible for a fixed input.
 */
class PlaceholderTable {
  /** kind -> (secret value -> index) */
  readonly #byKind = new Map<string, Map<string, number>>();

  placeholderFor(kind: string, value: string): string {
    let values = this.#byKind.get(kind);
    if (values === undefined) {
      values = new Map();
      this.#byKind.set(kind, values);
    }
    let index = values.get(value);
    if (index === undefined) {
      index = values.size + 1;
      values.set(value, index);
    }
    return `[REDACTED:${kind}:${index}]`;
  }
}

/**
 * Apply one rule. Returns the new text, the number of occurrences replaced, and
 * the number of INPUT characters those occurrences covered.
 *
 * The third figure exists for the R8.11 plugin cap: "how much of this string did
 * the rule consume" cannot be read off the length change, because a placeholder
 * is usually longer than the secret it replaces (so a greedy rule can *grow* the
 * string) and can also be about the same length (so a rule that swallows
 * everything can leave the length alone). Counting matched input characters is
 * the only measure that answers the question asked.
 */
function applyRule(
  text: string,
  rule: RedactionRule,
  table: PlaceholderTable,
): [string, number, number] {
  // Redact by the EXACT matched span (whole match, or the captured group at its
  // real index) — never by first-substring replace, which can hit the wrong
  // occurrence and leak the actual secret (T-C3, verification-notes §24). The
  // `d` flag gives per-group start/end indices so a group rule redacts precisely
  // the captured range and leaves the rest of the match (e.g. the host in a
  // connection string) untouched.
  const flags = rule.pattern.flags.includes("d") ? rule.pattern.flags : `${rule.pattern.flags}d`;
  const re = new RegExp(rule.pattern.source, flags);

  let count = 0;
  let matchedChars = 0;
  let result = "";
  let cursor = 0;
  for (const m of text.matchAll(re)) {
    const whole = m[0];
    const matchStart = m.index ?? 0;
    let redactStart = matchStart;
    let redactEnd = matchStart + whole.length;
    let target = whole;

    if (rule.group !== undefined) {
      const span = m.indices?.[rule.group];
      const value = m[rule.group];
      if (span === undefined || value === undefined || value === "") {
        continue; // no captured group → leave this match as-is
      }
      [redactStart, redactEnd] = span;
      target = value;
    }
    if (rule.validate !== undefined && !rule.validate(target)) {
      continue; // failed the extra check (e.g. Luhn) → not a secret, leave it
    }

    result += text.slice(cursor, redactStart);
    result += table.placeholderFor(rule.id, target);
    matchedChars += redactEnd - redactStart;
    cursor = redactEnd;
    count += 1;
  }
  result += text.slice(cursor);
  return [result, count, matchedChars];
}

function applyEntropy(text: string, table: PlaceholderTable): [string, number] {
  let count = 0;
  const out = text.replace(ENTROPY_CANDIDATE_RE, (match: string): string => {
    if (!isHighEntropyToken(match)) {
      return match;
    }
    count += 1;
    return table.placeholderFor(ENTROPY_RULE_ID, match);
  });
  return [out, count];
}

/**
 * R8.11 seam A — apply the installed plugin rules (ADR-0004 §2), between the
 * built-in table and the entropy sweep. Two properties are enforced here:
 *
 *  - **Over-redaction cap** (threat 5): if the plugin rules matched more than
 *    {@link MAX_PLUGIN_MATCH_FRACTION} of a long-enough string's characters,
 *    their whole contribution is discarded for this string and the built-in
 *    result stands. Judged from this string alone, so the stage stays pure and
 *    prefix-stable — no cross-request state can make the same input redact
 *    differently on a later pass.
 *  - **Cost measurement** (threat 4): elapsed time per rule is recorded so a
 *    pathological pattern is at least *visible* in `golem plugin list`. It is
 *    measured after the fact; Node cannot interrupt a regex mid-run, and the
 *    ADR accepts that residual risk rather than implying it is closed.
 *
 * A no-op when nothing is installed, which is the shipped default.
 */
function applyPluginRules(text: string, table: PlaceholderTable): [string, number] {
  const rules = pluginRedactionRules();
  if (rules.length === 0) {
    return [text, 0];
  }
  let current = text;
  let total = 0;
  let matched = 0;
  for (const rule of rules) {
    const started = performance.now();
    const [next, count, matchedChars] = applyRule(current, rule, table);
    recordPluginRuleTime(rule.id, performance.now() - started);
    current = next;
    total += count;
    matched += matchedChars;
  }
  if (text.length >= MIN_CAPPED_STRING_CHARS && matched > text.length * MAX_PLUGIN_MATCH_FRACTION) {
    return [text, 0];
  }
  return [current, total];
}

/**
 * Redact one string with a shared placeholder table. Rules run in table
 * order, then the installed plugin rules (R8.11 seam A — appended, never
 * interleaved), then the high-entropy sweep last, so built-in provider rules
 * win the placeholder kind for any string more than one rule matches.
 */
export function redactText(text: string, table: PlaceholderTable): RedactionResult {
  let current = text;
  let total = 0;
  for (const rule of REDACTION_RULES) {
    const [next, count] = applyRule(current, rule, table);
    current = next;
    total += count;
  }
  const [afterPlugins, pluginCount] = applyPluginRules(current, table);
  current = afterPlugins;
  total += pluginCount;
  const [afterEntropy, entropyCount] = applyEntropy(current, table);
  return { text: afterEntropy, count: total + entropyCount };
}

/**
 * Redact a single, standalone string with its own fresh placeholder table:
 * the full {@link REDACTION_RULES} table plus the high-entropy sweep, as a
 * pure `(text) => text` function. Convenience entry point for callers that
 * redact one independent string at a time (e.g. the PostToolUse hook's
 * tool-output text, T-C3) and don't need placeholders shared across multiple
 * strings the way {@link redactRequestBody} shares one table across a whole
 * request body. Allocating a fresh table per call keeps this pure and
 * deterministic — no state survives between calls.
 */
export function redactStandaloneText(text: string): string {
  return redactText(text, new PlaceholderTable()).text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively redact every string in a JSON value, sharing one placeholder
 * table across the whole request so the same secret gets the same placeholder
 * everywhere it appears. Object key order is preserved (spread keeps existing
 * keys in place) so re-serialization stays byte-stable.
 */
function redactValue(value: unknown, table: PlaceholderTable, stats: { count: number }): unknown {
  if (typeof value === "string") {
    const result = redactText(value, table);
    stats.count += result.count;
    return result.count === 0 ? value : result.text;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = redactValue(item, table, stats);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (isRecord(value)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const next = redactValue(v, table, stats);
      if (next !== v) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  }
  return value;
}

export interface RedactBodyResult {
  /** The request body with secrets replaced (same object identity if none). */
  readonly value: unknown;
  /** Occurrences replaced across the whole body. */
  readonly count: number;
  /** Token estimate before/after redaction (for telemetry attribution). */
  readonly delta: TokenDelta;
}

/**
 * Redact a parsed request body in place-preserving fashion. Runs over the
 * ENTIRE JSON (system prompt, every message, tool definitions, tool_result
 * content) — a secret anywhere must be stripped before it leaves the machine
 * or is handed to compression's CCR store.
 */
export function redactRequestBody(body: unknown): RedactBodyResult {
  const table = new PlaceholderTable();
  const stats = { count: 0 };
  const tokensBefore = estimateTokens(JSON.stringify(body) ?? "");
  const value = redactValue(body, table, stats);
  const tokensAfter =
    stats.count === 0 ? tokensBefore : estimateTokens(JSON.stringify(value) ?? "");
  return { value, count: stats.count, delta: { tokensBefore, tokensAfter } };
}
