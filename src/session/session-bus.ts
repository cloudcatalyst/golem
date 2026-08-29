/**
 * R13.5 — the per-session event bus: a bounded ring, a cursor, and subscribers.
 *
 * R13.3's `HostedSession` produces events; a device consumes them over SSE. In
 * between there has to be a buffer, because the two are not the same speed and
 * the connection between them is a phone's Wi-Fi.
 *
 * Three properties, and each one is a decision rather than a default:
 *
 * 1. **Every event gets a monotonically increasing `seq`.** That is what makes
 *    reconnect-without-loss-or-duplication possible at all: the client says
 *    where it got to, the server sends strictly what came after.
 *
 * 2. **The ring is bounded, and running off the end is REPORTED.** A client that
 *    was away too long cannot be silently given a partial conversation — it is
 *    told `gap: true` on reattach so it can say so. A gap the user can see is
 *    recoverable; a gap they cannot is a conversation they will misread.
 *
 * 3. **A slow subscriber is dropped, never allowed to stall the session.** The
 *    events it missed are still in the ring, so dropping it costs a reconnect
 *    rather than data. The alternative — letting one phone's backpressure block
 *    the agent — trades a correctness property for a convenience one.
 */

import type { SessionEvent } from "../interfaces/session-events.js";

/**
 * How many events one session retains for replay.
 *
 * 500 is roughly a long turn's worth of text deltas, tool calls and results —
 * enough to cover a tunnel, a lift, or a phone that locked, which are the real
 * disconnects. It is not enough to cover an hour away, and it is not meant to
 * be: {@link SessionBus.subscribe} reports the gap rather than pretending.
 */
export const RING_CAPACITY = 500;

/** How many events may queue for ONE subscriber before it is dropped as too slow. */
export const SUBSCRIBER_QUEUE_LIMIT = 200;

export interface Subscriber {
  /** Deliver one event. Returns false when the sink is backed up. */
  readonly send: (event: SessionEvent) => boolean;
  /** Called when this subscriber is dropped, with the reason. */
  readonly close: (reason: string) => void;
}

export interface AttachResult {
  /** Events the subscriber missed and can still be given, oldest first. */
  readonly replay: readonly SessionEvent[];
  /** True when the requested cursor has already fallen out of the ring. */
  readonly gap: boolean;
  /** Stop receiving. */
  readonly detach: () => void;
}

/**
 * One session's events, buffered and fanned out.
 *
 * Deliberately not an `EventEmitter`: the whole point is the ring and the
 * cursor, and an emitter would make "just subscribe" look like the complete
 * story when the interesting half is what a subscriber missed.
 */
export class SessionBus {
  private readonly ring: SessionEvent[] = [];
  private nextSeq = 1;
  private readonly subscribers = new Set<Subscriber>();
  private readonly backlog = new WeakMap<Subscriber, number>();
  /** Set once the session is over; a late attach is told immediately. */
  private ended: SessionEvent | undefined;

  constructor(
    readonly sessionId: string,
    private readonly capacity: number = RING_CAPACITY,
  ) {}

  /** The seq the NEXT published event will carry. */
  get cursor(): number {
    return this.nextSeq - 1;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Publish one event, stamping it with the next `seq`.
   *
   * Takes the event WITHOUT a seq and returns it with one, so no caller can
   * choose its own — a caller-chosen seq is how a ring stops being ordered.
   */
  publish<T extends Omit<SessionEvent, "seq">>(event: T): SessionEvent {
    const stamped = { ...event, seq: this.nextSeq } as SessionEvent;
    this.nextSeq += 1;
    this.ring.push(stamped);
    if (this.ring.length > this.capacity) this.ring.shift();
    if (stamped.type === "ended") this.ended = stamped;

    for (const sub of [...this.subscribers]) {
      const ok = sub.send(stamped);
      if (ok) {
        this.backlog.set(sub, 0);
        continue;
      }
      // Backed up. Count it, and drop past the limit — the ring still holds
      // everything, so this costs a reconnect and not a turn.
      const behind = (this.backlog.get(sub) ?? 0) + 1;
      this.backlog.set(sub, behind);
      if (behind > SUBSCRIBER_QUEUE_LIMIT) {
        this.subscribers.delete(sub);
        sub.close(
          `dropped: this client fell more than ${SUBSCRIBER_QUEUE_LIMIT} events behind. Reconnect with Last-Event-ID to resume — nothing was lost.`,
        );
      }
    }
    return stamped;
  }

  /**
   * Attach a subscriber, optionally resuming from a cursor.
   *
   * `after: 0` (or omitted) means "everything still in the ring", which on a
   * fresh session is everything there has ever been.
   */
  subscribe(sub: Subscriber, after = 0): AttachResult {
    const oldest = this.ring[0]?.seq;
    // A gap exists when the client wants something older than what survives.
    // `after === 0` is not a gap: it is a fresh attach, not a failed resume.
    const gap = after > 0 && oldest !== undefined && after + 1 < oldest;
    const replay = this.ring.filter((e) => e.seq > after);

    this.subscribers.add(sub);
    this.backlog.set(sub, 0);
    return {
      replay,
      gap,
      detach: () => {
        this.subscribers.delete(sub);
      },
    };
  }

  /** Has this session already ended? A late attach needs telling at once. */
  get endedEvent(): SessionEvent | undefined {
    return this.ended;
  }

  /** Drop every subscriber, e.g. because the process is going away. */
  closeAll(reason: string): void {
    for (const sub of [...this.subscribers]) {
      this.subscribers.delete(sub);
      sub.close(reason);
    }
  }
}

/**
 * Idempotency for inbound messages.
 *
 * A duplicated instruction to an agent is not a duplicated packet, so a retried
 * POST must not deliver twice. Bounded because it is a retry window, not a
 * history: a client retrying an id from an hour ago is not retrying.
 */
export class MessageLedger {
  private readonly seen = new Map<string, number>();

  constructor(private readonly capacity = 256) {}

  /** The seq recorded for this id, or `undefined` if it is new. */
  lookup(messageId: string): number | undefined {
    return this.seen.get(messageId);
  }

  record(messageId: string, seq: number): void {
    this.seen.set(messageId, seq);
    // Map preserves insertion order, so the oldest key is the first one.
    while (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}
