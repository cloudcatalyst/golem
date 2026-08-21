/**
 * R11.7 — the proxy's log line, with a timestamp on it.
 *
 * `.golem/proxy.log` held 11,655 lines of
 * `golem proxy: routed to "anthropic" — inference.default_target` and nothing
 * to place any of them in time. Diagnosing a live "Connection lost
 * mid-response" therefore could not use it at all: the evidence came from the
 * client's transcript and the process table instead. A log whose entries cannot
 * be located in time is not a log, and being unable to answer "was it Golem?"
 * from Golem's own records is a poor showing for a project whose pillar is
 * honest observability.
 *
 * Every proxy-side line goes through here, so the shape is decided once:
 *
 *   `2026-08-21T02:21:04.843Z golem proxy: <message>`
 *
 * ISO-8601 in UTC, deliberately. The daemon outlives clock changes and DST, the
 * client transcripts it has to be correlated against are ISO/UTC (that is how
 * the incident above was reconstructed), and it sorts lexicographically.
 *
 * stderr, not stdout: `startDetached` points both at the log file, and stdout
 * belongs to the CLI's own machine-readable output.
 */

/** Injectable for tests — the daemon always uses the real clock. */
export type Clock = () => Date;

let sink: (line: string) => void = (line) => {
  process.stderr.write(line);
};
let clock: Clock = () => new Date();

/**
 * Write one timestamped proxy log line. `message` is the part after
 * `golem proxy: ` and must not end in a newline.
 *
 * Never throws: a logging failure must not be able to break a request.
 */
export function proxyLog(message: string): void {
  try {
    sink(`${clock().toISOString()} golem proxy: ${message}\n`);
  } catch {
    // A log that cannot be written is not worth failing a request over.
  }
}

/**
 * Point the log somewhere else, and/or fix the clock. Returns a restore
 * function. Tests only — the daemon never calls this.
 */
export function setProxyLogForTesting(options: {
  sink?: (line: string) => void;
  clock?: Clock;
}): () => void {
  const previousSink = sink;
  const previousClock = clock;
  if (options.sink !== undefined) sink = options.sink;
  if (options.clock !== undefined) clock = options.clock;
  return () => {
    sink = previousSink;
    clock = previousClock;
  };
}

/** Bytes, rendered for a human reading a log line. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Milliseconds, rendered so a slow request stands out at a glance. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The one-line record of what became of a request (R11.7).
 *
 * Deliberately one line per request, and deliberately dense: the whole point is
 * that it can be grepped and correlated after the fact. `truncated` is spelled
 * loudly because it is the case nobody could see before.
 *
 * Structurally typed rather than importing `ProxyRequestOutcome`, so this stays
 * a formatter with no dependency on the proxy module.
 */
export function renderRequestOutcome(outcome: {
  readonly method: string;
  readonly path: string;
  readonly targetId?: string;
  readonly status?: number;
  readonly durationMs: number;
  readonly bytes: number;
  readonly streaming: boolean;
  readonly result: string;
  readonly lastEvent?: string;
  readonly events?: number;
  readonly detail?: string;
}): string {
  const target = outcome.targetId !== undefined ? ` → ${outcome.targetId}` : "";
  const status = outcome.status !== undefined ? ` ${outcome.status}` : "";
  const bytes = outcome.bytes > 0 ? `, ${formatBytes(outcome.bytes)}` : "";
  const stream =
    outcome.streaming && outcome.events !== undefined ? `, ${outcome.events} SSE events` : "";
  const head =
    `${outcome.method} ${outcome.path}${target}${status} — ` +
    `${outcome.result.toUpperCase()} in ${formatDuration(outcome.durationMs)}${bytes}${stream}`;
  const where =
    outcome.result === "truncated" && outcome.lastEvent !== undefined
      ? ` (last event: ${outcome.lastEvent})`
      : "";
  const why = outcome.detail !== undefined ? `: ${outcome.detail}` : "";
  return `${head}${where}${why}`;
}
