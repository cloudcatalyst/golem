/**
 * The panel's info section: the pet on the left, three lines of live state on the
 * right, and any warnings underneath.
 *
 * {@link headerLines} builds the text purely from the `golem status` report, so
 * what the panel shows and what `golem status` prints can't drift — and the lines
 * are assertable in tests without rendering ink.
 */

import { Box, Text } from "ink";
import type { StatusReport } from "../cli/status.js";
import { renderUpstream } from "../cli/status.js";
import { col, PET_LINES, PET_WIDTH, type Theme } from "./theme.js";

/** One header line as segments, so the value half can be coloured differently. */
export interface HeaderSegment {
  readonly label: string;
  readonly value: string;
  /**
   * Semantic tone for the value: drives colour only. Explicitly allows
   * `undefined` (rather than just being optional) because "no tone" is a normal
   * computed outcome here, and `exactOptionalPropertyTypes` distinguishes the two.
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
  const slider: HeaderSegment = {
    label: "Level",
    // Level 0 is the redaction-off bypass — flag it in the header, not just in a
    // warning line, so it can't be running unnoticed.
    value: `${report.slider.level} ${report.slider.name}`,
    tone: report.slider.level === 0 ? "error" : undefined,
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

interface HeaderProps {
  readonly report: StatusReport;
  readonly theme: Theme;
  readonly showPet: boolean;
  readonly width: number;
}

export function Header({ report, theme, showPet, width }: HeaderProps): React.JSX.Element {
  const lines = headerLines(report);
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {showPet ? (
          // Fixed width + flexShrink 0: the pet's first glyph (U+25A0) has
          // Ambiguous East Asian Width, so a CJK-configured terminal may draw it
          // double-wide. Reserving the column stops that shifting the text.
          <Box flexDirection="column" width={PET_WIDTH + 3} flexShrink={0} marginRight={1}>
            {PET_LINES.map((line) => (
              <Text key={line} color={theme.pet} bold>
                {line}
              </Text>
            ))}
          </Box>
        ) : null}
        <Box flexDirection="column" flexGrow={1}>
          {lines.map((line) => (
            // Keyed by the line's leading label ("Golem" / "Proxy" / "Local"),
            // which is stable across renders — headerLines always returns the
            // same three lines in the same order.
            <Text key={lineKey(line)} wrap="truncate-end">
              {line.map((segment, segIndex) => (
                <Text key={segment.label}>
                  {segIndex > 0 ? "   " : ""}
                  <Text color={theme.dim}>{segment.label} </Text>
                  <Text {...col(toneColor(segment.tone, theme))}>{segment.value}</Text>
                </Text>
              ))}
            </Text>
          ))}
        </Box>
      </Box>
      {report.warnings.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {report.warnings.map((warning) => (
            <Text key={warning} color={theme.warn} wrap="truncate-end">
              {`! ${collapse(warning, Math.max(20, width - 4))}`}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

/** Stable React key for a header line: its first segment's label. */
function lineKey(line: HeaderLine): string {
  return line[0]?.label ?? "line";
}

function toneColor(tone: HeaderSegment["tone"], theme: Theme): string | undefined {
  switch (tone) {
    case "ok":
      return theme.ok;
    case "warn":
      return theme.warn;
    case "error":
      return theme.error;
    default:
      return undefined;
  }
}

/** Squash a multi-line warning onto one line and clip it to the panel width. */
function collapse(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}
