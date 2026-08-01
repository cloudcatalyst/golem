/**
 * R3.5 — `golem note distill`: shape a captured note (T4, spec Decision 20f)
 * into a zone-1 draft `question`/`artifact` wiki page, the same reuse-over-
 * redistill and local-inference-construction pattern as `golem wiki distill`
 * (cli/distill.ts).
 */

import { loadConfig } from "../config/index.js";
import {
  createProbeRunner,
  detectCapability,
  OllamaClient,
  OllamaInferenceService,
} from "../inference/index.js";
import type { InferenceService } from "../interfaces/inference.js";
import { distillNote, findDraftByNoteTs, writeNoteDraftFile } from "../knowledge/index.js";
import { FileWikiStore } from "../wiki/index.js";
import { InitError } from "./init.js";
import { findNoteByTs, listNotes } from "./notes.js";
import { resolveWikiDir } from "./wiki.js";

export type DistillNoteResult =
  | { readonly kind: "exists"; readonly path: string }
  | { readonly kind: "written"; readonly path: string };

export interface DistillNoteOptions {
  readonly projectDir: string;
  /** Exact note timestamp to distill. Omit to distill the most recently captured note. */
  readonly ts?: string;
  /** Re-distill even if a draft already exists for this note. */
  readonly force?: boolean;
  /** Inject for tests — skips the real Ollama construction. */
  readonly inference?: InferenceService;
  readonly nowIso?: string;
}

/**
 * Distill one captured note. Prefers an existing draft (Decision 29's "reuse,
 * don't re-distill" rule) unless `force` is set. Throws InitError for every
 * user-facing failure (no notes captured, ts not found, no local inference)
 * so the CLI layer can report it consistently via `fail()`.
 */
export async function distillNoteCapture(options: DistillNoteOptions): Promise<DistillNoteResult> {
  const { projectDir } = options;

  const note =
    options.ts === undefined
      ? (await listNotes(projectDir, 1))[0]
      : await findNoteByTs(projectDir, options.ts);
  if (note === undefined || note === null) {
    throw new InitError(
      options.ts === undefined
        ? 'no notes captured yet — try: golem note "some idea"'
        : `no captured note with timestamp ${options.ts}`,
    );
  }

  if (options.force !== true) {
    const existing = await findDraftByNoteTs(projectDir, note.ts);
    if (existing !== null) return { kind: "exists", path: existing.path };
  }

  const { settings } = await loadConfig({ projectDir });

  let inference = options.inference;
  if (inference === undefined) {
    try {
      const client = new OllamaClient({
        baseUrl: settings.inference.ollama_base_url,
        requestTimeoutMs: settings.inference.request_timeout_ms,
      });
      const facts = await detectCapability(createProbeRunner());
      inference = new OllamaInferenceService(client, facts, {
        providers: settings.inference.providers,
      });
    } catch (err) {
      throw new InitError(
        `local inference unavailable, can't distill (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  const wikiDir = resolveWikiDir(projectDir, settings.knowledge.wiki_dir);
  const pages = await new FileWikiStore({ wikiDir }).listPages();
  const existingTitles = pages.map((page) => page.frontmatter.title);

  const draft = await distillNote(inference, { text: note.text, existingTitles });
  const file = await writeNoteDraftFile(
    projectDir,
    note.ts,
    draft,
    options.nowIso ?? new Date().toISOString(),
  );
  return { kind: "written", path: file };
}
