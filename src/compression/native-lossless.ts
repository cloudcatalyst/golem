/**
 * NativeLosslessCompression — Golem-native TypeScript implementation of the
 * frozen CompressionService contract (task A2; spec Decision 18, P0 bullet).
 *
 * Lossless stages only:
 *   - "dedup":      exact repeats of large content within one conversation are
 *                   replaced by CCR reference markers; the first occurrence is
 *                   always kept in place; originals are persisted
 *                   content-addressed so retrieve(ref) is byte-exact.
 *   - "compaction": pure whitespace/log-noise transforms on tool_result text
 *                   (see compaction.ts).
 *
 * ## Cache alignment: byte-stability by construction
 * Anthropic prompt-cache hits require a byte-identical prefix
 * (verification-notes.md §14), so re-compressing a previously-sent prefix
 * MUST reproduce identical bytes. Rather than persisting a replay ledger,
 * every decision here is a PURE function of the original message prefix:
 *
 *   - the transform of messages[i] depends ONLY on the original bytes of
 *     messages[0..i] (the dedup seen-set is rebuilt from the input on every
 *     call and never consults mutable store state),
 *   - marker text is derived only from the content hash and a deterministic
 *     token estimate,
 *   - compaction is a pure, versioned function.
 *
 * Therefore extending a conversation can never change the compressed form of
 * earlier messages, and any instance (even a fresh process) reproduces the
 * same bytes for the same input. This also makes the stage safe under
 * concurrent conversations sharing one CCR store.
 *
 * Determinism obligations for future edits: never let a compress() decision
 * depend on the CCR store, wall clock, config that varies per call (beyond
 * the PipelinePolicy stages gate), or iteration order of anything not derived
 * from the input.
 *
 * Fidelity: assistant messages (text, thinking, tool_use blocks) and any
 * unrecognized structure pass through untouched — only user-side text and
 * tool_result text are candidates (proxy fidelity hard rule).
 *
 * Stats are in-memory per service instance; durable per-stage attribution is
 * task A4 (telemetry/SQLite).
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  CCRRef,
  CompressionService,
  CompressionStats,
  CompressResult,
  Message,
  Original,
  TokenDelta,
} from "../interfaces/compression.js";
import type { PipelinePolicy } from "../interfaces/policy.js";
import type { BlobStore } from "../interfaces/storage.js";
import { resolveWorktreeRoot } from "../shared/git-worktree.js";
import { isRecord } from "../shared/json.js";
import { CcrStore } from "./ccr-store.js";
import { compactText } from "./compaction.js";
import { LocalDirBlobStore } from "./local-blob-store.js";
import { estimateTokens } from "./tokens.js";

/** Stage keys used in CompressResult.stageSavings / CompressionStats.perStage. */
export const STAGE_DEDUP = "dedup";
export const STAGE_COMPACTION = "compaction";

/** All CCR originals in this stage are text. */
const TEXT_PLAIN = "text/plain";

/**
 * Contents shorter than this are never dedup candidates: a marker would not
 * pay for itself, and tracking tiny strings adds hash noise. Changing this
 * value changes emitted bytes -> treat like COMPACTION_VERSION (call it out
 * in the PR; invalidates live cache prefixes).
 */
export const DEFAULT_MIN_DEDUP_CHARS = 256;

/** Regex that extracts the refId from an inline CCR marker (for expand). */
export const CCR_MARKER_RE = /hash=([0-9a-f]{64})/;

/**
 * R9.23 — tools whose results are NEVER dedup candidates, however large or
 * repeated.
 *
 * CCR's bargain is "replace bulk with a reference the agent can expand on
 * demand". That assumes expansion is always available. For a **tool schema** it
 * is not, and the failure is a deadlock rather than an inconvenience:
 *
 * `ToolSearch` is how a deferred tool's schema is loaded. Under snooze
 * enforcement (Decision 45) the only permitted call is `mcp__golem__snooze` —
 * itself deferred — so the agent must `ToolSearch` for its schema first. Every
 * such call came back elided (observed live twice: 2026-08-10 and 2026-08-13),
 * and `expand`, which would retrieve the reference, is *also* deferred and also
 * denied by enforcement. The agent cannot park, so the note that was supposed to
 * survive the session is never written.
 *
 * The elision was not even wrong-in-detail: the dedup keys on the response BODY,
 * so two differently-spelled queries resolving to the same schema collide and no
 * rephrasing escapes it (confirmed 2026-08-13 — same hash across four spellings
 * within a session, different hash across sessions).
 *
 * Beyond the deadlock, a schema is not prose. It is the executable contract for a
 * call the model is about to make, and unlike a file excerpt it cannot be
 * re-derived, narrowed, or grepped for. So the exemption is unconditional rather
 * than "only while enforcement is active" — a conditional one would leave a
 * confusing elision in every other session for no gain.
 *
 * Cheap, too: §102 measured `ToolSearch` results at a few hundred tokens.
 */
export const DEDUP_EXEMPT_TOOLS: readonly string[] = ["ToolSearch"];

/**
 * Inline retrieval marker, following Headroom's marker convention
 * ("... Retrieve more: hash=<h>", verification-notes.md §2) so a future P2
 * sidecar and expand share one `hash=` grammar. Pure function of
 * (refId, originalTokens) — REQUIRED for prefix byte-stability.
 */
export function ccrMarker(refId: string, originalTokens: number): string {
  return (
    `[Golem: duplicate content elided (lossless dedup, ~${originalTokens} tokens); ` +
    `identical content appears earlier in this conversation. ` +
    `Retrieve original: hash=${refId}]`
  );
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface MutableDelta {
  tokensBefore: number;
  tokensAfter: number;
}

function newDelta(): MutableDelta {
  return { tokensBefore: 0, tokensAfter: 0 };
}

/** Per-call working state. Rebuilt from the input on every compress() call. */
interface CompressContext {
  readonly minDedupChars: number;
  /** Content hashes seen earlier in THIS messages array (first occurrences). */
  readonly seen: Set<string>;
  /** refId -> emitted ref (unique per call even if elided multiple times). */
  readonly refs: Map<string, CCRRef>;
  /** refId -> original content awaiting persistence. */
  readonly pendingOriginals: Map<string, string>;
  /**
   * R9.23 — `tool_use` ids belonging to {@link DEDUP_EXEMPT_TOOLS}, collected
   * from assistant messages as the array is walked in order.
   *
   * Filled from the PREFIX, which is what keeps the determinism obligation in the
   * module doc intact: the API requires every `tool_result` to name a
   * `tool_use_id` from an EARLIER assistant message, so by the time a result is
   * transformed its id is already known — and the transform of `messages[i]`
   * still depends only on the original bytes of `messages[0..i]`.
   */
  readonly exemptToolUseIds: Set<string>;
  readonly dedup: MutableDelta;
  readonly compaction: MutableDelta;
}

interface ProjectAccount {
  requests: number;
  tokensBefore: number;
  tokensAfter: number;
  readonly perStage: Map<string, MutableDelta>;
  /** refIds this project has emitted (for retrieve attribution). */
  readonly refsEmitted: Set<string>;
  ccrRefsStored: number;
  ccrRefsRetrieved: number;
}

function newAccount(): ProjectAccount {
  return {
    requests: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    perStage: new Map(),
    refsEmitted: new Set(),
    ccrRefsStored: 0,
    ccrRefsRetrieved: 0,
  };
}

/**
 * Core per-text transform. Pure given (text, compactable, prior seen-set) —
 * see the module doc for why that purity is load-bearing.
 */
function processText(text: string, compactable: boolean, ctx: CompressContext): string {
  if (text.length >= ctx.minDedupChars) {
    const hash = sha256Hex(text);
    if (ctx.seen.has(hash)) {
      const originalTokens = estimateTokens(text);
      const marker = ccrMarker(hash, originalTokens);
      if (marker.length < text.length) {
        ctx.dedup.tokensBefore += originalTokens;
        ctx.dedup.tokensAfter += estimateTokens(marker);
        ctx.refs.set(hash, { refId: hash, contentType: TEXT_PLAIN, originalTokens });
        ctx.pendingOriginals.set(hash, text);
        return marker;
      }
    } else {
      ctx.seen.add(hash);
    }
  }
  if (compactable) {
    const compacted = compactText(text);
    if (compacted !== text) {
      ctx.compaction.tokensBefore += estimateTokens(text);
      ctx.compaction.tokensAfter += estimateTokens(compacted);
      return compacted;
    }
  }
  return text;
}

/** tool_result `content` may be a string or an array of blocks. */
function transformToolResultContent(content: unknown, ctx: CompressContext): unknown {
  if (typeof content === "string") {
    return processText(content, true, ctx);
  }
  if (Array.isArray(content)) {
    let changed = false;
    const out = content.map((item) => {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
        const text = processText(item.text, true, ctx);
        if (text !== item.text) {
          changed = true;
          return { ...item, text };
        }
      }
      return item;
    });
    return changed ? out : content;
  }
  return content;
}

/**
 * R9.23 — note the ids of `tool_use` blocks calling an exempt tool, so their
 * results can be recognized when they arrive in the next user message.
 *
 * Matching on the id rather than sniffing the result text is deliberate: the
 * conversation already carries the authoritative tool NAME, and a content
 * heuristic in a byte-stability-critical stage would be a guess where a fact is
 * available.
 */
function collectExemptToolUses(message: Message, ctx: CompressContext): void {
  const content = message.content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "tool_use" &&
      typeof block.name === "string" &&
      typeof block.id === "string" &&
      DEDUP_EXEMPT_TOOLS.includes(block.name)
    ) {
      ctx.exemptToolUseIds.add(block.id);
    }
  }
}

function transformUserBlock(block: unknown, ctx: CompressContext): unknown {
  if (!isRecord(block)) {
    return block;
  }
  if (block.type === "tool_result") {
    // R9.23: an exempt tool's result passes through byte-faithful — not elided,
    // not compacted, and deliberately NOT seeded into `seen` either. Seeding it
    // would let a schema silently become the "first occurrence" that elides some
    // later, non-exempt duplicate, which is the same trap one level along.
    if (typeof block.tool_use_id === "string" && ctx.exemptToolUseIds.has(block.tool_use_id)) {
      return block;
    }
    const content = transformToolResultContent(block.content, ctx);
    return content === block.content ? block : { ...block, content };
  }
  if (block.type === "text" && typeof block.text === "string") {
    // User-pasted text (e.g. file contents): dedup only, never compacted.
    const text = processText(block.text, false, ctx);
    return text === block.text ? block : { ...block, text };
  }
  return block;
}

/**
 * Object spreads below preserve key order (existing keys keep their
 * position), so re-serialization stays byte-stable.
 */
function transformMessage(message: Message, ctx: CompressContext): Message {
  if (message.role !== "user") {
    // Assistant (and any unknown role) passes through byte-faithful — but is
    // still READ, for the exempt `tool_use` ids R9.23 needs (see the ctx field).
    collectExemptToolUses(message, ctx);
    return message;
  }
  const content = message.content;
  if (typeof content === "string") {
    const text = processText(content, false, ctx);
    return text === content ? message : { ...message, content: text };
  }
  if (Array.isArray(content)) {
    let changed = false;
    const blocks = content.map((block) => {
      const out = transformUserBlock(block, ctx);
      if (out !== block) {
        changed = true;
      }
      return out;
    });
    return changed ? { ...message, content: blocks } : message;
  }
  return message;
}

export interface NativeLosslessOptions {
  /** Override DEFAULT_MIN_DEDUP_CHARS (affects emitted bytes — see its doc). */
  readonly minDedupChars?: number;
  /**
   * Where the CCR store is rooted, surfaced by `UnknownRefError`'s message
   * when `retrieve()` can't resolve a ref. Set automatically by
   * {@link NativeLosslessCompression.forProjectDir}; a caller constructing
   * the class directly (tests, `createGolemPipeline`'s standalone paths) may
   * omit it — `CcrStore` supplies its own generic default.
   */
  readonly ccrLocation?: string;
}

export class NativeLosslessCompression implements CompressionService {
  readonly #ccr: CcrStore;
  readonly #minDedupChars: number;
  readonly #accounts = new Map<string, ProjectAccount>();
  /** retrieve() calls whose refId no live project account emitted. */
  #unattributedRetrieved = 0;

  constructor(blobs: BlobStore, options: NativeLosslessOptions = {}) {
    this.#ccr =
      options.ccrLocation !== undefined
        ? new CcrStore(blobs, options.ccrLocation)
        : new CcrStore(blobs);
    this.#minDedupChars = options.minDedupChars ?? DEFAULT_MIN_DEDUP_CHARS;
  }

  /**
   * CCR originals under `<mainRoot>/.golem/ccr` (spec Decision 19 config
   * dir). `projectRoot` is resolved through {@link resolveWorktreeRoot}
   * FIRST (task ccr-ref-scope) — a git linked worktree is the SAME project
   * as its main checkout for CCR purposes, so a ref stored by a hook running
   * inside `.claude/worktrees/agent-<id>/` is rooted at the same directory
   * this reads from, whichever of the two `projectRoot` happens to name.
   * Non-repos and an already-main `projectRoot` pass through unchanged.
   */
  static forProjectDir(
    projectRoot: string,
    options: NativeLosslessOptions = {},
  ): NativeLosslessCompression {
    const mainRoot = resolveWorktreeRoot(projectRoot);
    const ccrDir = join(mainRoot, ".golem", "ccr");
    return new NativeLosslessCompression(new LocalDirBlobStore(ccrDir), {
      ...options,
      ccrLocation: ccrDir,
    });
  }

  async compress(
    messages: readonly Message[],
    policy: PipelinePolicy,
    projectId: string,
  ): Promise<CompressResult> {
    const tokensBefore = estimateTokens(JSON.stringify(messages));

    if (!policy.stages.losslessCompression) {
      // Level 0 — byte-faithful passthrough (frozen-contract requirement).
      this.#recordRequest(projectId, tokensBefore, tokensBefore, {}, [], 0);
      return { messagesOut: messages, refs: [], stageSavings: {} };
    }

    const ctx: CompressContext = {
      minDedupChars: this.#minDedupChars,
      seen: new Set(),
      refs: new Map(),
      pendingOriginals: new Map(),
      exemptToolUseIds: new Set(),
      dedup: newDelta(),
      compaction: newDelta(),
    };

    const messagesOut = messages.map((message) => transformMessage(message, ctx));
    const tokensAfter = estimateTokens(JSON.stringify(messagesOut));

    // Persist originals AFTER transforms; store contents never influence the
    // emitted bytes (determinism rule in the module doc).
    let newlyStored = 0;
    for (const [refId, content] of ctx.pendingOriginals) {
      const ref = ctx.refs.get(refId);
      if (ref === undefined) {
        continue; // unreachable: pendingOriginals and refs are set together
      }
      const stored = await this.#ccr.putIfAbsent(refId, {
        v: 1,
        contentType: ref.contentType,
        originalTokens: ref.originalTokens,
        content,
      });
      if (stored) {
        newlyStored += 1;
      }
    }

    const stageSavings: Record<string, TokenDelta> = {
      [STAGE_DEDUP]: { ...ctx.dedup },
      [STAGE_COMPACTION]: { ...ctx.compaction },
    };
    const refs = [...ctx.refs.values()];
    this.#recordRequest(
      projectId,
      tokensBefore,
      tokensAfter,
      stageSavings,
      refs.map((ref) => ref.refId),
      newlyStored,
    );
    return { messagesOut, refs, stageSavings };
  }

  async retrieve(ref: CCRRef): Promise<Original> {
    const envelope = await this.#ccr.getEnvelope(ref.refId);
    let attributed = false;
    for (const account of this.#accounts.values()) {
      if (account.refsEmitted.has(ref.refId)) {
        account.ccrRefsRetrieved += 1;
        attributed = true;
      }
    }
    if (!attributed) {
      this.#unattributedRetrieved += 1;
    }
    return { ref, content: envelope.content };
  }

  async stats(projectId?: string): Promise<CompressionStats> {
    if (projectId !== undefined) {
      const account = this.#accounts.get(projectId) ?? newAccount();
      return snapshot(projectId, [account], 0);
    }
    return snapshot(null, [...this.#accounts.values()], this.#unattributedRetrieved);
  }

  #recordRequest(
    projectId: string,
    tokensBefore: number,
    tokensAfter: number,
    stageSavings: Readonly<Record<string, TokenDelta>>,
    refIds: readonly string[],
    newlyStored: number,
  ): void {
    let account = this.#accounts.get(projectId);
    if (account === undefined) {
      account = newAccount();
      this.#accounts.set(projectId, account);
    }
    account.requests += 1;
    account.tokensBefore += tokensBefore;
    account.tokensAfter += tokensAfter;
    for (const [stage, delta] of Object.entries(stageSavings)) {
      let acc = account.perStage.get(stage);
      if (acc === undefined) {
        acc = newDelta();
        account.perStage.set(stage, acc);
      }
      acc.tokensBefore += delta.tokensBefore;
      acc.tokensAfter += delta.tokensAfter;
    }
    for (const refId of refIds) {
      account.refsEmitted.add(refId);
    }
    account.ccrRefsStored += newlyStored;
  }
}

function snapshot(
  projectId: string | null,
  accounts: readonly ProjectAccount[],
  extraRetrieved: number,
): CompressionStats {
  const perStage: Record<string, TokenDelta> = {};
  let requests = 0;
  let tokensBefore = 0;
  let tokensAfter = 0;
  let ccrRefsStored = 0;
  let ccrRefsRetrieved = extraRetrieved;
  for (const account of accounts) {
    requests += account.requests;
    tokensBefore += account.tokensBefore;
    tokensAfter += account.tokensAfter;
    ccrRefsStored += account.ccrRefsStored;
    ccrRefsRetrieved += account.ccrRefsRetrieved;
    for (const [stage, delta] of account.perStage) {
      const existing = perStage[stage];
      perStage[stage] =
        existing === undefined
          ? { ...delta }
          : {
              tokensBefore: existing.tokensBefore + delta.tokensBefore,
              tokensAfter: existing.tokensAfter + delta.tokensAfter,
            };
    }
  }
  return {
    projectId,
    requests,
    tokensBefore,
    tokensAfter,
    perStage,
    ccrRefsStored,
    ccrRefsRetrieved,
  };
}
