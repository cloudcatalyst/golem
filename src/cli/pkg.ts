/**
 * `golem pkg` — the managed-package surface (spec Decision 53).
 *
 * Read-only by design in this first cut: it answers "what can Golem use, is it
 * installed, is it on, and what happens without it" without installing,
 * upgrading, or spawning anything. Install remains a human act with the
 * upstream's own installer, because Golem redistributes no third-party bytes.
 *
 * Named `pkg` and not `ext` or `tools` deliberately: `golem bench tools` and
 * `src/tools/` are the tool-selection benchmark harness (§89), and `ext` was
 * the old name for this surface (kept as a CLI alias for backward compat).
 */

import { loadConfig } from "../config/index.js";
import { type PkgStatus, type PkgTier, pkgManifest, resolvePkgStatuses } from "../pkg/index.js";

export interface PkgReport {
  readonly projectDir: string;
  readonly rows: readonly PkgStatus[];
}

/** Resolve every registry row against this project's effective settings. */
export async function collectPkg(projectDir: string): Promise<PkgReport> {
  const { settings } = await loadConfig({ projectDir });
  return { projectDir, rows: resolvePkgStatuses({ settings }) };
}

const TIER_HEADINGS: Readonly<Record<PkgTier, string>> = {
  "tier-2": "Tier 2 — spawned or resolved at a pin; you provide it; absence is a no-op",
  "tier-3a": "Tier 3a — peers Golem detects and defers to; it never drives them",
  "tier-3b": "Tier 3b — ideas re-implemented as Golem's own data, source cited, nothing copied",
};

const TIER_ORDER: readonly PkgTier[] = ["tier-2", "tier-3a", "tier-3b"];

const STATE_LABEL: Readonly<Record<PkgStatus["state"], string>> = {
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

function renderRow(row: PkgStatus): string[] {
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

function renderVerboseExtras(row: PkgStatus): string[] {
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

/**
 * Install a managed external package (delegates to the tool's own installer —
 * Golem never ships third-party bytes).
 *
 * Currently supports:
 * - `caveman` — runs `claude plugin marketplace add JuliusBrussee/caveman && claude plugin install caveman@caveman`
 *
 * Returns stdout/stderr from the install process. Throws for unsupported ids.
 */
export async function pkgInstall(id: string, _projectDir: string): Promise<string> {
  const manifest = pkgManifest(id);
  if (manifest === undefined) {
    throw new Error(`unknown package: ${id}. Run \`golem pkg list\` to see available packages.`);
  }

  if (id === "caveman") {
    const { execSync } = await import("node:child_process");
    const lines: string[] = [];
    lines.push(`Installing ${manifest.title}...`);
    lines.push("");

    // Step 1: add the marketplace
    lines.push("> claude plugin marketplace add JuliusBrussee/caveman");
    try {
      const addOut = execSync("claude plugin marketplace add JuliusBrussee/caveman", {
        stdio: "pipe",
        timeout: 30_000,
        encoding: "utf8",
      });
      lines.push(addOut.trim());
    } catch (err) {
      if (isExecError(err) && err.stderr?.trim().includes("already exists")) {
        lines.push("→ marketplace already registered");
      } else {
        throw new Error(
          `failed to add Caveman marketplace: ${isExecError(err) ? err.stderr?.trim() || err.message : String(err)}`,
        );
      }
    }

    // Step 2: install the plugin
    lines.push("");
    lines.push("> claude plugin install caveman@caveman");
    try {
      const installOut = execSync("claude plugin install caveman@caveman", {
        stdio: "pipe",
        timeout: 60_000,
        encoding: "utf8",
      });
      lines.push(installOut.trim());
    } catch (err) {
      throw new Error(
        `failed to install Caveman plugin: ${isExecError(err) ? err.stderr?.trim() || err.message : String(err)}`,
      );
    }

    lines.push("");
    lines.push("Caveman installed. You may need to reload Claude Code for it to take effect.");
    lines.push('Use `/caveman` or say "talk like caveman" to activate it.');
    lines.push(
      "Note: Golem's own brevity dial covers the same ground — having both active may " +
        "stack (unexpectedly heavy compression). Golem's brevity will stand down when " +
        "Caveman is detected (hasExistingBrevityDirective).",
    );
    return lines.join("\n");
  }

  throw new Error(
    `${id} has no automated install path. See \`golem pkg list --verbose\` for manual instructions.`,
  );
}

function isExecError(err: unknown): err is { stderr: string; message: string } {
  return typeof err === "object" && err !== null && "stderr" in err;
}

export function renderPkg(report: PkgReport, verbose = false): string {
  const out: string[] = [
    "Golem managed packages — spawned or detected, never shipped (spec Decision 53)",
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
    `${report.rows.length} packages known · ${on.length} enabled · ${missing.length} not installed`,
  );
  out.push(
    "State is presence and configuration, not liveness — no process is probed. Read the notes.",
  );
  return `${out.join("\n")}\n`;
}
