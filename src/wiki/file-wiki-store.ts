/**
 * FileWikiStore — filesystem-backed WikiStore (WS-W W2; spec Decisions 28/29).
 *
 * No approval gating happens here (see `src/interfaces/wiki.ts`'s doc
 * comment) — this is the mechanical read/write + wikilink-graph primitive
 * that the `wiki_read`/`wiki_upsert` MCP tools sit on top of.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WikiFrontmatter, WikiPage, WikiStore, WikiUpsertInput } from "../interfaces/index.js";
import { UnknownWikiPageError, WikiWriteConflictError } from "../interfaces/index.js";
import { extractWikilinks, parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";

export interface FileWikiStoreOptions {
  readonly wikiDir: string;
  /** Today's date as YYYY-MM-DD; injected for tests. */
  readonly now?: () => string;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function union(base: readonly string[], extra: readonly string[]): readonly string[] {
  const seen = new Set(base);
  const merged = [...base];
  for (const item of extra) {
    if (!seen.has(item)) {
      seen.add(item);
      merged.push(item);
    }
  }
  return merged;
}

export class FileWikiStore implements WikiStore {
  private readonly wikiDir: string;
  private readonly now: () => string;

  constructor(options: FileWikiStoreOptions) {
    this.wikiDir = options.wikiDir;
    this.now = options.now ?? (() => new Date().toISOString().slice(0, 10));
  }

  private absPath(relPath: string): string {
    return path.join(this.wikiDir, relPath);
  }

  /** Read + parse one page by its exact wiki-relative path; undefined if absent. */
  private async readAt(relPath: string): Promise<WikiPage | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.absPath(relPath), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    const { frontmatter, body } = parseFrontmatter(raw);
    return { relPath: toPosix(relPath), frontmatter, body };
  }

  /** All parseable pages under wikiDir. Unparsable files are skipped (see `golem wiki check`). */
  private async listPages(): Promise<WikiPage[]> {
    let entries: string[];
    try {
      entries = await readdir(this.wikiDir, { recursive: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const pages: WikiPage[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      try {
        const page = await this.readAt(entry);
        if (page !== undefined) pages.push(page);
      } catch {
        // Skipped here; golem wiki check surfaces parse failures to the user.
      }
    }
    return pages;
  }

  async readPage(titleOrPath: string): Promise<WikiPage> {
    const asPath = titleOrPath.endsWith(".md") ? titleOrPath : `${titleOrPath}.md`;
    const direct = await this.readAt(asPath);
    if (direct !== undefined) return direct;

    const byTitle = (await this.listPages()).find((p) => p.frontmatter.title === titleOrPath);
    if (byTitle !== undefined) return byTitle;

    throw new UnknownWikiPageError(titleOrPath);
  }

  async resolveLink(title: string): Promise<string | undefined> {
    const pages = await this.listPages();
    return pages.find((p) => p.frontmatter.title === title)?.relPath;
  }

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

  async upsertPage(input: WikiUpsertInput): Promise<WikiPage> {
    const existing = await this.readAt(input.relPath);
    const today = this.now();

    if (existing === undefined) {
      const page: WikiPage = {
        relPath: toPosix(input.relPath),
        frontmatter: { ...input.frontmatter, created: today, updated: today },
        body: input.body,
      };
      await this.write(page);
      return page;
    }

    if (existing.frontmatter.title !== input.frontmatter.title) {
      throw new WikiWriteConflictError(
        input.relPath,
        `existing title "${existing.frontmatter.title}" != "${input.frontmatter.title}"`,
      );
    }
    if (existing.frontmatter.type !== input.frontmatter.type) {
      throw new WikiWriteConflictError(
        input.relPath,
        `existing type "${existing.frontmatter.type}" != "${input.frontmatter.type}"`,
      );
    }

    const frontmatter: WikiFrontmatter = {
      title: existing.frontmatter.title,
      type: existing.frontmatter.type,
      tags: union(existing.frontmatter.tags, input.frontmatter.tags),
      sources: union(existing.frontmatter.sources, input.frontmatter.sources),
      created: existing.frontmatter.created,
      updated: today,
    };
    const page: WikiPage = {
      relPath: toPosix(input.relPath),
      frontmatter,
      body: `${existing.body.trimEnd()}\n\n---\n\n${input.body}`,
    };
    await this.write(page);
    return page;
  }

  private async write(page: WikiPage): Promise<void> {
    const abs = this.absPath(page.relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, `${serializeFrontmatter(page.frontmatter)}\n\n${page.body}\n`, "utf8");
  }
}
