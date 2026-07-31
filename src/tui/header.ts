/**
 * The panel's info section, as data: the three lines shown beside the pet.
 *
 * Built purely from the `golem status` report, so what the panel shows and what
 * `golem status` prints cannot drift — and the lines are assertable in tests without
 * rendering anything. `render.ts` turns them into terminal text.
 */

import type { StatusReport } from "../cli/status.js";
import { renderUpstream } from "../cli/upstream-display.js";

/** One header line as segments, so the value half can be coloured differently. */
export interface HeaderSegment {
  readonly label: string;
  readonly value: string;
  /**
   * Semantic tone for the value: drives colour only. Explicitly allows `undefined`
   * (rather than just being optional) because "no tone" is a normal computed
   * outcome here, and `exactOptionalPropertyTypes` distinguishes the two.
   */
  readonly tone?: "ok" | "warn" | "error" | undefined;
}

export type HeaderLine = readonly HeaderSegment[];

/**
 * Exactly three lines — one per pet row — so the header block is always the same
 * height regardless of what is or isn't configured.
 */
export function headerLines(report: StatusReport): readonly HeaderLine[] {
  const proxy: HeaderSegment = {
    label: "Proxy",
    value: report.proxy.reachable
      ? `● ${report.proxy.url}`
      : `○ not running (${report.proxy.port})`,
    tone: report.proxy.reachable ? "ok" : "warn",
  };
  // §103: when the configured level is inert on this upstream, the header shows the
  // level that is RUNNING and marks the set-but-inert one, rather than displaying a
  // name the pipeline is not honouring.
  const ec = report.effective_compression;
  const slider: HeaderSegment = {
    label: "Level",
    // Level 0 is the redaction-off bypass — flagged in the header, not just in a
    // warning line, so it can't be running unnoticed.
    value: ec.degraded
      ? `${ec.effective} ${ec.effective_name} (${ec.nominal} inert)`
      : `${report.slider.level} ${report.slider.name}`,
    tone: report.slider.level === 0 ? "error" : ec.degraded ? "warn" : undefined,
  };

  const local = report.local_model;
  const localValue = !local.coder_enabled
    ? "○ coder disabled"
    : local.reachable
      ? `● ${local.coder_model ?? "reachable"}`
      : "○ unreachable";

  const line3: HeaderSegment[] = [
    {
      label: "Local",
      value: localValue,
      tone: local.coder_enabled && local.reachable ? "ok" : undefined,
    },
  ];
  if (report.limits !== undefined) {
    const pct = Math.round(report.limits.five_hour_utilization * 100);
    line3.push({
      label: "Limits",
      value: report.limits.stale ? `5h ${pct}% (stale)` : `5h ${pct}% used`,
      tone: report.limits.stale ? "warn" : pct >= 80 ? "warn" : undefined,
    });
  }

  return [
    [{ label: "Golem", value: `${report.version} · ${report.project_dir}` }],
    [proxy, slider, { label: "Upstream", value: renderUpstream(report.upstream) }],
    line3,
  ];
}

/**
 * The three lines shown before the status report arrives — same shape, same height,
 * so the layout doesn't shift when the real values replace them.
 *
 * Far less visible than under ink: the panel now reaches its first frame in ~150ms
 * rather than ~1.15s, so the header often lands within the same blink.
 */
export function pendingHeaderLines(version: string, projectDir: string): readonly HeaderLine[] {
  return [
    [{ label: "Golem", value: `${version} · ${projectDir}` }],
    [{ label: "Proxy", value: "…" }],
    [{ label: "Local", value: "…" }],
  ];
}

/** Squash a multi-line warning onto one line and clip it to the panel width. */
export function collapseWarning(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}
