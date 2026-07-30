/**
 * R8.1 — cache-prefix fingerprinting and cache-bust detection.
 *
 * Anthropic's prompt cache keys on a **byte-identical prefix**, rendered in the
 * order `tools` → `system` → `messages` (verification-notes §14). One changed
 * byte anywhere in that prefix silently invalidates everything after it: the
 * request still succeeds, the answer is still right, and the bill quietly jumps
 * from ~0.1× cache-read rates to full input rates. Nothing in the stack tells
 * you it happened.
 *
 * Golem sits on the request path and sees the exact bytes it forwards, so it can.
 * This module is the detector: fingerprint the cacheable components of each
 * outgoing request, compare against the previous request of the same
 * conversation, and classify the difference as a pure **append** (cache-safe,
 * the normal agentic turn) or a **bust** (an earlier byte changed) — naming the
 * component responsible.
 *
 * Two deliberate limits, stated rather than hidden:
 *
 * 1. **This is a prediction, not a measurement.** The authority on what actually
 *    happened is the response's `cache_read_input_tokens` /
 *    `cache_creation_input_tokens`, which Golem already records (R1.1). The two
 *    signals are reported side by side and never merged: this one explains *why*,
 *    the billed numbers say *whether*.
 * 2. **Conversation identity is a heuristic.** The Messages API carries no
 *    session id, so requests are grouped by a fingerprint of the first message —
 *    stable for the life of a conversation, and the same grouping a human would
 *    make by eye. A brand-new conversation that happens to open with an identical
 *    first message is indistinguishable, which costs at most one misattributed
 *    verdict and never a wrong bill.
 */

import { createHash } from "node:crypto";

/** How a request's cacheable prefix relates to the previous request's. */
export type CachePrefixVerdict =
  /** No previous request for this conversation — nothing to compare. */
  | "first"
  /** Prefix components unchanged and `messages` only grew: the cache should hit. */
  | "append"
  /** An earlier byte changed: the cached prefix is invalidated from that point. */
  | "bust";

/** Which cacheable component changed, when the verdict is `bust`. */
export type CacheBustComponent = "tools" | "system" | "messages";

export interface CachePrefixFingerprint {
  /** Hash of the `tools` array as sent (renders first, so a change busts everything). */
  readonly tools: string;
  /** Hash of the `system` block as sent. */
  readonly system: string;
  /** Per-message hashes, in order — enough to tell an append from an edit. */
  readonly messages: readonly string[];
  /** Conversation grouping key (hash of the first message). Empty when no messages. */
  readonly conversationKey: string;
}

export interface CachePrefixObservation {
  readonly verdict: CachePrefixVerdict;
  /** Set only when `verdict === "bust"`. */
  readonly component?: CacheBustComponent;
  /**
   * 0-based index of the first message that differs, when the bust is in
   * `messages`. Lets a report say *which turn* broke the cache.
   */
  readonly firstChangedMessage?: number;
  /** Human-readable one-liner naming the cause. Always present. */
  readonly detail: string;
}

function hash(value: unknown): string {
  // `undefined` and a missing key must fingerprint the same, since neither is
  // serialized into the request body.
  const json = value === undefined ? "" : JSON.stringify(value);
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

/**
 * Fingerprint the cacheable components of an outgoing Messages request.
 *
 * Hashes rather than bytes: the fingerprint is kept in memory for the life of the
 * proxy and written to telemetry, and neither should hold prompt content. Hashing
 * also makes comparison O(1) per component.
 */
export function cachePrefixFingerprint(
  body: Readonly<Record<string, unknown>>,
): CachePrefixFingerprint {
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const messages = rawMessages.map((m) => hash(m));
  return {
    tools: hash(body.tools),
    system: hash(body.system),
    messages,
    conversationKey: messages.length > 0 ? (messages[0] as string) : "",
  };
}

/**
 * Classify `next` against `prev`.
 *
 * Order matters and mirrors the render order: `tools` first, then `system`, then
 * `messages`. A `tools` change invalidates the whole prefix, so it is reported
 * even if `system` also changed — the earliest change is the one that costs.
 */
export function classifyPrefixChange(
  prev: CachePrefixFingerprint | undefined,
  next: CachePrefixFingerprint,
): CachePrefixObservation {
  if (prev === undefined) {
    return { verdict: "first", detail: "first request of this conversation — nothing cached yet" };
  }

  if (prev.tools !== next.tools) {
    return {
      verdict: "bust",
      component: "tools",
      detail:
        "the `tools` block changed — it renders first, so the entire cached prefix " +
        "(tools + system + history) was re-prefilled",
    };
  }

  if (prev.system !== next.system) {
    return {
      verdict: "bust",
      component: "system",
      detail: "the `system` block changed — the cached prefix was invalidated from `system` onward",
    };
  }

  // `messages`: an append keeps every earlier hash identical. Anything else is an
  // edit or a truncation of already-sent history, both of which bust.
  const shared = Math.min(prev.messages.length, next.messages.length);
  for (let i = 0; i < shared; i += 1) {
    if (prev.messages[i] !== next.messages[i]) {
      return {
        verdict: "bust",
        component: "messages",
        firstChangedMessage: i,
        detail:
          `message ${i} of the already-sent history changed — the cached prefix was ` +
          `invalidated from that turn onward`,
      };
    }
  }

  if (next.messages.length < prev.messages.length) {
    return {
      verdict: "bust",
      component: "messages",
      firstChangedMessage: next.messages.length,
      detail:
        `history shrank from ${prev.messages.length} to ${next.messages.length} messages ` +
        "(a compaction or a rewind) — the cached prefix no longer matches",
    };
  }

  return {
    verdict: "append",
    detail:
      next.messages.length === prev.messages.length
        ? "identical prefix — a full cache hit is expected"
        : `${next.messages.length - prev.messages.length} message(s) appended, earlier bytes ` +
          "untouched — the cache should hit",
  };
}

/** Cap on tracked conversations; oldest-inserted is evicted first. */
const DEFAULT_MAX_CONVERSATIONS = 64;

/**
 * Stateful observer: remembers the last fingerprint per conversation and
 * classifies each new request against it.
 *
 * Bounded on purpose — a long-lived proxy daemon must not accumulate one entry
 * per conversation forever. Eviction is insertion-ordered (a `Map` re-inserted on
 * every touch), which makes it least-recently-used in practice.
 */
export class CachePrefixObserver {
  readonly #last = new Map<string, CachePrefixFingerprint>();
  readonly #max: number;

  constructor(maxConversations: number = DEFAULT_MAX_CONVERSATIONS) {
    this.#max = Math.max(1, maxConversations);
  }

  /**
   * Fingerprint `body`, compare it with this conversation's previous request, and
   * remember it for next time.
   *
   * Never throws: a malformed body simply produces a fingerprint of whatever is
   * there. This runs on the request path, so it must not be able to fail a request.
   */
  observe(body: Readonly<Record<string, unknown>>): CachePrefixObservation {
    const next = cachePrefixFingerprint(body);
    const key = next.conversationKey;
    const prev = this.#last.get(key);
    const observation = classifyPrefixChange(prev, next);

    // Re-insert to refresh insertion order, then evict the oldest.
    this.#last.delete(key);
    this.#last.set(key, next);
    while (this.#last.size > this.#max) {
      const oldest = this.#last.keys().next();
      if (oldest.done === true) break;
      this.#last.delete(oldest.value);
    }

    return observation;
  }

  /** Number of conversations currently tracked (for tests and diagnostics). */
  size(): number {
    return this.#last.size;
  }
}
