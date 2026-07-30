/**
 * `golem ext` — the managed-tool surface (spec Decision 53).
 *
 * Read-only by design in this first cut: it answers "what can Golem use, is it
 * installed, is it on, and what happens without it" without installing,
 * upgrading, or spawning anything. Install remains a human act with the
 * upstream's own installer, because Golem redistributes no third-party bytes.
 *
 * Named `ext` and not `tools` deliberately: `golem bench tools` and `src/tools/`
 * are the tool-selection benchmark harness (§89), an unrelated thing.
 */

import { loadConfig } from "../config/index.js";
import { type ExtStatus, type ExtTier, resolveExtStatuses } from "../ext/index.js";

export interface ExtReport {
  readonly projectDir: string;
  readonly rows: readonly ExtStatus[];
}

/** Resolve every registry row against this project's effective settings. */
export async function collectExt(projectDir: string): Promise<ExtReport> {
  const { settings } = await loadConfig({ projectDir });
  return { projectDir, rows: resolveExtStatuses({ settings }) };
}

const TIER_HEADINGS: Readonly<Record<ExtTier, string>> = {
  "tier-2": "Tier 2 — spawned or resolved at a pin; you provide it; absence is a no-op",
  "tier-3a": "Tier 3a — peers Golem detects and defers to; it never drives them",
  "tier-3b": "Tier 3b — ideas re-implemented as Golem's own data, source cited, nothing copied",
};

const TIER_ORDER: readonly ExtTier[] = ["tier-2", "tier-3a", "tier-3b"];

const STATE_LABEL: Readonly<Record<ExtStatus["state"], string>> = {
  bundled: "built in",
  "not-installed": "not found",
  blocked: "blocked",
  disabled: "off",
  enabled: "on",
  present: "found",
};

/** Left pad for every continuation/detail line, matching the row label column. */
const PAD = " ".repeat(14);

/** Usable width for detail text once `PAD` is applied (keeps rows under ~80). */
const TEXT_WIDTH = 64;

/**
 * Greedy word wrap to `width`, returning **unprefixed** lines. The caller adds
 * `PAD`; folding the pad in here double-indented every continuation line.
 */
function wrap(text: string, width: number = TEXT_WIDTH): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line === "") {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line = `${line} ${word}`;
    } else {
      out.push(line);
      line = word;
    }
  }
  if (line !== "") out.push(line);
  return out;
}

/** Wrap `text` and prefix every line with the detail-column pad. */
function detail(text: string): string[] {
  return wrap(text).map((l) => `${PAD}${l}`);
}

function renderRow(row: ExtStatus): string[] {
  const lines: string[] = [];
  const label = `[${STATE_LABEL[row.state]}]`.padEnd(11);
  lines.push(`  ${label} ${row.manifest.id.padEnd(16)} ${row.manifest.title}`);

  const facts: string[] = [];
  if (row.manifest.pin !== undefined) facts.push(`pin ${row.manifest.pin}`);
  if (row.manifest.enabledBy !== undefined) {
    facts.push(`${row.manifest.enabledBy} = ${row.settingValue ?? "(default)"}`);
  }
  if (facts.length > 0) lines.push(`${PAD}${facts.join(" · ")}`);
  if (row.where !== null) lines.push(`${PAD}${row.where}`);

  if (row.missingRequirements.length > 0) {
    lines.push(`${PAD}needs: ${row.missingRequirements.join(", ")} (not found)`);
  }

  // The payoff line: why "on" may still not mean "running".
  if (row.manifest.gate !== undefined && row.state !== "not-installed") {
    lines.push(...detail(`note: ${row.manifest.gate}`));
  }

  if (row.state === "not-installed") {
    lines.push(...detail(`without it: ${row.manifest.degrade}`));
  }

  return lines;
}

function renderVerboseExtras(row: ExtStatus): string[] {
  const lines: string[] = [
    ...detail(`what: ${row.manifest.what}`),
    ...detail(`without it: ${row.manifest.degrade}`),
    ...detail(`install: ${row.manifest.install}`),
    `${PAD}upstream: ${row.manifest.upstream} (${row.manifest.licence})`,
  ];
  if (row.manifest.adapter !== undefined) {
    lines.push(`${PAD}adapter: ${row.manifest.adapter}`);
  }
  return lines;
}

export function renderExt(report: ExtReport, verbose = false): string {
  const out: string[] = [
    "Golem managed tools — spawned or detected, never shipped (spec Decision 53)",
    "",
  ];

  for (const tier of TIER_ORDER) {
    const rows = report.rows.filter((r) => r.manifest.tier === tier);
    if (rows.length === 0) continue;
    out.push(TIER_HEADINGS[tier]);
    for (const row of rows) {
      out.push(...renderRow(row));
      if (verbose) out.push(...renderVerboseExtras(row));
    }
    out.push("");
  }

  const missing = report.rows.filter((r) => r.state === "not-installed");
  const on = report.rows.filter((r) => r.state === "enabled");
  out.push(
    `${report.rows.length} tools known · ${on.length} enabled · ${missing.length} not installed`,
  );
  out.push(
    "State is presence and configuration, not liveness — no process is probed. Read the notes.",
  );
  return `${out.join("\n")}\n`;
}
