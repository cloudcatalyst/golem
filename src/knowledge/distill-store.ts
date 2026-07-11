/**
 * T3 (WS-W W3) — zone-1 draft storage for distilled source notes, extended by
 * R3.5 to also store `golem note` captures shaped into `question`/`artifact`
 * drafts. Drafts live at `.golem/distill/<slug>.md` (gitignored, never
 * auto-committed to the wiki) and are shaped like a wiki page from the start
 * — same frontmatter schema, `type` set to whatever zone-2 page it will
 * become — so promoting one is a copy/paste into `docs/wiki/<zone>/`, not a
 * reformat.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripKnownSecrets } from "../hooks/redact.js";
import type { WikiFrontmatter } from "../interfaces/index.js";
import { parseFrontmatter, serializeFrontmatter } from "../wiki/frontmatter.js";
import type { DistillDraft, NoteDraft } from "./distill.js";

/** Provenance marker stored in `sources` for a note-derived draft (R3.5). */
function noteSourceMarker(noteTs: string): string {
  return `note:${noteTs}`;
}

/** Where a project's distill drafts live. */
export function distillDir(projectDir: string): string {
  return path.join(projectDir, ".golem", "distill");
}

function draftPath(projectDir: string, slug: string): string {
  return path.join(distillDir(projectDir), `${slug}.md`);
}

function draftBody(draft: DistillDraft, url: string): string {
  const summary = stripKnownSecrets(draft.summary);
  const lines = [`# ${draft.title}`, "", summary, "", `Source: ${url}`];
  if (draft.wikilinks.length > 0) {
    lines.push("", "## Candidate wikilinks", "", ...draft.wikilinks.map((t) => `- [[${t}]]`));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Write (or overwrite) the draft file for a distilled page, keyed by slug —
 * calling this again for the same URL after a re-distill replaces the prior
 * draft rather than accumulating stale copies. Returns the file path written.
 */
export async function writeDraftFile(
  projectDir: string,
  url: string,
  draft: DistillDraft,
  nowIso: string,
): Promise<string> {
  const date = nowIso.slice(0, 10);
  const frontmatter: WikiFrontmatter = {
    title: draft.title,
    type: "source",
    tags: draft.tags,
    sources: [url],
    created: date,
    updated: date,
  };
  const file = draftPath(projectDir, draft.slug);
  await mkdir(distillDir(projectDir), { recursive: true });
  await writeFile(file, `${serializeFrontmatter(frontmatter)}\n\n${draftBody(draft, url)}`, "utf8");
  return file;
}

function noteDraftBody(draft: NoteDraft): string {
  const summary = stripKnownSecrets(draft.summary);
  const lines = [`# ${draft.title}`, "", summary];
  if (draft.wikilinks.length > 0) {
    lines.push("", "## Candidate wikilinks", "", ...draft.wikilinks.map((t) => `- [[${t}]]`));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * R3.5 — write (or overwrite) the draft file for a `golem note` capture
 * shaped by {@link distillNote}, keyed by slug like {@link writeDraftFile}.
 * `noteTs` (the note's own timestamp) is stored as a `note:<ts>` provenance
 * marker in `sources`, since there's no URL to cite. Returns the file path
 * written.
 */
export async function writeNoteDraftFile(
  projectDir: string,
  noteTs: string,
  draft: NoteDraft,
  nowIso: string,
): Promise<string> {
  const date = nowIso.slice(0, 10);
  const frontmatter: WikiFrontmatter = {
    title: draft.title,
    type: draft.type,
    tags: draft.tags,
    sources: [noteSourceMarker(noteTs)],
    created: date,
    updated: date,
  };
  const file = draftPath(projectDir, draft.slug);
  await mkdir(distillDir(projectDir), { recursive: true });
  await writeFile(file, `${serializeFrontmatter(frontmatter)}\n\n${noteDraftBody(draft)}`, "utf8");
  return file;
}

export interface DraftFile {
  readonly slug: string;
  readonly path: string;
  readonly frontmatter: WikiFrontmatter;
  readonly body: string;
}

/** Read one draft by slug. Null on a missing or unparseable file — never throws for those. */
export async function readDraftFile(projectDir: string, slug: string): Promise<DraftFile | null> {
  const file = draftPath(projectDir, slug);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const { frontmatter, body } = parseFrontmatter(raw);
    return { slug, path: file, frontmatter, body };
  } catch {
    return null;
  }
}

/** All pending drafts, sorted by slug. Empty (not an error) if the dir doesn't exist yet. */
export async function listDraftFiles(projectDir: string): Promise<DraftFile[]> {
  let entries: string[];
  try {
    entries = await readdir(distillDir(projectDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const slugs = entries
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort();
  const drafts: DraftFile[] = [];
  for (const slug of slugs) {
    const draft = await readDraftFile(projectDir, slug);
    if (draft !== null) drafts.push(draft);
  }
  return drafts;
}

/** Find an existing draft citing `url`, for the lazy-backfill pointer note in the fetch hook. */
export async function findDraftByUrl(projectDir: string, url: string): Promise<DraftFile | null> {
  const drafts = await listDraftFiles(projectDir);
  return drafts.find((draft) => draft.frontmatter.sources.includes(url)) ?? null;
}

/** R3.5 — find an existing draft shaped from the note with timestamp `noteTs`. */
export async function findDraftByNoteTs(
  projectDir: string,
  noteTs: string,
): Promise<DraftFile | null> {
  const marker = noteSourceMarker(noteTs);
  const drafts = await listDraftFiles(projectDir);
  return drafts.find((draft) => draft.frontmatter.sources.includes(marker)) ?? null;
}
