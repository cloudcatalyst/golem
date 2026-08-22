/**
 * R13.2 — the conversation store: persist redacted transcripts locally,
 * bounded, forgettable, and never in git.
 *
 * `session-tree.ts` (R8.S3) deliberately stores *content hashes, no prompt
 * content* — this is the deliberate, argued exception to that, made by
 * ADR-0007 §6 (a USER DECISION, spec Decision 60): scrollback ("see the
 * previous messages") and continuation (R13.8) both need real turn text on
 * disk, which hashes cannot provide. What changed: prompt content is now
 * persisted, here, and only here. What did NOT change: `session-tree.ts`
 * keeps recording hashes only, for its own branch-detection purpose; this
 * store does not replace it, does not read it, and does not weaken its
 * "no prompt content" guarantee — this is a second, separate store sitting
 * beside it. ADR-0007 Revision 1 dropped branching, so this store is sized
 * for scrollback and continuation, not an indefinite archive (see the
 * eviction defaults below).
 *
 * **Redaction is structural, not optional.** `appendTurn` always runs
 * `redactRequestBody` (the same stage the proxy runs before anything is
 * forwarded upstream — CLAUDE.md's redaction hard rule) over `turn.content`
 * before it is ever written to disk. There is no parameter, flag, or branch
 * that stores the raw value instead; the only content this class ever writes
 * is the redacted result. `turns` in a stored `ConversationRecord` are
 * therefore already-redacted by construction, not by caller discipline.
 *
 * **Local-only.** One JSON file per conversation under
 * `<project>/.golem/conversations/<conversationId>.json`, mode `0o600`
 * (owner-only where the platform honours file modes; a no-op on Windows).
 * Nothing here is sent anywhere.
 *
 * **Bounded.** Count (`maxConversations`) and age (`maxAgeMs`), oldest
 * evicted first, both configurable — precedent shape from
 * `src/knowledge/web-cache.ts` (a bounded local store under `.golem/`) and
 * `session-tree.ts` (count-based eviction, `MAX_CONVERSATIONS`).
 *
 * **Identity agrees with what exists.** `conversationIdFor` reuses
 * `cachePrefixFingerprint` (`src/proxy/cache-prefix.ts`, fixed by R8.13) —
 * the exact function `session-tree.ts` mirrors for its own conversation key —
 * so one conversation has one id in both stores; this file does not
 * re-derive a second hash of its own. `forProjectDir` resolves a git linked
 * worktree to its main checkout root via `resolveWorktreeRoot`
 * (`src/shared/git-worktree.ts`, task ccr-ref-scope) FIRST, the same
 * collapse the CCR store and the vector index already apply, so a
 * conversation started from inside a worktree checkout is rooted at the same
 * `.golem/conversations` a main-checkout reader would see.
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  ConversationRecord,
  ConversationStore,
  ConversationSummary,
  ConversationTurn,
} from "../interfaces/conversation-store.js";
import { redactRequestBody } from "../pipeline/redaction.js";
import { cachePrefixFingerprint } from "../proxy/cache-prefix.js";
import { resolveWorktreeRoot } from "../shared/git-worktree.js";

/** ── Zod schema for persistence ─────────────────────────────────────── */

// `z.unknown()` accepts `undefined`, which makes zod infer `content` as an
// optional key even though `ConversationTurn.content` is required (its VALUE
// type is `unknown`, not its presence) — a schema-inference quirk, not a
// real optionality. `as ConversationRecord` below is the deliberate,
// documented cast past that; the shapes otherwise match exactly.
const turnSchema = z.object({
  role: z.string(),
  content: z.unknown(),
  timestamp: z.string(),
});

const recordSchema = z.object({
  conversationId: z.string(),
  startedAt: z.string(),
  lastTurnAt: z.string(),
  turns: z.array(turnSchema),
});

/** ── Identity (shared with session-tree.ts) ────────────────────────── */

/**
 * Derive a conversation id from a request body. Delegates entirely to
 * {@link cachePrefixFingerprint} (as fixed by R8.13 — cache_control markers no
 * longer perturb the hash) so this store's identity is exactly
 * `session-tree.ts`'s conversation key, not a second opinion on it. The only
 * place this store derives identity; callers must not hash their own.
 */
export function conversationIdFor(body: Readonly<Record<string, unknown>>): string {
  return cachePrefixFingerprint(body).conversationKey;
}

/** ── Storage location ───────────────────────────────────────────────── */

/**
 * `<mainRoot>/.golem/conversations`. `projectRoot` is resolved through
 * {@link resolveWorktreeRoot} FIRST (task ccr-ref-scope) — a git linked
 * worktree is the SAME project as its main checkout, so a conversation
 * recorded from inside `.claude/worktrees/agent-<id>/` is rooted at the same
 * directory this reads from, whichever of the two `projectRoot` happens to
 * name. Non-repos and an already-main `projectRoot` pass through unchanged.
 */
export function conversationStoreDir(projectRoot: string): string {
  return path.join(resolveWorktreeRoot(projectRoot), ".golem", "conversations");
}

/** How many conversations to keep before evicting the oldest (by `lastTurnAt`). */
const DEFAULT_MAX_CONVERSATIONS = 32;

/**
 * How long a conversation may go unused before eviction. ADR-0007 Revision 1
 * dropped branching — this store exists for scrollback and continuation, not
 * an indefinite archive — so the default is measured in weeks, not forever.
 */
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface ConversationStoreOptions {
  readonly maxConversations?: number;
  readonly maxAgeMs?: number;
}

/** ── Implementation ─────────────────────────────────────────────────── */

/**
 * File-backed `ConversationStore`: one JSON file per conversation under
 * `dir`. Reads tolerate a missing/corrupt file (treated as absent), matching
 * `web-cache.ts`'s tolerance for an external-facing store. Writes are
 * atomic (temp file + rename), matching `session-tree.ts`'s
 * `writeSessionTree`.
 */
export class LocalConversationStore implements ConversationStore {
  readonly #dir: string;
  readonly #maxConversations: number;
  readonly #maxAgeMs: number;

  constructor(dir: string, options: ConversationStoreOptions = {}) {
    this.#dir = dir;
    this.#maxConversations = options.maxConversations ?? DEFAULT_MAX_CONVERSATIONS;
    this.#maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  /** See the module header for the worktree-collapse rationale. */
  static forProjectDir(
    projectRoot: string,
    options: ConversationStoreOptions = {},
  ): LocalConversationStore {
    return new LocalConversationStore(conversationStoreDir(projectRoot), options);
  }

  #fileFor(conversationId: string): string {
    return path.join(this.#dir, `${conversationId}.json`);
  }

  async #readRecord(conversationId: string): Promise<ConversationRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.#fileFor(conversationId), "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = recordSchema.safeParse(JSON.parse(raw));
      return parsed.success ? (parsed.data as ConversationRecord) : null;
    } catch {
      return null;
    }
  }

  async #writeRecord(record: ConversationRecord): Promise<void> {
    const file = this.#fileFor(record.conversationId);
    await mkdir(this.#dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, file);
  }

  /**
   * Redacts `turn.content` (unconditionally — see the module header) and
   * appends the redacted turn to `conversationId`, creating the conversation
   * if it does not exist yet. Runs eviction afterward so the store never
   * grows past its configured bounds.
   */
  async appendTurn(conversationId: string, turn: ConversationTurn): Promise<void> {
    const { value: redactedContent } = redactRequestBody(turn.content);
    const redactedTurn: ConversationTurn = {
      role: turn.role,
      content: redactedContent,
      timestamp: turn.timestamp,
    };

    const existing = await this.#readRecord(conversationId);
    const record: ConversationRecord = {
      conversationId,
      startedAt: existing?.startedAt ?? turn.timestamp,
      lastTurnAt: turn.timestamp,
      turns: [...(existing?.turns ?? []), redactedTurn],
    };

    await this.#writeRecord(record);
    await this.#evict();
  }

  async readConversation(conversationId: string): Promise<ConversationRecord | null> {
    return this.#readRecord(conversationId);
  }

  /**
   * All retained conversations, newest (`lastTurnAt`) first. Best-effort: a
   * missing store directory (nothing recorded yet) yields `[]`; a corrupt or
   * unparseable entry is skipped rather than throwing, same tolerance as
   * `#readRecord`.
   */
  async listConversations(): Promise<readonly ConversationSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return [];
    }

    const summaries: ConversationSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const conversationId = name.slice(0, -".json".length);
      const record = await this.#readRecord(conversationId);
      if (record === null) continue;
      summaries.push({
        conversationId: record.conversationId,
        startedAt: record.startedAt,
        lastTurnAt: record.lastTurnAt,
        turnCount: record.turns.length,
      });
    }

    return summaries.sort((a, b) => b.lastTurnAt.localeCompare(a.lastTurnAt));
  }

  /** Delete one conversation. Returns whether it existed before deletion. */
  async forget(conversationId: string): Promise<boolean> {
    const file = this.#fileFor(conversationId);
    try {
      await stat(file);
    } catch {
      return false;
    }
    await rm(file, { force: true });
    return true;
  }

  /**
   * Delete every conversation the store holds — the documented
   * delete-everything path (ADR-0007 §6 / task R13.2 gate). Recreates an
   * empty directory so a subsequent `appendTurn` does not need to special-case
   * "the store never existed" vs. "the store was just emptied."
   */
  async forgetAll(): Promise<void> {
    await rm(this.#dir, { recursive: true, force: true });
    await mkdir(this.#dir, { recursive: true });
  }

  /**
   * Evict by age first, then by count, oldest (`lastTurnAt`) first — run
   * after every `appendTurn` so the store never grows past its configured
   * bounds. Best-effort against a missing directory (nothing to evict) or an
   * unreadable entry (skipped, not counted).
   */
  async #evict(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return;
    }

    const cutoffMs = Date.now() - this.#maxAgeMs;
    const survivors: { conversationId: string; lastTurnAt: string }[] = [];

    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const conversationId = name.slice(0, -".json".length);
      const record = await this.#readRecord(conversationId);
      if (record === null) continue;

      const lastTurnMs = Date.parse(record.lastTurnAt);
      const isStale = !Number.isFinite(lastTurnMs) || lastTurnMs < cutoffMs;
      if (isStale) {
        await rm(this.#fileFor(conversationId), { force: true });
        continue;
      }
      survivors.push({ conversationId, lastTurnAt: record.lastTurnAt });
    }

    if (survivors.length <= this.#maxConversations) return;

    survivors.sort((a, b) => a.lastTurnAt.localeCompare(b.lastTurnAt));
    const toEvict = survivors.slice(0, survivors.length - this.#maxConversations);
    for (const { conversationId } of toEvict) {
      await rm(this.#fileFor(conversationId), { force: true });
    }
  }
}
