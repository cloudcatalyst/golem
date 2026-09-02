/**
 * Decision 52 — the output-side brevity stage.
 *
 * Unlike every other pipeline stage, this one does not try to make the request
 * smaller. It appends a fixed directive to the request's `system` block; the
 * MODEL then complies at generation time and produces fewer **output** tokens.
 * That is the whole point: output tokens are never cached and cost ~5× uncached
 * input / ~50× cache-read input, so this is the one axis Anthropic's prompt
 * caching does not blunt (verification-notes §87).
 *
 * Four properties are load-bearing, not stylistic:
 *
 * 1. **`system` only.** Nothing here touches `messages`, so tool-use blocks and
 *    the SSE response path stay byte-faithful (CLAUDE.md hard rule). This stage
 *    cannot weaken redaction either — it only appends a constant.
 * 2. **Byte-stable per level.** The directive is a `const` per level with no
 *    interpolation, so re-processing a previously-sent prefix reproduces
 *    identical bytes and Anthropic prompt-cache hits survive
 *    (verification-notes §14, mirrored from CompressionService's contract).
 *    Injection is therefore UNCONDITIONAL at a given level — never "only on the
 *    first turn", which would make the prefix flap and cost more than it saves.
 * 3. **Appended INTO the last text block, not added as a new one.** A new block
 *    placed after the client's `cache_control` breakpoint would sit outside the
 *    cached prefix and be re-billed at full price on every single turn — which
 *    would invert the economics this stage exists for. Concatenating into the
 *    last text block puts the directive inside the cached region, so it costs
 *    ~0.1× after the first turn. Changing level invalidates that entry once.
 * 4. **Marker-fenced and idempotent.** The fence makes the injection visible in
 *    a captured request, detectable so it is never doubled, and greppable when
 *    debugging a "why is Claude talking like this" report.
 *
 * The profile text is authored for Golem. The *idea* — and the specific insight
 * that a brevity directive must exempt code, commands and errors — comes from
 * Caveman (github.com/JuliusBrussee/caveman, MIT). No text is copied from it,
 * so this is attribution by courtesy rather than obligation; see
 * `docs/plan/proposals/golem-brevity.md` for why we vendor a profile instead of
 * depending on that package.
 */

import type { BrevityLevel } from "../interfaces/policy.js";
import { isRecord } from "../shared/json.js";

/** Marker fence version. Bump only if the fence GRAMMAR changes. */
const MARKER_VERSION = "1";
const MARKER_OPEN_PREFIX = "<golem-brevity";
const MARKER_CLOSE = "</golem-brevity>";

/**
 * Shared tail every profile ends with. Kept in one place because these are the
 * clauses that keep the directive safe: they protect verbatim payloads, protect
 * the response language, and scope the instruction to PROSE STYLE so it cannot
 * talk the model out of doing the work or calling tools.
 *
 * The last clause is that same guard from the other side: a level may not talk
 * the model into SILENCE either. Every profile below bans self-narration
 * outright, which is right for prose and wrong for a long agentic turn — it
 * produces turns of pure tool calls where the user cannot tell whether anything
 * is happening. So one short progress line is carved back out. It lives HERE
 * rather than in the three profiles because a rule repeated three times drifts,
 * and because it is a safety clause, not a style choice.
 */
const SAFETY_TAIL = [
  "Never abbreviate, paraphrase, translate or reformat code, commands, file paths,",
  "identifiers, URLs, quoted output, diffs or error text — reproduce those verbatim,",
  "in full. Never change the language you are writing in.",
  "This directive governs prose style ONLY: it must not change what you do, how",
  "thoroughly you do it, which tools you call, or how many steps you take. Omit",
  "words, never substance — if brevity would cost the reader information they need,",
  "keep the information.",
  "One carve-out from the no-narration rules above, because silence is not brevity:",
  "when you are about to call a tool, or would otherwise end a turn having produced",
  "only tool calls, first write ONE short line naming what you are doing or what you",
  "just found. A fragment is enough, such as: Reading the config loader. That line is",
  "a progress signal, not preamble — it must not restate the request, recap finished",
  "work, or offer further help. A turn with tool calls and no prose at all is a defect.",
].join("\n");

/** The directive body for each active level, weakest first. */
const PROFILE_BODY: Readonly<Record<Exclude<BrevityLevel, "off">, string>> = Object.freeze({
  lite: [
    "Write in a compressed register. Drop filler, hedging, preamble, self-narration",
    "and any restatement of the question. Do not open by summarising the request or",
    "close by offering further help. Keep complete sentences and normal grammar.",
  ].join("\n"),
  full: [
    "Write telegraphically. Sentence fragments are expected; drop articles, copulas",
    "and other function words wherever meaning survives without them. No preamble,",
    "no self-narration, no recap of what you just did, no closing offer of help.",
    "One clause per idea. Prefer a list to a paragraph.",
  ].join("\n"),
  ultra: [
    "Write at maximum compression. Minimum viable function words. Fragments only —",
    "no full sentences unless a fragment would be ambiguous. Strip every word that",
    "does not carry information. No preamble, no narration, no recap, no closing.",
  ].join("\n"),
});

/** Build the full marker-fenced block for a level. Pure and byte-stable. */
export function brevityDirective(level: Exclude<BrevityLevel, "off">): string {
  return [
    `${MARKER_OPEN_PREFIX} v="${MARKER_VERSION}" level="${level}">`,
    PROFILE_BODY[level],
    "",
    SAFETY_TAIL,
    MARKER_CLOSE,
  ].join("\n");
}

/**
 * True when `text` already carries a brevity directive we should not duplicate.
 *
 * Two cases, both real:
 * - **Ours.** A client echoing a previously-injected system block back at us.
 * - **The user's own Caveman install.** Caveman's Claude Code hook "writes a
 *   tiny flag file each session" so its skill activates *invisibly*
 *   (verification-notes §87) — the user need not have typed `/caveman`. Two
 *   stacked brevity directives is a worse outcome than none, so a plain
 *   case-insensitive mention of caveman in the system prompt is treated as
 *   "already handled". Deliberately a broad heuristic: a false positive costs
 *   one un-shortened response, a false negative costs a confusing double
 *   instruction the user cannot see the source of.
 */
export function hasExistingBrevityDirective(text: string): boolean {
  return text.includes(MARKER_OPEN_PREFIX) || /caveman/i.test(text);
}

/** A `system` content block that carries text we can append to. */
function isTextBlock(value: unknown): value is Record<string, unknown> & { text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

/** Separator between the client's own system text and our fence. */
const SEP = "\n\n";

export interface BrevityResult {
  /** The body to forward. Same reference as the input when nothing changed. */
  readonly body: Record<string, unknown>;
  /** Whether a directive was actually injected. */
  readonly injected: boolean;
  /**
   * Estimated input-token cost of the directive, so telemetry can report the
   * COST side of this stage rather than only the saving (Decision 52: never
   * report a brevity saving without its cost). 0 when nothing was injected.
   */
  readonly directiveTokens: number;
}

/**
 * Rough token estimate for the directive. Deliberately local and cheap — this
 * is a cost annotation on telemetry, not a billing figure, and the honest
 * number for billing is the upstream `usage` block.
 */
function estimateDirectiveTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Append the brevity directive for `level` to `body.system`.
 *
 * Fails open in every ambiguous case: an unrecognised `system` shape, or an
 * already-present directive, returns the body untouched rather than guessing.
 * A stage that garbles the system prompt would be far worse than one that
 * occasionally declines to shorten a response.
 */
export function applyBrevity(body: Record<string, unknown>, level: BrevityLevel): BrevityResult {
  const unchanged: BrevityResult = { body, injected: false, directiveTokens: 0 };
  if (level === "off") return unchanged;

  const directive = brevityDirective(level);
  const system = body.system;

  // No system block at all — create one. Valid per the Messages API, and the
  // only way to reach a client that sends none.
  if (system === undefined || system === null) {
    return {
      body: { ...body, system: directive },
      injected: true,
      directiveTokens: estimateDirectiveTokens(directive),
    };
  }

  if (typeof system === "string") {
    if (hasExistingBrevityDirective(system)) return unchanged;
    return {
      body: { ...body, system: `${system}${SEP}${directive}` },
      injected: true,
      directiveTokens: estimateDirectiveTokens(directive),
    };
  }

  if (Array.isArray(system)) {
    const blocks = system as readonly unknown[];
    const alreadyPresent = blocks.some(
      (block) => isTextBlock(block) && hasExistingBrevityDirective(block.text),
    );
    if (alreadyPresent) return unchanged;

    // Append into the LAST text block so the directive lands inside whatever
    // cached prefix that block anchors (see property 3 in the module doc). Any
    // `cache_control` on the block is preserved by the spread.
    let lastTextIndex = -1;
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      if (isTextBlock(blocks[i])) {
        lastTextIndex = i;
        break;
      }
    }

    if (lastTextIndex === -1) {
      // No text block to extend (e.g. an all-image system). Add one rather than
      // silently skipping — correctness over cache placement in a rare shape.
      return {
        body: { ...body, system: [...blocks, { type: "text", text: directive }] },
        injected: true,
        directiveTokens: estimateDirectiveTokens(directive),
      };
    }

    const target = blocks[lastTextIndex] as Record<string, unknown> & { text: string };
    const next = [...blocks];
    next[lastTextIndex] = { ...target, text: `${target.text}${SEP}${directive}` };
    return {
      body: { ...body, system: next },
      injected: true,
      directiveTokens: estimateDirectiveTokens(directive),
    };
  }

  // Unrecognised shape (number, boolean, object) — do not touch it.
  return unchanged;
}
