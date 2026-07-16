/**
 * R4.4 — opt-in draft → judge → revise loop for the `coder` tool.
 *
 * One-shot drafts from a small local model are hit-or-miss. This adds a single
 * refinement cycle expressed entirely with the already-frozen
 * `InferenceService.chat()` + `jsonSchema` mechanism (the Decision 34 pattern,
 * see `src/knowledge/rerank.ts`): critique the draft with the "judge" role,
 * and if it flags real (high/medium) issues, have the "drafter" role produce a
 * corrected version.
 *
 * Like rerank, this is best-effort: any failure (unreachable model, malformed
 * JSON, empty revision) falls back to the original draft with `rounds: 0`. The
 * draft already succeeded before refinement ran — refinement must never turn
 * it into an error.
 */

import { z } from "zod";
import type { ChatMessage, InferenceService } from "../interfaces/inference.js";

export interface RefineIssue {
  readonly severity: "high" | "medium" | "low";
  readonly description: string;
}

export interface RefineOutcome {
  /** The final draft — revised when the judge found real issues, else the original. */
  readonly text: string;
  /** Revision cycles performed: 0 (nothing worth revising / failure) or 1. */
  readonly rounds: number;
  /** The judge's one-line summary, when a revision happened. */
  readonly critiqueSummary?: string;
  /** The issues the judge flagged, when a revision happened. */
  readonly issues?: readonly RefineIssue[];
}

/** JSON Schema the judge is forced to fill (same shape convention as rerank's). */
const CRITIQUE_JSON_SCHEMA = {
  name: "draft_critique",
  schema: {
    type: "object",
    properties: {
      hasIssues: {
        type: "boolean",
        description: "True if the draft is incorrect, incomplete, or would not work as-is.",
      },
      summary: { type: "string", description: "One sentence: the most important problem, if any." },
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["high", "medium", "low"] },
            description: { type: "string" },
          },
          required: ["severity", "description"],
        },
      },
    },
    required: ["hasIssues", "summary", "issues"],
  },
} as const;

const critiqueResultSchema = z.object({
  hasIssues: z.boolean(),
  summary: z.string(),
  issues: z.array(
    z.object({
      severity: z.enum(["high", "medium", "low"]),
      description: z.string(),
    }),
  ),
});

function critiquePrompt(task: string, draft: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a strict code reviewer. Given a task and a candidate draft, judge whether the " +
        "draft correctly and completely solves the task. List concrete problems with a severity " +
        "(high = wrong/broken, medium = incomplete/poor, low = nit). If the draft is fine, set " +
        "hasIssues to false and return an empty issues array. Do not rewrite the code here.",
    },
    { role: "user", content: `Task:\n${task}\n\nDraft:\n${draft}` },
  ];
}

function revisePrompt(task: string, draft: string, issues: readonly RefineIssue[]): ChatMessage[] {
  const critique = issues.map((i) => `- [${i.severity}] ${i.description}`).join("\n");
  return [
    {
      role: "system",
      content:
        "Revise the draft to fix the reviewer's issues. Output only the corrected result, in the " +
        "same form as the draft — no commentary, no explanation of the changes.",
    },
    {
      role: "user",
      content: `Task:\n${task}\n\nDraft:\n${draft}\n\nReviewer issues to fix:\n${critique}`,
    },
  ];
}

/** True when the critique found at least one high/medium issue worth a revision. */
function worthRevising(critique: z.infer<typeof critiqueResultSchema>): boolean {
  return (
    critique.hasIssues &&
    critique.issues.some((i) => i.severity === "high" || i.severity === "medium")
  );
}

/**
 * Run one optional draft → judge → revise cycle. Returns the original draft
 * unchanged (`rounds: 0`) when the judge finds nothing worth revising or on any
 * failure; returns the revised text (`rounds: 1`) with the critique otherwise.
 */
export async function refineDraft(
  inference: InferenceService,
  task: string,
  draft: string,
): Promise<RefineOutcome> {
  try {
    const critiqueResult = await inference.chat("judge", critiquePrompt(task, draft), {
      jsonSchema: CRITIQUE_JSON_SCHEMA,
    });
    const parsed = critiqueResultSchema.safeParse(JSON.parse(critiqueResult.text));
    if (!parsed.success || !worthRevising(parsed.data)) {
      return { text: draft, rounds: 0 };
    }
    const revised = await inference.chat("drafter", revisePrompt(task, draft, parsed.data.issues));
    // An empty revision is worse than the draft — keep the draft in that case.
    if (revised.text.trim() === "") {
      return { text: draft, rounds: 0 };
    }
    return {
      text: revised.text,
      rounds: 1,
      critiqueSummary: parsed.data.summary,
      issues: parsed.data.issues,
    };
  } catch {
    return { text: draft, rounds: 0 };
  }
}
