/**
 * R3.4 (WS-W W4) — read-only federation of the project wiki with a
 * user-scope wiki (spec Decision 20e's local/P1 tier: "tiered user/workspace/
 * org shared standards & knowledge begins in P1 at local (user) scope
 * alongside the knowledge base"). Merges two {@link WikiReader}s so `search`/
 * `fetch` see both without any change to the graph-first search mechanics in
 * `src/mcp/server.ts` — those only ever depend on the generic `WikiReader`
 * surface, never on a concrete store.
 *
 * Writes are NOT federated: `upsertPage` stays on the single project
 * `WikiStore` as before (see `GolemMcpServerDeps.wiki` vs `.wikiSearch` in
 * `src/mcp/server.ts`) — a user-scope page is edited directly on disk or via
 * a future dedicated tool, not through this class.
 */

import type { WikiPage, WikiReader } from "../interfaces/index.js";
import { UnknownWikiPageError } from "../interfaces/index.js";
import { extractWikilinks } from "./frontmatter.js";

/** Prefix marking a merged page/relPath as coming from the user wiki, not the project one. */
export const USER_WIKI_PREFIX = "user:";

function prefixPage(page: WikiPage): WikiPage {
  return { ...page, relPath: `${USER_WIKI_PREFIX}${page.relPath}` };
}

export class FederatedWikiReader implements WikiReader {
  constructor(
    private readonly project: WikiReader,
    private readonly user: WikiReader,
  ) {}

  /** Every page from both wikis; user-wiki pages carry a `user:`-prefixed relPath. */
  async listPages(): Promise<readonly WikiPage[]> {
    const [projectPages, userPages] = await Promise.all([
      this.project.listPages(),
      this.user.listPages(),
    ]);
    return [...projectPages, ...userPages.map(prefixPage)];
  }

  /**
   * A `user:`-prefixed path resolves straight to the user wiki (this is how
   * `fetch` recovers a graph-first hit built from a user-wiki page, per
   * `wikiChunkRelPath`/`pageToHit` in `src/mcp/server.ts`). Otherwise the
   * project wiki is tried first — on a title or path miss there
   * (`UnknownWikiPageError`), the same lookup is retried against the user
   * wiki, so a plain title lookup still finds a user-only page. The project
   * wins on a title collision between the two wikis.
   */
  async readPage(titleOrPath: string): Promise<WikiPage> {
    if (titleOrPath.startsWith(USER_WIKI_PREFIX)) {
      return prefixPage(await this.user.readPage(titleOrPath.slice(USER_WIKI_PREFIX.length)));
    }
    try {
      return await this.project.readPage(titleOrPath);
    } catch (err) {
      if (!(err instanceof UnknownWikiPageError)) throw err;
    }
    return prefixPage(await this.user.readPage(titleOrPath));
  }

  /** Project wins a title collision; falls back to the user wiki when the project has no match. */
  async resolveLink(title: string): Promise<string | undefined> {
    const projectMatch = await this.project.resolveLink(title);
    if (projectMatch !== undefined) return projectMatch;
    const userMatch = await this.user.resolveLink(title);
    return userMatch !== undefined ? `${USER_WIKI_PREFIX}${userMatch}` : undefined;
  }

  /**
   * Computed over the merged page set directly (rather than delegating to
   * each reader's own backlinks()), so a project page linking a user-only
   * title — or vice versa — is found too.
   */
  async backlinks(titleOrPath: string): Promise<readonly string[]> {
    const pages = await this.listPages();
    const target = pages.find(
      (p) => p.frontmatter.title === titleOrPath || p.relPath === titleOrPath,
    );
    if (target === undefined) return [];
    return pages
      .filter((p) => p.relPath !== target.relPath)
      .filter((p) => extractWikilinks(p.body).includes(target.frontmatter.title))
      .map((p) => p.relPath);
  }
}
