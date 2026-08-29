/**
 * SessionEvent — FROZEN CONTRACT (task R13.5, ADR-0007 §7c).
 *
 * The wire shape a device sees when it attaches to a hosted session. R13.6's
 * chat surface codes against this, and so will anything after it, so the shapes
 * are named here rather than left implicit in a server file.
 *
 * Contract notes (binding on implementations):
 *
 * - **Every event carries a `seq`.** It is monotonically increasing per session
 *   and is what makes reconnect-without-loss-or-duplication possible: a client
 *   resumes with `Last-Event-ID: <seq>` and receives strictly what came after.
 *   An implementation MUST NOT reuse or reorder a `seq` within a session.
 *
 * - **Connection state is an EVENT, never an inference.** ADR-0006's rule — "a
 *   dropped link shows not connected, never a stale approved" — is inherited
 *   here for conversation, where the same failure looks like a message the user
 *   believes they sent. A client must be *told* the session ended, parked or
 *   died; it must never have to conclude it from silence. That is
 *   {@link SessionEndedEvent} and {@link SessionParkedEvent}, and it is why
 *   heartbeats exist: silence means "still here", never "gone".
 *
 * - **A `message` acknowledgement means DELIVERED**, not accepted. ADR-0007 §3b
 *   makes injection acknowledged, and acknowledging optimistically here would
 *   undo that. An implementation MUST NOT return success until the turn has
 *   actually reached the session.
 *
 * - **Local-only.** No field here carries a remote address, an account, or a
 *   token. This is a LAN transport (invariant 9); R13.10 is where that changes,
 *   and it will change this contract deliberately rather than by reinterpretation.
 */

/** Assistant prose. Sent as it arrives, not buffered to the end of a turn. */
export interface SessionTextEvent {
  readonly type: "text";
  readonly seq: number;
  readonly text: string;
}

/** A tool the session decided to call. Visible, per ADR-0007 §2. */
export interface SessionToolCallEvent {
  readonly type: "tool_call";
  readonly seq: number;
  readonly id: string;
  readonly name: string;
  /** Already redacted upstream; safe to render. */
  readonly input: unknown;
}

/**
 * What the tool returned. `isError` is how a REFUSAL reaches the device — the
 * host's deny surfaces as an errored result carrying its reason, so a client
 * that renders errors renders refusals for free.
 */
export interface SessionToolResultEvent {
  readonly type: "tool_result";
  readonly seq: number;
  readonly toolCallId: string;
  readonly isError: boolean;
  readonly content: string;
}

/** The runner's OWN guard refused something — a different fact from a host deny. */
export interface SessionRefusedEvent {
  readonly type: "refused";
  readonly seq: number;
  readonly tool: string;
  readonly message: string;
  /** `host` = Golem's gate; `runner` = Claude Code's own protection. */
  readonly by: "host" | "runner";
}

/** A turn finished. */
export interface SessionTurnEndEvent {
  readonly type: "turn_end";
  readonly seq: number;
  readonly costUsd?: number;
}

/**
 * The usage-limit park fired (invariant 8). Distinct from `ended`: the session
 * is alive and deliberately not spending, which is a different thing to tell a
 * user than "it stopped".
 */
export interface SessionParkedEvent {
  readonly type: "parked";
  readonly seq: number;
  readonly detail: string;
}

/** The session is over, and why. Silence must never have to mean this. */
export interface SessionEndedEvent {
  readonly type: "ended";
  readonly seq: number;
  readonly reason: string;
}

/**
 * Sent immediately on attach, before any replay, so a client knows what it is
 * looking at and from where.
 */
export interface SessionAttachedEvent {
  readonly type: "attached";
  readonly seq: number;
  readonly sessionId: string;
  /** The seq the client is resuming from, or 0 for a fresh attach. */
  readonly resumedFrom: number;
  /**
   * True when the client asked to resume from a cursor the server no longer
   * holds. The client has a GAP and must say so rather than render a continuous
   * conversation it cannot vouch for.
   */
  readonly gap: boolean;
}

export type SessionEvent =
  | SessionAttachedEvent
  | SessionTextEvent
  | SessionToolCallEvent
  | SessionToolResultEvent
  | SessionRefusedEvent
  | SessionTurnEndEvent
  | SessionParkedEvent
  | SessionEndedEvent;

/** What a device POSTs to send a turn. */
export interface SessionMessageRequest {
  /**
   * Client-generated, stable across retries.
   *
   * Idempotency here matters more than it looks: **a duplicated instruction to
   * an agent is not a duplicated packet.** A retry after a dropped connection
   * must not make the session act twice, so an implementation MUST return the
   * original outcome for a repeated id rather than delivering again.
   */
  readonly messageId: string;
  readonly text: string;
}

/** The answer to a POST. Returned only once delivery is real. */
export interface SessionMessageResponse {
  readonly messageId: string;
  /** `delivered` on first delivery; `duplicate` when the id was already seen. */
  readonly status: "delivered" | "duplicate";
  /** The seq of the turn record, so a client can correlate with the stream. */
  readonly seq: number;
}
