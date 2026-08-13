/**
 * R9.23 left `default_target` in two places: the live setting is
 * `inference.default_target`, while every function that consumes it
 * ({@link resolveDefaultTargetId}, {@link listTargets}, {@link
 * resolveUpstreamDisplay}) takes a *proxy-shaped* settings object that still
 * carries the deprecated `proxy.default_target` leaf — the one the migration
 * table forwards old files onto.
 *
 * Bridging the two is a three-line spread, and it was written out at five call
 * sites: the proxy build, the statusline, `golem targets`, and *twice* inside
 * `collectStatus` (once for the `upstream` field, once for the `targets` field —
 * which must agree, or `golem status --json` contradicts itself). One helper so
 * they cannot drift.
 *
 * **Dependency-free on purpose:** typed structurally rather than against
 * `GolemSettings`, so `src/providers/` keeps its one-way relationship with
 * `src/config/` and the statusline's hot import path pays nothing for this.
 */

/**
 * `settings.proxy` with the live `inference.default_target` folded in, when set.
 *
 * Always returns a fresh object, never `settings.proxy` itself, so a caller that
 * holds the result cannot alias (or mutate) the loaded settings.
 */
export function withDefaultTarget<P extends { readonly default_target?: string }>(settings: {
  readonly proxy: P;
  readonly inference: { readonly default_target?: string };
}): P {
  // The cast is the price of staying generic: TypeScript cannot prove a spread
  // of `P` is still `P`, but the only key added is one `P` already declares.
  return {
    ...settings.proxy,
    ...(settings.inference.default_target !== undefined
      ? { default_target: settings.inference.default_target }
      : {}),
  } as P;
}
