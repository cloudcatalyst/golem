/**
 * Workstream B — candidate `tools`-block transforms, as pure functions over a
 * catalog so the harness can score them before anything touches the request path.
 *
 * §88 sorted the candidates into three classes. Two of them are implemented here
 * because they bracket the interesting range:
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
 *    exists to catch.
 *
 * The third class — native `defer_loading` / tool-search passthrough — is not a
 * transform at all and is not modelled here: it rewrites nothing, it changes when
 * tools are visible. See notes §89 and `tests/integration/proxy-tool-search.test.ts`.
 */

import { estimateTokens } from "../compression/tokens.js";
import type { CatalogTool } from "./catalog.js";

export type ShrinkMode = "whitespace" | "first-sentence";

export const SHRINK_MODES: readonly ShrinkMode[] = ["whitespace", "first-sentence"];

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

/** Apply a transform to every description, recomputing the token census. */
export function shrinkCatalog(
  tools: readonly CatalogTool[],
  mode: ShrinkMode,
): readonly CatalogTool[] {
  const transform = mode === "whitespace" ? collapseWhitespace : firstSentence;
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
