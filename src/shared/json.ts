/**
 * Leaf helpers for walking untyped JSON.
 *
 * **Deliberately dependency-free.** This module is imported from the pipeline,
 * the compression stages, the config layer and the per-prompt statusline path,
 * so it must never pull anything into a caller's module graph — no barrels, no
 * node builtins, no third-party imports. Keep it that way: an import here is
 * paid by every one of those graphs at once.
 */

/**
 * Whether `value` is a non-null, non-array object — i.e. safe to index by string
 * key. Arrays are excluded on purpose: `typeof [] === "object"`, and treating an
 * array as a record is how untyped JSON walkers silently read `length` as data.
 *
 * Note this does NOT exclude functions or class instances; it is a JSON-shape
 * guard, not a plain-object guard. Callers that need those excluded keep their
 * own narrower predicate.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
