/**
 * JoinQueue — FROZEN CONTRACT (task R13.7, ADR-0007 §3b and invariants 3, 4, 6).
 *
 * The *second-class* half of ADR-0007: a message authored on a paired device,
 * addressed to a conversation the developer is already running in some harness,
 * delivered as an injected block on that conversation's **next request**.
 *
 * Two properties of the mechanism drive every shape below, and both are honest
 * limitations rather than implementation details:
 *
 * - **The proxy speaks only when the harness speaks to it.** A message reaches a
 *   looping session in seconds and an idle one never. So the queue's states are
 *   `queued` and `delivered`, and `queued` is a state a UI must render as such,
 *   naming the delivery condition — never as "sent".
 * - **Two processes share this queue.** The device writes through the mTLS write
 *   surface (`golem device serve`); the delivery happens inside the proxy
 *   (`golem proxy`). They are separate OS processes, so an implementation is
 *   necessarily backed by something both can see, and `claim` MUST be atomic
 *   across processes — see its contract note.
 *
 * Contract notes (binding on implementations):
 *
 * - **Redaction before storage.** `enqueue` takes RAW `text` and MUST run the
 *   request-body redaction pipeline over it before any byte reaches disk,
 *   exactly as {@link ../interfaces/conversation-store.ts | ConversationStore}
 *   does and for the same reason: there is no "already redacted, trust me"
 *   parameter a caller could pass instead. `JoinQueueMessage.text` as read back
 *   is therefore always the redacted form, and it is the form that is injected.
 * - **Exactly once, across processes.** `claim` both returns the pending
 *   messages and marks them delivered in one atomic step. Two concurrent
 *   claimers must never both receive the same message: a retried request, a
 *   second proxy, or a crash between claim and forward may cost a message, but
 *   must never duplicate one. **A duplicated instruction to an agent is not a
 *   duplicated packet** — losing a message is recoverable by re-sending it,
 *   acting on it twice is not.
 * - **Identity is not guessed (invariant 3).** `conversationId` is the
 *   `cachePrefixFingerprint` conversation key, the same identity
 *   `session-tree.ts` and the conversation store use. That key is a hash of the
 *   first message, so two conversations that open identically collide (§99).
 *   An implementation MUST refuse to enqueue against a key it cannot resolve to
 *   exactly one live conversation, returning `refused` with a reason — never
 *   pick one. Silence denies.
 * - **Opt-in, off by default (invariant 6).** Nothing here runs unless the user
 *   turned injection on. With injection off, or with nothing queued, the
 *   request the proxy forwards is byte-identical at compression ≤ 1.
 * - **Local-only.** No field here carries a remote address, an account or a
 *   token; the queue lives under `.golem/` and never leaves the machine.
 */

/** One message from a device, waiting for (or already delivered to) a conversation. */
export interface JoinQueueMessage {
  /** Client-generated and stable across retries — the idempotency key. */
  readonly messageId: string;
  /** The `cachePrefixFingerprint` conversation key this message is addressed to. */
  readonly conversationId: string;
  /** Which device authored it. Never optional — invariant 4 forbids an unattributable turn. */
  readonly deviceId: string;
  /** The message, REDACTED. See the redaction contract note above. */
  readonly text: string;
  /** ISO-8601 timestamp of the enqueue. */
  readonly enqueuedAt: string;
  /** ISO-8601 timestamp of delivery, once it has landed. Absent while pending. */
  readonly deliveredAt?: string;
  /**
   * ISO-8601 timestamp at which this message was expired INSTEAD of delivered.
   *
   * The other half of invariant 3's "nothing queued that might land later
   * unannounced": a message that waited longer than the implementation's TTL is
   * taken out of the queue rather than delivered to a session that finally
   * looped a day later. Set exclusively with {@link deliveredAt} — a message is
   * one or the other, never both.
   */
  readonly expiredAt?: string;
}

/**
 * What `enqueue` did.
 *
 * `refused` is a first-class outcome rather than a thrown error because the
 * reasons are all things a *user* needs to read — an ambiguous target, an
 * unknown conversation, a full queue — and a UI that renders them is the
 * difference between "silence denies" and "silence".
 */
export type JoinEnqueueResult =
  | { readonly status: "queued"; readonly message: JoinQueueMessage }
  /** The same `messageId` was already accepted; the original outcome is returned. */
  | { readonly status: "duplicate"; readonly message: JoinQueueMessage }
  | { readonly status: "refused"; readonly reason: string };

/**
 * A conversation the proxy has actually seen, as offered to a device.
 *
 * `ambiguous` is the §99 collision made visible: when two distinct live
 * conversations share a key, neither can be addressed, and a device must be told
 * that rather than shown a target that would deliver somewhere unpredictable.
 */
export interface LiveConversation {
  /** The `cachePrefixFingerprint` conversation key. */
  readonly conversationId: string;
  /** ISO-8601 timestamp of the first request the proxy saw for it. */
  readonly firstSeenAt: string;
  /** ISO-8601 timestamp of the most recent request. How "live" is judged. */
  readonly lastRequestAt: string;
  /** Messages carried by the most recent request — how deep the conversation is. */
  readonly messageCount: number;
  /** Requests seen. */
  readonly requestCount: number;
  /**
   * True when more than one distinct conversation has been observed under this
   * key (same opening message, different `system`/`tools`). An ambiguous
   * conversation cannot be addressed at all: see invariant 3.
   */
  readonly ambiguous: boolean;
}

export interface JoinQueue {
  /**
   * Accept a message for `conversationId`, or refuse and say why.
   *
   * Binding: redact `text` before writing it (see the contract note), and refuse
   * rather than guess when the target cannot be resolved to exactly one live
   * conversation.
   */
  enqueue(input: {
    readonly conversationId: string;
    readonly deviceId: string;
    readonly messageId: string;
    /** RAW text. The implementation redacts it; callers never pre-redact. */
    readonly text: string;
  }): Promise<JoinEnqueueResult>;

  /** Undelivered messages for one conversation, oldest first. Does not claim them. */
  pending(conversationId: string): Promise<readonly JoinQueueMessage[]>;

  /**
   * Atomically take the pending messages for `conversationId` — returning them
   * and marking them delivered in one step, so a concurrent claimer gets none of
   * the same ones. Oldest first. Empty when there is nothing to deliver.
   */
  claim(conversationId: string): Promise<readonly JoinQueueMessage[]>;

  /**
   * Everything the queue currently holds, pending and recently delivered,
   * newest first — the local visibility surface invariant 4 requires.
   */
  list(): Promise<readonly JoinQueueMessage[]>;

  /** Drop one message while it is still pending. Returns whether one was there. */
  forget(messageId: string): Promise<boolean>;
}
