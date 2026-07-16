/**
 * T3 (WS-W W3) — `golem wiki distill` engine: distill one cached page into a
 * zone-1 source-note draft, or list drafts pending review. Split out of
 * main.ts's CLI wiring (like ollama.ts/notes.ts) so the local-inference
 * construction + distill call is unit-testable without spawning the CLI.
 */

import { loadConfig } from "../config/index.js";
import {
  createProbeRunner,
  detectCapability,
  OllamaClient,
  OllamaInferenceService,
} from "../inference/index.js";
import type { InferenceService } from "../interfaces/inference.js";
import {
  type DraftFile,
  distillPage,
  findDraftByUrl,
  listDraftFiles,
  WebCache,
  webCacheDir,
  writeDraftFile,
} from "../knowledge/index.js";
import { FileWikiStore } from "../wiki/index.js";
import { InitError } from "./init.js";
import { resolveWikiDir } from "./wiki.js";

export type DistillOneResult =
  | { readonly kind: "exists"; readonly path: string }
  | { readonly kind: "written"; readonly path: string };

export interface DistillOneOptions {
  readonly projectDir: string;
  readonly url: string;
  /** Re-distill even if a draft already cites this URL. */
  readonly force?: boolean;
  /** Inject for tests — skips the real Ollama construction. */
  readonly inference?: InferenceService;
  readonly nowIso?: string;
}

/**
 * Distill one cached URL. Prefers an existing draft (Decision 29's "reuse,
 * don't re-distill" rule) unless `force` is set. Throws InitError for every
 * user-facing failure (no cache entry, no local inference) so the CLI layer
 * can report it consistently via `fail()`.
 */
export async function distillOne(options: DistillOneOptions): Promise<DistillOneResult> {
  const { projectDir, url } = options;

  if (options.force !== true) {
    const existing = await findDraftByUrl(projectDir, url);
    if (existing !== null) return { kind: "exists", path: existing.path };
  }

  const cache = new WebCache(webCacheDir(projectDir));
  const entry = await cache.get(url);
  if (entry === null) {
    throw new InitError(
      `no cached content for ${url} — fetch it first (WebFetch caches it automatically)`,
    );
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
      inference = new OllamaInferenceService(client, facts);
    } catch (err) {
      throw new InitError(
        `local inference unavailable, can't distill (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  const wikiDir = resolveWikiDir(projectDir, settings.knowledge.wiki_dir);
  const pages = await new FileWikiStore({ wikiDir }).listPages();
  const existingTitles = pages.map((page) => page.frontmatter.title);

  const draft = await distillPage(inference, { url, rawText: entry.content, existingTitles });
  const file = await writeDraftFile(
    projectDir,
    url,
    draft,
    options.nowIso ?? new Date().toISOString(),
  );
  return { kind: "written", path: file };
}

/** Drafts awaiting review, for `golem wiki distill --pending`. */
export async function pendingDrafts(projectDir: string): Promise<readonly DraftFile[]> {
  return listDraftFiles(projectDir);
}

/** Human-readable rendering of pending drafts (the default, non-`--json` output). */
export function renderPendingDrafts(drafts: readonly DraftFile[]): string {
  if (drafts.length === 0) return "No distill drafts pending review.\n";
  const lines = drafts.map(
    (d) => `  ${d.slug} — ${d.frontmatter.title} (${d.frontmatter.sources[0] ?? "?"})`,
  );
  return `${lines.join("\n")}\n`;
}
