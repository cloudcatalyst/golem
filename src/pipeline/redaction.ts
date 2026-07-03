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

function applyRule(text: string, rule: RedactionRule, table: PlaceholderTable): [string, number] {
  let count = 0;
  // Rule patterns carry the `g` flag; replace walks matches left-to-right.
  const out = text.replace(rule.pattern, (match, ...args): string => {
    // Trailing replace() args are: ...groups, offset, whole, [namedGroups].
    // With group set, the captured substring is args[group-1].
    const target =
      rule.group === undefined ? match : ((args[rule.group - 1] as string | undefined) ?? "");
    if (target === "") {
      return match;
    }
    if (rule.validate !== undefined && !rule.validate(target)) {
      return match;
    }
    count += 1;
    const placeholder = table.placeholderFor(rule.id, target);
    // Group rules replace only the captured target inside the match.
    return rule.group === undefined ? placeholder : match.replace(target, placeholder);
  });
  return [out, count];
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
 * Redact one string with a shared placeholder table. Rules run in table
 * order, then the high-entropy sweep runs last so provider-specific rules win
 * the placeholder kind for any string both would match.
 */
export function redactText(text: string, table: PlaceholderTable): RedactionResult {
  let current = text;
  let total = 0;
  for (const rule of REDACTION_RULES) {
    const [next, count] = applyRule(current, rule, table);
    current = next;
    total += count;
  }
  const [afterEntropy, entropyCount] = applyEntropy(current, table);
  return { text: afterEntropy, count: total + entropyCount };
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
