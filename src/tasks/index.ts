/**
 * R5.1 (WS-F1 / spec 20a) — durable task queue & auto-resume.
 *
 * Two scopes share one `Task` shape and one `TaskStore` seam: **local** tasks under
 * `.golem/tasks/*.json` (machine state — parked sessions, snooze holds) and **plan**
 * tasks under `docs/plan/tasks/*.md` (committed roadmap work). See `plan-task.ts`.
 */

export {
  escalateTask,
  type MultiplexDeps,
  mapWithConcurrency,
  type QueueRunResult,
  runQueueLocally,
  serviceTaskLocally,
} from "./multiplex.js";
export {
  PlanTaskStore,
  parsePlanTask,
  planTaskSlug,
  planTasksDir,
  serializePlanTask,
} from "./plan-task.js";
export { buildResumeArgv, formatResumeCommand, type ResumeArgvOptions } from "./resume.js";
export { FileTaskStore, type TaskStore, tasksDir } from "./store.js";
export {
  type Checkpoint,
  createTask,
  isResumable,
  type NewTaskInput,
  PLAN_TASK_OWNERS,
  PLAN_TASK_SIZES,
  type PlanMeta,
  type PlanTaskOwner,
  type PlanTaskSize,
  planMetaSchema,
  TASK_STATES,
  type Task,
  type TaskState,
  TERMINAL_TASK_STATES,
  taskSchema,
  type Worktree,
} from "./types.js";
