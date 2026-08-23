/**
 * ConversationStore — FROZEN CONTRACT (task R13.2, ADR-0007 §6 / invariant 5).
 *
 * `src/session/session-tree.ts` deliberately stores *content hashes, no prompt
 * content* — that was the project's position until ADR-0007. Scrollback ("see
 * the previous messages") and continuation (R13.8) both need real turn text on
 * disk, so ADR-0007 §6 accepted a **deliberate, argued exception** (USER
 * DECISION, spec Decision 60): a local conversation store under `.golem/`,
 * gitignored, redacted before write, bounded by count and age, forgettable one
 * conversation at a time or entirely. `session-tree.ts` is unchanged by this —
 * it keeps recording hashes only, and this store sits beside it, not instead
 * of it.
 *
 * Contract notes (binding on implementations):
 * - **Redaction is structural, not a caller obligation.** `appendTurn` takes
 *   RAW `turn.content` on purpose — there is no "already redacted, trust me"
 *   parameter a caller could pass instead, because that shape invites a branch
 *   that skips redaction. An implementation MUST run the request-body
 *   redaction pipeline over `turn.content` and persist only the result; it
 *   must never write raw content to disk under any code path. This is
 *   CLAUDE.md's "redaction must never be weakened or reordered" hard rule,
 *   applied to this store specifically.
 * - Identity: `conversationId` is caller-supplied so a single identity
 *   function can be shared across every consumer (see
 *   `src/session/conversation-store.ts`'s `conversationIdFor`, which mirrors
 *   `session-tree.ts`'s `cachePrefixFingerprint`-based key) rather than each
 *   call site deriving its own.
 * - Bounded, not an archive: implementations evict by count and by age
 *   (ADR-0007 Revision 1 — branching is dropped, so this is sized for
 *   scrollback and continuation, not an indefinite record).
 * - Local-only: nothing here may leave the machine. This interface has no
 *   network shape (no auth, no remote target) by design.
 */

/** One turn of a conversation, as it is appended to the store. */
export interface ConversationTurn {
  /** e.g. "user", "assistant", "system" — caller-defined, stored verbatim. */
  readonly role: string;
  /**
   * Raw turn payload (string or structured content blocks) as received by
   * `appendTurn`. What is actually PERSISTED is the redacted form — see the
   * contract note on `ConversationStore.appendTurn`.
   */
  readonly content: unknown;
  /** ISO-8601 timestamp of this turn. */
  readonly timestamp: string;
}

/** A full conversation as read back from the store. */
export interface ConversationRecord {
  readonly conversationId: string;
  /** ISO-8601 timestamp of the first turn. */
  readonly startedAt: string;
  /** ISO-8601 timestamp of the most recent turn. */
  readonly lastTurnAt: string;
  /** Oldest first — turn order as appended. Content here is already redacted. */
  readonly turns: readonly ConversationTurn[];
}

/** Lightweight listing entry — no turn content, for `listConversations`. */
export interface ConversationSummary {
  readonly conversationId: string;
  readonly startedAt: string;
  readonly lastTurnAt: string;
  readonly turnCount: number;
}

export interface ConversationStore {
  /**
   * Append one turn to `conversationId` (creating the conversation if it does
   * not exist yet).
   *
   * Redaction contract (binding): `turn.content` is RAW. The implementation
   * MUST redact it before any byte reaches disk, unconditionally — no
   * parameter, flag, or code path may skip that step. Callers pass raw
   * content precisely because there is no "pre-redacted" input this contract
   * accepts instead; the store is the one place that redaction cannot be
   * bypassed by caller error.
   *
   * Also responsible for enforcing the store's bounds (count and age) —
   * typically by evicting the oldest conversations after the write.
   */
  appendTurn(conversationId: string, turn: ConversationTurn): Promise<void>;

  /** Read a conversation back, redacted content included. `null` if unknown. */
  readConversation(conversationId: string): Promise<ConversationRecord | null>;

  /** All conversations currently retained, newest (`lastTurnAt`) first. */
  listConversations(): Promise<readonly ConversationSummary[]>;

  /** Delete one conversation. Returns whether one existed to delete. */
  forget(conversationId: string): Promise<boolean>;

  /** Delete every conversation the store holds. */
  forgetAll(): Promise<void>;
}
