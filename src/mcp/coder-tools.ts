/**
 * Coder tool (draft / edit / refine). Extracted from server.ts (R8.28).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TargetDispatcher } from "../inference/target-dispatcher.js";
import type { InferenceService, KnowledgeBase, WikiReader } from "../interfaces/index.js";
import { type RefineOutcome, refineDraft } from "./coder-refine.js";
import { backendUnavailableMessage, gatherGrounding } from "./search.js";
import { errorResult, instrumented, type ToolTelemetry } from "./shared.js";

/**
 * R4.2 — grounding surface passed to the coder tool (all optional but `defaultProjectId`).
 */
interface CoderGroundingDeps {
  readonly knowledge?: KnowledgeBase | undefined;
  readonly wiki?: WikiReader | undefined;
  readonly wikiDir?: string | undefined;
  readonly rerank?: InferenceService | undefined;
  readonly defaultProjectId: string;
  /** R8.7 — filesystem root `mode: "edit"` resolves and contains paths against. */
  readonly projectRootDir?: string | undefined;
  /**
   * R8.7 — offer the `edit` mode at all (`inference.local_editor_enabled`).
   * Its schema is omitted when false, so the mode costs nothing when unused.
   */
  readonly editEnabled?: boolean | undefined;
}

/**
 * Human-readable coder note for a refinement outcome. LE2: this must be
 * truthful — a skipped refine (no judge model, parse failure) never reads as a
 * clean "nothing worth revising".
 */
function refineNote(r: RefineOutcome): string {
  const by = r.critiquedBy === "drafter" ? " (drafter self-review)" : "";
  switch (r.status) {
    case "revised":
      return ` Refined ${r.rounds} round(s)${by}: ${r.critiqueSummary ?? "issues fixed"}.`;
    case "clean":
      return ` Reviewed${by} — nothing worth revising.`;
    case "judge-unavailable":
      return " Refine skipped — no local judge/drafter model available.";
    case "unparseable":
      return " Refine skipped — the critique was unparseable.";
    case "empty-revision":
      return " Refine skipped — the revision came back empty; kept the draft.";
    case "error":
      return " Refine skipped — the critique errored.";
  }
}

/**
 * R8.7 — the `edit` mode's schema half, added ONLY when the mode is enabled.
 */
const EDIT_MODE_DESCRIPTION =
  ' With `mode: "edit"` plus `file`, the local model rewrites that ONE small ' +
  "file from `task` and Golem validates the result (syntax must still parse, no " +
  "definition may disappear) — you get a diff to review instead of writing the " +
  "edit yourself; add `apply: true` to have Golem write it.";

const EDIT_MODE_SCHEMA = {
  mode: z
    .enum(["draft", "edit"])
    .optional()
    .describe(
      'Default "draft" returns text. "edit" needs `file`: the local model ' +
        "rewrites it and Golem validates the result before anything is written.",
    ),
  file: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Project-relative file to edit (mode "edit" only). Small files only — ' +
        "bigger ones are declined rather than guessed at.",
    ),
  apply: z
    .boolean()
    .optional()
    .describe(
      "Write the validated edit to disk (default false: propose a diff and " +
        "change nothing). Never writes an edit that failed validation.",
    ),
} as const;

export function registerCoderTool(
  server: McpServer,
  inference: InferenceService,
  grounding: CoderGroundingDeps,
  tel?: ToolTelemetry,
  dispatcher?: TargetDispatcher,
): void {
  const editEnabled = grounding.editEnabled === true;
  // R9.3: the conversation may pick a target, bounded to what config declares
  // AND marks agent-selectable. An enum (rather than a free string) is what
  // makes "can never reach anything undeclared" visible in the schema itself —
  // an ad-hoc URL or an account name is not expressible.
  const selectable = dispatcher?.selectableTargets() ?? [];
  // A single declared property type keeps the tool's shape inferable — a
  // conditionally-shaped object would erase every other parameter's type too.
  //
  // R10.8: `> 1`, not `> 0`. The dispatcher is now wired even for a project with
  // only the synthetic default target (it decides where an unrouted draft goes,
  // not just which of several targets to offer), so the schema gate has to be
  // the one that was always meant: offer the parameter when there is a CHOICE.
  // With a single target the enum would bill tokens on every request for a
  // parameter whose only legal value is the one already in use (§110).
  const targetSchema: { target?: z.ZodOptional<z.ZodType<string>> } =
    selectable.length > 1
      ? {
          target: z
            .enum(selectable.map((t) => t.id) as [string, ...string[]])
            .optional()
            .describe(
              "Which configured target to draft on; omit for the local model. " +
                `Available: ${selectable
                  .map((t) => `${t.id} (${t.provider}, trust=${t.trust})`)
                  .join("; ")}. Anything non-local is REDACTED before dispatch — ` +
                "secrets and PII are replaced with placeholders and restored in the reply.",
            ),
        }
      : {};
  server.registerTool(
    "coder",
    {
      title: "Draft code or tests with a local model",
      description:
        'Delegate a task to Golem\'s local tiered Ollama inference (the "drafter" ' +
        "role — currently backed by a qwen2.5-coder-family model tuned for cheap " +
        "first-draft code generation) instead of doing everything yourself. Use it " +
        "to offload simple or initial work — e.g. a first coding draft — then " +
        "refine the result. By default it grounds the draft in relevant hits from " +
        "Golem's local knowledge base (project code, docs, wiki) so the draft fits " +
        "this codebase; pass `ground: false` to skip that. Nothing leaves the " +
        "machine, but the local model may be slower or lower-quality than you: " +
        "treat the result as a draft to review, not a final answer." +
        (editEnabled ? EDIT_MODE_DESCRIPTION : ""),
      inputSchema: {
        task: z.string().min(1).describe("The task or instructions for the local model"),
        ...targetSchema,
        ...(editEnabled ? EDIT_MODE_SCHEMA : {}),
        context: z
          .string()
          .optional()
          .describe("Extra context to include, e.g. relevant code or file contents"),
        ground: z
          .boolean()
          .optional()
          .describe(
            "Inject relevant project context from Golem's knowledge base into the " +
              "prompt (default true). Set false to draft without grounding.",
          ),
        refine: z
          .boolean()
          .optional()
          .describe(
            "Run one extra local judge→revise pass on the draft (default false). " +
              "Improves quality on non-trivial tasks at the cost of ~2× local latency; " +
              "skip it for small drafts.",
          ),
        project_id: z
          .string()
          .min(1)
          .optional()
          .describe("Project whose knowledge base to ground against; omit to use this session's"),
      },
      outputSchema: {
        text: z.string(),
        model: z.string(),
        role: z.string(),
        ...(editEnabled
          ? {
              edit: z
                .object({
                  status: z.enum(["applied", "proposed", "rejected"]),
                  path: z.string(),
                  validation: z.string(),
                  added: z.number().int().nonnegative(),
                  removed: z.number().int().nonnegative(),
                  syntax_checked: z.boolean(),
                  reason: z.string().optional(),
                })
                .optional(),
            }
          : {}),
        grounding: z
          .object({
            sources: z.array(z.string()),
            injected_chars: z.number().int().nonnegative(),
          })
          .optional(),
        refinement: z
          .object({
            rounds: z.number().int().nonnegative(),
            critique_summary: z.string().optional(),
            issues: z.array(z.object({ severity: z.string(), description: z.string() })).optional(),
          })
          .optional(),
      },
    },
    async ({ task, target, mode, file, apply, context, ground, refine, project_id }) => {
      const startMs = Date.now();

      if (mode === "edit") {
        if (file === undefined) {
          return errorResult('mode "edit" needs `file` — the one file to rewrite.');
        }
        if (grounding.projectRootDir === undefined) {
          return errorResult(
            "This MCP server has no project root configured, so an edit cannot be " +
              "contained to the project — refusing to edit any path.",
          );
        }
        const { coderEdit } = await import("./coder-edit.js");
        const outcome = await coderEdit(
          { inference, projectDir: grounding.projectRootDir },
          {
            instruction: task,
            file,
            ...(apply === undefined ? {} : { apply }),
            ...(context === undefined ? {} : { context }),
          },
        );
        const headline =
          outcome.status === "applied"
            ? `Applied to ${outcome.path} (+${outcome.added}/-${outcome.removed})`
            : outcome.status === "proposed"
              ? `Proposed for ${outcome.path} (+${outcome.added}/-${outcome.removed}) — nothing written; call again with apply: true to write it`
              : `Refused to edit ${outcome.path}`;
        const validationNote =
          outcome.status === "rejected"
            ? ` Validation: ${outcome.validation}.`
            : outcome.parseChecked
              ? " Validated: it still parses and defines everything it did before."
              : " NOT syntax-checked (no grammar for this file type).";
        const body = outcome.diff === null ? "" : `\n\n${outcome.diff}`;
        return instrumented(tel, "coder", startMs, {
          content: [
            {
              type: "text",
              text:
                `**Golem** ${headline}. Edited by ${outcome.model ?? "the local model"} — review the diff.` +
                `${validationNote}${outcome.reason === null ? "" : ` ${outcome.reason}`}${body}`,
            },
          ],
          structuredContent: {
            text: outcome.diff ?? outcome.reason ?? "",
            model: outcome.model ?? "",
            role: "drafter",
            edit: {
              status: outcome.status,
              path: outcome.path,
              validation: outcome.validation,
              added: outcome.added,
              removed: outcome.removed,
              syntax_checked: outcome.parseChecked,
              ...(outcome.reason === null ? {} : { reason: outcome.reason }),
            },
          },
        });
      }

      const grounded =
        ground !== false && grounding.knowledge !== undefined
          ? await gatherGrounding(task, project_id ?? grounding.defaultProjectId, {
              knowledge: grounding.knowledge,
              wiki: grounding.wiki,
              wikiDir: grounding.wikiDir,
              rerank: grounding.rerank,
            })
          : null;
      const sections: string[] = [];
      if (context !== undefined && context !== "") sections.push(`---\nContext:\n${context}`);
      if (grounded !== null) sections.push(grounded.block);
      const prompt = sections.length === 0 ? task : `${task}\n\n${sections.join("\n\n")}`;
      try {
        // R9.3: with a target named, go through the dispatcher — which redacts
        // before any non-local dispatch and restores the placeholders in the
        // reply. Without one, this is exactly the previous call.
        const dispatched =
          dispatcher !== undefined
            ? await dispatcher.dispatch({
                role: "drafter",
                prompt,
                worker: "coder",
                ...(target !== undefined ? { targetId: target } : {}),
              })
            : null;
        const result =
          dispatched !== null
            ? { text: dispatched.text, model: dispatched.model, role: "drafter" as const }
            : await inference.chat("drafter", [{ role: "user", content: prompt }]);
        // Refinement stays on the LOCAL service: it is a cheap critique loop,
        // and sending the draft out a second time would double the egress for
        // no benefit the target was chosen for.
        const refined = refine === true ? await refineDraft(inference, task, result.text) : null;
        const finalText = refined !== null ? refined.text : result.text;
        const groundedNote =
          grounded !== null ? ` Grounded on ${grounded.sources.length} local source(s).` : "";
        const refinedNote = refined === null ? "" : refineNote(refined);
        // Say where it ran and whether anything was redacted — a remote draft
        // must never read like a local one.
        //
        // R10.8: also say WHY that target. A draft that went to the harness's
        // own upstream because nothing named a target reads identically to one
        // the user routed there deliberately, and only the first case means
        // their `worker_targets`/`default_target` is not doing what they think.
        const whereNote =
          dispatched === null
            ? "locally"
            : `on target "${dispatched.targetId}" (trust=${dispatched.trust}` +
              (dispatched.route === "harness"
                ? "; the harness default upstream — no target is configured for `coder`"
                : dispatched.route === "default_target"
                  ? "; via inference.default_target"
                  : dispatched.route === "worker"
                    ? "; via inference.worker_targets.coder"
                    : "") +
              (dispatched.redactedCount > 0
                ? `; ${dispatched.redactedCount} secret(s) redacted before dispatch, restored here`
                : "") +
              ")";
        return instrumented(tel, "coder", startMs, {
          content: [
            {
              type: "text",
              text: `**Golem** Used ${result.model} ${whereNote} — verify independently.${groundedNote}${refinedNote}\n\n${finalText}`,
            },
          ],
          structuredContent: {
            text: finalText,
            model: result.model,
            role: result.role,
            ...(dispatched !== null
              ? {
                  target: dispatched.targetId,
                  trust: dispatched.trust,
                  // R10.8: which step of the chain picked it, so a caller reading
                  // the structured result can tell a routed draft from a default.
                  route: dispatched.route,
                  redacted_count: dispatched.redactedCount,
                }
              : {}),
            ...(grounded !== null
              ? { grounding: { sources: grounded.sources, injected_chars: grounded.chars } }
              : {}),
            ...(refined !== null
              ? {
                  refinement: {
                    rounds: refined.rounds,
                    status: refined.status,
                    ...(refined.critiquedBy !== undefined
                      ? { critiqued_by: refined.critiquedBy }
                      : {}),
                    ...(refined.critiqueSummary !== undefined
                      ? { critique_summary: refined.critiqueSummary }
                      : {}),
                    ...(refined.issues !== undefined ? { issues: [...refined.issues] } : {}),
                  },
                }
              : {}),
          },
        });
      } catch (err) {
        const msg = backendUnavailableMessage(err);
        if (msg !== null) return errorResult(msg);
        throw err;
      }
    },
  );
}
