/**
 * WS-W W1b — `golem wiki init`: scaffold the project wiki (spec Decision 28).
 *
 * Idempotent, same create/skip reporting convention as `golemInit` (init.ts):
 * an existing WIKI.md or zone directory is never overwritten. `wikiDir` is
 * resolved by the caller (CLI reads `knowledge.wiki_dir` from config; relative
 * values are project-rooted, same rule as `resolveIndexPaths` in
 * auto-index.ts) so this module has no config dependency of its own.
 */

import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultUserDir } from "../config/paths.js";
import type { WikiPageType } from "../interfaces/index.js";
import { extractWikilinks, parseFrontmatter } from "../wiki/index.js";
import type { InitAction } from "./init.js";

/** Zone-2/3 subdirectories every scaffolded wiki gets, empty but git-tracked. */
const WIKI_ZONE_DIRS = [
  "concepts",
  "entities",
  "sources",
  "syntheses",
  "decisions",
  "debriefs",
  "questions",
  "artifacts",
] as const;

/** Generic zone-0 schema file content (WIKI.md), not tied to any one project. */
function wikiSchemaTemplate(date: string): string {
  return [
    "---",
    "title: WIKI",
    "type: schema",
    "tags: [meta]",
    "sources: []",
    `created: ${date}`,
    `updated: ${date}`,
    "---",
    "",
    "# Project wiki — schema (Zone 0)",
    "",
    "This directory is the project's durable knowledge store: human-readable, committed",
    "to git, and the **first port of call** for Claude before vector search or the",
    "outside world. Any vector index built over it is a derived, rebuildable cache of",
    "these pages — never the truth.",
    "",
    "## Zones and write rules",
    "",
    "| Zone | Where | Who writes | Rule |",
    "|---|---|---|---|",
    "| 1 — raw | local raw-capture stores (gitignored) | tooling/hooks | never committed; never hand-edited |",
    "| 2 — wiki | `concepts/ entities/ sources/ syntheses/ questions/ artifacts/` | agent, **plan-gated** | propose a plan, get approval, then write; append-and-refine, never wholesale rewrite |",
    "| 3 — dev | `decisions/ debriefs/` | human drives, agent co-pilots | accepted ADRs immutable except status; superseded, never deleted |",
    "",
    "Hard rules for every write, agent or human:",
    "",
    "1. **Redaction before storage** — no secrets/PII ever land here.",
    "2. **Link, don't restate.** The wiki never duplicates what the code, docs, or git",
    "   history already record — link to the file/section instead.",
    "3. **No raw fetched full-text.** What goes here is a distilled source note in our",
    "   own words, citing the URL.",
    "4. **Contradictions are reported to the human, never auto-resolved.**",
    "",
    "## Page conventions",
    "",
    "- Filenames: Title Case for `concepts/` and `entities/` (`Prompt Caching.md`);",
    "  kebab-case slugs for `sources/`, `syntheses/`, `questions/`, `artifacts/`;",
    "  `ADR-NNNN-slug.md` for decisions; `YYYY-MM-DD-slug.md` for debriefs.",
    "- Links: wikilinks (`[[Page Title]]`) between wiki pages; plain repo-relative paths",
    "  for code/docs. Every page carries **at least one wikilink**.",
    "- Required frontmatter on every page:",
    "",
    "```yaml",
    "---",
    "title: Page Title",
    "type: concept | entity | source | synthesis | question | artifact | adr | debrief",
    "tags: [kebab-case]",
    "sources: [urls or repo paths]   # where this knowledge came from",
    "created: YYYY-MM-DD",
    "updated: YYYY-MM-DD",
    "---",
    "```",
    "",
    "- Format is Obsidian-compatible on purpose, but nothing may depend on Obsidian.",
    "",
    "## Index",
    "",
    "(empty — pages will be added here as the wiki grows)",
    "",
  ].join("\n");
}

/** Resolve the configured `wiki_dir` against a project root (relative → project-rooted). */
export function resolveWikiDir(projectDir: string, wikiDirSetting: string): string {
  return path.isAbsolute(wikiDirSetting) ? wikiDirSetting : path.join(projectDir, wikiDirSetting);
}

/**
 * R3.4 (spec Decision 20e's local/P1 tier) — the user-scope wiki root,
 * `~/.golem/wiki/`, alongside every project's own `docs/wiki/`. Not
 * project-relative and not configurable per-project: it's one directory per
 * machine user, federated read-only into every project's `search`/`fetch`
 * (see `FederatedWikiReader`).
 */
export function defaultUserWikiDir(): string {
  return path.join(defaultUserDir(), "wiki");
}

/**
 * POSIX-relative form of an absolute wiki dir against the project root — the
 * same shape as `Chunk.sourcePath` when the ingest root is the project
 * directory (the default `watch_paths: []` case). Used by the MCP `search`
 * rank boost (spec Decision 28) to recognize wiki hits. A `wikiDir` outside
 * `projectDir` yields a `..`-prefixed string that never matches a
 * project-relative `sourcePath`, so the boost is safely inert in that case.
 */
export function wikiSourcePrefix(projectDir: string, wikiDir: string): string {
  return path.relative(projectDir, wikiDir).split(path.sep).join("/");
}

export interface WikiInitOptions {
  /** Project root (used only to compute paths reported relative to it). */
  readonly projectDir: string;
  /** Absolute wiki directory to scaffold (caller resolves via resolveWikiDir). */
  readonly wikiDir: string;
  /** Compute and report actions without writing anything. */
  readonly dryRun?: boolean;
  /** Today's date as YYYY-MM-DD; injected for tests. */
  readonly now?: () => string;
}

export interface WikiInitReport {
  readonly dryRun: boolean;
  readonly actions: readonly InitAction[];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function rel(projectDir: string, abs: string): string {
  return path.relative(projectDir, abs).split(path.sep).join("/");
}

/** Scaffold `wikiDir`: WIKI.md schema + empty, git-tracked zone directories. */
export async function golemWikiInit(options: WikiInitOptions): Promise<WikiInitReport> {
  const { projectDir, wikiDir } = options;
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? (() => new Date().toISOString().slice(0, 10));
  const actions: InitAction[] = [];

  const schemaPath = path.join(wikiDir, "WIKI.md");
  if (await pathExists(schemaPath)) {
    actions.push({ kind: "skip", path: rel(projectDir, schemaPath), detail: "already exists" });
  } else {
    actions.push({
      kind: "create",
      path: rel(projectDir, schemaPath),
      detail: "wiki schema (WIKI.md)",
    });
    if (!dryRun) {
      await mkdir(wikiDir, { recursive: true });
      await writeFile(schemaPath, wikiSchemaTemplate(now()), "utf8");
    }
  }

  for (const zone of WIKI_ZONE_DIRS) {
    const dir = path.join(wikiDir, zone);
    if (await pathExists(dir)) {
      actions.push({
        kind: "skip",
        path: rel(projectDir, dir),
        detail: "zone directory already exists",
      });
      continue;
    }
    actions.push({ kind: "create", path: rel(projectDir, dir), detail: "zone directory" });
    if (!dryRun) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, ".gitkeep"), "", "utf8");
    }
  }

  return { dryRun, actions };
}

const VALID_WIKI_PAGE_TYPES: ReadonlySet<WikiPageType> = new Set([
  "schema",
  "concept",
  "entity",
  "source",
  "synthesis",
  "question",
  "artifact",
  "adr",
  "debrief",
]);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface WikiCheckIssue {
  readonly relPath: string;
  readonly message: string;
}

export interface WikiCheckReport {
  readonly pagesChecked: number;
  readonly issues: readonly WikiCheckIssue[];
}

/**
 * `golem wiki check` (WS-W W2): frontmatter/date/link lint over every `.md`
 * page under `wikiDir`. Read-only — reports issues, never fixes them (the
 * wiki is plan-gated; a human or an approved agent write fixes what's found).
 */
export async function checkWiki(wikiDir: string): Promise<WikiCheckReport> {
  let entries: string[];
  try {
    entries = await readdir(wikiDir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { pagesChecked: 0, issues: [] };
    throw err;
  }
  const mdPaths = entries
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.split(path.sep).join("/"))
    .sort();

  const issues: WikiCheckIssue[] = [];
  const pages: Array<{ relPath: string; title: string; type: string; body: string }> = [];

  for (const relPath of mdPaths) {
    let raw: string;
    try {
      raw = await readFile(path.join(wikiDir, relPath), "utf8");
    } catch (err) {
      issues.push({ relPath, message: `could not read file: ${(err as Error).message}` });
      continue;
    }
    let frontmatter: ReturnType<typeof parseFrontmatter>["frontmatter"];
    let body: string;
    try {
      ({ frontmatter, body } = parseFrontmatter(raw));
    } catch (err) {
      issues.push({
        relPath,
        message: `frontmatter error: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (!VALID_WIKI_PAGE_TYPES.has(frontmatter.type)) {
      issues.push({ relPath, message: `invalid type "${frontmatter.type}"` });
    }
    if (!DATE_PATTERN.test(frontmatter.created)) {
      issues.push({
        relPath,
        message: `invalid created date "${frontmatter.created}" (want YYYY-MM-DD)`,
      });
    }
    if (!DATE_PATTERN.test(frontmatter.updated)) {
      issues.push({
        relPath,
        message: `invalid updated date "${frontmatter.updated}" (want YYYY-MM-DD)`,
      });
    }
    // The zone-0 schema page (WIKI.md) is exempt: a freshly scaffolded wiki
    // has no other pages yet for it to link to.
    if (frontmatter.type !== "schema" && extractWikilinks(body).length === 0) {
      issues.push({
        relPath,
        message: "no wikilinks in body (every page should link at least one other)",
      });
    }

    pages.push({ relPath, title: frontmatter.title, type: frontmatter.type, body });
  }

  const titleOwners = new Map<string, string[]>();
  for (const page of pages) {
    const owners = titleOwners.get(page.title) ?? [];
    owners.push(page.relPath);
    titleOwners.set(page.title, owners);
  }
  for (const [title, owners] of titleOwners) {
    if (owners.length <= 1) continue;
    for (const relPath of owners) {
      const others = owners.filter((o) => o !== relPath);
      issues.push({
        relPath,
        message: `duplicate title "${title}" also used by ${others.join(", ")}`,
      });
    }
  }

  const knownTitles = new Set(pages.map((p) => p.title));
  for (const page of pages) {
    for (const link of extractWikilinks(page.body)) {
      if (!knownTitles.has(link)) {
        issues.push({ relPath: page.relPath, message: `broken wikilink: [[${link}]]` });
      }
    }
  }

  return { pagesChecked: pages.length, issues };
}
