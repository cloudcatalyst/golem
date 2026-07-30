/**
 * R5.1 (WS-F1 / spec 20a) — durable task shape.
 *
 * Spec 20a's dogfooding origin: in-flight agent work was repeatedly lost to
 * session/credit limits. A task is a checkpointed unit — persisted so an
 * interruption re-queues it instead of losing it. This module is the zod
 * contract for one on-disk task file (`<project>/.golem/tasks/<id>.json`); the
 * store (`store.ts`) and the resume argv builder (`resume.ts`) build on it.
 *
 * Non-frozen seam (memo R5.1): lives under `src/tasks/`, NOT `src/interfaces/`,
 * so it can evolve as R5.3 (multiplexing) builds on it without the
 * frozen-contract ceremony. Fields are camelCase, matching the existing
 * session-state / proxy-state internal JSON precedent.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";

/** Lifecycle states. `blocked` = waiting on the human; `paused` = capacity-gated. */
export const TASK_STATES = [
  "queued",
  "running",
  "blocked",
  "paused",
  "done",
  "failed",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** A terminal state never auto-resumes. */
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "done",
  "failed",
  "cancelled",
]);

/**
 * Plan-task metadata (see `plan-task.ts` for the document format).
 *
 * Lives here rather than beside the store because `taskSchema` embeds it, and the
 * other direction would be a cycle. Deliberately small: every field answers a
 * question an agent asks in its first minute — who owns this, how big is it, where is
 * the design, what gate decides it, what is it waiting on — and none duplicates the
 * body.
 */
export const PLAN_TASK_OWNERS = ["agent", "user"] as const;
export type PlanTaskOwner = (typeof PLAN_TASK_OWNERS)[number];

export const PLAN_TASK_SIZES = ["S", "M", "L"] as const;
export type PlanTaskSize = (typeof PLAN_TASK_SIZES)[number];

export const planMetaSchema = z.object({
  /** `user` = an outward or credentialed act an agent must not take on its own. */
  owner: z.enum(PLAN_TASK_OWNERS).default("agent"),
  size: z.enum(PLAN_TASK_SIZES).default("M"),
  /** Where the design lives (memo, spec Decision, verification-notes §). */
  design: z.string().optional(),
  /** Task ids that must land first. */
  dependsOn: z.array(z.string()).default([]),
  /** Directories the work is expected to touch — a starting map, not a contract. */
  touches: z.array(z.string()).default([]),
  /**
   * Why this cannot start, when that is a fact about the world rather than a
   * dependency (no hardware, no credentials, needs a human decision). A task with
   * this set is visible-not-lost rather than actionable.
   */
  blocked: z.string().optional(),
  /** One-line definition of done / the gate that decides it. */
  gate: z.string().optional(),
});
export type PlanMeta = z.infer<typeof planMetaSchema>;

const checkpointSchema = z.object({
  /** Plan step label. */
  label: z.string(),
  status: z.enum(["pending", "done", "skipped", "failed"]),
  /** Optional idempotency key for a side-effecting step (re-verified on replay). */
  idempotencyKey: z.string().optional(),
  note: z.string().optional(),
  ts: z.string().optional(),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

const worktreeSchema = z.object({
  path: z.string(),
  baseCommit: z.string(),
  /** Files dirty at capture time — restored/re-verified on resume. */
  dirtyFiles: z.array(z.string()).default([]),
});
export type Worktree = z.infer<typeof worktreeSchema>;

export const taskSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  state: z.enum(TASK_STATES),
  /** The prompt/instructions the agent resumes with. */
  prompt: z.string(),
  /** Short human label for `task list` (defaults to a prompt prefix). */
  title: z.string().optional(),
  /** Agent type to relaunch as (advisory; defaults to the interactive agent). */
  agentType: z.string().optional(),
  /**
   * Claude Code session UUID (verification-notes §65). Set at launch via
   * `--session-id` so `--resume <id>` is deterministic later. Absent = a fresh
   * launch, or resume the most-recent via `--continue`.
   */
  sessionId: z.string().optional(),
  /** Prefer `claude --continue` (most-recent) over `--resume <id>`. */
  continueLatest: z.boolean().default(false),
  worktree: worktreeSchema.optional(),
  /** Task-level idempotency key (e.g. the PR/branch this task owns). */
  idempotencyKey: z.string().optional(),
  checkpoints: z.array(checkpointSchema).default([]),
  /**
   * Capacity gate (memo R5.1 option 1: user-declared reset window). Don't
   * auto-resume before this ISO time. Absent = resumable now.
   */
  notBefore: z.string().optional(),
  lastError: z.string().optional(),
  /** How many times this task has been resumed. */
  attempts: z.number().int().min(0).default(0),
  /**
   * R5.3 — the local model's servicing output (triage/draft/answer), attached
   * when the task was serviced locally. Additive, optional.
   */
  result: z.string().optional(),
  /** R5.3 — explicitly handed to the Claude tier (21a); prompt carries local grounding. */
  escalated: z.boolean().default(false),
  /**
   * Roadmap metadata, present only on a **plan-scoped** task — one persisted as a
   * committed document under `docs/plan/tasks/` rather than as local machine state
   * under `.golem/tasks/` (see `plan-task.ts`).
   *
   * Optional rather than a separate type on purpose: a parked session and a roadmap
   * item are the same concept with different lifetimes, so they share one schema and
   * one CLI. Its presence is also what tells a renderer which scope a task came from.
   */
  plan: planMetaSchema.optional(),
});
export type Task = z.infer<typeof taskSchema>;

/** Inputs for a brand-new task (everything else defaulted). */
export interface NewTaskInput {
  readonly prompt: string;
  readonly title?: string;
  readonly agentType?: string;
  readonly sessionId?: string;
  readonly continueLatest?: boolean;
  readonly idempotencyKey?: string;
  readonly notBefore?: string;
  readonly worktree?: Worktree;
}

/** Build a validated, queued task with timestamps. `nowIso`/`id` injectable for tests. */
export function createTask(
  input: NewTaskInput,
  nowIso: string = new Date().toISOString(),
  id: string = randomUUID(),
): Task {
  return taskSchema.parse({
    id,
    createdAt: nowIso,
    updatedAt: nowIso,
    state: "queued",
    prompt: input.prompt,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.agentType !== undefined ? { agentType: input.agentType } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    continueLatest: input.continueLatest ?? false,
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.notBefore !== undefined ? { notBefore: input.notBefore } : {}),
    ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
    checkpoints: [],
    attempts: 0,
  });
}

/** Is a task eligible to auto-resume now (non-terminal, capacity gate passed)? */
export function isResumable(task: Task, nowMs: number = Date.now()): boolean {
  if (TERMINAL_TASK_STATES.has(task.state)) return false;
  if (task.notBefore === undefined) return true;
  const t = Date.parse(task.notBefore);
  return !Number.isFinite(t) || t <= nowMs;
}
