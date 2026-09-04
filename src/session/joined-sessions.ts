/**
 * R13.7 — the write surface's view of a session it does NOT host.
 *
 * `golem session host serve` mounts a hosted session behind R13.4's mTLS server
 * and hands the transport a `deliver` that writes to a runner's stdin. There is
 * no runner here. A *joined* session is one the developer is running in their
 * own harness; all this process can do is put a message in the queue that the
 * proxy — a different process — claims on that conversation's next request.
 *
 * So everything in this module is shaped by two facts that must reach the user
 * rather than be smoothed over:
 *
 * - **Acceptance is not delivery.** The transport answers `queued`, with the
 *   condition under which it will land, because "sent" is the misunderstanding
 *   this feature generates (ADR-0007 §3b, and the `SessionEvent` contract note).
 * - **An unaddressable target is refused, not parked.** An idle conversation is
 *   *addressable* (its message waits, and the condition says so); an unknown or
 *   ambiguous one is not, and it is refused with the reason. That is invariant 3.
 */

import type { LiveConversation } from "../interfaces/join-queue.js";
import { FileJoinQueue, resolveFromSnapshot } from "./join-queue.js";
import { readLiveConversations } from "./live-conversations.js";
import { SessionBus } from "./session-bus.js";
import type { JoinAcceptance, TransportSession } from "./transport.js";

/** How long the cached snapshot of live conversations is reused. */
export const SNAPSHOT_CACHE_MS = 2_000;

/**
 * Below this, a conversation counts as actively looping and a message is minutes
 * or seconds from landing. Above it, the honest answer is "nothing until it runs
 * again" — and offering the hosted alternative is part of that answer.
 */
export const ACTIVE_WITHIN_MS = 60_000;

export interface JoinedTransportOptions {
  readonly projectDir: string;
  /** `security.join_injection`. False means the queue is refused at the door. */
  readonly injectionEnabled: boolean;
  /** Hosted sessions to include in `GET /sessions`, if this process knows any. */
  readonly hosted?: readonly { readonly sessionId: string; readonly projectDir: string }[];
  readonly now?: () => number;
}

export interface JoinedTransport {
  /** For `TransportOptions.lookup` — `null` for anything not a live conversation. */
  lookup(sessionId: string): TransportSession | null;
  /** For `TransportOptions.listSessions`. */
  listSessions(): Promise<{
    readonly hosted: readonly { readonly sessionId: string; readonly projectDir: string }[];
    readonly joined: readonly LiveConversation[];
    readonly injectionEnabled: boolean;
  }>;
  /** Refresh the cached snapshot now. Awaited at startup so the first lookup is warm. */
  refresh(): Promise<void>;
}

function conditionFor(
  conversation: LiveConversation | undefined,
  nowMs: number,
  injectionEnabled: boolean,
): string {
  if (!injectionEnabled) {
    return "delivery into running sessions is off — turn on `security.join_injection` to let queued messages land";
  }
  if (conversation === undefined) {
    return "the proxy has not seen this conversation recently — nothing will be delivered";
  }
  const idleMs = nowMs - Date.parse(conversation.lastRequestAt);
  if (idleMs <= ACTIVE_WITHIN_MS) {
    return "this conversation is running — the message is delivered on its next request, usually within seconds";
  }
  const minutes = Math.max(1, Math.round(idleMs / 60_000));
  return `this session is idle (${minutes} minute${minutes === 1 ? "" : "s"} since its last request); nothing will be delivered until it runs again. To have work done now instead, start a hosted session with \`golem session host serve\``;
}

/**
 * Build the lookup/listing pair `golem device serve` mounts.
 *
 * `lookup` is synchronous (the transport's contract), so it answers from a
 * cached snapshot refreshed on a timer and by every listing. A stale cache can
 * only cost a 404 the client retries after listing; it can never cause a
 * delivery, because `enqueue` re-reads the snapshot and refuses on that.
 */
export async function createJoinedTransport(
  options: JoinedTransportOptions,
): Promise<JoinedTransport> {
  const now = options.now ?? Date.now;
  const buses = new Map<string, SessionBus>();
  let cache: readonly LiveConversation[] = [];
  let refreshedAt = 0;

  const refresh = async (): Promise<void> => {
    cache = await readLiveConversations(options.projectDir, { now });
    refreshedAt = now();
  };

  const maybeRefresh = (): void => {
    if (now() - refreshedAt < SNAPSHOT_CACHE_MS) return;
    void refresh().catch(() => {
      // A snapshot we cannot read means no addressable conversations, which is
      // the safe direction; the previous cache stands until it can be re-read.
    });
  };

  const busFor = (conversationId: string): SessionBus => {
    let bus = buses.get(conversationId);
    if (bus === undefined) {
      bus = new SessionBus(conversationId);
      buses.set(conversationId, bus);
    }
    return bus;
  };

  await refresh();

  return {
    refresh,
    async listSessions() {
      await refresh();
      return {
        hosted: options.hosted ?? [],
        joined: cache,
        injectionEnabled: options.injectionEnabled,
      };
    },
    lookup(sessionId: string): TransportSession | null {
      maybeRefresh();
      const conversation = cache.find((c) => c.conversationId === sessionId);
      if (conversation === undefined) return null;
      const queue = new FileJoinQueue({
        projectDir: options.projectDir,
        // Resolved against a FRESH read, not the cache: the cache decides
        // whether a route exists, this decides whether a message may be left.
        resolve: async (id) =>
          resolveFromSnapshot(await readLiveConversations(options.projectDir, { now }))(id),
        now,
      });
      return {
        bus: busFor(sessionId),
        projectDir: options.projectDir,
        kind: "joined",
        // A joined session has no runner to write to. `deliver` exists only
        // because the transport's type carries it; reaching it would mean the
        // enqueue path above was skipped, and saying so beats pretending.
        deliver: async () => {
          throw new Error(
            "a joined session cannot be delivered to directly — it is queued for its next request",
          );
        },
        enqueue: async (input): Promise<JoinAcceptance> => {
          const nowMs = now();
          if (!options.injectionEnabled) {
            return {
              result: {
                status: "refused",
                reason:
                  "delivery into running sessions is off on this machine — set `security.join_injection` to true to enable it (ADR-0007 §3b; it is off by default)",
              },
              condition: conditionFor(conversation, nowMs, false),
            };
          }
          const result = await queue.enqueue({
            conversationId: sessionId,
            deviceId: input.deviceId,
            messageId: input.messageId,
            text: input.text,
          });
          return {
            result,
            condition: conditionFor(
              cache.find((c) => c.conversationId === sessionId),
              nowMs,
              true,
            ),
          };
        },
        pending: async () => queue.pending(sessionId),
        condition: async () => {
          await refresh();
          return conditionFor(
            cache.find((c) => c.conversationId === sessionId),
            now(),
            options.injectionEnabled,
          );
        },
      };
    },
  };
}
