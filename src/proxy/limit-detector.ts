/**
 * Auto-resume Phase 1 (proposals/auto-resume-on-limit.md) — pure detection of
 * an upstream usage/rate-limit response.
 *
 * The proxy is the only component that sees the upstream limit response and its
 * reset time. This turns a (statusCode, headers, now) triple into a
 * {@link UsageLimitSignal} — the resolved reset time plus a snapshot of the
 * limit-relevant headers — or null when the response isn't a limit.
 *
 * Pure and side-effect-free (no I/O, no clock of its own — `nowMs` is injected)
 * so it is exhaustively unit-testable. The side-effecting half (logging +
 * durable-task capture) lives in `src/tasks/limit-capture.ts`.
 *
 * Signal (verified live 2026-07-17, platform.claude.com/docs/en/api/rate-limits):
 * a limit is an HTTP 429 carrying `retry-after` (seconds) and/or
 * `anthropic-ratelimit-*-reset` (RFC 3339). The subscription session/weekly
 * limits may present differently — so the whole `anthropic-*` header set is
 * snapshotted for the capture layer to log, turning that unknown into data.
 */

/** HTTP status treated as a limit response (API rate + subscription usage both 429). */
export const LIMIT_STATUS = 429;

/** Documented RFC-3339 reset headers, most-restrictive-limit first is irrelevant — we take the max. */
const RESET_HEADER_NAMES = [
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-reset",
  "anthropic-ratelimit-input-tokens-reset",
  "anthropic-ratelimit-output-tokens-reset",
] as const;

export interface UsageLimitSignal {
  /** Always {@link LIMIT_STATUS} for a detected limit. */
  readonly statusCode: number;
  /** Resolved reset time (ISO 8601, the furthest-out candidate), or null if none was parseable. */
  readonly resetAtIso: string | null;
  /** Seconds from `now` until reset (>= 0), or null when `resetAtIso` is null. */
  readonly secondsUntilReset: number | null;
  /** Raw `retry-after` header value, if present. */
  readonly retryAfter: string | null;
  /** Which header/source the resolved reset came from (for debugging/logging). */
  readonly resetSource: string | null;
  /** Snapshot of `retry-after` + every `anthropic-*` header (first value), for logging. */
  readonly headers: Readonly<Record<string, string>>;
}

type RawHeaders = Readonly<Record<string, string | string[] | undefined>>;

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Snapshot the limit-relevant headers (retry-after + all anthropic-*), first value each. */
function snapshotHeaders(headers: RawHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key !== "retry-after" && !key.startsWith("anthropic-")) continue;
    const v = firstValue(value);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Parse `retry-after` (integer seconds, or an HTTP-date) into an epoch-ms reset, or null. */
function parseRetryAfter(value: string | undefined, nowMs: number): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return nowMs + Number(trimmed) * 1000;
  const asDate = Date.parse(trimmed); // HTTP-date form
  return Number.isFinite(asDate) ? asDate : null;
}

/**
 * Resolve the reset time: the FURTHEST-OUT of `retry-after` and every
 * `anthropic-ratelimit-*-reset` header. A transient per-minute 429 yields a
 * seconds-away reset (all candidates small); a real session/weekly exhaustion
 * yields an hours-away reset — the capture layer thresholds on that magnitude.
 */
function resolveReset(
  headers: RawHeaders,
  nowMs: number,
): { resetAtMs: number; source: string } | null {
  const candidates: Array<{ ms: number; source: string }> = [];
  const retryMs = parseRetryAfter(firstValue(headers["retry-after"]), nowMs);
  if (retryMs !== null) candidates.push({ ms: retryMs, source: "retry-after" });
  for (const name of RESET_HEADER_NAMES) {
    const raw = firstValue(headers[name]);
    if (raw === undefined) continue;
    const ms = Date.parse(raw.trim());
    if (Number.isFinite(ms)) candidates.push({ ms, source: name });
  }
  if (candidates.length === 0) return null;
  const best = candidates.reduce((a, b) => (b.ms > a.ms ? b : a));
  return { resetAtMs: best.ms, source: best.source };
}

/**
 * Detect a usage/rate-limit response. Returns null for any non-429 status
 * (Phase 1 scope; broadened once a real subscription-limit signal is captured).
 */
export function detectUsageLimit(
  statusCode: number,
  headers: RawHeaders,
  nowMs: number,
): UsageLimitSignal | null {
  if (statusCode !== LIMIT_STATUS) return null;
  const reset = resolveReset(headers, nowMs);
  const retryAfter = firstValue(headers["retry-after"]) ?? null;
  return {
    statusCode,
    resetAtIso: reset === null ? null : new Date(reset.resetAtMs).toISOString(),
    secondsUntilReset:
      reset === null ? null : Math.max(0, Math.round((reset.resetAtMs - nowMs) / 1000)),
    retryAfter,
    resetSource: reset?.source ?? null,
    headers: snapshotHeaders(headers),
  };
}
