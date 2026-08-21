/**
 * `golem pkg` — the managed-package surface (spec Decision 53).
 *
 * The read half answers "what can Golem use, is it installed, is it on, and what
 * happens without it" without spawning anything. The write half (R8.14 —
 * `install` / `remove` / `upgrade`) is here too, and it stays a *human* act: it
 * invokes the upstream's own installer at a recorded pin, only with explicit
 * consent, because Golem redistributes no third-party bytes. The rules live in
 * `src/pkg/install.ts`; this file only renders and takes the yes/no.
 *
 * Named `pkg` and not `ext` or `tools` deliberately: `golem bench tools` and
 * `src/tools/` are the tool-selection benchmark harness (§89), and `ext` was
 * the old name for this surface (kept as a CLI alias for backward compat).
 */

import { loadConfig } from "../config/index.js";
import {
  type PkgAction,
  type PkgPlan,
  type PkgRunOutcome,
  type PkgStatus,
  type PkgTier,
  planPkgAction,
  resolvePkgStatuses,
  runPkgAction,
} from "../pkg/index.js";

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
 * Ask a human, in a TTY, before an install runs. Non-TTY without `--yes` is a
 * refusal, not a silent yes — the same discipline as `golem wiki promote`.
 */
async function confirm(question: string): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

/** The consent preview: what would run, whose installer it is, and at what pin. */
export function renderPkgPlan(plan: PkgPlan): string {
  if (plan.kind === "refused") {
    const body = wrap(plan.reason, 76).join("\n");
    return `golem pkg ${plan.action} ${plan.id}: refused.\n\n${body}\n`;
  }

  const out: string[] = [
    `${plan.action} ${plan.title} — via ${plan.upstream}, which you already have installed.`,
    "",
  ];
  if (plan.pin !== null) {
    const policy =
      plan.pinPolicy === "manifest"
        ? "pinned by Golem's registry; an upgrade re-converges on it and cannot move past it"
        : plan.pinPolicy === "playbook"
          ? "pinned by an upgrade playbook"
          : "the upstream versions this itself";
    out.push(`pin: ${plan.pin} (${policy})`);
  } else if (plan.pinPolicy === "upstream-unpinned") {
    out.push(
      "pin: none — this upstream's installer has no version selector; it tracks its own ref.",
    );
  }
  if (plan.reinstall) {
    out.push("upgrade = re-run install at the pin above. That is the whole upgrade.");
  }
  out.push("");
  out.push("Golem ships none of this package's bytes. It will run:");
  for (const [i, step] of plan.steps.entries()) {
    out.push(`  ${i + 1}. ${step.command} ${step.args.join(" ")}`);
    out.push(...wrap(step.why, 72).map((l) => `     ${l}`));
  }
  if (plan.caveat !== null) {
    out.push("");
    out.push("note:");
    out.push(...wrap(plan.caveat, 72).map((l) => `  ${l}`));
  }
  return `${out.join("\n")}\n`;
}

/** What actually happened, step by step. */
export function renderPkgOutcome(outcome: PkgRunOutcome): string {
  const out: string[] = [];
  for (const step of outcome.steps) {
    const mark =
      step.state === "ok"
        ? "ok"
        : step.state === "tolerated"
          ? "already done"
          : step.state === "skipped"
            ? "skipped"
            : step.state === "not-found"
              ? "not on PATH"
              : "failed";
    out.push(`  [${mark}] ${step.step.command} ${step.step.args.join(" ")}`);
  }
  if (out.length > 0) out.push("");
  out.push(...wrap(outcome.message, 76));
  return `${out.join("\n")}\n`;
}

/**
 * Run one write verb end to end: plan, preview, take consent, execute.
 *
 * Consent is never inferred. `--yes` is one route; a TTY answer is the other;
 * anything else prints the plan and stops with a non-zero-worthy status. The
 * autonomy gate inside `runPkgAction` is what makes that mandatory, not this
 * function — see `src/pkg/install.ts`.
 */
export async function runPkgWrite(
  id: string,
  action: PkgAction,
  opts: { readonly projectDir: string; readonly yes: boolean; readonly dryRun: boolean },
): Promise<{ readonly outcome: PkgRunOutcome; readonly text: string }> {
  const plan = planPkgAction(id, action);
  if (plan.kind === "refused") {
    return {
      outcome: { plan, status: "refused", steps: [], message: plan.reason },
      text: renderPkgPlan(plan),
    };
  }

  const preview = renderPkgPlan(plan);
  if (opts.dryRun) {
    const outcome = await runPkgAction(id, action, { projectDir: opts.projectDir, dryRun: true });
    return { outcome, text: `${preview}\n${outcome.message}\n` };
  }

  let consent = opts.yes;
  if (!consent && process.stdin.isTTY === true && process.stdout.isTTY === true) {
    process.stdout.write(preview);
    process.stdout.write("\n");
    consent = await confirm(`Run ${plan.steps.length} step(s) now?`);
    if (!consent) {
      return {
        outcome: { plan, status: "needs-consent", steps: [], message: "cancelled — nothing ran." },
        text: "cancelled — nothing ran.\n",
      };
    }
  }

  const outcome = await runPkgAction(id, action, {
    projectDir: opts.projectDir,
    consent,
    onOutput: (chunk) => process.stdout.write(chunk),
  });
  const head = opts.yes || outcome.status === "needs-consent" ? preview : "";
  return { outcome, text: `${head}${renderPkgOutcome(outcome)}` };
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
