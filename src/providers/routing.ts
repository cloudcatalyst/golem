/**
 * R9.2 — per-request route resolution (proposal `multi-target-routing.md`).
 *
 * A **pure function**: no I/O, no config loading, no clock. Everything that
 * decides where a request goes is an argument, so the precedence chain is
 * exhaustively unit-testable and the `reason` it returns is exactly what the
 * audit log records. The proxy does the effects; this decides.
 *
 * Every level of the chain is an **explicit, user-authored act**:
 *
 * | # | level | authored by |
 * |---|---|---|
 * | 1 | virtual model id in the body — `model: "golem/coder"` | user / sub-agent definition |
 * | 2 | header `x-golem-target: <id>` | hook / config |
 * | 3 | conversation binding (an optimisation over levels 1–2) | derived |
 * | 4 | `inference.default_target` | user config |
 *
 * **There is deliberately no rules engine and no suggestion channel.** Both were
 * dropped when diversion moved out-of-band. In particular, do not reintroduce a
 * rule keyed on a *per-turn* signal (thinking-enabled, token count, time of
 * day): that ping-pongs one conversation between targets and busts the
 * prompt-cache prefix on every switch, which costs far more than any routing
 * decision saves. The design makes that class of rule inexpressible on purpose —
 * the inputs here are per-*conversation* or per-*request-authored*, never
 * per-turn-observed.
 */

/**
 * The prefix that marks a model id as a Golem target selector rather than a
 * model to forward. `golem/coder` routes to target `coder`.
 *
 * A slash is safe: Claude Code disables its model-recognition check behind a
 * custom `ANTHROPIC_BASE_URL` and "passes any string through without checking
 * it" (verification-notes §114), and sub-agent frontmatter documents a full
 * model ID as an accepted `model` value. The namespace also cannot collide with
 * a real Anthropic id, which is the reason to prefix at all.
 */
export const VIRTUAL_MODEL_PREFIX = "golem/";

/** The header a hook or client sets to pick a target without touching the body. */
export const TARGET_HEADER = "x-golem-target";

export interface RouteInputs {
  /** The `model` field read from the request body, if any. */
  readonly bodyModel?: string | undefined;
  /** The `x-golem-target` header value, if any. */
  readonly headerTarget?: string | undefined;
  /**
   * A conversation already bound to a target by an earlier explicit act. An
   * optimisation only: level 1 is already stable across turns because the client
   * re-sends the same model id every turn.
   */
  readonly boundTarget?: string | undefined;
  /** `inference.default_target`, already resolved (including the `active_account` shim). */
  readonly defaultTarget: string;
}

/** Where a request goes, and why — `reason` is what the audit log records. */
export interface RouteDecision {
  readonly targetId: string;
  readonly reason: string;
  /** True when the decision came from a conversation binding rather than this request. */
  readonly sticky: boolean;
  /**
   * The virtual model id that selected the target, when level 1 chose it. The
   * transport must NOT forward this string upstream — no provider has a model
   * called `golem/coder`; the target's own configured model is sent instead.
   */
  readonly virtualModel?: string;
}

/** Whether a body `model` value is a Golem target selector rather than a real model id. */
export function isVirtualModelId(model: string | undefined): boolean {
  return model?.startsWith(VIRTUAL_MODEL_PREFIX) === true;
}

/**
 * The target id inside a virtual model id, or undefined when it is not one.
 * `golem/` with nothing after it is NOT a valid selector — it names no target,
 * and treating it as one would resolve the empty string against the registry.
 */
export function targetIdFromVirtualModel(model: string | undefined): string | undefined {
  if (!isVirtualModelId(model)) return undefined;
  const id = (model as string).slice(VIRTUAL_MODEL_PREFIX.length).trim();
  return id === "" ? undefined : id;
}

/**
 * Resolve the route for one request.
 *
 * Returns a decision for an id that may not exist — validating it against the
 * registry is the caller's job, because only the caller can fail closed with a
 * useful error naming the configured targets. Keeping the lookup out of here is
 * what lets this stay pure and total.
 */
export function resolveRoute(inputs: RouteInputs): RouteDecision {
  const virtual = targetIdFromVirtualModel(inputs.bodyModel);
  if (virtual !== undefined) {
    return {
      targetId: virtual,
      reason: `virtual model id "${inputs.bodyModel}" in the request body`,
      sticky: false,
      virtualModel: inputs.bodyModel as string,
    };
  }

  const header = inputs.headerTarget?.trim();
  if (header !== undefined && header !== "") {
    return {
      targetId: header,
      reason: `${TARGET_HEADER}: ${header}`,
      sticky: false,
    };
  }

  if (inputs.boundTarget !== undefined && inputs.boundTarget !== "") {
    return {
      targetId: inputs.boundTarget,
      reason: `conversation already bound to "${inputs.boundTarget}"`,
      sticky: true,
    };
  }

  return {
    targetId: inputs.defaultTarget,
    reason: "inference.default_target",
    sticky: false,
  };
}
