/**
 * R8.1 — the cache rollup: what the prompt cache actually did, and what broke it.
 *
 * Two independent signals, reported side by side and never merged:
 *
 * - **Billed (authoritative).** `cache_read_input_tokens` /
 *   `cache_creation_input_tokens` / `input_tokens` off each response, already
 *   recorded as `kind: "usage"` events by the R1.1 sniffer. This says *whether*
 *   the cache hit and what it cost.
 * - **Observed (explanatory).** The per-request cacheable-prefix verdict recorded
 *   on pipeline events by `CachePrefixObserver`. This says *why* — and names the
 *   component and turn responsible for a bust.
 *
 * Keeping them apart matters: the billed number is ground truth but silent about
 * cause, while the verdict is a prediction from the bytes Golem forwarded and can
 * be wrong at the margins (its conversation grouping is a heuristic, and requests
 * that bypass the pipeline are not observed at all). A single blended "cache
 * health score" would hide exactly the distinction a user needs.
 */

import { pct } from "../bench/stats.js";
import { LOOKBACK_WINDOW_BLOCKS } from "../proxy/cache-prefix.js";
import type { TelemetryEvent } from "./types.js";

/** Per-component bust counts (which part of the prefix changed). */
export interface CacheBustBreakdown {
  readonly tools: number;
  readonly system: number;
  readonly messages: number;
  /**
   * R8.13: the prefix was intact but sat outside the 20-block lookback window, so
   * the read could not find it. Counted apart from the three content components
   * because the fix is different — a breakpoint, not a byte.
   */
  readonly lookback: number;
  /** Busts recorded without a component (older events). */
  readonly unattributed: number;
}

/**
 * R8.13: how deep into the history the worst `messages` bust landed.
 *
 * A bust at index 2 of 180 re-prefills essentially everything; one at index 179 of
 * 180 costs the tail. §99's flat count could not tell those apart, which is how a
 * 98%-bust report survived next to a 98.4% billed hit rate. `null` when no
 * message bust carried the index (pre-R8.13 events).
 */
export interface WorstMessageBust {
  /** 0-based index of the changed message — the lowest seen, i.e. the most costly. */
  readonly index: number;
  /** Messages in that request, so the index can be read as a share of history. */
  readonly messageCount: number;
}

/** Prefix verdict counts across observed pipeline events. */
export interface CachePrefixCounts {
  readonly first: number;
  readonly append: number;
  readonly bust: number;
  /**
   * Pipeline events carrying no verdict — either written before R8.1 or produced
   * by a caller that does not classify. Reported so a low bust count is never
   * mistaken for good news when coverage is simply thin.
   */
  readonly unobserved: number;
}

export interface CacheStats {
  /** Usage samples that carried a billed `usage` block. */
  readonly samples: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /** Input tokens billed at full rate — neither read from nor written to cache. */
  readonly uncachedInputTokens: number;
  /**
   * `cacheRead / (cacheRead + cacheCreation + uncachedInput)`, or `null` when
   * there are no samples. Null rather than 0 on purpose: "no data" and "nothing
   * cached" are different answers.
   */
  readonly hitRate: number | null;
  readonly prefix: CachePrefixCounts;
  readonly busts: CacheBustBreakdown;
  /** R8.13: the most costly `messages` bust seen, or `null` if none carried a depth. */
  readonly worstMessageBust: WorstMessageBust | null;
}

const EMPTY: CacheStats = {
  samples: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  uncachedInputTokens: 0,
  hitRate: null,
  prefix: { first: 0, append: 0, bust: 0, unobserved: 0 },
  busts: { tools: 0, system: 0, messages: 0, lookback: 0, unattributed: 0 },
  worstMessageBust: null,
};

/** Roll `events` up into {@link CacheStats}, optionally scoped to one project. */
export function aggregateCacheStats(
  events: readonly TelemetryEvent[],
  projectId?: string,
): CacheStats {
  const scoped = projectId === undefined ? events : events.filter((e) => e.projectId === projectId);
  if (scoped.length === 0) return EMPTY;

  let samples = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let uncachedInputTokens = 0;
  let first = 0;
  let append = 0;
  let bust = 0;
  let unobserved = 0;
  let tools = 0;
  let system = 0;
  let messages = 0;
  let lookback = 0;
  let unattributed = 0;
  let worstMessageBust: WorstMessageBust | null = null;

  for (const event of scoped) {
    const kind = event.kind ?? "request";

    if (kind === "usage" && event.usage !== undefined) {
      samples += 1;
      cacheReadTokens += event.usage.cacheReadInputTokens;
      cacheCreationTokens += event.usage.cacheCreationInputTokens;
      uncachedInputTokens += event.usage.inputTokens;
      continue;
    }

    if (kind !== "request") continue;

    switch (event.cachePrefix) {
      case "first":
        first += 1;
        break;
      case "append":
        append += 1;
        break;
      case "bust":
        bust += 1;
        switch (event.cacheBustComponent) {
          case "tools":
            tools += 1;
            break;
          case "system":
            system += 1;
            break;
          case "messages": {
            messages += 1;
            // R8.13 — keep the SHALLOWEST index, which is the most expensive bust:
            // everything from there to the end of the history was re-prefilled.
            const index = event.cacheBustMessageIndex;
            const count = event.cacheMessageCount;
            if (
              index !== undefined &&
              count !== undefined &&
              (worstMessageBust === null || index < worstMessageBust.index)
            ) {
              worstMessageBust = { index, messageCount: count };
            }
            break;
          }
          case "lookback":
            lookback += 1;
            break;
          default:
            unattributed += 1;
        }
        break;
      default:
        unobserved += 1;
    }
  }

  const billed = cacheReadTokens + cacheCreationTokens + uncachedInputTokens;
  return {
    samples,
    cacheReadTokens,
    cacheCreationTokens,
    uncachedInputTokens,
    hitRate: samples === 0 || billed === 0 ? null : cacheReadTokens / billed,
    prefix: { first, append, bust, unobserved },
    busts: { tools, system, messages, lookback, unattributed },
    worstMessageBust,
  };
}

function num(value: number): string {
  return value.toLocaleString("en-US");
}

/** Human-readable cache report. Says "no data" plainly rather than showing zeros. */
export function renderCacheReport(stats: CacheStats): string {
  const out: string[] = ["Prompt cache — billed reality, and what broke the prefix", ""];

  if (stats.samples === 0) {
    out.push("Billed: no usage samples yet.");
    out.push("  The proxy records these from upstream responses — run some traffic first.");
  } else {
    const total = stats.cacheReadTokens + stats.cacheCreationTokens + stats.uncachedInputTokens;
    out.push(`Billed input over ${num(stats.samples)} response(s): ${num(total)} tokens`);
    out.push(
      `  cache read     ${num(stats.cacheReadTokens).padStart(12)}  ` +
        `(~0.1x rate)${stats.hitRate === null ? "" : ` — hit rate ${pct(stats.hitRate)}`}`,
    );
    out.push(
      `  cache write    ${num(stats.cacheCreationTokens).padStart(12)}  (~1.25x rate — a prefix was (re)prefilled)`,
    );
    out.push(`  uncached       ${num(stats.uncachedInputTokens).padStart(12)}  (full rate)`);
  }

  out.push("");
  const { first, append, bust, unobserved } = stats.prefix;
  const observed = first + append + bust;
  if (observed === 0) {
    out.push("Prefix verdicts: none recorded.");
    out.push(
      "  Only requests that transit the pipeline are classified — level 0 is a full bypass.",
    );
  } else {
    out.push(`Prefix verdicts over ${num(observed)} classified request(s):`);
    out.push(`  append (should hit)   ${num(append).padStart(8)}`);
    out.push(`  first of a thread     ${num(first).padStart(8)}`);
    out.push(`  BUST (re-prefilled)   ${num(bust).padStart(8)}`);
    if (bust > 0) {
      const { tools, system, messages, lookback, unattributed } = stats.busts;
      const parts = [
        tools > 0 ? `tools ${tools}` : null,
        system > 0 ? `system ${system}` : null,
        messages > 0 ? `messages ${messages}` : null,
        lookback > 0 ? `lookback ${lookback}` : null,
        unattributed > 0 ? `unattributed ${unattributed}` : null,
      ].filter((p): p is string => p !== null);
      out.push(`    caused by: ${parts.join(" · ")}`);
      if (tools > 0) {
        out.push("    `tools` renders first, so a change there re-prefills the WHOLE prefix — the");
        out.push("    most expensive kind of bust, and usually the most avoidable.");
      }
      // R8.13 — a bust is only as expensive as the history behind it. Saying where the
      // worst one landed is the difference between "the cache is broken" and "the last
      // turn was rewritten"; conflating those is what made §99's count useless.
      const worst = stats.worstMessageBust;
      if (worst !== null && worst.messageCount > 0) {
        const lost = worst.messageCount - worst.index;
        out.push(
          `    deepest history bust: message ${num(worst.index)} of ${num(worst.messageCount)} — ` +
            `${num(lost)} message(s) (${pct(lost / worst.messageCount)} of history) re-prefilled.`,
        );
      }
      if (lookback > 0) {
        out.push("    `lookback` busts changed NOTHING — the prefix was still valid but sat more");
        out.push(
          `    than ${LOOKBACK_WINDOW_BLOCKS} blocks behind the breakpoint, so the read could not find it.`,
        );
        out.push("    Fixed with an extra `cache_control` breakpoint, not with fewer edits.");
      }
    }
  }
  if (unobserved > 0) {
    out.push(
      `  ${num(unobserved)} request(s) carried no verdict (pre-R8.1 events, or a non-classifying caller).`,
    );
  }

  // R8.1/§99/§104 — when the two signals disagree, say so instead of letting the
  // reader believe the weaker one. A high billed hit rate alongside mostly-bust
  // verdicts means the classifier is wrong, not that the cache is broken: the billed
  // number is measured and the verdict is a prediction. This check is the reason the
  // two are reported separately at all, and it is what caught §99.
  //
  // Kept AFTER the §104 fix rather than retired with it: it is a live consistency
  // check on the predictor, not a note about one past bug. If it fires again, the
  // classifier has drifted from the caching rules again and the billed half is still
  // the answer.
  if (stats.hitRate !== null && observed > 0) {
    const bustShare = bust / observed;
    if (stats.hitRate > 0.8 && bustShare > 0.5) {
      out.push("");
      out.push(
        `⚠ These two disagree: ${pct(stats.hitRate)} of billed input was a cache READ, ` +
          `yet ${pct(bustShare)} of verdicts say "bust".`,
      );
      out.push("  The billed figure is measured; the verdict is only a prediction, so distrust");
      out.push("  the verdict and read the billed section as the answer. §99 was one instance of");
      out.push("  this (a `cache_control` marker counted as content, fixed in §104) — a fresh");
      out.push("  disagreement means the predictor has drifted from the caching rules again.");
    }
  }

  out.push("");
  out.push("Billed numbers are authoritative; verdicts explain them and are a prediction");
  out.push("from the forwarded bytes. Conversation grouping is a heuristic — see cache-prefix.ts.");
  return `${out.join("\n")}\n`;
}
