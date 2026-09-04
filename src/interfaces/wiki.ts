/**
 * WikiStore — FROZEN CONTRACT (IMPLEMENTATION_PLAN §WS-W W2; spec Decisions 28/29).
 *
 * Read/write surface over the committed markdown wiki at project setting
 * `knowledge.wiki_dir` (default `docs/wiki`, see `cli/wiki.ts`). Pages are
 * plain files with required frontmatter (see `docs/wiki/WIKI.md`); this
 * interface adds a title/wikilink graph on top so an agent can navigate
 * page-to-page without falling back to vector search.
 *
 * This interface performs no approval gating itself — it is the mechanical
 * read/write + graph primitive. Plan-gating ("propose a plan, get approval,
 * then write") is enforced at the prompt/tool-description layer (the
 * `wiki_upsert` MCP tool, `/golem-wiki-ingest`), the same convention every
 * other Golem tool already uses (Decision 29) — there is no in-protocol
 * confirmation step here.
 *
 * Implemented by `src/wiki/file-wiki-store.ts` (`FileWikiStore`) against the
 * local filesystem.
 */

/** The `type` values `docs/wiki/WIKI.md` requires in frontmatter. */
export type WikiPageType =
  | "schema"
  | "concept"
  | "entity"
  | "source"
  | "synthesis"
  | "question"
  | "artifact"
  | "adr"
  | "debrief";

/** Required frontmatter on every wiki page (WIKI.md page-conventions table). */
export interface WikiFrontmatter {
  readonly title: string;
  readonly type: WikiPageType;
  readonly tags: readonly string[];
  readonly sources: readonly string[];
  /** YYYY-MM-DD */
  readonly created: string;
  /** YYYY-MM-DD */
  readonly updated: string;
}

/** One wiki page: parsed frontmatter plus the markdown body that follows it. */
export interface WikiPage {
  /** POSIX-relative path from `wiki_dir`, e.g. `concepts/Prompt Caching.md`. */
  readonly relPath: string;
  readonly frontmatter: WikiFrontmatter;
  readonly body: string;
}

/** Thrown by readPage() for a title or path that resolves to no page. */
export class UnknownWikiPageError extends Error {
  constructor(titleOrPath: string) {
    super(`unknown wiki page: ${titleOrPath}`);
    this.name = "UnknownWikiPageError";
  }
}

/**
 * Thrown by upsertPage() when `relPath` already holds a page whose `title` or
 * `type` differs from the input — refuses to silently fold unrelated content
 * together under one path.
 */
export class WikiWriteConflictError extends Error {
  constructor(relPath: string, detail: string) {
    super(`wiki write conflict at ${relPath}: ${detail}`);
    this.name = "WikiWriteConflictError";
  }
}

/**
 * Input to upsertPage(). Per Decision 29, this is append-and-refine, never a
 * wholesale rewrite: a page absent at `relPath` is created verbatim from
 * `frontmatter`/`body`; a page already present there keeps its existing body
 * with `body` appended under a dated separator, and has `tags`/`sources`
 * unioned (de-duplicated) with the existing values — `frontmatter.title` and
 * `frontmatter.type` must match the existing page's when one exists, else
 * WikiWriteConflictError. `created`/`updated` are stamped by the
 * implementation, not the caller.
 */
export interface WikiUpsertInput {
  readonly relPath: string;
  readonly frontmatter: Pick<WikiFrontmatter, "title" | "type" | "tags" | "sources">;
  readonly body: string;
}

/** The read side: look up a page by title or by its wiki-relative path. */
export interface WikiReader {
  /** Reject with UnknownWikiPageError if no page matches. */
  readPage(titleOrPath: string): Promise<WikiPage>;

  /** Resolve a `[[wikilink]]` title to a page's relPath, or undefined if none. */
  resolveLink(title: string): Promise<string | undefined>;

  /** relPaths of every page whose body wikilinks the given title or path. */
  backlinks(titleOrPath: string): Promise<readonly string[]>;

  /**
   * Every page in the wiki (added T5, spec Decision 28's graph-first search:
   * `search` needs a title/alias table it can build once per call and reuse
   * for both exact-match and 1-hop wikilink expansion, instead of each of
   * readPage/resolveLink/backlinks re-scanning the directory independently).
   */
  listPages(): Promise<readonly WikiPage[]>;
}

/** Full wiki surface: graph-aware reads plus the single, gated write path. */
export interface WikiStore extends WikiReader {
  upsertPage(input: WikiUpsertInput): Promise<WikiPage>;
}
