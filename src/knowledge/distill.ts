/**
 * T3 (WS-W W3) — distillation: turn a raw fetched page into a wiki-ready
 * source-note draft via the local "summarizer" role, rather than storing (or
 * chunking) the raw text itself. The distilled text is in the model's own
 * words and cites the source URL (spec Decision 28's "distill, don't mirror"
 * rule); candidate wikilinks are drawn only from `existingTitles` the caller
 * already knows about — the model is never trusted to invent a page that
 * doesn't exist, which would otherwise show up as a broken link once the
 * draft is promoted into the wiki (`golem wiki check`).
 */

import { z } from "zod";
import type { ChatMessage, InferenceService } from "../interfaces/inference.js";

export interface DistillInput {
  readonly url: string;
  readonly rawText: string;
  /** Existing wiki page titles, for candidate-wikilink matching. */
  readonly existingTitles: readonly string[];
}

export interface DistillDraft {
  readonly title: string;
  readonly slug: string;
  readonly tags: readonly string[];
  /** Distilled summary in the model's own words, citing `url`. */
  readonly summary: string;
  /** Subset of `existingTitles` (canonical casing) the draft should link to. */
  readonly wikilinks: readonly string[];
}

/** The model's JSON response failed to parse or didn't match the expected shape. */
export class DistillParseError extends Error {
  constructor(
    message: string,
    readonly rawOutput: string,
  ) {
    super(message);
    this.name = "DistillParseError";
  }
}

const distillResultSchema = z.object({
  title: z.string().min(1),
  slug: z.string(),
  tags: z.array(z.string()),
  summary: z.string().min(1),
  wikilinks: z.array(z.string()),
});

const DISTILL_JSON_SCHEMA = {
  name: "distill_draft",
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      slug: { type: "string", description: "kebab-case, derived from the title" },
      tags: { type: "array", items: { type: "string" }, description: "2-5 kebab-case tags" },
      summary: {
        type: "string",
        description:
          "Facts in your own words, citing the source URL. Do not quote the page at length.",
      },
      wikilinks: {
        type: "array",
        items: { type: "string" },
        description: "Zero or more titles copied verbatim from the supplied existing-page list",
      },
    },
    required: ["title", "slug", "tags", "summary", "wikilinks"],
  },
} as const;

/** kebab-case: lowercase, non-alphanumeric runs collapsed to one hyphen, no leading/trailing hyphen. */
function kebabCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildPrompt(input: DistillInput): ChatMessage[] {
  const titleList =
    input.existingTitles.length > 0
      ? input.existingTitles.map((t) => `- ${t}`).join("\n")
      : "(none yet)";
  return [
    {
      role: "system",
      content:
        "You distill fetched web pages into short wiki source notes. Write the summary " +
        "in your own words — never quote or mirror the page at length. Always cite the " +
        "source URL in the summary. Suggest wikilinks ONLY from the existing-page list " +
        "given to you; never invent a page title that isn't on that list.",
    },
    {
      role: "user",
      content:
        `Source URL: ${input.url}\n\n` +
        `Existing wiki page titles (only these are valid wikilinks):\n${titleList}\n\n` +
        `Page content:\n${input.rawText}`,
    },
  ];
}

/**
 * Distill one raw page into a source-note draft. Errors from `inference.chat`
 * (endpoint unreachable, model missing, capability unavailable) propagate
 * unchanged — routing/fallback is the InferenceService's job, not this
 * module's.
 */
export async function distillPage(
  inference: InferenceService,
  input: DistillInput,
): Promise<DistillDraft> {
  const result = await inference.chat("summarizer", buildPrompt(input), {
    jsonSchema: DISTILL_JSON_SCHEMA,
  });

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(result.text);
  } catch {
    throw new DistillParseError("model response was not valid JSON", result.text);
  }
  const parsed = distillResultSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new DistillParseError(
      `model response did not match the expected shape: ${parsed.error.message}`,
      result.text,
    );
  }
  const draft = parsed.data;

  const slug = kebabCase(draft.slug) || kebabCase(draft.title);

  // Canonicalize casing to the caller's title, not the model's — the wiki's
  // titles are the source of truth for how a link should read.
  const canonicalByLower = new Map(input.existingTitles.map((t) => [t.toLowerCase(), t]));
  const wikilinks = [
    ...new Set(
      draft.wikilinks
        .map((link) => canonicalByLower.get(link.toLowerCase()))
        .filter((title): title is string => title !== undefined),
    ),
  ];

  return {
    title: draft.title,
    slug,
    tags: draft.tags,
    summary: draft.summary,
    wikilinks,
  };
}
