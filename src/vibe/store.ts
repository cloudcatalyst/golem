/**
 * The personal vibe guide on disk, and the only door into it.
 *
 * Shape (all under `~/.golem/vibe/`):
 *
 * | path | role | reaches context |
 * |---|---|---|
 * | `VIBE.md` | the prose brief | ALWAYS, on coding/writing/review turns |
 * | `guidelines/<topic>.md` | formatting, naming, comments, voice | on demand |
 * | `snippets/<lang>/<id>.md` | exemplars with provenance | on demand |
 * | `candidates.jsonl` | unconfirmed observations awaiting a quiz | never |
 * | `sources.json` | what the guide was seeded from | never |
 *
 * That split IS the anti-bloat design. One small, capped brief is always on and
 * everything else is retrievable, so the guide can grow without growing the
 * prefix of every request.
 *
 * Two invariants this module exists to hold:
 *
 * 1. **Gated.** {@link openVibeStore} returns null outside a Golem project, and
 *    it decides that BEFORE touching the filesystem. A non-Golem directory
 *    performs no reads at all, rather than reads that happen to find nothing.
 * 2. **Redacted.** Every byte written here came out of the user's real source
 *    files, so it goes through the pipeline redactor first. A style guide is not
 *    a reason to copy a secret into the home directory.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultUserDir } from "../config/paths.js";
import { redactStandaloneText } from "../pipeline/redaction.js";
import { BRIEF_MAX_BYTES, isGolemProject, type VibePaths, vibePaths } from "./paths.js";

/** One seeded source: what the user pointed at, and when it was last read. */
export interface VibeSource {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly addedAt: string;
  readonly lastSeededAt?: string;
  readonly files?: number;
}

export interface VibeSources {
  readonly sources: readonly VibeSource[];
}

/** Where a snippet came from, so a reader can go and check it. */
export interface SnippetProvenance {
  readonly sourcePath: string;
  readonly lang: string;
  readonly note?: string;
  readonly capturedAt: string;
}

export interface SnippetRef {
  readonly lang: string;
  readonly id: string;
  readonly file: string;
}

export interface OpenVibeOptions {
  /** Directory the session is working in — the thing being gated on. */
  readonly cwd?: string;
  /** Override the user dir (tests; never in production). */
  readonly userDir?: string;
  /** Caps the upward walk for the project marker (tests). */
  readonly rootDir?: string;
  /** Override the home directory, which is never itself a project (tests). */
  readonly home?: string;
}

/**
 * Open the personal guide, or return null when this directory has no business
 * reading it.
 *
 * Null is the normal answer outside a Golem project — not an error, and not
 * something to report. The caller simply proceeds without a personal style.
 */
export function openVibeStore(opts: OpenVibeOptions = {}): VibeStore | null {
  const cwd = opts.cwd ?? process.cwd();
  // THE GATE — before any filesystem access to the guide.
  if (!isGolemProject(cwd, opts.rootDir, opts.home)) return null;
  return new VibeStore(vibePaths(opts.userDir ?? defaultUserDir()));
}

/** Slugify a topic or id into something safe to use as a filename. */
export function vibeSlug(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (slug === "") throw new Error("vibe: name must contain at least one alphanumeric character");
  return slug;
}

/**
 * Truncate the brief at a section boundary rather than mid-sentence.
 *
 * The cap is a promise about every future request, so it is enforced on write
 * and not merely documented. Cutting at a heading keeps the result readable;
 * cutting at the byte would leave half a word in every prompt.
 */
export function capBrief(text: string, maxBytes: number = BRIEF_MAX_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  let lastHeading = 0;
  for (const line of lines) {
    const cost = Buffer.byteLength(`${line}\n`, "utf8");
    if (bytes + cost > maxBytes) break;
    kept.push(line);
    bytes += cost;
    if (line.startsWith("#")) lastHeading = kept.length - 1;
  }
  // Prefer dropping the partial section entirely — a half-stated rule is worse
  // than an absent one, because the reader cannot tell it was cut.
  const cut = lastHeading > 0 ? kept.slice(0, lastHeading) : kept;
  return `${cut.join("\n").trimEnd()}\n`;
}

/** Markdown code fence, named so the snippet template needs no escaping. */
const FENCE = "```";

export class VibeStore {
  constructor(readonly paths: VibePaths) {}

  /** The always-loaded brief, or null when the guide has not been started. */
  async brief(): Promise<string | null> {
    try {
      return await readFile(this.paths.brief, "utf8");
    } catch {
      return null;
    }
  }

  /** Write the brief, redacted and capped. Returns the bytes actually stored. */
  async writeBrief(text: string): Promise<number> {
    const body = capBrief(redactStandaloneText(text));
    await mkdir(this.paths.root, { recursive: true });
    await writeFile(this.paths.brief, body, "utf8");
    return Buffer.byteLength(body, "utf8");
  }

  async listGuidelines(): Promise<string[]> {
    try {
      return (await readdir(this.paths.guidelines))
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.slice(0, -3))
        .sort();
    } catch {
      return [];
    }
  }

  async readGuideline(topic: string): Promise<string | null> {
    try {
      return await readFile(path.join(this.paths.guidelines, `${vibeSlug(topic)}.md`), "utf8");
    } catch {
      return null;
    }
  }

  async writeGuideline(topic: string, body: string): Promise<string> {
    const file = path.join(this.paths.guidelines, `${vibeSlug(topic)}.md`);
    await mkdir(this.paths.guidelines, { recursive: true });
    await writeFile(file, redactStandaloneText(body), "utf8");
    return file;
  }

  async listSnippets(): Promise<SnippetRef[]> {
    const out: SnippetRef[] = [];
    let langs: string[];
    try {
      langs = (await readdir(this.paths.snippets, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return out;
    }
    for (const lang of langs.sort()) {
      const dir = path.join(this.paths.snippets, lang);
      for (const f of (await readdir(dir)).filter((n) => n.endsWith(".md")).sort()) {
        out.push({ lang, id: f.slice(0, -3), file: path.join(dir, f) });
      }
    }
    return out;
  }

  async readSnippet(lang: string, id: string): Promise<string | null> {
    try {
      return await readFile(
        path.join(this.paths.snippets, vibeSlug(lang), `${vibeSlug(id)}.md`),
        "utf8",
      );
    } catch {
      return null;
    }
  }

  /**
   * Store one exemplar excerpt with its provenance.
   *
   * The body is redacted before it is written, never after — there is no window
   * in which the unredacted text exists on disk.
   */
  async writeSnippet(id: string, body: string, prov: SnippetProvenance): Promise<string> {
    const lang = vibeSlug(prov.lang);
    const dir = path.join(this.paths.snippets, lang);
    const file = path.join(dir, `${vibeSlug(id)}.md`);
    const page = [
      `# ${id}`,
      "",
      `- source: \`${prov.sourcePath}\``,
      `- language: ${prov.lang}`,
      `- captured: ${prov.capturedAt}`,
      ...(prov.note === undefined ? [] : [`- note: ${prov.note}`]),
      "",
      `${FENCE}${lang}`,
      body.trimEnd(),
      FENCE,
      "",
    ].join("\n");
    await mkdir(dir, { recursive: true });
    await writeFile(file, redactStandaloneText(page), "utf8");
    return file;
  }

  async sources(): Promise<VibeSources> {
    try {
      const parsed = JSON.parse(await readFile(this.paths.sources, "utf8")) as Partial<VibeSources>;
      return { sources: Array.isArray(parsed.sources) ? parsed.sources : [] };
    } catch {
      return { sources: [] };
    }
  }

  /** Add or refresh one source. Keyed on path, so a re-seed updates in place. */
  async recordSource(entry: VibeSource): Promise<void> {
    const current = await this.sources();
    const others = current.sources.filter((s) => s.path !== entry.path);
    const next: VibeSources = {
      sources: [...others, entry].sort((a, b) => a.path.localeCompare(b.path)),
    };
    await mkdir(this.paths.root, { recursive: true });
    await writeFile(this.paths.sources, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }
}
