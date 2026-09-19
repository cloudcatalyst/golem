/**
 * Seeding: turn "here is code that has my vibe" into a guide.
 *
 * The user points at files or whole projects; this reads them, measures what can
 * be measured (`analyze.ts`), writes the measured formatting guideline, captures
 * a few exemplar snippets with provenance, and refreshes the brief.
 *
 * What it deliberately does NOT do is invent prose. The generated half of the
 * brief is bounded by markers and is regenerated on every seed; everything
 * outside those markers is the human's and is preserved verbatim. That is what
 * makes a re-seed safe to run at any time.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  dominantIndentWidth,
  emptyObservation,
  observeSource,
  renderFormattingGuideline,
  type StyleObservation,
} from "./analyze.js";
import type { VibeStore } from "./store.js";

/** Directories never worth reading: generated, vendored, or version control. */
const SKIP_DIRS = new Set([
  ".git",
  ".golem",
  ".claude",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "target",
  ".next",
  ".venv",
  "__pycache__",
]);

/** Extension -> the language label used for snippet grouping. */
const LANGS: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".cs": "csharp",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".swift": "swift",
  ".kt": "kotlin",
  ".sh": "shell",
  ".ps1": "powershell",
  ".sql": "sql",
  ".css": "css",
  ".scss": "css",
  ".html": "html",
};

export function languageOf(file: string): string | null {
  return LANGS[path.extname(file).toLowerCase()] ?? null;
}

/** Files above this are skipped: a generated bundle is not a style exemplar. */
const MAX_FILE_BYTES = 256 * 1024;

/** Collect readable source files under a path, depth-first and bounded. */
export async function collectSourceFiles(root: string, limit = 400): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (found.length >= limit) return;
    // `Dirent[]` explicitly: `ReturnType<typeof readdir>` resolves to the
    // Buffer-name overload, which types every `entry.name` as a Buffer.
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(full);
      } else if (entry.isFile() && languageOf(entry.name) !== null) {
        found.push(full);
      }
    }
  };

  const info = await stat(root);
  if (info.isFile()) return languageOf(root) === null ? [] : [root];
  await walk(root);
  return found.sort();
}

export interface SeedResult {
  readonly source: string;
  readonly filesRead: number;
  readonly filesSkipped: number;
  readonly snippetsWritten: number;
  readonly observation: StyleObservation;
  readonly guidelinePath: string;
  readonly briefBytes: number;
}

/** Markers bounding the generated half of the brief. Outside them is the human's. */
export const MEASURED_BEGIN = "<!-- golem:vibe-measured:begin -->";
export const MEASURED_END = "<!-- golem:vibe-measured:end -->";

/**
 * Rebuild the brief, keeping every word the human wrote.
 *
 * The generated block is replaced wholesale; anything before or after it — the
 * voice notes, the rules the quiz confirmed — survives untouched. On a first
 * seed there is nothing to preserve, so a starter scaffold is written instead,
 * with the voice section left empty for the human to fill.
 */
export function composeBrief(existing: string | null, o: StyleObservation, when: string): string {
  const width = dominantIndentWidth(o);
  const generated = [
    MEASURED_BEGIN,
    "## Measured habits",
    "",
    `Seeded from ${o.files} file(s) on ${when}. Full detail in \`guidelines/formatting.md\`;`,
    "exemplars in `snippets/`. Read those on demand — do not load them by habit.",
    "",
    `- Indent: ${o.indentTabs > o.indentSpaces ? "tabs" : `spaces${width === null ? "" : `, width ${width}`}`}`,
    `- Quotes: ${o.quoteDouble >= o.quoteSingle ? "double" : "single"}`,
    `- Semicolons: ${o.semicolonLines > o.terminatorCandidates / 2 ? "yes" : "no"}`,
    `- Typical line width: ${o.widthLe100 >= o.lines * 0.9 ? "within 100" : o.widthLe120 >= o.lines * 0.9 ? "within 120" : "long lines are common"}`,
    `- Comments: ${Math.round(((o.commentLine + o.commentBlock) / Math.max(1, o.lines)) * 100)}% of lines, ${o.commentsCounted === 0 ? "shape unknown" : `averaging ${Math.round(o.commentWords / o.commentsCounted)} words`}`,
    MEASURED_END,
  ].join("\n");

  if (existing?.includes(MEASURED_BEGIN) === true && existing.includes(MEASURED_END)) {
    const head = existing.slice(0, existing.indexOf(MEASURED_BEGIN));
    const tail = existing.slice(existing.indexOf(MEASURED_END) + MEASURED_END.length);
    return `${head}${generated}${tail}`;
  }

  const preserved = existing === null ? "" : `\n${existing.trim()}\n`;
  return [
    "# Personal vibe",
    "",
    "How this human writes code and prose. PERSONAL, not the project's: where a",
    "project's own committed conventions disagree, the project wins and the",
    "conflict is raised, never resolved silently.",
    "",
    generated,
    "",
    "## Voice",
    "",
    "_Not yet captured. `/vibe quiz` fills this in from real choices._",
    preserved,
  ].join("\n");
}

/**
 * Seed the guide from one path.
 *
 * Snippets are sampled, not exhaustive — the point is a handful of files that
 * read the way the user writes, so `sampleSnippets` files are captured whole and
 * the rest contribute only to the measurements.
 */
export async function seedFromPath(
  store: VibeStore,
  source: string,
  opts: { readonly now?: Date; readonly sampleSnippets?: number } = {},
): Promise<SeedResult> {
  const now = opts.now ?? new Date();
  // The user's LOCAL date. A guide seeded this evening and dated yesterday
  // reads like a stale file, and UTC does that for most of the day west of
  // Greenwich. The `capturedAt` timestamps stay ISO/UTC, where precision beats
  // familiarity.
  const when = localDate(now);
  const sampleSnippets = opts.sampleSnippets ?? 3;

  const abs = path.resolve(source);
  const info = await stat(abs);
  const files = await collectSourceFiles(abs);

  let observation = emptyObservation();
  let filesRead = 0;
  let filesSkipped = 0;
  const readable: { file: string; text: string }[] = [];

  for (const file of files) {
    try {
      const fileInfo = await stat(file);
      if (fileInfo.size > MAX_FILE_BYTES) {
        filesSkipped += 1;
        continue;
      }
      const text = await readFile(file, "utf8");
      observation = observeSource(text, observation);
      filesRead += 1;
      if (readable.length < sampleSnippets) readable.push({ file, text });
    } catch {
      filesSkipped += 1;
    }
  }

  const guidelinePath = await store.writeGuideline(
    "formatting",
    renderFormattingGuideline(observation, when),
  );

  let snippetsWritten = 0;
  for (const { file, text } of readable) {
    const lang = languageOf(file);
    if (lang === null) continue;
    await store.writeSnippet(path.basename(file, path.extname(file)), excerpt(text), {
      sourcePath: file,
      lang,
      capturedAt: now.toISOString(),
      note: `seeded from ${path.basename(abs)}`,
    });
    snippetsWritten += 1;
  }

  const briefBytes = await store.writeBrief(composeBrief(await store.brief(), observation, when));

  await store.recordSource({
    path: abs,
    kind: info.isFile() ? "file" : "directory",
    addedAt: now.toISOString(),
    lastSeededAt: now.toISOString(),
    files: filesRead,
  });

  return {
    source: abs,
    filesRead,
    filesSkipped,
    snippetsWritten,
    observation,
    guidelinePath,
    briefBytes,
  };
}

/** `YYYY-MM-DD` in the machine's own timezone. */
export function localDate(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** First ~60 lines: enough to show shape, small enough to stay a snippet. */
function excerpt(text: string, lines = 60): string {
  return text.split(/\r?\n/).slice(0, lines).join("\n");
}
