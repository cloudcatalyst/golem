/**
 * WS-A A4 — append-only JSONL telemetry store (P0 default backend).
 *
 * One JSON object per line under `<project>/.golem/telemetry/events.jsonl`.
 * Appends are serialized through an internal promise chain so concurrent
 * record() calls cannot interleave partial lines, and each append is a single
 * `appendFile` of `<json>\n` (atomic enough for line-oriented readers). A
 * corrupt/partial trailing line is skipped on read rather than throwing, so a
 * crash mid-write never poisons future aggregates.
 *
 * Aggregation reads the whole file and folds events into CompressionStats.
 * That is O(events) per query — fine at P0 volumes; a future node:sqlite
 * backend (same TelemetryStore interface) can index if this ever gets hot.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CompressionStats, TokenDelta } from "../interfaces/compression.js";
import type {
  AvoidedUpstreamStats,
  TelemetryEvent,
  TelemetryStore,
  ToolUsagePerTool,
  ToolUsageStats,
  UsageByBrevity,
  UsageByLevel,
  UsageBySemanticForced,
  UsageTotals,
} from "./types.js";

/** Telemetry file location for a project. */
export function telemetryFilePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "telemetry", "events.jsonl");
}

/**
 * Read and parse every recorded event for a project (R6.4 — the cost-governance
 * benchmark needs raw, timestamped events to window by 24h/7d, which the
 * kind-specific `aggregate*` rollups do not expose). A missing file yields an
 * empty list; corrupt/partial lines are skipped, same as {@link parseEvent}
 * everywhere else. Read-only — never used on the request critical path.
 */
export async function readTelemetryEvents(projectDir: string): Promise<readonly TelemetryEvent[]> {
  let raw: string;
  try {
    raw = await readFile(telemetryFilePath(projectDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const events: TelemetryEvent[] = [];
  for (const line of raw.split("\n")) {
    const ev = parseEvent(line);
    if (ev !== null) events.push(ev);
  }
  return events;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isTokenDelta(v: unknown): v is TokenDelta {
  return isRecord(v) && typeof v.tokensBefore === "number" && typeof v.tokensAfter === "number";
}

function isUsageTotals(v: unknown): v is UsageTotals {
  return (
    isRecord(v) &&
    typeof v.inputTokens === "number" &&
    typeof v.cacheCreationInputTokens === "number" &&
    typeof v.cacheReadInputTokens === "number" &&
    typeof v.outputTokens === "number"
  );
}

/** Parse one JSONL line into a TelemetryEvent, or null if malformed. */
function parseEvent(line: string): TelemetryEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null; // partial/corrupt trailing line — skip, don't throw
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.projectId !== "string" || typeof parsed.ts !== "string") return null;
  const stageSavings: Record<string, TokenDelta> = {};
  if (isRecord(parsed.stageSavings)) {
    for (const [k, v] of Object.entries(parsed.stageSavings)) {
      if (isTokenDelta(v))
        stageSavings[k] = { tokensBefore: v.tokensBefore, tokensAfter: v.tokensAfter };
    }
  }
  const kind =
    parsed.kind === "retrieval"
      ? "retrieval"
      : parsed.kind === "usage"
        ? "usage"
        : parsed.kind === "avoidedUpstream"
          ? "avoidedUpstream"
          : parsed.kind === "tool"
            ? "tool"
            : "request";
  return {
    ts: parsed.ts,
    projectId: parsed.projectId,
    level: typeof parsed.level === "number" ? parsed.level : 0,
    kind,
    ...(isTokenDelta(parsed.requestTokens) ? { requestTokens: parsed.requestTokens } : {}),
    stageSavings,
    ccrRefsStored: typeof parsed.ccrRefsStored === "number" ? parsed.ccrRefsStored : 0,
    ccrRefsRetrieved: typeof parsed.ccrRefsRetrieved === "number" ? parsed.ccrRefsRetrieved : 0,
    ...(isUsageTotals(parsed.usage) ? { usage: parsed.usage } : {}),
    semanticForced: parsed.semanticForced === true,
    // Decision 52. Absent on every line written before the dial existed, which
    // must read as "off" — brevity could not have been on then.
    ...(typeof parsed.brevity === "string" ? { brevity: parsed.brevity } : {}),
    ...(typeof parsed.brevityDirectiveTokens === "number"
      ? { brevityDirectiveTokens: parsed.brevityDirectiveTokens }
      : {}),
    ...(typeof parsed.avoidedUpstreamInputTokens === "number"
      ? { avoidedUpstreamInputTokens: parsed.avoidedUpstreamInputTokens }
      : {}),
    ...(typeof parsed.avoidedUpstreamOutputTokens === "number"
      ? { avoidedUpstreamOutputTokens: parsed.avoidedUpstreamOutputTokens }
      : {}),
    ...(typeof parsed.tool === "string" ? { tool: parsed.tool } : {}),
    ...(typeof parsed.toolDurationMs === "number" ? { toolDurationMs: parsed.toolDurationMs } : {}),
    ...(typeof parsed.toolResultBytes === "number"
      ? { toolResultBytes: parsed.toolResultBytes }
      : {}),
    ...(typeof parsed.toolModel === "string" ? { toolModel: parsed.toolModel } : {}),
    ...(typeof parsed.toolDraftChars === "number" ? { toolDraftChars: parsed.toolDraftChars } : {}),
    // R8.1. These were written by the proxy but NOT carried here, so
    // `aggregateCacheStats` could never see a verdict and always reported "none
    // recorded" — the field-by-field reconstruction in this function is an
    // allow-list, and a new TelemetryEvent field is invisible until added to it.
    // Any future field needs a line here AND a round-trip test through the store;
    // a unit test that feeds objects straight to an aggregator will not catch it.
    ...(typeof parsed.cachePrefix === "string" ? { cachePrefix: parsed.cachePrefix } : {}),
    ...(typeof parsed.cacheBustComponent === "string"
      ? { cacheBustComponent: parsed.cacheBustComponent }
      : {}),
  };
}

export class JsonlTelemetryStore implements TelemetryStore {
  readonly #file: string;
  /** Serializes appends so concurrent record() calls never interleave lines. */
  #writeChain: Promise<void> = Promise.resolve();
  #dirEnsured = false;

  constructor(projectDir: string) {
    this.#file = telemetryFilePath(projectDir);
  }

  async #ensureDir(): Promise<void> {
    if (this.#dirEnsured) return;
    await mkdir(path.dirname(this.#file), { recursive: true });
    this.#dirEnsured = true;
  }

  record(event: TelemetryEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    // Chain the append after any in-flight write; swallow errors into the chain
    // so telemetry never throws into the request path (fire-and-forget).
    const next = this.#writeChain.then(async () => {
      await this.#ensureDir();
      await appendFile(this.#file, line, "utf8");
    });
    // Keep the chain alive even if this write rejects.
    this.#writeChain = next.catch(() => {});
    return next;
  }

  async aggregate(projectId?: string): Promise<CompressionStats> {
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyStats(projectId ?? null);
      }
      throw err;
    }

    let requests = 0;
    let tokensBefore = 0;
    let tokensAfter = 0;
    let ccrRefsStored = 0;
    let ccrRefsRetrieved = 0;
    const perStage: Record<string, TokenDelta> = {};

    for (const line of raw.split("\n")) {
      const ev = parseEvent(line);
      if (ev === null) continue;
      if (projectId !== undefined && ev.projectId !== projectId) continue;

      if (ev.kind === "retrieval") {
        // Not a pipeline run — counts toward ccrRefsRetrieved only, never
        // toward `requests` or token savings (verification-notes §25).
        ccrRefsRetrieved += ev.ccrRefsRetrieved ?? 0;
        continue;
      }
      if (ev.kind === "usage") {
        // Not a pipeline run either — rolled up separately by
        // aggregateUsageByLevel (R1.1), never into the gross-token headline.
        continue;
      }
      if (ev.kind === "avoidedUpstream") {
        // Not a pipeline run either — rolled up separately by
        // aggregateAvoidedUpstream (R2.2), never into the gross-token headline.
        continue;
      }
      if (ev.kind === "tool") {
        // Not a pipeline run either — rolled up separately by
        // aggregateToolUsage (R4.3), never into the gross-token headline.
        continue;
      }

      requests += 1;
      ccrRefsStored += ev.ccrRefsStored;

      // Headline savings = the WHOLE-request before/after (requestTokens). Only
      // legacy events (written before that field) fall back to the mixed-scope
      // stage stitch, which over-reports (verification-notes §30).
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

  async aggregateUsageByLevel(projectId?: string): Promise<UsageByLevel> {
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { projectId: projectId ?? null, byLevel: {} };
      }
      throw err;
    }

    const byLevel: Record<number, UsageTotals & { requests: number }> = {};
    for (const line of raw.split("\n")) {
      const ev = parseEvent(line);
      if (ev === null || ev.kind !== "usage" || ev.usage === undefined) continue;
      if (projectId !== undefined && ev.projectId !== projectId) continue;

      const acc = byLevel[ev.level] ?? {
        requests: 0,
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      };
      byLevel[ev.level] = {
        requests: acc.requests + 1,
        inputTokens: acc.inputTokens + ev.usage.inputTokens,
        cacheCreationInputTokens: acc.cacheCreationInputTokens + ev.usage.cacheCreationInputTokens,
        cacheReadInputTokens: acc.cacheReadInputTokens + ev.usage.cacheReadInputTokens,
        outputTokens: acc.outputTokens + ev.usage.outputTokens,
      };
    }
    return { projectId: projectId ?? null, byLevel };
  }

  async aggregateUsageBySemanticForced(projectId?: string): Promise<UsageBySemanticForced> {
    let raw: string;
    const empty = (): UsageTotals & { requests: number } => ({
      requests: 0,
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 0,
    });
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { projectId: projectId ?? null, forced: empty(), notForced: empty() };
      }
      throw err;
    }

    let forced = empty();
    let notForced = empty();
    for (const line of raw.split("\n")) {
      const ev = parseEvent(line);
      if (ev === null || ev.kind !== "usage" || ev.usage === undefined) continue;
      if (projectId !== undefined && ev.projectId !== projectId) continue;

      const acc = ev.semanticForced === true ? forced : notForced;
      const next = {
        requests: acc.requests + 1,
        inputTokens: acc.inputTokens + ev.usage.inputTokens,
        cacheCreationInputTokens: acc.cacheCreationInputTokens + ev.usage.cacheCreationInputTokens,
        cacheReadInputTokens: acc.cacheReadInputTokens + ev.usage.cacheReadInputTokens,
        outputTokens: acc.outputTokens + ev.usage.outputTokens,
      };
      if (ev.semanticForced === true) forced = next;
      else notForced = next;
    }
    return { projectId: projectId ?? null, forced, notForced };
  }

  /**
   * Decision 52 — brevity rollup. Reads BOTH event kinds in one pass because the
   * two halves of the honest number live in different places: billed output
   * tokens on `usage` samples, and the directive's input cost on pipeline
   * events. Events written before the dial existed carry no `brevity` field and
   * are attributed to "off", which is correct — brevity could not have been on.
   */
  async aggregateUsageByBrevity(projectId?: string): Promise<UsageByBrevity> {
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { projectId: projectId ?? null, byBrevity: {} };
      }
      throw err;
    }

    // Mutable accumulator (UsageTotals' fields are readonly); widened back to the
    // readonly shape by the return type.
    interface BrevityAcc {
      requests: number;
      inputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      outputTokens: number;
      directiveTokens: number;
      injections: number;
    }
    const byBrevity: Record<string, BrevityAcc> = {};
    const bucket = (key: string) => {
      const existing = byBrevity[key];
      if (existing !== undefined) return existing;
      const fresh = {
        requests: 0,
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
        directiveTokens: 0,
        injections: 0,
      };
      byBrevity[key] = fresh;
      return fresh;
    };

    for (const line of raw.split("\n")) {
      const ev = parseEvent(line);
      if (ev === null) continue;
      if (projectId !== undefined && ev.projectId !== projectId) continue;
      const key = ev.brevity ?? "off";

      if (ev.kind === "usage" && ev.usage !== undefined) {
        const acc = bucket(key);
        acc.requests += 1;
        acc.inputTokens += ev.usage.inputTokens;
        acc.cacheCreationInputTokens += ev.usage.cacheCreationInputTokens;
        acc.cacheReadInputTokens += ev.usage.cacheReadInputTokens;
        acc.outputTokens += ev.usage.outputTokens;
        continue;
      }
      // Pipeline events (kind absent === "request") carry the directive's cost.
      if (ev.kind === undefined || ev.kind === "request") {
        const cost = ev.brevityDirectiveTokens ?? 0;
        if (cost > 0) {
          const acc = bucket(key);
          acc.directiveTokens += cost;
          acc.injections += 1;
        }
      }
    }
    return { projectId: projectId ?? null, byBrevity };
  }

  async aggregateAvoidedUpstream(projectId?: string): Promise<AvoidedUpstreamStats> {
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          projectId: projectId ?? null,
          events: 0,
          inputTokensAvoided: 0,
          outputTokensAvoided: 0,
        };
      }
      throw err;
    }

    let events = 0;
    let inputTokensAvoided = 0;
    let outputTokensAvoided = 0;
    for (const line of raw.split("\n")) {
      const ev = parseEvent(line);
      if (ev === null || ev.kind !== "avoidedUpstream") continue;
      if (projectId !== undefined && ev.projectId !== projectId) continue;
      events += 1;
      inputTokensAvoided += ev.avoidedUpstreamInputTokens ?? 0;
      outputTokensAvoided += ev.avoidedUpstreamOutputTokens ?? 0;
    }
    return { projectId: projectId ?? null, events, inputTokensAvoided, outputTokensAvoided };
  }

  async aggregateToolUsage(projectId?: string): Promise<ToolUsageStats> {
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { projectId: projectId ?? null, byTool: {} };
      }
      throw err;
    }

    const byTool: Record<string, ToolUsagePerTool> = {};
    for (const line of raw.split("\n")) {
      const ev = parseEvent(line);
      if (ev === null || ev.kind !== "tool" || ev.tool === undefined) continue;
      if (projectId !== undefined && ev.projectId !== projectId) continue;

      const acc = byTool[ev.tool] ?? {
        calls: 0,
        totalDurationMs: 0,
        totalResultBytes: 0,
        draftChars: 0,
      };
      byTool[ev.tool] = {
        calls: acc.calls + 1,
        totalDurationMs: acc.totalDurationMs + (ev.toolDurationMs ?? 0),
        totalResultBytes: acc.totalResultBytes + (ev.toolResultBytes ?? 0),
        draftChars: acc.draftChars + (ev.toolDraftChars ?? 0),
      };
    }
    return { projectId: projectId ?? null, byTool };
  }

  async close(): Promise<void> {
    // Drain any pending appends.
    await this.#writeChain;
  }
}

function emptyStats(projectId: string | null): CompressionStats {
  return {
    projectId,
    requests: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    perStage: {},
    ccrRefsStored: 0,
    ccrRefsRetrieved: 0,
  };
}
