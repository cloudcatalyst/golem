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

import type { TelemetryEvent } from "./types.js";

/** Per-component bust counts (which part of the prefix changed). */
export interface CacheBustBreakdown {
  readonly tools: number;
  readonly system: number;
  readonly messages: number;
  /** Busts recorded without a component (older events). */
  readonly unattributed: number;
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
}

const EMPTY: CacheStats = {
  samples: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  uncachedInputTokens: 0,
  hitRate: null,
  prefix: { first: 0, append: 0, bust: 0, unobserved: 0 },
  busts: { tools: 0, system: 0, messages: 0, unattributed: 0 },
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
  let unattributed = 0;

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
          case "messages":
            messages += 1;
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
    busts: { tools, system, messages, unattributed },
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
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
      const { tools, system, messages, unattributed } = stats.busts;
      const parts = [
        tools > 0 ? `tools ${tools}` : null,
        system > 0 ? `system ${system}` : null,
        messages > 0 ? `messages ${messages}` : null,
        unattributed > 0 ? `unattributed ${unattributed}` : null,
      ].filter((p): p is string => p !== null);
      out.push(`    caused by: ${parts.join(" · ")}`);
      if (tools > 0) {
        out.push("    `tools` renders first, so a change there re-prefills the WHOLE prefix — the");
        out.push("    most expensive kind of bust, and usually the most avoidable.");
      }
    }
  }
  if (unobserved > 0) {
    out.push(
      `  ${num(unobserved)} request(s) carried no verdict (pre-R8.1 events, or a non-classifying caller).`,
    );
  }

  out.push("");
  out.push("Billed numbers are authoritative; verdicts explain them and are a prediction");
  out.push("from the forwarded bytes. Conversation grouping is a heuristic — see cache-prefix.ts.");
  return `${out.join("\n")}\n`;
}
