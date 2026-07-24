/**
 * R4.5 — `golem wiki promote`: review a pending distill draft and apply it as a
 * real wiki page, closing the capture → distill → **promote** loop.
 *
 * Drafts accumulate in `.golem/distill/` (from `golem wiki distill` and
 * `golem note distill`) already shaped like a wiki page (frontmatter + body).
 * Promotion is the mechanical write: it routes the draft to its zone by `type`,
 * writes it through the same append-and-refine `upsertPage` semantics as
 * `wiki_upsert` (Decision 29 — union-merge frontmatter, dated separator, never
 * a wholesale rewrite), then removes the consumed draft.
 *
 * The human approving IS the plan-gate (Decision 28): in a TTY the draft is
 * shown and confirmed; a non-interactive run refuses unless `--yes` was passed
 * (the Decision 26 consent convention, mirroring `runOllamaSetup`).
 */

import readline from "node:readline/promises";
import { UnknownWikiPageError, type WikiPageType } from "../interfaces/index.js";
import {
  type DraftFile,
  listDraftFiles,
  readDraftFile,
  removeDraftFile,
} from "../knowledge/distill-store.js";
import { FileWikiStore } from "../wiki/index.js";

/**
 * Zone directory each page type lives under (spec Decision 28 layout, amended by
 * Decision 44). `adr` is kept only so this map stays total over the frozen
 * `WikiPageType`; ADRs are NOT promoted into the wiki — decisions live at
 * `docs/decisions/`, and `runPromote` refuses an `adr` draft. The value is the
 * legacy relative path, never written for `adr`.
 */
const ZONE_FOR_TYPE: Readonly<Record<WikiPageType, string>> = {
  schema: "",
  concept: "concepts",
  entity: "entities",
  source: "sources",
  synthesis: "syntheses",
  question: "questions",
  artifact: "artifacts",
  adr: "decisions",
  debrief: "debriefs",
};

/** The wiki-relative path a draft promotes to, from its `type` (zone) + slug. */
export function draftTargetRelPath(draft: DraftFile): string {
  const zone = ZONE_FOR_TYPE[draft.frontmatter.type];
  return zone === "" ? `${draft.slug}.md` : `${zone}/${draft.slug}.md`;
}

/** Pending drafts awaiting promotion (thin alias over the draft store). */
export function listPendingPromotions(projectDir: string): Promise<DraftFile[]> {
  return listDraftFiles(projectDir);
}

/** Whole-days difference between two YYYY-MM-DD dates (0 if unparseable). */
function ageInDays(createdDate: string, nowIso: string): number {
  const created = Date.parse(`${createdDate}T00:00:00Z`);
  const now = Date.parse(nowIso);
  if (Number.isNaN(created) || Number.isNaN(now)) return 0;
  return Math.max(0, Math.floor((now - created) / 86_400_000));
}

/** Human-readable listing of pending drafts: id, target page, provenance, age. */
export function renderPendingPromotions(drafts: readonly DraftFile[], nowIso: string): string {
  if (drafts.length === 0) {
    return "No pending distill drafts to promote. Capture with `golem note`/`golem wiki distill`.\n";
  }
  const lines = ["Pending distill drafts (promote with: golem wiki promote <id>):", ""];
  for (const d of drafts) {
    const age = ageInDays(d.frontmatter.created, nowIso);
    const provenance = d.frontmatter.sources.length > 0 ? d.frontmatter.sources.join(", ") : "—";
    lines.push(`  ${d.slug}  [${d.frontmatter.type}]`);
    lines.push(`    → ${draftTargetRelPath(d)}`);
    lines.push(`    from ${provenance} · created ${d.frontmatter.created} (${age}d ago)`);
  }
  return `${lines.join("\n")}\n`;
}

/** A preview of a single draft, shown before the confirmation prompt. */
export function renderDraftPreview(draft: DraftFile): string {
  return [
    `Draft: ${draft.slug}`,
    `Title: ${draft.frontmatter.title}`,
    `Type:  ${draft.frontmatter.type}  →  ${draftTargetRelPath(draft)}`,
    `From:  ${draft.frontmatter.sources.join(", ") || "—"}`,
    "",
    draft.body.trimEnd(),
    "",
  ].join("\n");
}

/** Thrown when promotion can't get consent (non-TTY, no `--yes`). */
export class PromoteRefusedError extends Error {}

export type PromoteOutcome =
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "promoted";
      readonly slug: string;
      readonly relPath: string;
      readonly created: boolean;
    };

export interface PromoteOptions {
  readonly projectDir: string;
  readonly wikiDir: string;
  readonly slug: string;
  readonly nowIso: string;
  /** Skip the interactive confirmation (required for non-interactive promotion). */
  readonly yes: boolean;
  /** Test/override seam — defaults to `process.stdin.isTTY`. */
  readonly isTTY?: boolean;
  /** Test/override seam — defaults to a readline y/N prompt. */
  readonly confirm?: (question: string) => Promise<boolean>;
  /** Where the preview is written before prompting (defaults to stdout). */
  readonly onPreview?: (text: string) => void;
}

async function defaultConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Promote one draft by id (slug). Refuses without consent (non-TTY + no
 * `--yes`); in a TTY shows the draft and asks. On confirmation, upserts the
 * page (append-and-refine) and removes the draft. Returns `cancelled` if the
 * user declined.
 */
export async function runPromote(opts: PromoteOptions): Promise<PromoteOutcome> {
  const draft = await readDraftFile(opts.projectDir, opts.slug);
  if (draft === null) {
    throw new Error(`no pending draft "${opts.slug}" (see: golem wiki promote --list)`);
  }
  if (draft.frontmatter.type === "adr") {
    // ADRs are not a wiki zone (spec Decision 44) — decisions live at
    // docs/decisions/ under a stricter rule. Author them there directly.
    throw new Error(
      `"${opts.slug}" is an ADR — decisions live at docs/decisions/, outside the wiki ` +
        "(spec Decision 44). Author it there directly rather than promoting it into the wiki.",
    );
  }

  if (!opts.yes) {
    const isTTY = opts.isTTY ?? process.stdin.isTTY === true;
    if (!isTTY) {
      throw new PromoteRefusedError(
        `refusing to promote "${opts.slug}" without confirmation in a non-interactive ` +
          "session — re-run with --yes (or an explicit id in a TTY)",
      );
    }
    (opts.onPreview ?? ((t) => process.stdout.write(t)))(renderDraftPreview(draft));
    const confirm = opts.confirm ?? defaultConfirm;
    const accepted = await confirm(`Promote "${opts.slug}" to ${draftTargetRelPath(draft)}?`);
    if (!accepted) return { kind: "cancelled" };
  }

  const relPath = draftTargetRelPath(draft);
  const store = new FileWikiStore({ wikiDir: opts.wikiDir, now: () => opts.nowIso.slice(0, 10) });

  let existedBefore = true;
  try {
    await store.readPage(relPath);
  } catch (err) {
    if (err instanceof UnknownWikiPageError) existedBefore = false;
    else throw err;
  }

  await store.upsertPage({
    relPath,
    frontmatter: {
      title: draft.frontmatter.title,
      type: draft.frontmatter.type,
      tags: draft.frontmatter.tags,
      sources: draft.frontmatter.sources,
    },
    body: draft.body,
  });
  await removeDraftFile(opts.projectDir, opts.slug);

  return { kind: "promoted", slug: opts.slug, relPath, created: !existedBefore };
}
