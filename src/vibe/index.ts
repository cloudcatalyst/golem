/**
 * The read path — what a coder, scribe or reviewer turn actually consults.
 *
 * Public surface of the vibe module. The contract is deliberately small: one
 * call returns the capped brief plus an INDEX of what else exists, and nothing
 * more. Guidelines and snippets are named here but not inlined, so the cost of
 * having a rich personal guide stays flat no matter how large it grows.
 */

export {
  dominantIndentWidth,
  emptyObservation,
  mergeObservations,
  observeSource,
  renderFormattingGuideline,
  type StyleObservation,
} from "./analyze.js";
export {
  type Candidate,
  type CandidateState,
  confirmCandidate,
  loadCandidates,
  QUIZ_THRESHOLD,
  quizzable,
  recordSignal,
  rejectCandidate,
} from "./candidates.js";
export {
  contentHash,
  isWriteTool,
  MAX_PENDING,
  type PendingWrite,
  pendingLedgerPath,
  recordAgentWrite,
  type SweepResult,
  sweepCorrections,
  writeTargetPath,
} from "./capture.js";
export { captureAfterWrite, captureOnPrompt } from "./hook.js";
export {
  BRIEF_MAX_BYTES,
  isGolemProject,
  type VibePaths,
  vibePaths,
} from "./paths.js";
export {
  applyConfirmed,
  BRIEF_PREFERENCE_LIMIT,
  CONFIRMED_BEGIN,
  CONFIRMED_END,
  type PromoteResult,
  preferenceLine,
  rankConfirmed,
  renderPreferences,
  spliceBlock,
} from "./promote.js";
export {
  collectSourceFiles,
  composeBrief,
  languageOf,
  localDate,
  MEASURED_BEGIN,
  MEASURED_END,
  type SeedResult,
  seedFromPath,
} from "./seed.js";
export {
  describeSignal,
  diffObservations,
  type SignalKind,
  type StyleSignal,
  signalKey,
} from "./signals.js";
export {
  capBrief,
  type OpenVibeOptions,
  openVibeStore,
  type SnippetProvenance,
  type SnippetRef,
  type VibeSource,
  type VibeSources,
  VibeStore,
  vibeSlug,
} from "./store.js";

import { type OpenVibeOptions, openVibeStore } from "./store.js";

/** What a coding/writing/review turn gets: the brief, and pointers to the rest. */
export interface VibeContext {
  readonly brief: string;
  readonly guidelines: readonly string[];
  readonly snippets: readonly string[];
  readonly bytes: number;
}

/**
 * Load the personal style context for a turn, or null when there is none.
 *
 * Null covers three ordinary cases and does not distinguish them, because the
 * caller does the same thing in all three: not a Golem project (the gate), no
 * guide written yet, or an empty brief. None of them is an error and none is
 * worth a warning — a session with no personal vibe simply proceeds without one.
 */
export async function loadVibeContext(opts: OpenVibeOptions = {}): Promise<VibeContext | null> {
  const store = openVibeStore(opts);
  if (store === null) return null;

  const brief = await store.brief();
  if (brief === null || brief.trim() === "") return null;

  const [guidelines, snippets] = await Promise.all([store.listGuidelines(), store.listSnippets()]);
  return {
    brief,
    guidelines,
    snippets: snippets.map((s) => `${s.lang}/${s.id}`),
    bytes: Buffer.byteLength(brief, "utf8"),
  };
}

/**
 * Render the context for injection into a prompt.
 *
 * The index is one line, not a list, for the same reason the brief is capped:
 * this text is paid for on every turn it appears in. A user with forty snippets
 * should not be paying forty lines to be told they exist.
 */
export function renderVibeContext(ctx: VibeContext): string {
  const index: string[] = [];
  if (ctx.guidelines.length > 0) {
    index.push(`guidelines: ${ctx.guidelines.join(", ")}`);
  }
  if (ctx.snippets.length > 0) {
    index.push(
      `snippets: ${ctx.snippets.length} (${ctx.snippets.slice(0, 6).join(", ")}${ctx.snippets.length > 6 ? ", …" : ""})`,
    );
  }
  return [
    ctx.brief.trimEnd(),
    "",
    index.length === 0
      ? "_No guidelines or snippets captured yet._"
      : `On demand under \`~/.golem/vibe/\` — ${index.join("; ")}. Read one only when it decides something.`,
    "",
  ].join("\n");
}
