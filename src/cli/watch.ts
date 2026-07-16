/**
 * R5.2 (WS-F10 / spec 21c) — `golem watch`: the full-screen sidecar TUI.
 *
 * The "expanded" companion to the one-line `golem statusline`: run it in a
 * second pane / tmux split next to the Claude Code conversation and it polls
 * the consolidated session-state API ({@link collectSessionStateReport}) and
 * redraws a live dashboard. Cross-platform and dependency-free — hand-rolled
 * ANSI only (works on Windows Terminal, modern macOS/Linux terminals); no TUI
 * library enters the default install (CLAUDE.md hard rule).
 *
 * The renderer ({@link renderWatchFrame}) is a pure function of a report so it
 * is unit-testable; {@link runWatch} owns the alternate-screen lifecycle and
 * the poll loop.
 */

import type { SessionStateReport } from "./session-report.js";
import { collectSessionStateReport } from "./session-report.js";

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;
/** Enter/leave the alternate screen buffer so the scrollback is preserved. */
const ALT_SCREEN_ON = `${CSI}?1049h`;
const ALT_SCREEN_OFF = `${CSI}?1049l`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
/** Clear the whole screen and home the cursor (top-left). */
const CLEAR_HOME = `${CSI}2J${CSI}H`;

/** Default redraw cadence; matches the web dashboard's REFRESH_MS. */
export const WATCH_REFRESH_MS = 2_000;

type Colorize = (s: string) => string;
function ansi(code: number, enabled: boolean): Colorize {
  return (s: string) => (enabled ? `${CSI}${code}m${s}${CSI}0m` : s);
}

/** Human-readable byte size (1536 → "1.5 KB"). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const shown = i === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${shown} ${units[i]}`;
}

function known(v: boolean | null, yes: string, no: string, unknown = "unknown"): string {
  return v === null ? unknown : v ? yes : no;
}

export interface WatchRenderOptions {
  readonly color?: boolean;
}

/**
 * Pure full-screen frame for a report. Returns clear+home followed by the
 * rendered dashboard. Defensive — never throws on odd data.
 */
export function renderWatchFrame(
  report: SessionStateReport,
  opts: WatchRenderOptions = {},
): string {
  const color = opts.color ?? false;
  const dim = ansi(2, color);
  const green = ansi(32, color);
  const cyan = ansi(36, color);
  const yellow = ansi(33, color);
  const red = ansi(31, color);
  const bold = ansi(1, color);

  const L: string[] = [];
  const s = report.savings;

  // Header.
  const proxyOn = report.proxy.running !== false;
  L.push(`${proxyOn ? green("⬢") : dim("⬡")} ${bold("Golem watch")}   ${dim(report.project_dir)}`);
  L.push(dim("─".repeat(52)));

  // Liveness row.
  const proxyText =
    report.proxy.running === null
      ? dim("proxy unknown")
      : report.proxy.running
        ? green("proxy running")
        : red("proxy OFF");
  L.push(`${proxyText}  ${cyan(`→${report.proxy.upstream}`)}`);
  L.push(
    `slider ${cyan(`L${report.slider.level} ${report.slider.name}`)}   ` +
      `local model ${known(report.local_model.reachable, green("reachable"), dim("down"))}`,
  );

  // Redaction-off is a loud, un-missable warning (Decision 30 / CLAUDE.md rule).
  if (report.slider.redaction_off) {
    L.push(red("⚠ REDACTION OFF — level 0 passthrough: secrets/PII reach the upstream unredacted"));
  }
  if (report.blocked.waiting) {
    const why = report.blocked.reason !== undefined ? `: ${report.blocked.reason}` : "";
    L.push(yellow(`⏸ waiting on you${why}`));
  }

  // Savings.
  L.push("");
  L.push(bold("Savings"));
  if (s.tokens_before > 0 && s.tokens_after <= s.tokens_before) {
    const pct = Math.round(((s.tokens_before - s.tokens_after) / s.tokens_before) * 100);
    L.push(
      `  ${green(`saved ${pct}%`)}  ${s.tokens_before} → ${s.tokens_after}  ` +
        dim(`(${s.requests} request(s))`),
    );
  } else {
    L.push(dim("  no savings recorded yet"));
  }
  L.push(`  CCR refs: ${s.ccr_refs_stored} stored / ${s.ccr_refs_retrieved} retrieved`);

  const stages = Object.entries(s.per_stage);
  if (stages.length > 0) {
    L.push(dim("  per stage:"));
    for (const [stage, d] of stages) {
      L.push(
        `    ${stage.padEnd(12)} ${d.tokens_before} → ${d.tokens_after} ` +
          dim(`(saved ${d.tokens_saved})`),
      );
    }
  }

  // Local tools (R4.3 telemetry).
  const tools = s.tool_usage === undefined ? [] : Object.entries(s.tool_usage);
  if (tools.length > 0) {
    L.push("");
    L.push(bold("Local tools"));
    for (const [tool, u] of tools) {
      const avgMs = u.calls > 0 ? Math.round(u.total_duration_ms / u.calls) : 0;
      const drafted = u.draft_chars > 0 ? `, ~${Math.round(u.draft_chars / 4)} tok drafted` : "";
      L.push(`  ${tool.padEnd(12)} ${u.calls} call(s), avg ${avgMs}ms${drafted}`);
    }
  }

  // Storage.
  L.push("");
  L.push(bold("Storage"));
  const st = report.storage;
  L.push(
    `  ccr ${formatBytes(st.ccr_bytes)}   knowledge ${formatBytes(st.knowledge_bytes)}   ` +
      `telemetry ${formatBytes(st.telemetry_bytes)}   webcache ${formatBytes(st.webcache_bytes)}`,
  );

  // Footer.
  L.push("");
  L.push(
    dim(
      `updated ${report.generated_at} · refreshes every ${WATCH_REFRESH_MS / 1000}s · Ctrl+C to exit`,
    ),
  );

  return `${CLEAR_HOME}${L.join("\r\n")}\r\n`;
}

export interface RunWatchOptions {
  readonly dir: string;
  readonly refreshMs?: number;
  readonly color?: boolean;
  /** Injectable for tests; defaults to the real collector. */
  readonly collect?: (dir: string) => Promise<SessionStateReport>;
  /** Where to write frames (defaults to process.stdout). */
  readonly out?: NodeJS.WritableStream;
}

/**
 * Run the live watch loop until SIGINT/SIGTERM. Enters the alternate screen,
 * hides the cursor, and restores both on exit (even on error). Resolves when
 * the loop is torn down.
 */
export async function runWatch(options: RunWatchOptions): Promise<void> {
  const out = options.out ?? process.stdout;
  const refreshMs = options.refreshMs ?? WATCH_REFRESH_MS;
  const collect = options.collect ?? collectSessionStateReport;
  const color = options.color ?? (process.stdout.isTTY === true && !process.env.NO_COLOR);

  out.write(ALT_SCREEN_ON + HIDE_CURSOR);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const restore = (): void => {
    if (timer !== undefined) clearInterval(timer);
    out.write(SHOW_CURSOR + ALT_SCREEN_OFF);
  };

  const draw = async (): Promise<void> => {
    if (stopped) return;
    try {
      const report = await collect(options.dir);
      out.write(renderWatchFrame(report, { color }));
    } catch (err) {
      // A single failed poll must not kill the loop; show it and keep going.
      out.write(
        `${CLEAR_HOME}golem watch: ${err instanceof Error ? err.message : String(err)}\r\n`,
      );
    }
  };

  await draw();
  return new Promise<void>((resolve) => {
    const shutdown = (): void => {
      if (stopped) return;
      stopped = true;
      restore();
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    timer = setInterval(() => void draw(), refreshMs);
  });
}
