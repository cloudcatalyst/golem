/**
 * R8.9 — the change ledger (opt-in checkpoint / restore over shadow git refs).
 *
 * Design: `docs/plan/proposals/r8-context-economy.md` (R8d). The point is
 * context economy, not git: discarding a failed attempt is cheaper than
 * repairing one, and the wreckage of a repair stays in the window for every
 * later turn.
 */

export {
  type GitResult,
  gitOk,
  inspectRepo,
  type RepoFacts,
  type RepoState,
  type RepoUnavailable,
  type RunGitOptions,
  runGit,
} from "./git.js";
export {
  type Checkpoint,
  type CheckpointKind,
  type CreateCheckpointOptions,
  type CreateCheckpointResult,
  checkpointId,
  createCheckpoint,
  DEFAULT_KEEP,
  dropCheckpoint,
  LEDGER_REF_PREFIX,
  type LedgerOutcome,
  listCheckpoints,
  planRestore,
  pruneCheckpoints,
  type RestorePlan,
  type RestoreResult,
  resolveCheckpoint,
  restoreCheckpoint,
} from "./ledger.js";
