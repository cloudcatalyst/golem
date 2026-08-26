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
import {
  CapabilityUnavailableError,
  type ChatMessage,
  type ChatResult,
  type InferenceService,
  type Role,
} from "../interfaces/inference.js";

export interface RefineIssue {
  readonly severity: "high" | "medium" | "low";
  readonly description: string;
}

/**
 * Why refinement ended (LE2 observability). A bare `rounds: 0` used to hide the
 * difference between "the judge ran and found nothing" and "the judge never ran"
 * (its model wasn't pulled) — the latter silently no-op'd every call while the
 * tool falsely reported "nothing worth revising".
 */
export type RefineStatus =
  | "revised" // rounds 1: real issues found and a revision applied
  | "clean" // the critique ran and found nothing high/medium
  | "judge-unavailable" // no judge AND no drafter model could run the critique
  | "unparseable" // the critique returned but wasn't valid/matching JSON
  | "empty-revision" // the revision produced empty output; kept the draft
  | "error"; // an unexpected inference error

export interface RefineOutcome {
  /** The final draft — revised when the judge found real issues, else the original. */
  readonly text: string;
  /** Revision cycles performed: 0 (nothing worth revising / could not run) or 1. */
  readonly rounds: number;
  /** Why refinement ended — distinguishes a clean draft from a judge that never ran. */
  readonly status: RefineStatus;
  /** The judge's one-line summary, when the critique ran. */
  readonly critiqueSummary?: string;
  /** The issues the judge flagged, when a revision happened. */
  readonly issues?: readonly RefineIssue[];
  /** Which role produced the critique: "judge", or "drafter" when the judge model was unavailable. */
  readonly critiquedBy?: Role;
  /**
   * R13.11 — the concrete LOCAL model that produced the revision, set only when
   * `rounds > 0`.
   *
   * Refinement always runs on the local tiered service, including for a draft
   * that came from a remote target. Without this the caller could only attribute
   * the returned text to whatever produced the *original* draft, so a remote
   * draft rewritten by the local 7B was reported under the remote model's name.
   */
  readonly revisedBy?: string;
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
 * Run one optional draft → critique → revise cycle, with an explicit
 * {@link RefineStatus} so a no-op is never silent (LE2).
 *
 * The critique prefers the dedicated "judge" role but **falls back to the
 * "drafter" role** when no judge model is pulled — a drafter self-review is far
 * better than skipping refinement, and at many tiers the judge model isn't
 * installed while the drafter (just used to write the draft) is. Ollama honors
 * `response_format: json_schema`, so the critique parses.
 */
export async function refineDraft(
  inference: InferenceService,
  task: string,
  draft: string,
): Promise<RefineOutcome> {
  // 1. Critique: judge role, falling back to the drafter as self-reviewer.
  let critique: ChatResult;
  let critiquedBy: Role;
  try {
    critique = await inference.chat("judge", critiquePrompt(task, draft), {
      jsonSchema: CRITIQUE_JSON_SCHEMA,
    });
    critiquedBy = "judge";
  } catch (judgeErr) {
    if (!(judgeErr instanceof CapabilityUnavailableError)) {
      return { text: draft, rounds: 0, status: "error" };
    }
    try {
      critique = await inference.chat("drafter", critiquePrompt(task, draft), {
        jsonSchema: CRITIQUE_JSON_SCHEMA,
      });
      critiquedBy = "drafter";
    } catch {
      // Neither a judge nor the drafter model could run — surface it, don't hide it.
      return { text: draft, rounds: 0, status: "judge-unavailable" };
    }
  }

  // 2. Parse the critique.
  let parsed: ReturnType<typeof critiqueResultSchema.safeParse>;
  try {
    parsed = critiqueResultSchema.safeParse(JSON.parse(critique.text));
  } catch {
    return { text: draft, rounds: 0, status: "unparseable", critiquedBy };
  }
  if (!parsed.success) {
    return { text: draft, rounds: 0, status: "unparseable", critiquedBy };
  }
  if (!worthRevising(parsed.data)) {
    return {
      text: draft,
      rounds: 0,
      status: "clean",
      critiquedBy,
      critiqueSummary: parsed.data.summary,
    };
  }

  // 3. Revise once with the drafter.
  let revised: ChatResult;
  try {
    revised = await inference.chat("drafter", revisePrompt(task, draft, parsed.data.issues));
  } catch {
    return {
      text: draft,
      rounds: 0,
      status: "error",
      critiquedBy,
      critiqueSummary: parsed.data.summary,
      issues: parsed.data.issues,
    };
  }
  // An empty revision is worse than the draft — keep the draft in that case.
  if (revised.text.trim() === "") {
    return {
      text: draft,
      rounds: 0,
      status: "empty-revision",
      critiquedBy,
      critiqueSummary: parsed.data.summary,
      issues: parsed.data.issues,
    };
  }
  return {
    text: revised.text,
    rounds: 1,
    status: "revised",
    critiquedBy,
    revisedBy: revised.model,
    critiqueSummary: parsed.data.summary,
    issues: parsed.data.issues,
  };
}
