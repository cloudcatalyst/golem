/**
 * R2.4 — reconciles Headroom's own elision markers with Golem's CCR store
 * (verification-notes §38, §6x).
 *
 * Headroom's semantic stage (slider ≥2, `headroom-adapter.ts`) can elide
 * stale/superseded Read tool-result content and substitute an inline marker
 * using the SAME `hash=<hex>` grammar Golem's own `ccrMarker()` deliberately
 * mirrors (`native-lossless.ts`'s doc comment). But that hash is a key into
 * Headroom's own in-process store (`read_lifecycle.py`'s
 * `ReadLifecycleManager._replace_content`, confirmed against the pinned
 * `headroom-ai==0.30.0` source), which Golem's TS `CcrStore`/`expand` never
 * receives — so the marker is unresolvable (`UnknownRefError`).
 *
 * The hash IS a reproducible digest of the pre-elision content though
 * (`compression_store.py`'s `explicit_hash`: SHA-256[:24] by default, with
 * some transforms supplying their own — e.g. `log_compressor.py` uses
 * MD5[:24], SmartCrusher's Rust row-drop path uses SHA-256[:12]). So rather
 * than changing any marker text, this diffs the semantic stage's pre/post
 * messages, verifies each new `hash=` marker is actually derived from the
 * content it replaced, and backfills that original into Golem's own
 * `CcrStore` under the exact same hash — the marker Headroom already emits
 * then resolves through the existing `expand` path with no other changes.
 *
 * Scope: covers the two message shapes `read_lifecycle.py` itself handles —
 * Anthropic-format `tool_result` content blocks and OpenAI-format
 * `role: "tool"` messages. Fails open throughout (mirrors Headroom's own
 * "storage failure must not break the request" philosophy for this exact
 * mechanism) — a backfill miss never blocks the request or throws.
 */

import { createHash } from "node:crypto";
import type { CcrStore } from "./ccr-store.js";
import { estimateTokens } from "./tokens.js";

/** Headroom's own marker grammar (shared with `ccrMarker()`/`CCR_MARKER_RE`),
 * but tolerant of the shorter truncated hashes Headroom actually emits (8-64
 * hex chars observed across its transforms) rather than Golem's own
 * fixed 64-char convention. */
const HASH_MARKER_RE = /hash=([0-9a-f]{8,64})/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Is `hash` a prefix of a standard digest of `content`? Headroom's store
 * defaults to SHA-256[:24] but some transforms supply MD5 or a shorter
 * truncation as an explicit hash — check both digests it's known to use. */
function isDerivedFrom(hash: string, content: string): boolean {
  const lower = hash.toLowerCase();
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  if (sha256.startsWith(lower)) return true;
  const md5 = createHash("md5").update(content, "utf8").digest("hex");
  return md5.startsWith(lower);
}

async function backfillPair(ccr: CcrStore, before: string, after: string): Promise<number> {
  if (before === after) return 0;
  let stored = 0;
  for (const match of after.matchAll(HASH_MARKER_RE)) {
    const hash = match[1];
    if (hash === undefined || !isDerivedFrom(hash, before)) continue;
    try {
      const isNew = await ccr.putIfAbsent(hash.toLowerCase(), {
        v: 1,
        contentType: "text/plain",
        originalTokens: estimateTokens(before),
        content: before,
      });
      if (isNew) stored++;
    } catch {
      // Best-effort — a backfill failure must never break the request.
    }
  }
  return stored;
}

/** Anthropic format: `content` is an array of blocks; `tool_result` blocks
 * carry their own string `content` field, which is what read_lifecycle
 * actually replaces (the surrounding block/array survive unchanged). */
async function backfillAnthropicBlocks(
  ccr: CcrStore,
  before: readonly unknown[],
  after: readonly unknown[],
): Promise<number> {
  let stored = 0;
  const count = Math.min(before.length, after.length);
  for (let i = 0; i < count; i++) {
    const b = before[i];
    const a = after[i];
    if (!isRecord(b) || !isRecord(a)) continue;
    if (b.type !== "tool_result" || a.type !== "tool_result") continue;
    if (typeof b.content !== "string" || typeof a.content !== "string") continue;
    stored += await backfillPair(ccr, b.content, a.content);
  }
  return stored;
}

async function backfillMessage(
  ccr: CcrStore,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): Promise<number> {
  if (before === after) return 0;
  const beforeContent = before.content;
  const afterContent = after.content;

  // OpenAI format: role: "tool" messages carry a bare string `content`.
  if (typeof beforeContent === "string" && typeof afterContent === "string") {
    return backfillPair(ccr, beforeContent, afterContent);
  }
  if (Array.isArray(beforeContent) && Array.isArray(afterContent)) {
    return backfillAnthropicBlocks(ccr, beforeContent, afterContent);
  }
  return 0;
}

/**
 * Diff the semantic stage's input/output message arrays and backfill Golem's
 * CcrStore for every Headroom-emitted `hash=` marker verified to be derived
 * from the content it replaced. Returns the count of newly-stored refs (for
 * `PipelineEvent.ccrRefsStored`).
 */
export async function backfillHeadroomCcrRefs(
  ccr: CcrStore,
  before: ReadonlyArray<Readonly<Record<string, unknown>>>,
  after: ReadonlyArray<Readonly<Record<string, unknown>>>,
): Promise<number> {
  let stored = 0;
  const count = Math.min(before.length, after.length);
  for (let i = 0; i < count; i++) {
    const b = before[i];
    const a = after[i];
    if (b === undefined || a === undefined) continue;
    stored += await backfillMessage(ccr, b, a);
  }
  return stored;
}
