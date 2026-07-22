/**
 * R5.4 (WS-F4 / spec 20d) — cruise-control autonomy modes & approval gates.
 * Threat model: docs/wiki/decisions/ADR-0002-autonomy-approval-gates.md.
 */

export { type ActionClass, classifyAction, classifyBash } from "./classify.js";
export { decideGate, type GateDecision, type GateEmission } from "./gate.js";
export {
  type ActionLogEntry,
  actionLogPath,
  appendActionLog,
  decisionLabel,
  readActionLog,
} from "./log.js";
export {
  AUTONOMY_LEVEL_HELP,
  AUTONOMY_LEVELS,
  type AutonomyLevel,
  type AutonomyState,
  autonomyStatePath,
  DEFAULT_AUTONOMY_GATE_ENABLED,
  DEFAULT_AUTONOMY_LEVEL,
  parseAutonomyLevel,
  readAutonomyGateEnabled,
  readAutonomyLevel,
  readAutonomyState,
  setAutonomyGateEnabled,
  writeAutonomyLevel,
} from "./policy.js";
