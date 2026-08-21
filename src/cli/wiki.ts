/**
 * WS-W W1b — `golem wiki init`: scaffold the project wiki (spec Decision 28).
 *
 * Idempotent, same create/skip reporting convention as `golemInit` (init.ts):
 * an existing WIKI.md or zone directory is never overwritten. `wikiDir` is
 * resolved by the caller (CLI reads `knowledge.wiki_dir` from config; relative
 * values are project-rooted, same rule as `resolveIndexPaths` in
 * auto-index.ts) so this module has no config dependency of its own.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultUserDir } from "../config/paths.js";
import type { WikiPageType } from "../interfaces/index.js";
import { extractWikilinks, parseFrontmatter } from "../wiki/index.js";
import type { InitAction } from "./init.js";
import { pathExists, rel } from "./json-file.js";

/**
 * Zone-2 subdirectories every scaffolded wiki gets, empty but git-tracked.
 * ADRs are deliberately NOT here — decisions live outside the wiki at
 * `docs/decisions/` under a stricter rule (spec Decision 44).
 */
const WIKI_ZONE_DIRS = [
  "concepts",
  "entities",
  "sources",
  "syntheses",
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
    "| 2 — wiki | `concepts/ entities/ sources/ syntheses/ questions/ artifacts/ debriefs/` | agent + human | **author freely** — create or refine pages without prior approval. Every write is committed to git, so it is diffable, reviewable, and revertible in history. Prefer append-and-refine over wholesale rewrites. |",
    "",
    "> **Decisions (ADRs) live at `docs/decisions/`, outside this wiki.** They are",
    "> human-driven dev artifacts with a stricter rule — accepted ADRs immutable",
    "> except status; superseded, never deleted — so they sit apart from the",
    "> freely-authored wiki.",
    "",
    "Hard rules for every write, agent or human (these still bind):",
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
    "  `YYYY-MM-DD-slug.md` for debriefs. (ADRs — `ADR-NNNN-slug.md` — live outside",
    "  this wiki at `docs/decisions/`.)",
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

/**
 * Blank out fenced code blocks and inline code spans so wikilinks inside them
 * (schema examples like WIKI.md's `[[Page Title]]`) aren't scanned as real
 * links. Newlines are preserved so nothing else shifts.
 */
function stripCode(md: string): string {
  return md.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, " ")).replace(/`[^`\n]*`/g, "");
}

/**
 * An identifier a shipped decision retired, which must not survive in prose that
 * teaches the CURRENT system.
 *
 * Appended to, never rewritten: the next retirement adds a row instead of
 * inventing its own one-off grep. `pattern` must stay non-global — `test()` is
 * called once per prose unit and a `g` flag would carry `lastIndex` between
 * calls.
 */
interface RetiredIdentifier {
  readonly label: string;
  readonly pattern: RegExp;
  readonly hint: string;
}

const RETIRED_IDENTIFIERS: readonly RetiredIdentifier[] = [
  {
    label: "slider",
    // Substring, not `\bslider\b`: the camelCase and CONSTANT_CASE spellings
    // (`setSliderLevel`, `MAX_SLIDER_LEVEL`) are the same drift quoted in prose.
    pattern: /slider/i,
    hint: "ADR-0004 retired it — the dials are `compression.level` and `brevity.level`",
  },
];

/**
 * NOT in the table, deliberately: `level N`.
 *
 * `compression` is still a 0–3 dial, so "level 3 (aggressive)" and "level 1
 * (lossless)" are legitimate CURRENT output of `golem status` and of every dial
 * surface (`describeDial`). A rule that flagged them would fire on correct prose
 * on its first run, which is how a check gets switched off instead of obeyed.
 * The retired thing was the *slider* — the preset over the two dials — and that
 * is the only word this rule knows.
 */

/**
 * A prose unit is exempt when it names the retirement itself: prose is allowed
 * to say a thing is gone, and the pages that explain a retirement are the ones
 * that must name it most often.
 */
const RETIREMENT_CONTEXT = /ADR-\d{4}|\bR11\.\d+\b|retire|no longer|used to|former|was removed/i;

/**
 * A prose unit is exempt when it cites a dated record, because there the wording
 * *is* the record: `WIKI.md`'s Index describes what each debrief said, and
 * rewriting those lines would falsify the history they point at.
 */
const RECORD_CITATION =
  /(?:^|[\s(`/[])(?:debriefs|syntheses|sources)\/|docs\/(?:decisions|plan)\/|verification-notes\.md/i;

/** Ordered list markers, unordered markers, and table rows all start their own unit. */
const LIST_MARKER = /^(?:[-*+]\s|\d+[.)]\s|\|)/;
const HEADING = /^#{1,6}\s/;

/**
 * Split a markdown body into the units an exemption applies to.
 *
 * Granularity is the whole design. Too coarse and one honest "the slider was
 * retired" line buys a free pass for real drift elsewhere on the page — which is
 * exactly what a whole-section scope would do to `WIKI.md`, whose Index holds
 * both record descriptions and the live page summaries. Too fine (per line) and
 * a correctly written history section fails on its own heading.
 *
 * So: every list item and table row is its own unit, a paragraph is one unit,
 * and a heading joins the paragraph beneath it (a heading like "What happened to
 * the slider" carries no marker of its own — the paragraph under it does). A
 * heading followed by a LIST keeps its own unit, so the list's items stay
 * independently checked.
 *
 * Code fences are not stripped: `golem slider 3` in a copy-pasteable example is
 * the worst drift on the page, not the most excusable.
 */
export function splitProseUnits(md: string): Array<{ startLine: number; text: string }> {
  const lines = md.split("\n");
  const units: Array<{ startLine: number; text: string }> = [];
  const blank = (line: string | undefined): boolean => line === undefined || line.trim() === "";

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (blank(line)) {
      i++;
      continue;
    }
    const startLine = i + 1;
    const text: string[] = [line];
    i++;

    if (HEADING.test(line.trim())) {
      // Absorb the paragraph under the heading, across the blank line that
      // conventionally separates them — but never a list, whose items must stay
      // separately checkable.
      let look = i;
      while (look < lines.length && blank(lines[look])) look++;
      if (look < lines.length && !LIST_MARKER.test((lines[look] as string).trim())) {
        i = look;
        while (i < lines.length && !blank(lines[i])) {
          text.push(lines[i] as string);
          i++;
        }
      }
    } else if (LIST_MARKER.test(line.trim())) {
      // Indented continuation lines belong to the item they wrap out of.
      while (
        i < lines.length &&
        !blank(lines[i]) &&
        /^\s/.test(lines[i] as string) &&
        !LIST_MARKER.test((lines[i] as string).trim())
      ) {
        text.push(lines[i] as string);
        i++;
      }
    } else {
      while (
        i < lines.length &&
        !blank(lines[i]) &&
        !LIST_MARKER.test((lines[i] as string).trim()) &&
        !HEADING.test((lines[i] as string).trim())
      ) {
        text.push(lines[i] as string);
        i++;
      }
    }

    units.push({ startLine, text: text.join("\n") });
  }
  return units;
}

/**
 * Zones whose pages are dated records rather than teaching prose. A debrief,
 * synthesis or distilled source note describes the system as it was on its own
 * date; holding it to today's vocabulary would mean editing history.
 */
const RECORD_ZONES = ["debriefs/", "syntheses/", "sources/"] as const;

/** Whether a wiki page (relPath, forward slashes) is prose the reader is taught from. */
export function isProseScanned(relPath: string): boolean {
  return !RECORD_ZONES.some((zone) => relPath.startsWith(zone));
}

/**
 * R12/docs-slider-drift — the check that stops the sixth stale line.
 *
 * R11.1 retired the slider and R11.4 swept the strings out of the CLI, the
 * settings help and the skills; nobody re-read the README, so the front page
 * still taught the retired control to every first-time reader. Same shape as
 * R11.5's Index rule: a checklist nobody could fail is a checklist that drifts.
 */
export function findRetiredIdentifiers(relPath: string, body: string): WikiCheckIssue[] {
  const issues: WikiCheckIssue[] = [];
  for (const unit of splitProseUnits(body)) {
    if (RETIREMENT_CONTEXT.test(unit.text) || RECORD_CITATION.test(unit.text)) continue;
    for (const retired of RETIRED_IDENTIFIERS) {
      if (!retired.pattern.test(unit.text)) continue;
      issues.push({
        relPath,
        message: `retired identifier "${retired.label}" in user-facing prose (line ${unit.startLine}): ${retired.hint}`,
      });
    }
  }
  return issues;
}

export interface WikiCheckIssue {
  readonly relPath: string;
  readonly message: string;
}

export interface WikiCheckReport {
  readonly pagesChecked: number;
  readonly issues: readonly WikiCheckIssue[];
  /** Non-wiki prose files scanned for retired identifiers (only when a projectDir was given). */
  readonly proseChecked?: number;
}

/**
 * Prose files outside the wiki that the retired-identifier rule also covers.
 * Repo-relative, resolved against the project dir.
 *
 * Deliberately short. Two surfaces are known to still name the slider and are
 * NOT here yet, each with its own task rather than a silent hole:
 * `docs/golem-spec.md`'s body (its Decisions Log is a dated record, but §1–§8
 * describe the slider throughout — a spec rewrite, not a docs sweep) and
 * `vscode-extension/README.md` (owned by a live workstream while this landed).
 * Widening this list is the way to close them; disabling the rule is not.
 */
const PROSE_FILES_OUTSIDE_WIKI = ["README.md"] as const;

/**
 * Lint `PROSE_FILES_OUTSIDE_WIKI` for retired identifiers. A file that isn't
 * there is skipped silently — this runs in any project, and only this repo is
 * guaranteed to have a README at the root.
 */
async function checkProseOutsideWiki(
  projectDir: string | undefined,
): Promise<{ issues: WikiCheckIssue[]; proseChecked?: number }> {
  if (projectDir === undefined) return { issues: [] };
  const issues: WikiCheckIssue[] = [];
  let proseChecked = 0;
  for (const relPath of PROSE_FILES_OUTSIDE_WIKI) {
    let text: string;
    try {
      text = await readFile(path.join(projectDir, relPath), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    proseChecked++;
    issues.push(...findRetiredIdentifiers(relPath, text));
  }
  return { issues, proseChecked };
}

/**
 * `golem wiki check` (WS-W W2): frontmatter/date/link lint over every `.md`
 * page under `wikiDir`. Read-only — reports issues, never fixes them (the
 * wiki is plan-gated; a human or an approved agent write fixes what's found).
 *
 * Pass `projectDir` to also lint the prose files outside the wiki
 * (`PROSE_FILES_OUTSIDE_WIKI`) for retired identifiers.
 */
export async function checkWiki(
  wikiDir: string,
  options?: { readonly projectDir?: string },
): Promise<WikiCheckReport> {
  let entries: string[];
  try {
    entries = await readdir(wikiDir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // A wiki that hasn't been scaffolded yet is not an error — but the prose
    // files outside it still exist and still drift.
    const outside = await checkProseOutsideWiki(options?.projectDir);
    return { pagesChecked: 0, ...outside };
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
    // Frontmatter is excluded on purpose: a `sources:` entry citing
    // ADR-0004-retire-the-slider.md is a citation, neither drift nor a licence.
    if (isProseScanned(relPath)) issues.push(...findRetiredIdentifiers(relPath, body));

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
    // Ignore wikilinks inside code (fenced blocks or inline spans) — those are
    // examples/schema, not real graph edges (e.g. WIKI.md's `[[Page Title]]`).
    for (const link of extractWikilinks(stripCode(page.body))) {
      if (!knownTitles.has(link)) {
        issues.push({ relPath: page.relPath, message: `broken wikilink: [[${link}]]` });
      }
    }
  }

  // R11.5 — a debrief nobody indexed is a debrief nobody finds.
  //
  // `WIKI.md`'s Index is the entry point the wiki-first rule tells every agent
  // to skim, and the close-out checklist says to author a debrief — but nothing
  // tied the two together, so the Index quietly fell 39 debriefs behind (every
  // one from 2026-07-16 on). The vector index still found them; graph traversal
  // from the Index did not, which is the half the wiki exists for.
  //
  // Scoped to `debriefs/` deliberately: those are append-only records that must
  // stay reachable. Concept pages are linked from each other and from the zone
  // sections, so requiring an Index line for every one of them would be noise.
  const indexPage = pages.find((p) => p.type === "schema");
  if (indexPage !== undefined) {
    for (const page of pages) {
      if (!page.relPath.startsWith("debriefs/")) continue;
      if (indexPage.body.includes(page.relPath)) continue;
      issues.push({
        relPath: page.relPath,
        message: "not listed in WIKI.md — add an Index line so graph traversal can reach it",
      });
    }
  }

  const outside = await checkProseOutsideWiki(options?.projectDir);
  issues.push(...outside.issues);

  return {
    pagesChecked: pages.length,
    issues,
    ...(outside.proseChecked !== undefined && { proseChecked: outside.proseChecked }),
  };
}
