/**
 * R13.7 — which conversations are live, and which of them can be addressed at all.
 *
 * ADR-0007 invariant 3 ("silence denies") is what this module exists for. A
 * device addresses a conversation by its `cachePrefixFingerprint` conversation
 * key — the same identity `session-tree.ts` and the conversation store use — and
 * that key is a **hash of the first message**. Two conversations that open with
 * an identical first message therefore collide (verification-notes §99), and
 * delivering a remote instruction into "one of the two" is exactly the guess the
 * invariant forbids.
 *
 * So the registry does not merely count conversations per key; it separates the
 * distinct *instances* hiding under one key, by message-chain continuity:
 *
 * - a request whose message-hash chain **extends** an instance's chain is that
 *   instance's next turn (the ordinary case, and what the cache-prefix observer
 *   calls an append);
 * - a request whose chain is a **prefix** of an instance's chain is that same
 *   instance rewound — still one conversation;
 * - a request that diverges from an instance **mid-chain** is a different
 *   conversation (or a fork of it), and once a key holds two of those the key is
 *   `ambiguous` and nothing may be delivered to it until one of them goes idle.
 *
 * The registry lives in the proxy process, because that is the only process that
 * sees requests. The device-facing write surface is a *different* process, so
 * the snapshot is written to `.golem/state/live-conversations.json` and read
 * from there — {@link readLiveConversations}. It holds hashes and timestamps
 * only: no prompt content, matching `session-tree.ts`'s standing rule (the
 * conversation store, ADR-0007 §6, is the one deliberate exception to it).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LiveConversation } from "../interfaces/join-queue.js";
import { resolveWorktreeRoot } from "../shared/git-worktree.js";

/**
 * How long an instance may go unseen before it stops counting as live.
 *
 * This is what stops a §99 collision from being permanent: two conversations
 * that once shared a key make it ambiguous only while *both* are still running.
 * When one falls silent for this long the survivor becomes addressable again.
 */
export const IDLE_AFTER_MS = 30 * 60_000;

/** How many keys to retain. Mirrors `session-tree.ts`'s bound and its reasoning. */
export const MAX_CONVERSATIONS = 32;

/** Minimum gap between snapshot writes. The registry is on the request path. */
export const SNAPSHOT_THROTTLE_MS = 1_000;

const liveConversationSchema = z.object({
  conversationId: z.string(),
  firstSeenAt: z.string(),
  lastRequestAt: z.string(),
  messageCount: z.number().int().nonnegative(),
  requestCount: z.number().int().nonnegative(),
  ambiguous: z.boolean(),
});

const snapshotSchema = z.object({
  updatedAt: z.string(),
  conversations: z.array(liveConversationSchema),
});

/**
 * `<mainRoot>/.golem/state/live-conversations.json`. Resolved through
 * {@link resolveWorktreeRoot} for the same reason the CCR store and the
 * conversation store are: a linked worktree is the same project as its main
 * checkout, and a device addressing "this project" must not see two of it.
 */
export function liveConversationsPath(projectDir: string): string {
  return path.join(resolveWorktreeRoot(projectDir), ".golem", "state", "live-conversations.json");
}

/** Hash matching `cache-prefix.ts` — `cache_control` markers excluded, 16 hex chars. */
function hash(value: unknown): string {
  const json =
    value === undefined
      ? ""
      : JSON.stringify(value, (key, v) => (key === "cache_control" ? undefined : v));
  return createHash("sha256")
    .update(json ?? "")
    .digest("hex")
    .slice(0, 16);
}

function chainOf(body: Readonly<Record<string, unknown>>): readonly string[] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.map((m) => hash(m));
}

/** One conversation actually running, as distinct from the key it is filed under. */
interface Instance {
  chain: readonly string[];
  firstSeenAt: string;
  lastRequestAt: string;
  requestCount: number;
}

/**
 * How `next` relates to an instance's recorded chain.
 *
 * `continuation` covers both growth and rewind, because both are the same
 * conversation seen at two depths. `divergent` is the only answer that creates a
 * second instance, and therefore the only one that can make a key ambiguous.
 */
function relates(instance: Instance, next: readonly string[]): "continuation" | "divergent" {
  const shared = Math.min(instance.chain.length, next.length);
  for (let i = 0; i < shared; i += 1) {
    if (instance.chain[i] !== next[i]) return "divergent";
  }
  return "continuation";
}

/**
 * Observe request bodies; answer which conversations are live and addressable.
 *
 * Never throws on the request path: {@link observe} is fire-and-forget, exactly
 * like `SessionTreeRecorder.observe`, and a registry that failed a user's
 * request would be a worse bargain than one that missed a conversation.
 */
export class LiveConversationRegistry {
  /** Keyed by conversation key; each value is the set of distinct live instances. */
  readonly #keys = new Map<string, Instance[]>();
  readonly #projectDir: string | undefined;
  readonly #idleAfterMs: number;
  readonly #now: () => number;
  #lastSnapshotAt = 0;
  #inFlight: Promise<void> | null = null;
  #dirty = false;

  constructor(options: {
    /** When set, snapshots are written for other processes to read. */
    readonly projectDir?: string;
    readonly idleAfterMs?: number;
    readonly now?: () => number;
  }) {
    this.#projectDir = options.projectDir;
    this.#idleAfterMs = options.idleAfterMs ?? IDLE_AFTER_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Record one request. Call with the ORIGINAL client body, before any injection. */
  observe(body: Readonly<Record<string, unknown>>): void {
    const chain = chainOf(body);
    if (chain.length === 0) return; // no messages — nothing addressable
    const key = chain[0] as string;
    const nowMs = this.#now();
    const nowIso = new Date(nowMs).toISOString();

    this.#pruneIdle(nowMs);
    const instances = this.#keys.get(key) ?? [];
    const match = instances.find((instance) => relates(instance, chain) === "continuation");
    if (match === undefined) {
      instances.push({
        chain,
        firstSeenAt: nowIso,
        lastRequestAt: nowIso,
        requestCount: 1,
      });
    } else {
      // Keep the DEEPEST chain seen: after a rewind the shorter chain is still a
      // prefix of it, so continuity survives, and a later branch is still caught.
      if (chain.length >= match.chain.length) match.chain = chain;
      match.lastRequestAt = nowIso;
      match.requestCount += 1;
    }
    this.#keys.set(key, instances);
    this.#evict();
    this.#dirty = true;
    this.#maybeSnapshot(nowMs);
  }

  /** Every live conversation, most recently active first. */
  list(): readonly LiveConversation[] {
    this.#pruneIdle(this.#now());
    const out: LiveConversation[] = [];
    for (const [conversationId, instances] of this.#keys) {
      if (instances.length === 0) continue;
      const newest = instances.reduce((a, b) => (a.lastRequestAt >= b.lastRequestAt ? a : b));
      out.push({
        conversationId,
        firstSeenAt: instances.reduce((a, b) => (a.firstSeenAt <= b.firstSeenAt ? a : b))
          .firstSeenAt,
        lastRequestAt: newest.lastRequestAt,
        messageCount: newest.chain.length,
        requestCount: instances.reduce((total, i) => total + i.requestCount, 0),
        ambiguous: instances.length > 1,
      });
    }
    return out.sort((a, b) => b.lastRequestAt.localeCompare(a.lastRequestAt));
  }

  /** One conversation, or `undefined` when the proxy has not seen it (or it went idle). */
  get(conversationId: string): LiveConversation | undefined {
    return this.list().find((c) => c.conversationId === conversationId);
  }

  /**
   * Whether a message may be delivered to `conversationId` right now, and if
   * not, the reason in the words a user needs to read.
   */
  addressable(
    conversationId: string,
  ): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    const found = this.get(conversationId);
    if (found === undefined) {
      return {
        ok: false,
        reason: `no live conversation ${conversationId} — the proxy has not seen a request for it (or it has been idle for over ${Math.round(this.#idleAfterMs / 60_000)} minutes)`,
      };
    }
    if (found.ambiguous) {
      return {
        ok: false,
        reason: `conversation ${conversationId} is ambiguous — two distinct conversations opened with the same first message, so this key cannot identify one of them (verification-notes §99). Nothing is delivered rather than guessing which`,
      };
    }
    return { ok: true };
  }

  /**
   * Write the snapshot now, awaiting any write already in flight.
   *
   * Awaiting the in-flight one is the whole point: `observe` starts writes
   * fire-and-forget, so a `flush` that only started its own would return before
   * the file another process reads actually existed.
   */
  async flush(): Promise<void> {
    if (this.#inFlight !== null) await this.#inFlight;
    await this.#write();
  }

  #pruneIdle(nowMs: number): void {
    const cutoff = nowMs - this.#idleAfterMs;
    for (const [key, instances] of this.#keys) {
      const live = instances.filter((i) => Date.parse(i.lastRequestAt) >= cutoff);
      if (live.length === 0) this.#keys.delete(key);
      else if (live.length !== instances.length) {
        this.#keys.set(key, live);
        this.#dirty = true;
      }
    }
  }

  #evict(): void {
    while (this.#keys.size > MAX_CONVERSATIONS) {
      // Map iteration is insertion-ordered, so the first key is the oldest —
      // the same eviction rule `session-tree.ts` uses.
      const oldest = this.#keys.keys().next();
      if (oldest.done === true) break;
      this.#keys.delete(oldest.value);
    }
  }

  #maybeSnapshot(nowMs: number): void {
    if (nowMs - this.#lastSnapshotAt < SNAPSHOT_THROTTLE_MS) return;
    void this.#write();
  }

  /** Start a write if one is warranted; return the promise so `flush` can await it. */
  #write(): Promise<void> {
    if (this.#projectDir === undefined || !this.#dirty) return Promise.resolve();
    if (this.#inFlight !== null) return this.#inFlight;
    this.#dirty = false;
    this.#lastSnapshotAt = this.#now();
    const promise = this.#doWrite().finally(() => {
      this.#inFlight = null;
    });
    this.#inFlight = promise;
    return promise;
  }

  async #doWrite(): Promise<void> {
    if (this.#projectDir === undefined) return;
    const file = liveConversationsPath(this.#projectDir);
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const payload = {
        updatedAt: new Date(this.#now()).toISOString(),
        conversations: this.list(),
      };
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(
        tmp,
        `${JSON.stringify(payload, null, 2)}
`,
        "utf8",
      );
      await rename(tmp, file);
    } catch {
      // Observe-only: a snapshot nobody could write is a device that sees no
      // conversations, which is the safe direction (invariant 3).
    }
  }
}

/**
 * Read the proxy's snapshot from another process (the mTLS write surface).
 *
 * Returns `[]` when there is no snapshot, when it is unreadable, or when it is
 * stale enough that every conversation in it has gone idle — all three mean the
 * same thing to a device: nothing here can be addressed.
 */
export async function readLiveConversations(
  projectDir: string,
  options: { readonly idleAfterMs?: number; readonly now?: () => number } = {},
): Promise<readonly LiveConversation[]> {
  const idleAfterMs = options.idleAfterMs ?? IDLE_AFTER_MS;
  const nowMs = (options.now ?? Date.now)();
  let raw: string;
  try {
    raw = await readFile(liveConversationsPath(projectDir), "utf8");
  } catch {
    return [];
  }
  let parsed: z.infer<typeof snapshotSchema>;
  try {
    parsed = snapshotSchema.parse(JSON.parse(raw));
  } catch {
    return [];
  }
  const cutoff = nowMs - idleAfterMs;
  return parsed.conversations.filter((c) => Date.parse(c.lastRequestAt) >= cutoff);
}
