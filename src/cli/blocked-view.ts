/**
 * R12.2 — the blocked read model's **wire shape**, and the one function that
 * produces it.
 *
 * Two JSON surfaces carry this block: the consolidated session report served at
 * the dashboard's `/api/state` (`./session-report.ts`) and `golem status --json`
 * (`./status.ts`), which is what the VS Code extension reads. Both must describe
 * a block identically — the whole premise of R12.2 is one read model with many
 * renderers, and two hand-written projections is how that stops being true. So
 * the projection lives here, once, and both import it.
 *
 * Deliberately light: this module pulls only the read model itself, so the
 * `golem status` path does not acquire the telemetry/stats graph just to say
 * whether a session is waiting.
 *
 * snake_case, because both consumers are JSON APIs.
 */

import { z } from "zod";
import type { BlockKind, BlockStatus, ResolvedBlock } from "../hooks/session-state.js";

/** The tool and argument a human must judge — verbatim, and already redacted. */
export interface BlockedToolView {
  readonly name: string;
  /**
   * The argument itself. ADR-0006 §2 requires full text rather than a summary
   * for an `unknown`-class command, since that is the class a remote device may
   * actually approve. Redacted before it was written (ADR-0006 §1).
   */
  readonly argument?: string;
  /** ADR-0002's `classifyAction` class. R12.3 is what will act on it. */
  readonly action_class?: string;
}

export interface BlockedView {
  /**
   * Waiting on the human right now. Retained for every reader written before
   * R12.2 — but it cannot tell the three not-waiting cases apart, which is what
   * {@link BlockedView.status} is for.
   */
  readonly waiting: boolean;
  /**
   * `waiting` — someone is being asked something.
   * `abandoned` — blocked, but stale: **nobody ever wrote again.**
   * `clear` — a writer recorded that the human responded.
   * `unknown` — no readable state. Not the same as `clear`.
   */
  readonly status: BlockStatus;
  /** The notification text, redacted. */
  readonly reason?: string;
  /** A permission request, a plain question, or an idle turn. */
  readonly kind?: BlockKind;
  /** ISO-8601 timestamp the block began — the "since when". */
  readonly since?: string;
  /** Age of `since` in ms, so a stale block is visibly stale, not silently current. */
  readonly age_ms?: number;
  /** WHICH session — a phone may be watching more than one. */
  readonly session_id?: string;
  /** WHICH project — a session id does not name a working tree. */
  readonly project_name?: string;
  readonly tool?: BlockedToolView;
}

/**
 * Project a resolved block into the wire shape.
 *
 * Detail fields are carried for `waiting` **and** `abandoned`: an abandoned block
 * is exactly the case where a reader needs to see what it was and how old it is,
 * rather than being told that nothing is happening. `clear` and `unknown` carry
 * no details, because there is no block to describe.
 */
export function blockedView(resolved: ResolvedBlock): BlockedView {
  const { status, state, ageMs } = resolved;
  const base = { waiting: status === "waiting", status } as const;
  if (state === null || (status !== "waiting" && status !== "abandoned")) return base;
  return {
    ...base,
    since: state.ts,
    ...(ageMs !== undefined ? { age_ms: ageMs } : {}),
    ...(state.reason !== undefined ? { reason: state.reason } : {}),
    ...(state.kind !== undefined ? { kind: state.kind } : {}),
    ...(state.sessionId !== undefined ? { session_id: state.sessionId } : {}),
    ...(state.project !== undefined ? { project_name: state.project.name } : {}),
    ...(state.tool !== undefined
      ? {
          tool: {
            name: state.tool.name,
            ...(state.tool.argument !== undefined ? { argument: state.tool.argument } : {}),
            ...(state.tool.actionClass !== undefined
              ? { action_class: state.tool.actionClass }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * The zod contract for {@link BlockedView}, validated at the HTTP boundary
 * (internal code trusts the types). Lives beside the projection so the schema
 * and the shape cannot drift apart.
 */
export const blockedViewSchema = z.object({
  waiting: z.boolean(),
  status: z.enum(["waiting", "abandoned", "clear", "unknown"]),
  reason: z.string().optional(),
  kind: z.enum(["permission", "question", "idle"]).optional(),
  since: z.string().optional(),
  age_ms: z.number().optional(),
  session_id: z.string().optional(),
  project_name: z.string().optional(),
  tool: z
    .object({
      name: z.string(),
      argument: z.string().optional(),
      action_class: z.string().optional(),
    })
    .optional(),
});
