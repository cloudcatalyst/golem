/**
 * R14.2 — which LANE staffs a persona.
 *
 * R13.12 settled the underlying question for one worker; this generalises it to
 * the whole bench without changing the answer:
 *
 *  - a **registry target** → the `worker` lane. Golem dispatches to it itself,
 *    through the R9.1 registry and the R9.3 redaction floor, as a bounded
 *    single-shot. This is what a weak or local model gets, because a 4B model
 *    cannot drive an agent loop.
 *  - a **model id** → the `agent` lane. The HARNESS runs a subagent on that
 *    model. Golem cannot do this itself — an MCP server exposes tools to its
 *    client and cannot invoke the client's own tools, so there is no call that
 *    spawns a subagent. What Golem can do is generate the definition (R14.3) and,
 *    when work arrives anyway, say so.
 *  - **unstaffed** → nothing. The work stays in the calling session.
 *
 * ## Why a target id wins the ambiguity
 *
 * `claude-sonnet-5` and `anthropic` are both bare words; nothing about the string
 * says which set it came from. Declaring a target is a deliberate act, and
 * silently reading a declared target's id as a model name would send work
 * somewhere the user did not choose while reporting success — the failure
 * R10.8's fail-closed lookup exists to prevent. So resolution is tried against
 * the registry first, and only a value that resolves to NO target is read as a
 * model.
 *
 * ## Why a non-resolving colon-shaped id raises
 *
 * Registry ids are `gateway:model` shaped. A value containing a colon that
 * resolves to nothing is far more likely a typo'd target than a model called
 * `openrouter:qwn/...`, and treating it as a model would generate an agent
 * definition naming a model that does not exist — surfacing later, somewhere
 * else, as "There's an issue with the selected model". Better to fail here,
 * naming both sets.
 *
 * This module is the ONE implementation of that chain. `coder-route.ts` now
 * delegates to it rather than keeping a second copy — a second answer to "where
 * does this work go" is exactly what retiring `default_coder` was about.
 */

import { listTargets, resolveTarget, type TargetRegistrySettings } from "../providers/index.js";
import { effectivePersona, type PersonaConfig } from "./personas.js";

/** Where a persona's work actually goes. */
export type PersonaLane =
  /** Golem dispatches to this registry target itself (bounded, single-shot). */
  | {
      readonly kind: "worker";
      readonly targetId: string;
      readonly via: "worker_targets" | "persona";
    }
  /** The harness runs a subagent on this model; Golem cannot spawn one. */
  | { readonly kind: "agent"; readonly model: string }
  /** Unstaffed, undeclared, or human-owned — the work stays in the calling session. */
  | { readonly kind: "unstaffed"; readonly reason: "undeclared" | "no-model" | "owner-user" };

/** Raised for a persona model that names neither a target nor a plausible model. */
export class PersonaLaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaLaneError";
  }
}

export interface PersonaLaneInput {
  readonly settings: TargetRegistrySettings;
  /** The whole bench, so an undeclared id is distinguishable from an unstaffed one. */
  readonly personas: Readonly<Record<string, PersonaConfig>>;
  readonly personaId: string;
  /** `inference.worker_targets` — the explicit low-level map, which still wins. */
  readonly workerTargets?: Readonly<Record<string, string>> | undefined;
}

/**
 * Whether `value` could be a model id at all.
 *
 * Deliberately permissive — provider model ids are opaque strings and Claude Code
 * forwards ones it cannot validate (verification-notes §114) — but not a blank
 * cheque: whitespace and shell-ish punctuation are refused, because the value
 * ends up as a `--model` argument and in generated frontmatter.
 */
export function looksLikeModelId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/u.test(value);
}

/** Resolve one persona's lane. Pure; raises only for a model that cannot mean anything. */
export function resolvePersonaLane(input: PersonaLaneInput): PersonaLane {
  const { personaId, personas } = input;

  const config = personas[personaId];
  // An undeclared persona resolves to NOTHING, including through
  // `worker_targets`. That preserves R9.4's discipline exactly: a
  // `worker_targets` key naming no worker is a config typo, reported by
  // {@link unknownWorkerWarnings}, never a route. Honouring it here would make
  // the warning a lie — the key would both "do nothing" and send work somewhere.
  if (config === undefined) return { kind: "unstaffed", reason: "undeclared" };

  // For a DECLARED persona, `worker_targets` still wins: it is the explicit
  // low-level map, and keeping its precedence is what leaves R9.4 configs
  // working unchanged.
  const fromWorker = input.workerTargets?.[personaId];
  if (fromWorker !== undefined && fromWorker !== "") {
    return { kind: "worker", targetId: fromWorker, via: "worker_targets" };
  }

  const persona = effectivePersona(personaId, config);
  if (!persona.staffed) return { kind: "unstaffed", reason: "no-model" };
  // The permission axis outranks staffing: a role only a human fills is never
  // dispatched, however it is configured.
  if (!persona.dispatchable) return { kind: "unstaffed", reason: "owner-user" };

  const configured = (persona.model ?? "").trim();

  // Registry first — see the header.
  if (resolveTarget(input.settings, configured).ok) {
    return { kind: "worker", targetId: configured, via: "persona" };
  }

  // A bare GATEWAY id resolves to that gateway's first target, matching what
  // `resolveDefaultTargetId` does for `default_target` (R9.23). Applied here
  // rather than assumed, because a persona model meaning something different
  // from `default_target` for the same string would be a gratuitous
  // inconsistency between two adjacent settings.
  const viaGateway = listTargets(input.settings).find((t) => t.accountId === configured);
  if (viaGateway !== undefined) {
    return { kind: "worker", targetId: viaGateway.id, via: "persona" };
  }

  if (configured.includes(":") || !looksLikeModelId(configured)) {
    const declared = listTargets(input.settings).map((t) => t.id);
    throw new PersonaLaneError(
      `inference.personas.${personaId}.model = "${configured}" names neither a configured ` +
        "target nor a usable model id. Configured targets: " +
        (declared.length > 0 ? declared.join(", ") : "(none)") +
        ". For a model, give a plain id like `claude-sonnet-5` or `sonnet` and the harness " +
        "will run a subagent on it; for a target, use one of the ids above.",
    );
  }

  return { kind: "agent", model: configured };
}

/**
 * Both keys set to different destinations — reported, never silently resolved.
 *
 * `worker_targets.<id>` wins (it is the explicit low-level map R9.4 built for N
 * workers). A user who set both almost certainly expects the newer key to apply,
 * so silence would be the wrong kind of correct.
 */
export function personaLaneConflict(input: PersonaLaneInput): string | undefined {
  const fromWorker = input.workerTargets?.[input.personaId];
  if (fromWorker === undefined || fromWorker === "") return undefined;
  const config = input.personas[input.personaId];
  if (config === undefined) return undefined;
  const configured = effectivePersona(input.personaId, config).model?.trim();
  if (configured === undefined || configured === "" || configured === fromWorker) return undefined;
  return (
    `inference.worker_targets.${input.personaId} = "${fromWorker}" and ` +
    `inference.personas.${input.personaId}.model = "${configured}" name different destinations. ` +
    "worker_targets wins; unset it to use the persona's model."
  );
}
