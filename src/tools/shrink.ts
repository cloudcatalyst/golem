/**
 * Workstream B / R8.S1 — candidate `tools`-block transforms, as pure functions over
 * a catalog so the harness can score them before anything touches the request path.
 *
 * §88 sorted the *prose* candidates into three classes. Two of them are implemented
 * here because they bracket the interesting range:
 *
 *  - **`whitespace`** — collapse redundant whitespace. Genuinely lossless: the
 *    model reads the same words. Also worth almost nothing, because these strings
 *    are already prose. Included as the control: a transform whose accuracy delta
 *    *must* be zero-ish, so a non-zero delta means the harness is noisy rather
 *    than the transform being harmful.
 *  - **`first-sentence`** — keep only each description's first sentence. A large
 *    saving and an honest hazard: Golem's descriptions carry load-bearing detail
 *    in later sentences ("never engages the local model", "use when the excerpt is
 *    not enough", the level-0 redaction warning). This is the transform the gate
 *    exists to catch. §89 measured it: 56% saved, false positives **tripled** →
 *    REGRESSED, not shipped.
 *
 * The third class — native `defer_loading` / tool-search passthrough — is not a
 * transform at all and is not modelled here: it rewrites nothing, it changes when
 * tools are visible. See notes §89 and `tests/integration/proxy-tool-search.test.ts`.
 *
 * **R8.S1 adds the schema transforms**, because §89's closing finding was that the
 * prose shrinker had been attacking the smaller half all along: input schemas are
 * ~2900 of the ~3847 definition tokens. The three schema modes below are again
 * ordered by hazard, and again the first is a control — but this time a control
 * that should save something rather than nothing:
 *
 *  - **`schema-meta`** — drop the `$schema` draft URI. Provably invisible to the
 *    model (it names a validation dialect, not a parameter) and non-zero, so it is
 *    the one transform in this file expected to be free money.
 *  - **`schema-validation`** — additionally drop the numeric/length constraints and
 *    `additionalProperties`. Saving is small and the hazard is real in both
 *    directions: `minimum`/`maximum` tell the model a level is 0–5, and
 *    `additionalProperties: false` is part of what stops it inventing parameters.
 *  - **`schema-descriptions`** — additionally drop every per-property
 *    `description`. The big saving and the big hazard: these are the strings that
 *    say `until` is ISO-8601 and `ref_id` is the hex after `hash=`. This is the
 *    schema-side equivalent of `first-sentence`, and it is what the argument
 *    harness (`runArgumentHarness`) exists to catch — **selection accuracy cannot
 *    see it**, because the model still picks the right tool and then fills it in
 *    wrongly.
 */

import { estimateTokens } from "../compression/tokens.js";
import type { CatalogTool } from "./catalog.js";

export type ShrinkMode =
  | "whitespace"
  | "first-sentence"
  | "schema-meta"
  | "schema-validation"
  | "schema-descriptions"
  | "ext-caveman-shrink";

export const SHRINK_MODES: readonly ShrinkMode[] = [
  "whitespace",
  "first-sentence",
  "schema-meta",
  "schema-validation",
  "schema-descriptions",
  "ext-caveman-shrink",
];

/**
 * P3b — the one mode Golem does not implement. `ext-caveman-shrink` delegates to
 * the user's own `caveman-shrink` install (see `ext-shrink.ts`); the caller must
 * pass the resolved transform, and {@link shrinkCatalog} THROWS without it rather
 * than quietly measuring an identity transform as if it were their shrinker.
 */
export const EXTERNAL_MODES: readonly ShrinkMode[] = ["ext-caveman-shrink"];

export function isExternalMode(mode: ShrinkMode): boolean {
  return EXTERNAL_MODES.includes(mode);
}

/** Modes that rewrite the input schema rather than the description. */
export const SCHEMA_MODES: readonly ShrinkMode[] = [
  "schema-meta",
  "schema-validation",
  "schema-descriptions",
];

export function isSchemaMode(mode: ShrinkMode): boolean {
  return SCHEMA_MODES.includes(mode);
}

/** Collapse whitespace runs without touching a single word. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * First sentence only. Sentence-splits on `. ` followed by a capital, so
 * `e.g.`, `hash=<id>.` and version strings don't split mid-thought.
 */
function firstSentence(text: string): string {
  const collapsed = collapseWhitespace(text);
  const match = /^(.*?[.!?])\s+[A-Z(`]/.exec(collapsed);
  return match?.[1] ?? collapsed;
}

/**
 * Keys each schema mode strips, cumulatively — every mode includes the ones above
 * it, so the A/B ladder measures marginal cost rather than three unrelated points.
 */
const STRIPPED_KEYS: Readonly<Record<string, readonly string[]>> = {
  "schema-meta": ["$schema"],
  "schema-validation": [
    "$schema",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minItems",
    "maxItems",
    "pattern",
    "additionalProperties",
  ],
  "schema-descriptions": [
    "$schema",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minItems",
    "maxItems",
    "pattern",
    "additionalProperties",
    "description",
  ],
};

/**
 * Recursively drop `keys` from a JSON-schema value.
 *
 * Structural keys are never in the strip lists — `type`, `properties`, `required`,
 * `enum`, `items` all survive every mode. A transform that dropped `required`
 * would not be a shrinker, it would be a bug that the harness would then have to
 * discover the expensive way.
 */
function stripKeys(value: unknown, keys: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => stripKeys(v, keys));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(key)) continue;
    out[key] = stripKeys(child, keys);
  }
  return out;
}

/**
 * Apply a transform to every tool, recomputing the token census.
 *
 * Description modes leave the schema byte-identical and vice versa, so
 * `definitionTokens` is recomputed from whichever half moved rather than assumed —
 * the same "recompute, don't assume" rule the original description path used.
 */
export function shrinkCatalog(
  tools: readonly CatalogTool[],
  mode: ShrinkMode,
  opts?: {
    /**
     * P3b: the transform for an {@link EXTERNAL_MODES} mode, resolved from the
     * user's own install. Required for those modes — see {@link isExternalMode}.
     */
    readonly externalTransform?: (text: string) => string;
  },
): readonly CatalogTool[] {
  if (isSchemaMode(mode)) {
    const keys = STRIPPED_KEYS[mode] ?? [];
    return tools.map((tool) => {
      const schema = stripKeys(tool.schema, keys);
      const schemaTokens = estimateTokens(JSON.stringify(schema));
      return {
        ...tool,
        schema,
        schemaTokens,
        definitionTokens: tool.definitionTokens - tool.schemaTokens + schemaTokens,
      };
    });
  }

  let transform: (text: string) => string;
  if (isExternalMode(mode)) {
    const external = opts?.externalTransform;
    if (external === undefined) {
      throw new Error(
        `shrink mode "${mode}" needs the external transform — install caveman-shrink ` +
          "(npm i -g caveman-shrink) or point GOLEM_CAVEMAN_SHRINK at it. Refusing to " +
          "measure an identity transform as if it were theirs.",
      );
    }
    transform = external;
  } else {
    transform = mode === "whitespace" ? collapseWhitespace : firstSentence;
  }
  return tools.map((tool) => {
    const description = transform(tool.description);
    return {
      ...tool,
      description,
      descriptionTokens: estimateTokens(description),
      // The schema is untouched, so the definition shrinks by exactly the
      // description's delta — recompute rather than assume.
      definitionTokens:
        tool.definitionTokens - tool.descriptionTokens + estimateTokens(description),
    };
  });
}
