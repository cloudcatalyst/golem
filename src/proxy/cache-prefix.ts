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
 *
 * ## R8.13 — what §99's 98%-wrong verdict actually was
 *
 * The first cut of this module hashed each message **as sent**, including its
 * `cache_control` marker. Claude Code moves that marker to the newest block every
 * turn, so the previously-final message lost a key it used to carry, its hash
 * changed, and every single turn was reported as a `bust` at index `prevLen - 1`
 * while the bill showed a ~99% cache read. §99 guessed the conversation key was
 * colliding; the live trace disproved that (one `first`, a coherent chain, the bust
 * always on the previous request's last message) and named the real cause.
 *
 * `cache_control` is a **breakpoint marker, not cached content**. Anthropic's
 * prompt-caching docs are explicit about exactly this case: "blocks that were
 * previously marked with a `cache_control` block are later not marked with this,
 * but they will still be considered a cache hit". The cache key is a cumulative
 * hash of prefix *content*; breakpoint placement is not on the documented
 * invalidation list. So the fingerprint excludes it — see {@link hash}.
 *
 * The same source documents a second, real miss this module now models: the
 * **20-block lookback window** ({@link LOOKBACK_WINDOW_BLOCKS}). A read walks
 * backward at most 20 block positions from a breakpoint looking for a prior write,
 * so a turn that appends 20+ blocks past the last write misses even though no byte
 * of the prefix changed. Verified 2026-07-31, notes §104.
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
export type CacheBustComponent =
  | "tools"
  | "system"
  | "messages"
  /**
   * R8.13: nothing changed — the prefix simply moved out of reach. A cache read
   * walks back at most {@link LOOKBACK_WINDOW_BLOCKS} block positions from the
   * breakpoint looking for a prior write, so a turn that appends that many blocks
   * at once misses a prefix that is still byte-identical and still live.
   */
  | "lookback";

/**
 * How many block positions a cache read walks backward from a breakpoint, the
 * breakpoint itself counting as the first (Anthropic prompt-caching docs, verified
 * 2026-07-31 — notes §104). A write further back than this is not found.
 */
export const LOOKBACK_WINDOW_BLOCKS = 20;

export interface CachePrefixFingerprint {
  /** Hash of the `tools` array as sent (renders first, so a change busts everything). */
  readonly tools: string;
  /** Hash of the `system` block as sent. */
  readonly system: string;
  /** Per-message hashes, in order — enough to tell an append from an edit. */
  readonly messages: readonly string[];
  /**
   * R8.13: content blocks per message, in order. Anthropic's lookback window is
   * counted in **blocks**, not messages, so predicting a lookback miss needs this
   * rather than the message count. A string `content` counts as one block.
   */
  readonly blockCounts: readonly number[];
  /**
   * R8.13: how many `cache_control` breakpoints the request carries. Excluded from
   * every hash (a marker is not content) but retained as a number, because a second
   * breakpoint opens a second lookback window and so suppresses the lookback
   * prediction below.
   */
  readonly breakpoints: number;
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
  /**
   * R8.13: how many messages this request carried. Paired with
   * {@link firstChangedMessage} it says how much of the prefix a bust actually
   * cost — the difference between "index 2 of 180" (everything re-prefilled) and
   * "index 179 of 180" (the tail only), which §99's flat bust count could not tell
   * apart.
   */
  readonly messageCount: number;
  /** Human-readable one-liner naming the cause. Always present. */
  readonly detail: string;
}

/**
 * `JSON.stringify` replacer that drops every `cache_control` key at any depth.
 *
 * A replacer rather than a deep clone on purpose: this runs on the request path for
 * every message of every request, and stringifying is work we already do — filtering
 * during serialization costs nothing extra and allocates no copy of the body.
 *
 * Array indices arrive as the string keys `"0"`, `"1"`, … so they are never mistaken
 * for the marker.
 */
function omitCacheControl(key: string, value: unknown): unknown {
  return key === "cache_control" ? undefined : value;
}

/**
 * Hash the **cache-relevant content** of a value.
 *
 * `cache_control` is excluded: it marks where a breakpoint sits, and Anthropic's
 * cache key is a cumulative hash of prefix content, so a block that is marked on one
 * turn and unmarked on the next still hits. Including it made every turn a false
 * `bust` (§99 → §104).
 */
function hash(value: unknown): string {
  // `undefined` and a missing key must fingerprint the same, since neither is
  // serialized into the request body.
  const json = value === undefined ? "" : JSON.stringify(value, omitCacheControl);
  return createHash("sha256")
    .update(json ?? "")
    .digest("hex")
    .slice(0, 16);
}

/** Content blocks in one message: the `content` array's length, or 1 for a string. */
function blockCount(message: unknown): number {
  if (typeof message !== "object" || message === null) return 1;
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content.length : 1;
}

/** Count `cache_control` markers anywhere in a value, without allocating a copy. */
function countBreakpoints(value: unknown): number {
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += countBreakpoints(item);
    return total;
  }
  if (typeof value !== "object" || value === null) return 0;
  let total = 0;
  for (const [key, child] of Object.entries(value)) {
    if (key === "cache_control") {
      total += 1;
      continue;
    }
    total += countBreakpoints(child);
  }
  return total;
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
    blockCounts: rawMessages.map((m) => blockCount(m)),
    breakpoints:
      countBreakpoints(body.messages) +
      countBreakpoints(body.system) +
      countBreakpoints(body.tools),
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
  return { ...classifyCore(prev, next), messageCount: next.messages.length };
}

function classifyCore(
  prev: CachePrefixFingerprint | undefined,
  next: CachePrefixFingerprint,
): Omit<CachePrefixObservation, "messageCount"> {
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

  // R8.13 — every byte of the previous prefix survived, but survival is not enough:
  // the read has to still be able to FIND the previous write. It walks back at most
  // LOOKBACK_WINDOW_BLOCKS block positions from this request's breakpoint, so a turn
  // that appends that many blocks at once steps over the write and re-prefills from
  // scratch. A second breakpoint opens a second window that would find it, so this is
  // only predicted for a single-breakpoint request (Anthropic docs, notes §104).
  let appendedBlocks = 0;
  for (let i = prev.messages.length; i < next.blockCounts.length; i += 1) {
    appendedBlocks += next.blockCounts[i] ?? 0;
  }
  if (appendedBlocks >= LOOKBACK_WINDOW_BLOCKS && next.breakpoints <= 1) {
    return {
      verdict: "bust",
      component: "lookback",
      detail:
        `${appendedBlocks} blocks were appended in one turn, past the ` +
        `${LOOKBACK_WINDOW_BLOCKS}-block lookback window — the previous write is still ` +
        "valid but can no longer be found, so the prefix is re-prefilled. Nothing changed; " +
        "an extra `cache_control` breakpoint nearer the last write would recover it",
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
