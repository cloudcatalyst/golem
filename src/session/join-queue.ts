/**
 * R13.7 — the per-conversation queue of messages authored on a device.
 *
 * Implements {@link ../interfaces/join-queue.ts | JoinQueue}. Two facts about
 * the surrounding system decide the whole design, and neither is negotiable:
 *
 * 1. **Two processes.** The device writes through the mTLS write surface
 *    (`golem device serve`); the delivery happens inside the proxy
 *    (`golem proxy`). They do not share memory, so the queue is on disk, under
 *    `.golem/state/join-queue/`, gitignored like everything else there.
 * 2. **Exactly once, and never twice.** A duplicated instruction to an agent is
 *    not a duplicated packet. So a claim is an **exclusive create** of the
 *    message's file under `delivered/` (`wx`, i.e. `O_EXCL`/`CREATE_NEW`):
 *    exactly one caller can create a given path, and every other caller gets
 *    EEXIST. A message is returned by a claim only once that create has
 *    succeeded. The failure mode this chooses is losing a message (recoverable:
 *    re-send it), never acting on one twice (not recoverable).
 *
 *    This was a `rename` first — the reflexive choice, on the assumption that
 *    the loser of a rename race gets ENOENT. **It is not true on Windows**: two
 *    concurrent `fs.rename` calls on the same source both resolve successfully
 *    (measured 2026-09-03, verification-notes §148), so the first version of
 *    this queue delivered every message twice under a two-process race. Do not
 *    reintroduce a rename here.
 *
 * Layout, one file per message so that no two writers ever edit one file:
 *
 * ```
 * .golem/state/join-queue/
 *   pending/<conversationId>/<enqueuedMs>-<messageId>.json
 *   delivered/<conversationId>/<enqueuedMs>-<messageId>.json
 * ```
 *
 * Both ids are validated against a strict charset before they touch a path:
 * `messageId` is client-supplied, and a queue that let a client choose where a
 * file lands would be a path-traversal bug wearing an idempotency key.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  JoinEnqueueResult,
  JoinQueue,
  JoinQueueMessage,
  LiveConversation,
} from "../interfaces/join-queue.js";
import { redactStandaloneText } from "../pipeline/redaction.js";
import { resolveWorktreeRoot } from "../shared/git-worktree.js";

/** Largest message the queue stores. Matches the transport's own limit. */
export const MAX_MESSAGE_CHARS = 32_000;

/** How many undelivered messages one conversation may hold (gate-map item 6). */
export const MAX_PENDING_PER_CONVERSATION = 16;

/**
 * How long a message may wait before it is expired rather than delivered.
 *
 * The point is invariant 3's tail: "nothing queued that might land later
 * unannounced". An instruction written this morning, delivered when the session
 * finally loops tomorrow, is exactly that — the developer would have forgotten
 * they sent it. Twelve hours is long enough to survive a lunch break and short
 * enough that delivery still means something.
 */
export const PENDING_TTL_MS = 12 * 60 * 60_000;

/** How long a delivered record is kept for the UI before it is pruned. */
export const DELIVERED_RETENTION_MS = 24 * 60 * 60_000;

const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const messageSchema = z.object({
  messageId: z.string(),
  conversationId: z.string(),
  deviceId: z.string(),
  text: z.string(),
  enqueuedAt: z.string(),
  deliveredAt: z.string().optional(),
  expiredAt: z.string().optional(),
});

/** `<mainRoot>/.golem/state/join-queue` — worktree-collapsed, as every store here is. */
export function joinQueueDir(projectDir: string): string {
  return path.join(resolveWorktreeRoot(projectDir), ".golem", "state", "join-queue");
}

export interface FileJoinQueueOptions {
  readonly projectDir: string;
  /**
   * Resolve whether a conversation may be addressed at all.
   *
   * Supplied by the caller rather than imported, because the two processes
   * answer it from different places: the proxy asks its in-memory
   * {@link LiveConversationRegistry}, the write surface reads that registry's
   * snapshot from disk. Omitted means "do not check" — used only where the
   * caller has already checked, never as a default for a device-facing path.
   */
  readonly resolve?: (
    conversationId: string,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  readonly now?: () => number;
  readonly pendingTtlMs?: number;
}

export class FileJoinQueue implements JoinQueue {
  readonly #root: string;
  readonly #resolve: FileJoinQueueOptions["resolve"];
  readonly #now: () => number;
  readonly #ttl: number;

  constructor(options: FileJoinQueueOptions) {
    this.#root = joinQueueDir(options.projectDir);
    this.#resolve = options.resolve;
    this.#now = options.now ?? Date.now;
    this.#ttl = options.pendingTtlMs ?? PENDING_TTL_MS;
  }

  async enqueue(input: {
    readonly conversationId: string;
    readonly deviceId: string;
    readonly messageId: string;
    readonly text: string;
  }): Promise<JoinEnqueueResult> {
    if (!ID_PATTERN.test(input.conversationId)) {
      return { status: "refused", reason: "conversationId is not a valid conversation key" };
    }
    if (!ID_PATTERN.test(input.messageId)) {
      return {
        status: "refused",
        reason: "messageId must be 1-64 characters of [A-Za-z0-9._-]",
      };
    }
    if (input.text.trim() === "") {
      return { status: "refused", reason: "an empty message is not a message" };
    }
    if (input.text.length > MAX_MESSAGE_CHARS) {
      return {
        status: "refused",
        reason: `message too long: ${input.text.length} characters, limit ${MAX_MESSAGE_CHARS}`,
      };
    }

    // Idempotency first, and BEFORE the addressability check: a retry of a
    // message that already landed must return its original outcome even if the
    // conversation has since gone idle or ambiguous.
    const existing = await this.#find(input.messageId);
    if (existing !== undefined) return { status: "duplicate", message: existing };

    if (this.#resolve !== undefined) {
      const verdict = await this.#resolve(input.conversationId);
      if (!verdict.ok) return { status: "refused", reason: verdict.reason };
    }

    const pending = await this.pending(input.conversationId);
    if (pending.length >= MAX_PENDING_PER_CONVERSATION) {
      return {
        status: "refused",
        reason: `${pending.length} messages are already waiting for this conversation (limit ${MAX_PENDING_PER_CONVERSATION}) — it may be idle, in which case nothing is being delivered`,
      };
    }

    const nowMs = this.#now();
    const message: JoinQueueMessage = {
      messageId: input.messageId,
      conversationId: input.conversationId,
      deviceId: input.deviceId,
      // Redaction before storage — the contract's binding note, and CLAUDE.md's
      // hard rule applied to this store. There is no path here that writes raw.
      text: redactStandaloneText(input.text),
      enqueuedAt: new Date(nowMs).toISOString(),
    };
    const dir = path.join(this.#root, "pending", input.conversationId);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${nowMs}-${input.messageId}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(message, null, 2)}\n`, "utf8");
    await rename(tmp, file);
    return { status: "queued", message };
  }

  async pending(conversationId: string): Promise<readonly JoinQueueMessage[]> {
    if (!ID_PATTERN.test(conversationId)) return [];
    const entries = await this.#readDir(path.join(this.#root, "pending", conversationId));
    return entries.map((e) => e.message);
  }

  async claim(conversationId: string): Promise<readonly JoinQueueMessage[]> {
    if (!ID_PATTERN.test(conversationId)) return [];
    const pendingDir = path.join(this.#root, "pending", conversationId);
    const deliveredDir = path.join(this.#root, "delivered", conversationId);
    const entries = await this.#readDir(pendingDir);
    if (entries.length === 0) return [];
    await mkdir(deliveredDir, { recursive: true });

    const nowMs = this.#now();
    const claimed: JoinQueueMessage[] = [];
    for (const entry of entries) {
      const expired = nowMs - Date.parse(entry.message.enqueuedAt) > this.#ttl;
      const settled: JoinQueueMessage = expired
        ? { ...entry.message, expiredAt: new Date(nowMs).toISOString() }
        : { ...entry.message, deliveredAt: new Date(nowMs).toISOString() };
      const target = path.join(deliveredDir, entry.name);
      try {
        // THE CLAIM. Exclusive create — `wx` is `CREATE_NEW`/`O_EXCL`, so exactly
        // one caller can create this path and every other gets EEXIST.
        //
        // This was a `rename` first, on the usual assumption that a rename is
        // atomic and its loser gets ENOENT. It is not enough on Windows:
        // two concurrent `fs.rename` calls on the SAME source both resolve
        // successfully there (measured 2026-09-03, verification-notes §148),
        // which delivered every queued message twice. Exclusive create is the
        // primitive that actually refuses the second caller.
        await writeFile(target, `${JSON.stringify(settled, null, 2)}\n`, { flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          // Someone else owns this message. If they died between claiming it and
          // removing the pending copy, that copy would otherwise sit here
          // forever, unclaimable and undelivered — so clear it now. The
          // delivered record is what proves ownership was settled, and it is
          // already on disk, so this cannot cause a second delivery.
          await rm(entry.file).catch(() => {});
        }
        continue;
      }
      // Ownership is settled; losing this leaves a pending copy the branch above
      // collects on the next claim.
      await rm(entry.file).catch(() => {});
      // An expired message is claimed (so it can never land later) but NOT
      // returned for delivery — the whole point of the TTL.
      if (!expired) claimed.push(settled);
    }
    return claimed;
  }

  async list(): Promise<readonly JoinQueueMessage[]> {
    const out: JoinQueueMessage[] = [];
    for (const state of ["pending", "delivered"] as const) {
      const base = path.join(this.#root, state);
      let conversations: string[];
      try {
        conversations = await readdir(base);
      } catch {
        continue;
      }
      for (const conversationId of conversations) {
        const entries = await this.#readDir(path.join(base, conversationId));
        for (const entry of entries) out.push(entry.message);
      }
    }
    return out.sort((a, b) => b.enqueuedAt.localeCompare(a.enqueuedAt));
  }

  async forget(messageId: string): Promise<boolean> {
    if (!ID_PATTERN.test(messageId)) return false;
    const base = path.join(this.#root, "pending");
    let conversations: string[];
    try {
      conversations = await readdir(base);
    } catch {
      return false;
    }
    for (const conversationId of conversations) {
      const entries = await this.#readDir(path.join(base, conversationId));
      const found = entries.find((e) => e.message.messageId === messageId);
      if (found === undefined) continue;
      try {
        await rm(found.file);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /** Drop delivered records older than {@link DELIVERED_RETENTION_MS}. */
  async prune(): Promise<void> {
    const base = path.join(this.#root, "delivered");
    const cutoff = this.#now() - DELIVERED_RETENTION_MS;
    let conversations: string[];
    try {
      conversations = await readdir(base);
    } catch {
      return;
    }
    for (const conversationId of conversations) {
      const entries = await this.#readDir(path.join(base, conversationId));
      for (const entry of entries) {
        if (Date.parse(entry.message.enqueuedAt) >= cutoff) continue;
        try {
          await rm(entry.file);
        } catch {
          // A record someone else already pruned is not an error.
        }
      }
    }
  }

  async #find(messageId: string): Promise<JoinQueueMessage | undefined> {
    for (const state of ["pending", "delivered"] as const) {
      const base = path.join(this.#root, state);
      let conversations: string[];
      try {
        conversations = await readdir(base);
      } catch {
        continue;
      }
      for (const conversationId of conversations) {
        const entries = await this.#readDir(path.join(base, conversationId));
        const found = entries.find((e) => e.message.messageId === messageId);
        if (found !== undefined) return found.message;
      }
    }
    return undefined;
  }

  /** Oldest first — the filename's millisecond prefix is the sort key. */
  async #readDir(
    dir: string,
  ): Promise<readonly { name: string; file: string; message: JoinQueueMessage }[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: { name: string; file: string; message: JoinQueueMessage }[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
      const file = path.join(dir, name);
      try {
        const parsed = messageSchema.parse(JSON.parse(await readFile(file, "utf8")));
        // Rebuilt field by field rather than spread: under
        // `exactOptionalPropertyTypes` a zod-optional key is `string | undefined`,
        // which is a different type from "absent" — and absent is what "still
        // pending" means here.
        const message: JoinQueueMessage = {
          messageId: parsed.messageId,
          conversationId: parsed.conversationId,
          deviceId: parsed.deviceId,
          text: parsed.text,
          enqueuedAt: parsed.enqueuedAt,
          ...(parsed.deliveredAt !== undefined && { deliveredAt: parsed.deliveredAt }),
          ...(parsed.expiredAt !== undefined && { expiredAt: parsed.expiredAt }),
        };
        out.push({ name, file, message });
      } catch {
        // A half-written or hand-mangled file is skipped, never delivered.
      }
    }
    return out;
  }
}

/**
 * The addressability check, phrased for the write surface — which cannot ask the
 * proxy's in-memory registry and so reads its snapshot instead.
 */
export function resolveFromSnapshot(
  conversations: readonly LiveConversation[],
): (conversationId: string) => Promise<{ ok: true } | { ok: false; reason: string }> {
  return async (conversationId: string) => {
    const found = conversations.find((c) => c.conversationId === conversationId);
    if (found === undefined) {
      return {
        ok: false,
        reason: `no live conversation ${conversationId} — the proxy has not seen a request for it recently`,
      };
    }
    if (found.ambiguous) {
      return {
        ok: false,
        reason: `conversation ${conversationId} is ambiguous — two conversations opened with the same first message, so nothing is delivered rather than guessing which (verification-notes §99)`,
      };
    }
    return { ok: true };
  };
}
