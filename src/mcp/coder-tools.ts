/**
 * Coder tool (draft / edit / refine). Extracted from server.ts (R8.28).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveCoderPrompt } from "../inference/coder-prompt.js";
import { CODER_AGENT_NAME } from "../inference/coder-route.js";
import {
  buildDispatchMessages,
  NoDrafterConfiguredError,
  type TargetDispatcher,
} from "../inference/target-dispatcher.js";
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
  /** R13.12 — `inference.coder_prompt`; undefined uses Golem's default. */
  readonly coderPrompt?: string | undefined;
  /**
   * R13.12 — the model `inference.default_coder` names, when it names a MODEL.
   * Present means every task here belongs to the `golem-coder` subagent, which
   * this process cannot start (see `Deps.harnessCoderModel`).
   */
  readonly harnessCoderModel?: string | undefined;
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

/** Normalize a task for repeat detection — whitespace and case carry no intent. */
function taskKey(task: string): string {
  return task.trim().toLowerCase().replace(/\s+/gu, " ");
}

export function registerCoderTool(
  server: McpServer,
  inference: InferenceService,
  grounding: CoderGroundingDeps,
  tel?: ToolTelemetry,
  dispatcher?: TargetDispatcher,
): void {
  const editEnabled = grounding.editEnabled === true;
  /**
   * R13.11 — how many times this server has been asked each task.
   *
   * A dispatched draft is stateless: the model sees one conversation built from
   * what THIS call passed and nothing else. So an agent that calls `coder`,
   * dislikes the draft, and calls again with the same task gets the same draft —
   * and reads that as the model looping, when it is really the harness asking
   * the same question twice. Counting repeats lets the reply say so, and point at
   * `previous_attempts`, which is the parameter that actually breaks the cycle.
   *
   * In-process and unbounded-by-session only: a Map in this closure, cleared when
   * the server exits. Nothing durable, because the observation is only useful
   * within the run that made it.
   */
  const taskCounts = new Map<string, number>();
  // R13.12 — resolved once here, not per call: it cannot change without the
  // server restarting, and both the dispatch `system` field and the generated
  // subagent body must read the same setting.
  const coderPromptText = resolveCoderPrompt(grounding.coderPrompt);
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
              "Which configured target to draft on; omit to use the configured " +
                "route (`inference.worker_targets.coder`, then " +
                "`inference.default_target`, then the session's own upstream). " +
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
      title: "Draft code or tests with a delegated model",
      description:
        'Delegate a task to Golem\'s "drafter" role instead of doing everything ' +
        "yourself — a first coding draft you then review and refine. Where it runs " +
        "is a ROUTING decision, not a property of this tool: `inference." +
        "worker_targets.coder`, then `inference.default_target`, then the session's " +
        "own upstream (R10.8). It is the local tiered Ollama model only when a " +
        "target points there, so do NOT assume the work stays on this machine — " +
        "anything non-local is REDACTED before dispatch and restored in the reply, " +
        "and the reply always says which model and target served it. With nothing " +
        "routed at all this tool DECLINES and tells you to do the work yourself. " +
        "By default it grounds the draft in relevant hits from Golem's local " +
        "knowledge base (project code, docs, wiki) so the draft fits this codebase; " +
        "pass `ground: false` to skip that. The drafter may be slower or " +
        "lower-quality than you: treat the result as a draft to review, not a final " +
        "answer. **Each call is a fresh conversation** — the model cannot see any " +
        "earlier call, so if a draft did not work, do not just call again with the " +
        "same task (you will get the same answer): pass `previous_attempts` so it " +
        "can see what it already tried and why that failed." +
        (editEnabled ? EDIT_MODE_DESCRIPTION : ""),
      inputSchema: {
        task: z.string().min(1).describe("The task or instructions for the drafter"),
        previous_attempts: z
          .array(
            z.object({
              draft: z.string().min(1).describe("What the drafter produced last time, verbatim"),
              problem: z
                .string()
                .min(1)
                .describe(
                  "What was actually wrong with it — the test that failed, the error, " +
                    "the behaviour you observed. Be specific: this is the only thing " +
                    "distinguishing this call from the one that already failed.",
                ),
            }),
          )
          .optional()
          .describe(
            "Earlier attempts at THIS task, oldest first, sent as real conversation " +
              "turns. Without this the drafter starts from zero every call and will " +
              "re-derive the same answer — pass it whenever you are retrying.",
          ),
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
        /** R13.11 — true when no drafter is routed and the caller should do the work. */
        declined: z.boolean().optional(),
        /** R13.12 — the subagent this work belongs to, when one is configured. */
        delegate_to: z.string().optional(),
        delegate_model: z.string().optional(),
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
    async ({
      task,
      target,
      mode,
      file,
      apply,
      context,
      ground,
      refine,
      project_id,
      previous_attempts,
    }) => {
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

      // R13.12 — `inference.default_coder` names a MODEL, so this work belongs to
      // the `golem-coder` subagent. Golem cannot start it: an MCP server exposes
      // tools to its client and cannot invoke the client's own tools, so there is
      // no call this handler could make that spawns a subagent.
      //
      // So say so, rather than quietly drafting somewhere else. Silence was the
      // alternative and it is worse: the generated definition would sit unused
      // while `coder` dispatched to a destination the user did not choose for this
      // purpose. Returned as an ORDINARY result — nothing is broken, the caller
      // simply has a better route available than this tool.
      //
      // An explicit `target` still wins: the caller named a destination for THIS
      // call, which outranks a default. `mode: "edit"` is also untouched — it is
      // the opt-in locally-validated edit path, not a routing decision.
      if (
        grounding.harnessCoderModel !== undefined &&
        grounding.harnessCoderModel !== "" &&
        target === undefined
      ) {
        return instrumented(tel, "coder", startMs, {
          content: [
            {
              type: "text",
              text:
                `**Golem** No draft — \`inference.default_coder\` routes coding work to the ` +
                `\`${CODER_AGENT_NAME}\` subagent on \`${grounding.harnessCoderModel}\`, and this ` +
                "tool cannot start a subagent (an MCP server cannot invoke its client's tools).\n\n" +
                `Delegate this task to the \`${CODER_AGENT_NAME}\` subagent instead — it gets real ` +
                "tool use and its own context, and its traffic still goes through Golem's proxy. " +
                "If you meant to draft on a configured target with this tool, name it explicitly " +
                "with `target`.",
            },
          ],
          structuredContent: {
            text: "",
            model: "",
            role: "drafter",
            declined: true,
            delegate_to: CODER_AGENT_NAME,
            delegate_model: grounding.harnessCoderModel,
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
      // R13.11 — count this ask BEFORE dispatching, so the note below is right
      // even when the dispatch throws.
      const key = taskKey(task);
      const askCount = (taskCounts.get(key) ?? 0) + 1;
      taskCounts.set(key, askCount);

      try {
        // R9.3: the dispatcher redacts before any non-local dispatch and restores
        // the placeholders in the reply. R10.8 wired it unconditionally — it
        // decides WHERE an unrouted draft goes, not just which of several targets
        // to offer — so this is the path for every call, with or without a named
        // target. The `inference.chat` branch below survives only for a caller
        // that constructs this tool without a dispatcher at all (tests, and an
        // embedding host that wires no target registry).
        const dispatched =
          dispatcher !== undefined
            ? await dispatcher.dispatch({
                role: "drafter",
                prompt,
                system: coderPromptText,
                worker: "coder",
                ...(previous_attempts !== undefined && previous_attempts.length > 0
                  ? { attempts: previous_attempts }
                  : {}),
                ...(target !== undefined ? { targetId: target } : {}),
              })
            : null;
        const result =
          dispatched !== null
            ? { text: dispatched.text, model: dispatched.model, role: "drafter" as const }
            : await inference.chat(
                "drafter",
                // Same conversation the dispatcher would have built, from the same
                // function — a second copy of the rendering would drift.
                buildDispatchMessages({
                  prompt,
                  system: coderPromptText,
                  ...(previous_attempts !== undefined && previous_attempts.length > 0
                    ? { attempts: previous_attempts }
                    : {}),
                }),
              );
        // Refinement stays on the LOCAL service: it is a cheap critique loop,
        // and sending the draft out a second time would double the egress for
        // no benefit the target was chosen for.
        const refined = refine === true ? await refineDraft(inference, task, result.text) : null;
        const finalText = refined !== null ? refined.text : result.text;
        // R13.11 — attribute the text that is actually being returned. Refinement
        // runs on the LOCAL service even when the draft came from a remote
        // target, so a revised remote draft was being reported under the remote
        // model's name while the words on screen were the local 7B's.
        const revisedLocally = refined !== null && refined.rounds > 0;
        const attributedModel = revisedLocally
          ? `${result.model}, revised locally by ${refined?.revisedBy ?? "the local model"}`
          : result.model;
        const groundedNote =
          grounded !== null ? ` Grounded on ${grounded.sources.length} local source(s).` : "";
        const refinedNote = refined === null ? "" : refineNote(refined);
        // R13.11 — a dispatched draft is a fresh conversation every call, so the
        // same task asked twice returns the same answer. That reads as the model
        // looping when it is really the harness re-asking; say so, and name the
        // parameter that breaks the cycle.
        const repeatNote =
          askCount > 1 && (previous_attempts === undefined || previous_attempts.length === 0)
            ? ` NOTE: this is ask #${askCount} for this same task and you passed no ` +
              "`previous_attempts` — the drafter cannot see any earlier call, so this " +
              "answer is derived from scratch and will keep matching the last one. Pass " +
              "`previous_attempts` with what it produced and what was wrong, or do the " +
              "work yourself."
            : "";
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
              text: `**Golem** Used ${attributedModel} ${whereNote} — verify independently.${groundedNote}${refinedNote}${repeatNote}\n\n${finalText}`,
            },
          ],
          structuredContent: {
            text: finalText,
            model: attributedModel,
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
        // R13.11 — a decline is not a failure. Nothing routes `coder` and the
        // session's own upstream cannot be dispatched to on Golem's behalf, so
        // there is no drafter to delegate to; the work falls back to the caller,
        // which is what an unconfigured project should do. Returned as an ORDINARY
        // result (no `isError`) precisely so it reads as "do it yourself" rather
        // than "Golem is broken" — the bare 401 this replaces read as the latter.
        if (err instanceof NoDrafterConfiguredError) {
          return instrumented(tel, "coder", startMs, {
            content: [
              {
                type: "text",
                text:
                  `**Golem** No draft — ${err.message}\n\n` +
                  "Nothing is wrong with your configuration; `coder` is simply not " +
                  "routed anywhere in this project. Proceed with the task directly.",
              },
            ],
            structuredContent: { text: "", model: "", role: "drafter", declined: true },
          });
        }
        const msg = backendUnavailableMessage(err);
        if (msg !== null) return errorResult(msg);
        throw err;
      }
    },
  );
}
