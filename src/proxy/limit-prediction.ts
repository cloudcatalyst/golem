/**
 * Limit prediction (snooze proposal docs/plan/proposals/golem-snooze.md, P2a).
 *
 * The proxy is the only component that sees Anthropic's per-response
 * `anthropic-ratelimit-unified-*` headers — the session (5h) and weekly (7d)
 * window utilization and reset times. This module turns those headers into a
 * small, persisted `LimitPrediction` snapshot under `.golem/state/` so the
 * PreToolUse trigger (P2b) can decide "near the limit — snooze now" and the
 * `snooze` tool can default its `until` from the observed reset.
 *
 * Observe-only, like the response-usage sniffer: it never alters the forwarded
 * response (CLAUDE.md proxy-fidelity). NOTE: this is prediction/observability,
 * NOT the auto-resume detect+capture that Decision 37 removed — it reads the
 * utilization on EVERY response (not just 429s) and only records state; nothing
 * is captured, spawned, or resumed.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const UTIL_5H = "anthropic-ratelimit-unified-5h-utilization";
const RESET_5H = "anthropic-ratelimit-unified-5h-reset";
const STATUS_5H = "anthropic-ratelimit-unified-5h-status";
const UTIL_7D = "anthropic-ratelimit-unified-7d-utilization";
const RESET_7D = "anthropic-ratelimit-unified-7d-reset";
const STATUS_7D = "anthropic-ratelimit-unified-7d-status";

/** One rate-limit window's observed state. */
export interface LimitWindow {
  /** Fraction of the window used, 0..1 (Anthropic's reported value, unclamped). */
  readonly utilization: number;
  /** Window reset time (ISO), or null when the reset header was absent/unparseable. */
  readonly resetAtIso: string | null;
  /** `allowed` | `rejected` | … when the status header is present. */
  readonly status?: string | undefined;
}

/** A snapshot of the session (5h) and, when present, weekly (7d) windows. */
export interface LimitPrediction {
  /** When the proxy observed these headers (ISO). */
  readonly observedAtIso: string;
  readonly fiveHour: LimitWindow;
  readonly sevenDay?: LimitWindow | undefined;
}

const windowSchema = z.object({
  utilization: z.number(),
  resetAtIso: z.string().nullable(),
  status: z.string().optional(),
});
const predictionSchema = z.object({
  observedAtIso: z.string(),
  fiveHour: windowSchema,
  sevenDay: windowSchema.optional(),
});

type RawHeaders = Readonly<Record<string, string | string[] | undefined>>;

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function toNumber(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : undefined;
}

/** Anthropic unified reset headers are unix EPOCH SECONDS → ISO, or null. */
function epochSecondsToIso(v: string | undefined): string | null {
  const secs = toNumber(v);
  if (secs === undefined) return null;
  const ms = secs * 1000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function parseWindow(
  headers: RawHeaders,
  utilKey: string,
  resetKey: string,
  statusKey: string,
): LimitWindow | null {
  const utilization = toNumber(firstValue(headers[utilKey]));
  if (utilization === undefined) return null; // no data for this window
  const status = firstValue(headers[statusKey]);
  return {
    utilization,
    resetAtIso: epochSecondsToIso(firstValue(headers[resetKey])),
    ...(status !== undefined ? { status } : {}),
  };
}

/**
 * Build a {@link LimitPrediction} from response headers, or null when the
 * session-window (5h) utilization header is absent (nothing to predict from).
 * Pure; `nowIso` is injected so it is deterministic in tests.
 */
export function parseLimitPrediction(headers: RawHeaders, nowIso: string): LimitPrediction | null {
  const fiveHour = parseWindow(headers, UTIL_5H, RESET_5H, STATUS_5H);
  if (fiveHour === null) return null;
  const sevenDay = parseWindow(headers, UTIL_7D, RESET_7D, STATUS_7D);
  return {
    observedAtIso: nowIso,
    fiveHour,
    ...(sevenDay !== null ? { sevenDay } : {}),
  };
}

/** `.golem/state/limit-state.json` for a project. */
export function limitStatePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "limit-state.json");
}

/** Persist the latest prediction (atomic temp+rename). Fail-open — caller ignores errors. */
export async function writeLimitState(projectDir: string, state: LimitPrediction): Promise<void> {
  const file = limitStatePath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

/** Read the latest persisted prediction, or null (missing/corrupt). */
export async function readLimitState(projectDir: string): Promise<LimitPrediction | null> {
  let raw: string;
  try {
    raw = await readFile(limitStatePath(projectDir), "utf8");
  } catch {
    return null;
  }
  try {
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = predictionSchema.safeParse(JSON.parse(stripped));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
