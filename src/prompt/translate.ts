/**
 * R5.5 (WS-F7 / spec 20g) — prompt translation (SPIKE).
 *
 * Rewrites a raw user note into a clearer, higher-yield prompt using the LOCAL
 * model, grounded in the user's own accepted examples. Hard constraints from the
 * spec (never negotiable, even in a spike):
 *
 *  - **Never silently alter intent.** This ALWAYS returns a suggestion for the
 *    user to inspect; it never sends anything and never sits on the proxy path.
 *    The caller shows it; the user decides.
 *  - **Fully inspectable + disableable.** It only runs when explicitly invoked
 *    (`golem prompt translate`). There is no automatic rewrite anywhere.
 *
 * Demand-gated: this is a measurement spike, not a committed feature. See the
 * R5.5 debrief for the gate before any further investment.
 */

import type { InferenceService } from "../interfaces/inference.js";
import type { StyleExample } from "./style-store.js";

const SYSTEM =
  "You turn a developer's rough note into a clear, specific prompt for a coding " +
  "assistant. PRESERVE the intent exactly — never add requirements, scope, or " +
  "assumptions the note didn't state. Keep it concise. Output ONLY the rewritten " +
  "prompt, no preamble, no explanation.";

export interface TranslateDeps {
  readonly inference: InferenceService;
  /** Accepted (raw → translated) pairs used as few-shot style grounding. */
  readonly examples?: readonly StyleExample[];
}

export interface TranslateResult {
  readonly raw: string;
  /** The suggested rewrite, or null if the local model was unavailable. */
  readonly translated: string | null;
  /** How many accepted examples grounded the rewrite. */
  readonly examplesUsed: number;
  readonly error?: string;
}

/** Build the few-shot message list from accepted examples + the raw note. */
function buildMessages(raw: string, examples: readonly StyleExample[]) {
  const messages: { role: string; content: string }[] = [{ role: "system", content: SYSTEM }];
  // A few most-recent accepted pairs as one-shot demonstrations.
  for (const ex of examples.slice(-3)) {
    messages.push({ role: "user", content: ex.raw });
    messages.push({ role: "assistant", content: ex.translated });
  }
  messages.push({ role: "user", content: raw });
  return messages;
}

/**
 * Suggest a rewritten prompt for `raw`. Always returns a result object — a
 * suggestion to show, never an action. Degrades to `translated: null` (+error)
 * if the local model is unavailable.
 */
export async function translatePrompt(raw: string, deps: TranslateDeps): Promise<TranslateResult> {
  const examples = deps.examples ?? [];
  try {
    const res = await deps.inference.chat("drafter", buildMessages(raw, examples), {
      temperature: 0.2,
    });
    const translated = res.text.trim();
    return {
      raw,
      translated: translated.length > 0 ? translated : null,
      examplesUsed: Math.min(examples.length, 3),
      ...(translated.length === 0 ? { error: "local model returned an empty rewrite" } : {}),
    };
  } catch (err) {
    return {
      raw,
      translated: null,
      examplesUsed: 0,
      error: `local model unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
