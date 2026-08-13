/**
 * R8.S3 — session tree recorder: observe request bodies, build a conversation tree
 * keyed on content hashes (no prompt content), detect branches on rewind.
 *
 * **Spike scope.** Recording + `golem session tree` only. No actuation — Decision 37
 * stands. Conversation identity mirrors `cachePrefixFingerprint` (hash of the first
 * message), with the same known limitation (§99: multiplexed short conversations
 * through one proxy share a key). R8.13 is the identity fix.
 *
 * **Bounded storage.** Only the latest N conversations are kept; oldest-inserted
 * evicted first. Persisted to `.golem/state/session-tree.json`.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** ── Data model ─────────────────────────────────────────────────────── */

export interface SessionBranch {
  /** 0-based index in the parent conversation's messages where this branch diverged. */
  forkedAt: number;
  /** Timestamp (ISO) of the first request on this branch. */
  startedAt: string;
  /** Timestamp (ISO) of the most recent request on this branch. */
  lastRequestAt: string;
  /** Number of requests on this branch. */
  requestCount: number;
  /** Current depth (number of messages in the latest request, minus the fork point). */
  depth: number;
  /** Sub-branches, newest-first. */
  branches: SessionBranch[];
}

export interface SessionConversation {
  /** Hash of the first message (the cache-prefix conversation key). */
  conversationKey: string;
  /** Timestamp (ISO) of the first request. */
  startedAt: string;
  /** Timestamp (ISO) of the most recent request. */
  lastRequestAt: string;
  /** Total requests across all branches. */
  requestCount: number;
  /** The root branch — unwinds on rewind, forks on divergence. */
  root: SessionBranch;
}

export interface SessionTree {
  conversations: SessionConversation[];
}

/** ── Zod schemas for persistence ────────────────────────────────────── */

const branchSchema: z.ZodType<SessionBranch> = z.object({
  forkedAt: z.number().int().nonnegative(),
  startedAt: z.string(),
  lastRequestAt: z.string(),
  requestCount: z.number().int().positive(),
  depth: z.number().int().nonnegative(),
  branches: z.lazy(() => z.array(branchSchema)),
});

const conversationSchema: z.ZodType<SessionConversation> = z.object({
  conversationKey: z.string(),
  startedAt: z.string(),
  lastRequestAt: z.string(),
  requestCount: z.number().int().positive(),
  root: branchSchema,
});

const sessionTreeSchema = z.object({
  conversations: z.array(conversationSchema),
});

/** ── Recorder ───────────────────────────────────────────────────────── */

/**
 * Hash of a value (SHA-256, first 16 hex chars) — matches the convention in
 * `cache-prefix.ts` so the conversation key is the same stable identifier.
 * Excludes `cache_control` markers, matching the cache-prefix rule.
 */
function hash(value: unknown): string {
  const json =
    value === undefined
      ? ""
      : JSON.stringify(value, (_key, v) => (_key === "cache_control" ? undefined : v));
  return createHash("sha256")
    .update(json ?? "")
    .digest("hex")
    .slice(0, 16);
}

/**
 * Derive a conversation key. Mirrors `cachePrefixFingerprint` — hash of the
 * first message — so the session tree and cache-prefix observer agree on identity.
 * An empty key means "no messages yet" (unusual for a real request, handled).
 */
function conversationKey(body: Readonly<Record<string, unknown>>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.length > 0 ? hash(messages[0]) : "";
}

/** How many conversations to keep before evicting the oldest. */
const MAX_CONVERSATIONS = 32;

/**
 * Observe request bodies and build a conversation tree. Wired into the request
 * pipeline alongside the context-ledger write.
 *
 * Thread-safety: called from a single-threaded Node event loop, so no locking.
 * Persistence is atomic (temp + rename).
 */
export class SessionTreeRecorder {
  /** Keyed by conversationKey. */
  readonly #conversations = new Map<string, SessionConversation>();
  readonly #max: number;

  constructor(maxConversations = MAX_CONVERSATIONS) {
    this.#max = maxConversations;
  }

  /**
   * Observe a request body and update the tree. Called once per request.
   *
   * The observation is: given the current request's messages array, what is the
   * longest prefix that matches the last request for this conversation?
   * If the prefix is shorter than the last request's total messages, the user
   * rewound — that's a fork point. If it's longer, we're in the same branch.
   * If the conversation is new, we create a root branch.
   */
  observe(body: Readonly<Record<string, unknown>>): void {
    this.#observeAt(body, new Date().toISOString());
  }

  /** Time-injected variant — lets tests drive the clock without waiting. */
  observeAt(body: Readonly<Record<string, unknown>>, nowIso: string): void {
    this.#observeAt(body, nowIso);
  }

  #observeAt(body: Readonly<Record<string, unknown>>, nowIso: string): void {
    const key = conversationKey(body);
    if (key === "") return;

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const currentHashes = messages.map((m) => hash(m));

    const existing = this.#conversations.get(key);

    if (existing === undefined) {
      // New conversation.
      const branch: SessionBranch = {
        forkedAt: 0,
        startedAt: nowIso,
        lastRequestAt: nowIso,
        requestCount: 1,
        depth: currentHashes.length,
        branches: [],
      };
      this.#conversations.set(key, {
        conversationKey: key,
        startedAt: nowIso,
        lastRequestAt: nowIso,
        requestCount: 1,
        root: branch,
      });
    } else {
      // Existing conversation — find the right branch and update it.
      existing.lastRequestAt = nowIso;
      existing.requestCount++;
      this.#updateBranch(existing.root, currentHashes, nowIso, new Set<string>());
    }

    // Evict oldest.
    this.#evict();
  }

  /**
   * Walk the branch tree to find where the current messages fit.
   * Strategy: compare the current hash sequence against the branch's recorded state.
   * If the current sequence is an extension of the branch's last sequence, update depth.
   * If it's a rewind, find or create a sub-branch.
   */
  #updateBranch(
    branch: SessionBranch,
    currentHashes: readonly string[],
    nowIso: string,
    _seen: Set<string>,
  ): void {
    branch.lastRequestAt = nowIso;
    branch.requestCount++;

    // The branch's scope is messages from `forkedAt` onward.
    // Current messages are `[0..currentHashes.length)`.
    // If currentHashes is longer than the branch's current depth + fork point,
    // we're extending this branch.
    const branchEnd = branch.forkedAt + branch.depth;

    if (currentHashes.length > branchEnd) {
      // Extending this branch.
      branch.depth = currentHashes.length - branch.forkedAt;
      return;
    }

    if (currentHashes.length === branchEnd) {
      // Same length — no change to depth.
      return;
    }

    // The request is shorter than the branch's last state — a rewind.
    // Find the right sub-branch or create one.
    if (currentHashes.length <= branch.forkedAt) {
      // Rewound past this branch's fork point — shouldn't happen in normal
      // conversation flow, but handle gracefully.
      return;
    }

    // Look for an existing sub-branch that forked at the same point.
    const forkIndex = currentHashes.length;
    const existing = branch.branches.find((b) => b.forkedAt === forkIndex);

    if (existing !== undefined) {
      // Continue the sub-branch.
      this.#updateBranch(existing, currentHashes, nowIso, _seen);
    } else {
      // New sub-branch.
      branch.branches.push({
        forkedAt: forkIndex,
        startedAt: nowIso,
        lastRequestAt: nowIso,
        requestCount: 1,
        depth: 0, // Will be set by the recursive call, but for a new branch depth=0 means "at the fork point"
        branches: [],
      });
      // Sort branches newest-first.
      branch.branches.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    }
  }

  #evict(): void {
    while (this.#conversations.size > this.#max) {
      const oldest = this.#conversations.keys().next();
      if (oldest.done === true) break;
      this.#conversations.delete(oldest.value);
    }
  }

  /** Snapshot the current tree. */
  snapshot(): SessionTree {
    return {
      conversations: [...this.#conversations.values()].sort((a, b) =>
        b.lastRequestAt.localeCompare(a.lastRequestAt),
      ),
    };
  }

  /** Number of conversations tracked. */
  size(): number {
    return this.#conversations.size;
  }
}

/** ── Persistence ────────────────────────────────────────────────────── */

export function sessionTreePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "session-tree.json");
}

export async function writeSessionTree(projectDir: string, tree: SessionTree): Promise<void> {
  const file = sessionTreePath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(tree, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

export async function readSessionTree(projectDir: string): Promise<SessionTree | null> {
  let raw: string;
  try {
    raw = await readFile(sessionTreePath(projectDir), "utf8");
  } catch {
    return null;
  }
  try {
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = sessionTreeSchema.safeParse(JSON.parse(stripped));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** ── Rendering (CLI) ────────────────────────────────────────────────── */

/**
 * Render a session tree for the terminal.
 * Shows each conversation, its branches, and when they forked.
 */
export function renderSessionTree(tree: SessionTree): string {
  if (tree.conversations.length === 0) return "No recorded sessions.\n";

  const lines: string[] = [];
  lines.push(`session tree — ${tree.conversations.length} conversation(s)\n`);

  for (const conv of tree.conversations) {
    const ago = timeAgo(conv.lastRequestAt);
    lines.push(
      `  ${conv.conversationKey.slice(0, 10)}…  ${conv.requestCount} request(s)  ` +
        `last ${ago}  ${conv.startedAt.slice(0, 10)}`,
    );
    renderBranchLines(lines, conv.root, "    ", 0);
  }

  lines.push("");
  return lines.join("\n");
}

function renderBranchLines(
  lines: string[],
  branch: SessionBranch,
  indent: string,
  _depth: number,
): void {
  const ago = timeAgo(branch.lastRequestAt);
  const branchLabel =
    branch.forkedAt === 0
      ? `root  ${branch.depth} messages, ${branch.requestCount} request(s), last ${ago}`
      : `fork at msg ${branch.forkedAt}  ${branch.depth} messages, ${branch.requestCount} request(s), last ${ago}`;
  lines.push(`${indent}${branchLabel}`);

  for (const sub of branch.branches) {
    renderBranchLines(lines, sub, `${indent}  `, 0);
  }
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}
