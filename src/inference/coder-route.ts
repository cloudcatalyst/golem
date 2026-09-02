/**
 * R13.12 — resolve `inference.default_coder` into a MECHANISM.
 *
 * The setting deliberately accepts two shapes because the user's question is one
 * question ("who does the coding work?") while the answers are served by two
 * different machines:
 *
 *  - a **target id** → Golem dispatches to it itself, through the R9.1 registry
 *    and the R9.3 redaction floor. Unchanged behaviour.
 *  - a **model id** → the HARNESS runs a subagent on that model. Golem cannot do
 *    this itself: an MCP server exposes tools to its client and cannot invoke the
 *    client's own tools, so there is no call `coder` could make that spawns a
 *    subagent. What Golem can do — and R13.12 does — is generate the agent
 *    definition at `init` time and, when a task arrives anyway, say so.
 *
 * ## Why a target id wins the ambiguity
 *
 * `claude-sonnet-5` and `anthropic` are both bare words; nothing about the string
 * says which set it came from. Declaring a target is a deliberate act, and
 * silently reading a declared target's id as a model name would send work
 * somewhere the user did not choose while reporting success — the exact failure
 * R10.8's fail-closed lookup exists to prevent. So resolution is tried first, and
 * only a value that resolves to NO target is read as a model.
 *
 * ## Why a non-resolving colon-shaped id raises instead
 *
 * Registry ids are `gateway:model` shaped. A value containing a colon that
 * resolves to nothing is far more likely a typo'd target than a model called
 * `openrouter:qwn/...`, and treating it as a model would produce an agent
 * definition naming a model that does not exist — a failure that surfaces later,
 * somewhere else, as "There's an issue with the selected model". Better to fail
 * here, naming both sets.
 */

import { listTargets, resolveTarget, type TargetRegistrySettings } from "../providers/index.js";
import type { PersonaConfig } from "./personas.js";
import { workerTarget } from "./workers.js";

/**
 * The one subagent Golem generates, and the `.claude/agents/<name>.md` basename.
 *
 * Lives here rather than in `src/cli/agents.ts` (which owns the file's CONTENT)
 * because `src/mcp/` needs to name it too, in the decline it returns when
 * `default_coder` routes to the harness. `src/mcp/` importing from `src/cli/`
 * would invert the layering; `src/inference/` is upstream of both.
 */
export const CODER_AGENT_NAME = "golem-coder";

/** What `default_coder` (and `worker_targets`) resolved to. */
export type CoderRoute =
  /** Golem dispatches to this registry target itself. */
  | { readonly kind: "target"; readonly targetId: string; readonly via: "worker" | "default_coder" }
  /** The harness should run a subagent on this model; Golem cannot spawn one. */
  | { readonly kind: "harness"; readonly model: string }
  /** Nothing is configured — the work stays in the calling session (R13.11). */
  | { readonly kind: "none" };

/** Raised for a `default_coder` that names neither a target nor a plausible model. */
export class CoderRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoderRouteError";
  }
}

export interface CoderRouteInput {
  readonly settings: TargetRegistrySettings;
  /** `inference.worker_targets` — takes precedence, being the explicit low-level map. */
  readonly workerTargets?: Readonly<Record<string, string>> | undefined;
  /** The `coder` persona's model (`inference.personas.coder.model`). */
  readonly defaultCoder?: string | undefined;
  /** R14.2: `inference.personas` — the roster `workerTargets` keys are checked against. */
  readonly personas?: Readonly<Record<string, PersonaConfig>> | undefined;
}

/**
 * Whether `value` could be a model id at all.
 *
 * Deliberately permissive — provider model ids are opaque strings and Claude Code
 * forwards ones it cannot validate (verification-notes §114) — but not a blank
 * cheque: whitespace and shell-ish punctuation are refused, because the value
 * ends up as a `--model` argument and in generated frontmatter.
 */
function looksLikeModelId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/u.test(value);
}

/**
 * Resolve the coder mechanism. Pure; raises only for a `default_coder` that
 * cannot mean anything.
 */
export function resolveCoderRoute(input: CoderRouteInput): CoderRoute {
  const fromWorker = workerTarget(input.workerTargets, "coder", input.personas);
  if (fromWorker !== undefined) {
    return { kind: "target", targetId: fromWorker, via: "worker" };
  }

  const configured = input.defaultCoder?.trim();
  if (configured === undefined || configured === "") return { kind: "none" };

  // Try the registry first — see the header.
  if (resolveTarget(input.settings, configured).ok) {
    return { kind: "target", targetId: configured, via: "default_coder" };
  }

  // A bare GATEWAY id resolves to that gateway's first target, matching what
  // `resolveDefaultTargetId` does for `default_target` (R9.23). `resolveTarget`
  // itself does not do this — the rule lives in the default-target path — so it
  // is applied here rather than assumed, because `default_coder = "openrouter"`
  // meaning something different from `default_target = "openrouter"` would be a
  // gratuitous inconsistency between two adjacent settings.
  const viaGateway = listTargets(input.settings).find((t) => t.accountId === configured);
  if (viaGateway !== undefined) {
    return { kind: "target", targetId: viaGateway.id, via: "default_coder" };
  }

  if (configured.includes(":") || !looksLikeModelId(configured)) {
    const declared = listTargets(input.settings).map((t) => t.id);
    throw new CoderRouteError(
      `inference.personas.coder.model = "${configured}" names neither a configured target nor a ` +
        "usable model id. Configured targets: " +
        (declared.length > 0 ? declared.join(", ") : "(none)") +
        ". For a model, give a plain id like `claude-sonnet-5` or `sonnet` and the harness " +
        "will run a subagent on it; for a target, use one of the ids above.",
    );
  }

  return { kind: "harness", model: configured };
}

/**
 * Both keys set to different destinations — reported, never silently resolved.
 *
 * `worker_targets.coder` wins (it is the explicit low-level map R9.4 built for N
 * workers; `default_coder` is the friendly alias for the one that exists). A user
 * who set both almost certainly expects the newer key to apply, so the silence
 * would be the wrong kind of correct.
 */
export function coderRouteConflict(input: CoderRouteInput): string | undefined {
  const fromWorker = workerTarget(input.workerTargets, "coder", input.personas);
  const configured = input.defaultCoder?.trim();
  if (fromWorker === undefined || configured === undefined || configured === "") return undefined;
  if (fromWorker === configured) return undefined;
  return (
    `inference.worker_targets.coder = "${fromWorker}" and inference.personas.coder.model = ` +
    `"${configured}" name different destinations. worker_targets wins; unset it to use ` +
    "the persona's model."
  );
}
