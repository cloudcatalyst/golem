/**
 * Wiki read and upsert tools. Extracted from server.ts (R8.28).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WikiPage, WikiPageType, WikiStore } from "../interfaces/index.js";
import { UnknownWikiPageError, WikiWriteConflictError } from "../interfaces/index.js";
import { errorResult, instrumented, type ToolTelemetry } from "./shared.js";

const WIKI_PAGE_TYPES: [WikiPageType, ...WikiPageType[]] = [
  "schema",
  "concept",
  "entity",
  "source",
  "synthesis",
  "question",
  "artifact",
  "adr",
  "debrief",
];

function structuredWikiPage(page: WikiPage): {
  rel_path: string;
  title: string;
  type: WikiPageType;
  tags: string[];
  sources: string[];
  created: string;
  updated: string;
  body: string;
} {
  return {
    rel_path: page.relPath,
    title: page.frontmatter.title,
    type: page.frontmatter.type,
    tags: [...page.frontmatter.tags],
    sources: [...page.frontmatter.sources],
    created: page.frontmatter.created,
    updated: page.frontmatter.updated,
    body: page.body,
  };
}

/** WS-W W2: wiki authoring tools over an injected WikiStore (spec Decisions 28/29). */
export function registerWikiTools(server: McpServer, wiki: WikiStore, tel?: ToolTelemetry): void {
  server.registerTool(
    "wiki_read",
    {
      title: "Read a Golem wiki page",
      description:
        "Read one page from the project's committed wiki (spec Decision 28) by its " +
        "title or its wiki-relative path. The wiki is the canonical knowledge store " +
        "— check it before falling back to search or the outside world.",
      inputSchema: {
        title_or_path: z
          .string()
          .min(1)
          .describe(
            'A page title (e.g. "Prompt Caching") or a wiki-relative path ' +
              '(e.g. "concepts/Prompt Caching.md")',
          ),
      },
      outputSchema: {
        rel_path: z.string(),
        title: z.string(),
        type: z.enum(WIKI_PAGE_TYPES),
        tags: z.array(z.string()),
        sources: z.array(z.string()),
        created: z.string(),
        updated: z.string(),
        body: z.string(),
      },
    },
    async ({ title_or_path }) => {
      const startMs = Date.now();
      try {
        const page = await wiki.readPage(title_or_path);
        return instrumented(tel, "wiki_read", startMs, {
          content: [{ type: "text", text: page.body }],
          structuredContent: structuredWikiPage(page),
        });
      } catch (err) {
        if (err instanceof UnknownWikiPageError) {
          return errorResult(
            `No wiki page found for "${title_or_path}". Check docs/wiki/WIKI.md's ` +
              "index, or search for it before proposing a new page.",
          );
        }
        throw err;
      }
    },
  );

  server.registerTool(
    "wiki_upsert",
    {
      title: "Write a Golem wiki page",
      description:
        "Create or refine a page in the project's committed wiki (spec Decisions " +
        "28/29, de-gated by Decision 44). Author freely — no prior approval needed; " +
        "every write is committed to git, so it's reviewable and revertible. " +
        "Redaction-before-storage still applies and contradictions must be surfaced " +
        "to the human, never auto-resolved. If a page already exists at rel_path, " +
        "the new body is appended under a dated separator and tags/sources are " +
        "merged in; this never replaces existing content wholesale. title/type must " +
        "match the existing page's when one is already there.",
      inputSchema: {
        rel_path: z
          .string()
          .min(1)
          .describe('Wiki-relative path, e.g. "concepts/Prompt Caching.md"'),
        title: z.string().min(1),
        type: z.enum(WIKI_PAGE_TYPES),
        tags: z.array(z.string()).optional().describe("Tags to add (default none)"),
        sources: z
          .array(z.string())
          .optional()
          .describe("URLs or repo paths this content comes from (default none)"),
        body: z.string().min(1).describe("Markdown body; frontmatter is generated"),
      },
      outputSchema: {
        rel_path: z.string(),
        title: z.string(),
        type: z.enum(WIKI_PAGE_TYPES),
        tags: z.array(z.string()),
        sources: z.array(z.string()),
        created: z.string(),
        updated: z.string(),
        body: z.string(),
        appended: z.boolean(),
      },
    },
    async ({ rel_path, title, type, tags, sources, body }) => {
      let existedBefore = true;
      try {
        await wiki.readPage(rel_path);
      } catch (err) {
        if (err instanceof UnknownWikiPageError) {
          existedBefore = false;
        } else {
          throw err;
        }
      }
      try {
        const page = await wiki.upsertPage({
          relPath: rel_path,
          frontmatter: { title, type, tags: tags ?? [], sources: sources ?? [] },
          body,
        });
        return {
          content: [
            {
              type: "text",
              text: `Golem: ${existedBefore ? "updated" : "created"} wiki page ${page.relPath}.`,
            },
          ],
          structuredContent: { ...structuredWikiPage(page), appended: existedBefore },
        };
      } catch (err) {
        if (err instanceof WikiWriteConflictError) return errorResult(err.message);
        throw err;
      }
    },
  );
}
