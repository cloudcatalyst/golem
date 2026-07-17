/**
 * LE3 (PRE_R6_BATCH) — grounding for `golem task run`'s local multiplexing.
 *
 * R5.3 services queued tasks on the Ollama tier but did not inject KB/wiki
 * grounding the way `coder` has since R4.2, so a locally-serviced task saw a
 * context-blind draft. This builds the `ground` callback `runQueueLocally`
 * takes, reusing the EXACT shared `gatherGrounding` path `coder` uses (via the
 * `mcp serve` → `registerCoderTool` deps shape) so a serviced task is grounded
 * identically to a `coder` draft.
 *
 * Best-effort by the R4.2 contract: returns `undefined` — service ungrounded,
 * never fail the run — when knowledge is disabled or the KB stack fails to
 * build. The returned callback never throws either (`gatherGrounding` swallows
 * failures and returns null).
 *
 * Extracted from `main.ts` (which runs the CLI on import) so it is independently
 * importable and unit-testable; `buildStack` is injectable for the same reason.
 */

import { loadConfig } from "../config/index.js";
import type { InferenceService } from "../interfaces/inference.js";
import type { KnowledgeBase } from "../interfaces/knowledge.js";
import { gatherGrounding, type HitAssemblyDeps } from "../mcp/index.js";
import { FederatedWikiReader, FileWikiStore } from "../wiki/index.js";
import { buildKnowledgeStack } from "./build-knowledge.js";
import { defaultUserWikiDir, resolveWikiDir, wikiSourcePrefix } from "./wiki.js";

/** Returns a labeled grounding block for a prompt, or null when there's nothing to inject. */
export type GroundFn = (prompt: string) => Promise<string | null>;

/** Injection seam for tests (defaults to the real KB stack builder). */
export interface TaskGroundingDeps {
  readonly buildStack?: (dir: string) => Promise<{ readonly knowledge: KnowledgeBase }>;
}

export async function buildTaskGrounding(
  dir: string,
  inference: InferenceService,
  deps: TaskGroundingDeps = {},
): Promise<GroundFn | undefined> {
  try {
    const { settings } = await loadConfig({ projectDir: dir });
    if (!settings.knowledge.enabled) return undefined;
    const build = deps.buildStack ?? ((d) => buildKnowledgeStack({ projectDir: d }));
    const { knowledge } = await build(dir);
    const resolvedWikiDir = resolveWikiDir(dir, settings.knowledge.wiki_dir);
    const wiki = new FileWikiStore({ wikiDir: resolvedWikiDir });
    // Mirror the `registerCoderTool` deps exactly (server.ts): project + optional
    // user-federated wiki, wikiSourcePrefix for the wiki-rank boost, opt-in rerank.
    const hitDeps: HitAssemblyDeps = {
      knowledge,
      wiki: settings.knowledge.user_wiki_enabled
        ? new FederatedWikiReader(wiki, new FileWikiStore({ wikiDir: defaultUserWikiDir() }))
        : wiki,
      wikiDir: wikiSourcePrefix(dir, resolvedWikiDir),
      ...(settings.knowledge.rerank_enabled ? { rerank: inference } : {}),
    };
    return async (prompt) => (await gatherGrounding(prompt, dir, hitDeps))?.block ?? null;
  } catch {
    return undefined; // best-effort — service ungrounded rather than fail the run
  }
}
