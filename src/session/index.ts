/**
 * R13.3 — the session host, plus the two stores that predate it.
 *
 * `session-tree.ts` records content HASHES only (R8.S3). `conversation-store.ts`
 * records redacted turn TEXT (R13.2, ADR-0007 §6's argued exception). The host
 * is neither store — it is the thing that runs a session Golem owns.
 */

export { type ChatPageOptions, renderChatPage } from "./chat-page.js";
export {
  conversationIdFor,
  conversationStoreDir,
  LocalConversationStore,
} from "./conversation-store.js";
export {
  type HostEvent,
  HostedSession,
  type HostedSessionOptions,
  type HostPermissionDeniedEvent,
  type HostRateLimitEvent,
  type HostResultEvent,
  type HostStreamEvent,
  type HostTextEvent,
  type HostToolResultEvent,
  type HostToolUseEvent,
  normaliseEvent,
  RUNNER_BIN,
  runnerArgs,
  userMessageLine,
} from "./host.js";
export {
  decideHostGate,
  type HostAttachment,
  type HostDecision,
  type HostGateDecision,
  NOBODY_ATTACHED,
  resolveHostGate,
} from "./host-gate.js";
export {
  appendHostLog,
  HOST_LOG_MAX_LINES,
  type HostDecisionEntry,
  type HostLifecycleEntry,
  type HostLogEntry,
  type HostTurnEntry,
  hostLogPath,
  readHostLog,
  trimHostLog,
} from "./host-log.js";
export {
  findHostSession,
  forgetHostSession,
  type HostSessionRecord,
  hostRegistryPath,
  hostSessionLogPath,
  isAlive,
  type LiveHostSession,
  listHostSessions,
  reapDeadSessions,
  registerHostSession,
  updateHostSession,
} from "./host-registry.js";
export {
  HOST_GATE_HOOK_COMMAND,
  HOST_GATE_TIMEOUT_SECONDS,
  type HostSettingsOptions,
  hostSettings,
  hostSettingsArg,
} from "./host-settings.js";
export {
  DELIVERED_RETENTION_MS,
  FileJoinQueue,
  joinQueueDir,
  MAX_PENDING_PER_CONVERSATION,
  PENDING_TTL_MS,
  resolveFromSnapshot,
} from "./join-queue.js";
export {
  ACTIVE_WITHIN_MS,
  createJoinedTransport,
  type JoinedTransport,
  type JoinedTransportOptions,
} from "./joined-sessions.js";
export {
  IDLE_AFTER_MS,
  LiveConversationRegistry,
  liveConversationsPath,
  readLiveConversations,
} from "./live-conversations.js";
export {
  type AttachResult,
  MessageLedger,
  RING_CAPACITY,
  SessionBus,
  SUBSCRIBER_QUEUE_LIMIT,
  type Subscriber,
} from "./session-bus.js";
export { readSessionTree, renderSessionTree, sessionTreePath } from "./session-tree.js";
export {
  CHAT_SUFFIX,
  HEARTBEAT_MS,
  HISTORY_SUFFIX,
  INTERRUPT_SUFFIX,
  type JoinAcceptance,
  MAX_MESSAGE_CHARS,
  MESSAGE_SUFFIX,
  parseSessionPath,
  QUEUE_SUFFIX,
  resetLedgers,
  resumeCursor,
  SESSIONS_PATH,
  type SessionRoute,
  STREAM_PREFIX,
  STREAM_SUFFIX,
  sessionTransportHandler,
  sseFrame,
  type TransportOptions,
  type TransportSession,
} from "./transport.js";
