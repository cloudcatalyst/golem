/**
 * R3.4 (WS-W W4) — `golem wiki synthesize` engine: draft a weekly synthesis
 * tying together recent debriefs and captured notes (spec Decision 20e's
 * local tier), styled after `docs/wiki/syntheses/wiki-knowledge-loop-batch.md`.
 * Same split-out-of-main.ts convention as distill.ts/distill-note.ts, so the
 * local-inference construction + gather-then-call flow is unit-testable
 * without spawning the CLI. Plan-gated like every other distill flow: this
 * only ever writes a zone-1 `.golem/distill/` draft, never the wiki itself.
 */

import { loadConfig } from "../config/index.js";
import {
  createProbeRunner,
  detectCapability,
  OllamaClient,
  OllamaInferenceService,
} from "../inference/index.js";
import type { InferenceService } from "../interfaces/inference.js";
import { synthesizeWeekly, writeSynthesisDraftFile } from "../knowledge/index.js";
import { FileWikiStore } from "../wiki/index.js";
import { InitError } from "./init.js";
import { listNotesSince } from "./notes.js";
import { resolveWikiDir, wikiSourcePrefix } from "./wiki.js";

const DEFAULT_DAYS = 7;

export interface SynthesizeWeeklyOptions {
  readonly projectDir: string;
  /** How many days back to gather debriefs/notes from (default 7). */
  readonly days?: number;
  /** Inject for tests — skips the real Ollama construction. */
  readonly inference?: InferenceService;
  readonly nowIso?: string;
}

export interface SynthesizeWeeklyResult {
  readonly path: string;
  readonly debriefCount: number;
  readonly noteCount: number;
}

/**
 * Gather debriefs (from the wiki's `debriefs/` zone) and notes created/
 * captured since `days` ago, then draft a synthesis via the local
 * `summarizer` role. Throws InitError when there's nothing this period to
 * synthesize, or when local inference is unavailable.
 */
export async function synthesizeWeeklyReport(
  options: SynthesizeWeeklyOptions,
): Promise<SynthesizeWeeklyResult> {
  const { projectDir } = options;
  const days = options.days ?? DEFAULT_DAYS;
  const nowIso = options.nowIso ?? new Date().toISOString();
  const cutoffIso = new Date(new Date(nowIso).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const cutoffDate = cutoffIso.slice(0, 10);

  const { settings } = await loadConfig({ projectDir });
  const wikiDir = resolveWikiDir(projectDir, settings.knowledge.wiki_dir);
  const wiki = new FileWikiStore({ wikiDir });
  const pages = await wiki.listPages();
  const existingTitles = pages.map((page) => page.frontmatter.title);

  const debriefPages = pages
    .filter((p) => p.relPath.startsWith("debriefs/") && p.frontmatter.created >= cutoffDate)
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
  const notes = await listNotesSince(projectDir, cutoffIso);

  if (debriefPages.length === 0 && notes.length === 0) {
    throw new InitError(
      `nothing captured in the last ${days} day(s) (no debriefs, no notes) — nothing to synthesize yet`,
    );
  }

  let inference = options.inference;
  if (inference === undefined) {
    try {
      const client = new OllamaClient({ baseUrl: settings.inference.ollama_base_url });
      const facts = await detectCapability(createProbeRunner());
      inference = new OllamaInferenceService(client, facts);
    } catch (err) {
      throw new InitError(
        `local inference unavailable, can't synthesize (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  const draft = await synthesizeWeekly(inference, {
    debriefs: debriefPages.map((p) => ({ title: p.frontmatter.title, body: p.body })),
    notes: notes.map((n) => ({ ts: n.ts, text: n.text })),
    existingTitles,
  });

  const wikiRelPrefix = wikiSourcePrefix(projectDir, wikiDir);
  const sources = [
    ...debriefPages.map((p) => `${wikiRelPrefix}/${p.relPath}`),
    ...notes.map((n) => `note:${n.ts}`),
  ];
  const path = await writeSynthesisDraftFile(projectDir, sources, draft, nowIso);
  return { path, debriefCount: debriefPages.length, noteCount: notes.length };
}
