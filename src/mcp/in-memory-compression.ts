/**
 * An in-memory {@link CompressionService} — the one `golem mcp serve` uses when
 * it runs standalone.
 *
 * Named "stub" until R10.1, which was a lie by then: it began (WS-B task B1) as
 * a placeholder so the MCP server and its tests could run before WS-A's real
 * implementation landed, but WS-A has long since landed and this is still what
 * `createStandaloneDeps()` wires up. It is a real, contract-conformant
 * implementation of a deliberately small contract, not scaffolding awaiting
 * replacement — so it is named for what it is.
 *
 * What it deliberately does NOT do: it is not a compression *algorithm*. Level
 * <= 1 is a pure passthrough, and the only transformation it ever applies is
 * the level >= 2 tool-result CCR swap (a large `tool_result` string replaced by
 * a deterministic ref marker), which is what `expand` needs to work end to end.
 * The proxy's real lossless stage is `NativeLosslessCompression` in
 * `src/compression/`.
 *
 * It honours the frozen contract in `src/interfaces/compression.ts` and is
 * registered against `describeCompressionServiceContract` in tests/contract/.
 */

import { createHash } from "node:crypto";
import type {
  CCRRef,
  CompressionService,
  CompressionStats,
  CompressResult,
  Message,
  Original,
  PipelinePolicy,
  TokenDelta,
} from "../interfaces/index.js";
import { UnknownRefError } from "../interfaces/index.js";

/** Rough token estimate (chars/4) — good enough for stub telemetry. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Marker text substituted for a swapped-out tool result. */
export function ccrMarker(ref: CCRRef): string {
  return `[golem:ccr ref=${ref.refId} original_tokens=${ref.originalTokens} — expand with the expand tool]`;
}

interface MutableStats {
  requests: number;
  tokensBefore: number;
  tokensAfter: number;
  ccrRefsStored: number;
  ccrRefsRetrieved: number;
}

function newStats(): MutableStats {
  return { requests: 0, tokensBefore: 0, tokensAfter: 0, ccrRefsStored: 0, ccrRefsRetrieved: 0 };
}

export interface InMemoryCompressionServiceOptions {
  /** Minimum tool_result content length (chars) before it is swapped for a CCR ref. */
  readonly toolResultSwapThresholdChars?: number;
}

export class InMemoryCompressionService implements CompressionService {
  readonly #store = new Map<string, Original>();
  readonly #global = newStats();
  readonly #perProject = new Map<string, MutableStats>();
  readonly #threshold: number;

  constructor(options: InMemoryCompressionServiceOptions = {}) {
    this.#threshold = options.toolResultSwapThresholdChars ?? 1024;
  }

  compress(
    messages: readonly Message[],
    policy: PipelinePolicy,
    projectId: string,
  ): Promise<CompressResult> {
    const tokensBefore = estimateTokens(JSON.stringify(messages));
    const refs: CCRRef[] = [];
    const messagesOut = policy.stages.toolResultCache
      ? messages.map((message) => this.#swapLargeToolResults(message, refs))
      : messages;
    const tokensAfter = estimateTokens(JSON.stringify(messagesOut));

    const stageSavings: Record<string, TokenDelta> = {};
    if (policy.stages.losslessCompression) {
      // Stub applies no lossless transform; report the stage as a no-op delta.
      stageSavings.lossless = { tokensBefore, tokensAfter: tokensBefore };
    }
    if (policy.stages.toolResultCache) {
      stageSavings.tool_result_cache = { tokensBefore, tokensAfter };
    }

    for (const stats of [this.#global, this.#projectStats(projectId)]) {
      stats.requests += 1;
      stats.tokensBefore += tokensBefore;
      stats.tokensAfter += tokensAfter;
      stats.ccrRefsStored += refs.length;
    }

    return Promise.resolve({ messagesOut, refs, stageSavings });
  }

  retrieve(ref: CCRRef): Promise<Original> {
    const original = this.#store.get(ref.refId);
    if (original === undefined) {
      return Promise.reject(new UnknownRefError(ref.refId));
    }
    this.#global.ccrRefsRetrieved += 1;
    return Promise.resolve(original);
  }

  stats(projectId?: string): Promise<CompressionStats> {
    const source = projectId === undefined ? this.#global : this.#projectStats(projectId);
    return Promise.resolve({
      projectId: projectId ?? null,
      requests: source.requests,
      tokensBefore: source.tokensBefore,
      tokensAfter: source.tokensAfter,
      perStage: {},
      ccrRefsStored: source.ccrRefsStored,
      ccrRefsRetrieved: projectId === undefined ? source.ccrRefsRetrieved : 0,
    });
  }

  /** Test/demo helper: store arbitrary content and get a retrievable ref. */
  seed(content: string, contentType = "text/plain"): CCRRef {
    return this.#storeContent(content, contentType);
  }

  #projectStats(projectId: string): MutableStats {
    let stats = this.#perProject.get(projectId);
    if (stats === undefined) {
      stats = newStats();
      this.#perProject.set(projectId, stats);
    }
    return stats;
  }

  #storeContent(content: string, contentType: string): CCRRef {
    // Content-hash ref ids keep re-compression byte-identical (prompt-cache
    // stability, interfaces/compression.ts contract note).
    const refId = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
    const ref: CCRRef = { refId, contentType, originalTokens: estimateTokens(content) };
    if (!this.#store.has(refId)) {
      this.#store.set(refId, { ref, content });
    }
    return ref;
  }

  #swapLargeToolResults(message: Message, refs: CCRRef[]): Message {
    const content = message.content;
    if (!Array.isArray(content)) return message;

    let changed = false;
    const newContent = content.map((block: unknown) => {
      if (
        typeof block !== "object" ||
        block === null ||
        (block as Record<string, unknown>).type !== "tool_result"
      ) {
        return block;
      }
      const blockRecord = block as Record<string, unknown>;
      const text = blockRecord.content;
      if (typeof text !== "string" || text.length < this.#threshold) return block;

      const ref = this.#storeContent(text, "text/plain");
      refs.push(ref);
      changed = true;
      return { ...blockRecord, content: ccrMarker(ref) };
    });

    return changed ? { ...message, content: newContent } : message;
  }
}
