/**
 * R5.1 (WS-F1 / spec 20a) — durable task queue & auto-resume.
 */

export {
  escalateTask,
  type MultiplexDeps,
  mapWithConcurrency,
  type QueueRunResult,
  runQueueLocally,
  serviceTaskLocally,
} from "./multiplex.js";
export { buildResumeArgv, formatResumeCommand, type ResumeArgvOptions } from "./resume.js";
export { FileTaskStore, type TaskStore, tasksDir } from "./store.js";
export {
  type Checkpoint,
  createTask,
  isResumable,
  type NewTaskInput,
  TASK_STATES,
  type Task,
  type TaskState,
  TERMINAL_TASK_STATES,
  taskSchema,
  type Worktree,
} from "./types.js";
