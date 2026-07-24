/**
 * Windowed savings rollup (Decision 23 — savings is situational).
 *
 * The all-time {@link JsonlTelemetryStore.aggregate} headline blends every
 * upstream/level a project ever used into one figure that barely moves. The
 * status surfaces instead want "what Golem did for me lately", so this folds the
 * raw, timestamped {@link readTelemetryEvents} into a {@link CompressionStats}
 * scoped to a rolling window (24h / 7d / all — the same {@link BenchWindow}
 * primitive the cost benchmark uses).
 *
 * Fold logic mirrors `aggregate`'s request path exactly (whole-request
 * `requestTokens`, legacy stage-stitch fallback, per-stage breakdown, CCR
 * counts); only the time bound and the fallback wrapper are new. Pure — the
 * caller supplies both the events and `nowMs`.
 */

import type { CompressionStats, TokenDelta } from "../interfaces/compression.js";
import { type BenchWindow, windowStartMs } from "./cost-benchmark.js";
import type { TelemetryEvent } from "./types.js";

export interface WindowedStats {
  readonly stats: CompressionStats;
  /** Which window actually supplied the data (may be wider than requested after fallback). */
  readonly windowApplied: BenchWindow;
}

/** Fold request-kind events at/after `startMs` (null = no lower bound) into CompressionStats. */
function foldRequests(
  events: readonly TelemetryEvent[],
  projectId: string | undefined,
  startMs: number | null,
): CompressionStats {
  let requests = 0;
  let tokensBefore = 0;
  let tokensAfter = 0;
  let ccrRefsStored = 0;
  let ccrRefsRetrieved = 0;
  const perStage: Record<string, TokenDelta> = {};

  for (const ev of events) {
    if (projectId !== undefined && ev.projectId !== projectId) continue;
    if (startMs !== null) {
      const t = Date.parse(ev.ts);
      if (!Number.isFinite(t) || t < startMs) continue;
    }

    if (ev.kind === "retrieval") {
      ccrRefsRetrieved += ev.ccrRefsRetrieved ?? 0;
      continue;
    }
    // usage / avoidedUpstream / tool events never count toward the gross-token
    // headline — same treatment as JsonlTelemetryStore.aggregate.
    if (ev.kind === "usage" || ev.kind === "avoidedUpstream" || ev.kind === "tool") continue;

    requests += 1;
    ccrRefsStored += ev.ccrRefsStored;

    const stageEntries = Object.entries(ev.stageSavings);
    if (ev.requestTokens !== undefined) {
      tokensBefore += ev.requestTokens.tokensBefore;
      tokensAfter += ev.requestTokens.tokensAfter;
    } else if (stageEntries.length > 0) {
      const firstBefore = stageEntries[0]?.[1].tokensBefore ?? 0;
      const lastAfter = stageEntries[stageEntries.length - 1]?.[1].tokensAfter ?? firstBefore;
      tokensBefore += firstBefore;
      tokensAfter += lastAfter;
    }

    for (const [stage, delta] of stageEntries) {
      const acc = perStage[stage] ?? { tokensBefore: 0, tokensAfter: 0 };
      perStage[stage] = {
        tokensBefore: acc.tokensBefore + delta.tokensBefore,
        tokensAfter: acc.tokensAfter + delta.tokensAfter,
      };
    }
  }

  return {
    projectId: projectId ?? null,
    requests,
    tokensBefore,
    tokensAfter,
    perStage,
    ccrRefsStored,
    ccrRefsRetrieved,
  };
}

/** Windowed CompressionStats for exactly `window` (no fallback). */
export function windowedStats(
  events: readonly TelemetryEvent[],
  opts: { readonly projectId?: string; readonly window: BenchWindow; readonly nowMs: number },
): CompressionStats {
  return foldRequests(events, opts.projectId, windowStartMs(opts.window, opts.nowMs));
}

/**
 * Windowed stats for `preferred`, widening to the next window when the narrower
 * one recorded no requests (24h → 7d → all). Keeps the headline recent when
 * there's recent traffic, but never shows a bare 0% on a quiet day when older
 * history exists. `windowApplied` reports which window the returned numbers came
 * from so the surface can label it honestly.
 */
export function windowedStatsWithFallback(
  events: readonly TelemetryEvent[],
  opts: { readonly projectId?: string; readonly preferred: BenchWindow; readonly nowMs: number },
): WindowedStats {
  const order: readonly BenchWindow[] =
    opts.preferred === "24h"
      ? ["24h", "7d", "all"]
      : opts.preferred === "7d"
        ? ["7d", "all"]
        : ["all"];
  let last = foldRequests(events, opts.projectId, windowStartMs("all", opts.nowMs));
  for (const window of order) {
    const stats = foldRequests(events, opts.projectId, windowStartMs(window, opts.nowMs));
    last = stats;
    if (stats.requests > 0) return { stats, windowApplied: window };
  }
  return { stats: last, windowApplied: "all" };
}
