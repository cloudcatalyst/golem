/**
 * The last leg: a confirmed candidate becomes something the guide actually says.
 *
 * Until this runs, a candidate is only a thing that was noticed. Confirmation is
 * the moment a measurement becomes a STATED PREFERENCE, and the two are kept
 * visibly apart everywhere — different blocks in the brief, different wording,
 * different provenance. An agent reading the guide has to be able to tell "you
 * were measured doing this" from "you said you want this", because only the
 * second is an instruction.
 *
 * Everything written here is generated and regenerated. The human's own prose
 * lives outside the markers and is never touched.
 */

import { type Candidate, loadCandidates } from "./candidates.js";
import { MEASURED_BEGIN } from "./seed.js";
import { describeSignal } from "./signals.js";
import type { VibeStore } from "./store.js";

export const CONFIRMED_BEGIN = "<!-- golem:vibe-confirmed:begin -->";
export const CONFIRMED_END = "<!-- golem:vibe-confirmed:end -->";

/**
 * How many confirmed preferences reach the always-loaded brief.
 *
 * The rest stay in `guidelines/preferences.md`, one read away. The brief is
 * capped, so an unbounded list here would simply push the measured habits out of
 * it — silently, and in a way nobody would notice until the advice got worse.
 */
export const BRIEF_PREFERENCE_LIMIT = 6;

/**
 * Replace the text between two markers, inserting the block at the end if the
 * markers are not there yet.
 *
 * Exported because the brief now carries two generated regions and a third is
 * plausible; one splice with one set of edge cases beats three.
 */
export function spliceBlock(
  text: string,
  begin: string,
  end: string,
  body: string,
  insertBefore?: string,
): string {
  const block = `${begin}\n${body}\n${end}`;
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  if (from !== -1 && to !== -1 && to >= from) {
    return `${text.slice(0, from)}${block}${text.slice(to + end.length)}`;
  }
  // First insertion. `insertBefore` matters because the brief is CAPPED and the
  // cap truncates from the bottom: appending confirmed preferences to the end
  // would make the most valuable part of the guide the first thing dropped.
  if (insertBefore !== undefined) {
    const at = text.indexOf(insertBefore);
    if (at !== -1) return `${text.slice(0, at)}${block}\n\n${text.slice(at)}`;
  }
  return `${text.trimEnd()}\n\n${block}\n`;
}

/** Confirmed candidates, strongest evidence first. */
export function rankConfirmed(candidates: readonly Candidate[]): Candidate[] {
  return candidates
    .filter((c) => c.state === "confirmed")
    .sort(
      (a, b) => b.files.length - a.files.length || b.seen - a.seen || a.key.localeCompare(b.key),
    );
}

/** One line of prose for a confirmed candidate, with its evidence attached. */
export function preferenceLine(c: Candidate): string {
  const prose = describeSignal({ kind: c.kind, from: c.from, to: c.to });
  const evidence = `${c.seen}× across ${c.files.length} file${c.files.length === 1 ? "" : "s"}`;
  const note = c.note === undefined ? "" : ` — "${c.note}"`;
  return `- ${prose} (${evidence})${note}`;
}

/** The full guideline page: every confirmed preference, with provenance. */
export function renderPreferences(candidates: readonly Candidate[], when: string): string {
  const confirmed = rankConfirmed(candidates);
  if (confirmed.length === 0) {
    return ["# Preferences — confirmed", "", `None confirmed yet, as of ${when}.`, ""].join("\n");
  }
  return [
    "# Preferences — confirmed",
    "",
    `${confirmed.length} preference(s) the human confirmed, as of ${when}. Each was`,
    "observed as a CORRECTION — the agent wrote one thing and they changed it —",
    "and then explicitly agreed to. Unlike the measured habits, these are",
    "instructions rather than observations.",
    "",
    ...confirmed.map(preferenceLine),
    "",
  ].join("\n");
}

export interface PromoteResult {
  readonly confirmed: number;
  readonly inBrief: number;
  readonly guidelinePath: string;
  readonly briefBytes: number;
}

/**
 * Write every confirmed preference into the guide.
 *
 * Idempotent: both targets are generated regions, so running it twice changes
 * nothing. Safe to call after every confirmation rather than at some end-of-run
 * moment that may never arrive.
 */
export async function applyConfirmed(store: VibeStore, when: string): Promise<PromoteResult> {
  const candidates = await loadCandidates(store);
  const confirmed = rankConfirmed(candidates);

  const guidelinePath = await store.writeGuideline(
    "preferences",
    renderPreferences(candidates, when),
  );

  const top = confirmed.slice(0, BRIEF_PREFERENCE_LIMIT);
  const body =
    top.length === 0
      ? "## Confirmed preferences\n\n_None yet._"
      : [
          "## Confirmed preferences",
          "",
          "Stated, not merely measured — follow these.",
          "",
          ...top.map((c) => `- ${describeSignal({ kind: c.kind, from: c.from, to: c.to })}`),
          ...(confirmed.length > top.length
            ? ["", `${confirmed.length - top.length} more in \`guidelines/preferences.md\`.`]
            : []),
        ].join("\n");

  const brief = (await store.brief()) ?? "# Personal vibe\n";
  const briefBytes = await store.writeBrief(
    spliceBlock(brief, CONFIRMED_BEGIN, CONFIRMED_END, body, MEASURED_BEGIN),
  );

  return { confirmed: confirmed.length, inBrief: top.length, guidelinePath, briefBytes };
}
