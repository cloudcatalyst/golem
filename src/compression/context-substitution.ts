/**
 * R2.2 — proxy-side context substitution (spec Decision 24, sub-mode 1;
 * verification-notes §62).
 *
 * When a message carries a large text span whose content is already sitting
 * in the project's web-cache (a page fetched earlier this session, or a
 * prior one), replace that span with a compact reference the model can
 * `expand`/`fetch` instead of resending the full text — the same
 * "elide + CCR-backed reversibility" grammar `native-lossless.ts`'s dedup
 * stage already uses, just sourced from an external, cross-request index
 * instead of the in-request seen-set.
 *
 * ## Why this is gated OFF on caching (Anthropic-style) upstreams
 * `native-lossless.ts`'s dedup stage is safe to run unconditionally because
 * it is a PURE function of the current request's own message prefix (its
 * module doc, "Determinism obligations"): re-sending an identical prefix
 * always re-derives identical output bytes, so Anthropic's cached prefix
 * survives. The lookup this stage consults is NOT like that — the web-cache
 * grows across requests, so the very same prefix can substitute differently
 * on a later call as new pages are fetched, which would change bytes inside
 * what was previously a stable cached prefix (a cache miss on the whole
 * suffix — verification-notes §14). Rather than teaching this stage to parse
 * Anthropic's actual `cache_control` breakpoints (real, but materially more
 * complex, machinery Golem does not have today), it reuses the simpler,
 * already-tested Decision-31 pattern the semantic stage established: gate
 * the whole stage off on caching upstreams. On a non-caching upstream there
 * is no stable prefix to break, so any substitution there is unconditionally
 * cache-safe — satisfying §14 by construction. See pipeline.ts's
 * `isCachingUpstream` — the exact same gate is reused for this stage.
 *
 * Fidelity: only user-side text and tool_result text are candidates (proxy
 * fidelity hard rule), mirroring native-lossless's own scope exactly.
 */

import { createHash } from "node:crypto";
import type { CcrStore } from "./ccr-store.js";
import { estimateTokens } from "./tokens.js";

/** Contents shorter than this are never substitution candidates — a marker would not pay for itself. */
export const DEFAULT_MIN_SUBSTITUTION_CHARS = 512;

/**
 * sha256(text) -> a short human-readable label (e.g. the source URL), or undefined on a miss.
 *
 * **Must be deterministic:** the same hash MUST always produce the same label.
 * This function is called across multiple requests, and varying labels produce
 * different marker text that breaks prompt-cache prefix stability
 * (verification-notes §14). Build the lookup from a stable snapshot, not a
 * live/mutable cache that grows between calls.
 */
export type KnownContentLookup = (hash: string) => string | undefined;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Pure function of (refId, label, originalTokens) — mirrors `ccrMarker()`'s determinism requirement. */
export function contextSubstitutionMarker(
  refId: string,
  label: string,
  originalTokens: number,
): string {
  return (
    `[Golem: content already cached locally (${label}, ~${originalTokens} tokens); ` +
    `elided to avoid re-sending it. Retrieve original: hash=${refId}]`
  );
}

interface SubstitutionContext {
  readonly minChars: number;
  readonly lookup: KnownContentLookup;
  substitutions: number;
  tokensBefore: number;
  tokensAfter: number;
  /** refId -> original content, persisted to the CCR store after the transform pass. */
  readonly pending: Map<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function substituteText(text: string, ctx: SubstitutionContext): string {
  if (text.length < ctx.minChars) return text;
  const hash = sha256Hex(text);
  const label = ctx.lookup(hash);
  if (label === undefined) return text;
  const originalTokens = estimateTokens(text);
  const replaced = contextSubstitutionMarker(hash, label, originalTokens);
  if (replaced.length >= text.length) return text;
  ctx.substitutions += 1;
  ctx.tokensBefore += originalTokens;
  ctx.tokensAfter += estimateTokens(replaced);
  ctx.pending.set(hash, text);
  return replaced;
}

function transformToolResultContent(content: unknown, ctx: SubstitutionContext): unknown {
  if (typeof content === "string") {
    return substituteText(content, ctx);
  }
  if (Array.isArray(content)) {
    let changed = false;
    const out = content.map((item) => {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
        const text = substituteText(item.text, ctx);
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

function transformUserBlock(block: unknown, ctx: SubstitutionContext): unknown {
  if (!isRecord(block)) return block;
  if (block.type === "tool_result") {
    const content = transformToolResultContent(block.content, ctx);
    return content === block.content ? block : { ...block, content };
  }
  if (block.type === "text" && typeof block.text === "string") {
    const text = substituteText(block.text, ctx);
    return text === block.text ? block : { ...block, text };
  }
  return block;
}

function transformMessage(
  message: Readonly<Record<string, unknown>>,
  ctx: SubstitutionContext,
): Readonly<Record<string, unknown>> {
  if (message.role !== "user") {
    // Assistant (and any unknown role) passes through byte-faithful.
    return message;
  }
  const content = message.content;
  if (typeof content === "string") {
    const text = substituteText(content, ctx);
    return text === content ? message : { ...message, content: text };
  }
  if (Array.isArray(content)) {
    let changed = false;
    const blocks = content.map((block) => {
      const out = transformUserBlock(block, ctx);
      if (out !== block) changed = true;
      return out;
    });
    return changed ? { ...message, content: blocks } : message;
  }
  return message;
}

export interface ContextSubstitutionResult {
  readonly messages: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly substitutions: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

/**
 * Substitute every span whose content `lookup` recognizes. Persists each
 * substituted original into `ccr` under its content hash (fail-open — a
 * persistence failure never blocks the request) so the existing `expand`
 * path resolves the marker unchanged, same reversibility precedent R2.4
 * established for Headroom's markers.
 */
export async function substituteKnownContent(
  messages: ReadonlyArray<Readonly<Record<string, unknown>>>,
  lookup: KnownContentLookup,
  ccr: CcrStore,
  minChars: number = DEFAULT_MIN_SUBSTITUTION_CHARS,
): Promise<ContextSubstitutionResult> {
  const ctx: SubstitutionContext = {
    minChars,
    lookup,
    substitutions: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    pending: new Map(),
  };
  const out = messages.map((message) => transformMessage(message, ctx));
  for (const [refId, content] of ctx.pending) {
    try {
      await ccr.putIfAbsent(refId, {
        v: 1,
        contentType: "text/plain",
        originalTokens: estimateTokens(content),
        content,
      });
    } catch {
      // Best-effort — a backfill failure must never break the request.
    }
  }
  return {
    messages: out,
    substitutions: ctx.substitutions,
    tokensBefore: ctx.tokensBefore,
    tokensAfter: ctx.tokensAfter,
  };
}
