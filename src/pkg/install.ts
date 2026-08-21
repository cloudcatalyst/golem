/**
 * `src/pkg/install.ts` — the WRITE half of the managed-package registry
 * (R8.14, spec Decision 53(e)).
 *
 * `golem pkg list` shipped read-only on purpose. Installing is a different risk
 * class: it fetches and executes third-party code on the user's machine. So this
 * module holds the whole of that risk in three properties, each testable without
 * spawning anything:
 *
 * 1. **Golem distributes no third-party bytes.** Every step is a spawn of an
 *    installer the user already has (`claude`, `npm`) against the *upstream's*
 *    source. There is no vendoring, no mirror, and no auto-download on first use
 *    — `planPkgAction` is pure, and nothing runs until a human consents.
 * 2. **Consent is explicit, per-tool, and not implied by anything.** Installing
 *    is an `outward` action, and `decideGate` answers `ask` for `outward` at
 *    EVERY autonomy level (ADR-0002) — including `outcome`. There is no level,
 *    setting, or flag combination in which `golem pkg list` installs something.
 * 3. **`upgrade` cannot move a pin outside its playbook.** A `"manifest"`-pinned
 *    row upgrades by *re-running install at the recorded pin* (`"reinstall"`), so
 *    the most an upgrade can do is converge on the pin. A `"playbook"`-pinned row
 *    (Headroom / T-C4) refuses `upgrade` outright.
 *
 * Absence still degrades to a no-op: a refusal is an explanation plus the
 * documented human route, never a broken feature.
 */

import { spawn } from "node:child_process";
import {
  appendActionLog,
  decideGate,
  decisionLabel,
  readAutonomyLevel,
} from "../autonomy/index.js";
import { commandOnPath } from "./detect.js";
import { type PkgInstallStep, type PkgPinPolicy, pkgManifest } from "./manifest.js";

/** The three write verbs. `list`/`status` are the read half and are not here. */
export type PkgAction = "install" | "remove" | "upgrade";

export interface PkgRunnablePlan {
  readonly kind: "runnable";
  readonly id: string;
  readonly title: string;
  readonly action: PkgAction;
  /** Whose installer will be spawned — for the consent preview. */
  readonly upstream: string;
  readonly pin: string | null;
  readonly pinPolicy: PkgPinPolicy | null;
  readonly steps: readonly PkgInstallStep[];
  readonly caveat: string | null;
  /** True when `upgrade` was satisfied by re-running `install` at the pin. */
  readonly reinstall: boolean;
}

export interface PkgRefusedPlan {
  readonly kind: "refused";
  readonly id: string;
  readonly action: PkgAction;
  /** Why, in full sentences, ending with the route that does work. */
  readonly reason: string;
}

export type PkgPlan = PkgRunnablePlan | PkgRefusedPlan;

/**
 * Decide what `action` on `id` would do. **Pure**: no spawn, no filesystem, no
 * network — so the whole refusal matrix is unit-testable, and the CLI can show a
 * plan before asking for consent.
 */
export function planPkgAction(id: string, action: PkgAction): PkgPlan {
  const manifest = pkgManifest(id);
  if (manifest === undefined) {
    return {
      kind: "refused",
      id,
      action,
      reason: `unknown package "${id}". Run \`golem pkg list\` for the ids this registry knows.`,
    };
  }

  const refuse = (reason: string): PkgRefusedPlan => ({ kind: "refused", id, action, reason });

  if (manifest.detect.kind === "bundled") {
    return refuse(
      `${manifest.title} is Golem's own bundled data — there is nothing to install, remove or upgrade.`,
    );
  }

  // The pin guard, before anything else about this row is considered: the
  // Headroom pin is governed by the T-C4 upgrade playbook and CLAUDE.md forbids
  // moving it outside that. A CLI verb must not be a way around a playbook.
  if (action === "upgrade" && manifest.pinPolicy === "playbook") {
    return refuse(
      `${manifest.title} is pinned by an upgrade playbook, not by this command. Its pin ` +
        `(${manifest.pin ?? "see the manifest"}) moves only through the T-C4 playbook — a code ` +
        "change to `src/compression/pins.ts` with the qualification run, reviewed. `golem pkg " +
        "upgrade` will not do it.",
    );
  }

  const installer = manifest.installer;
  if (installer === undefined) {
    return refuse(
      `${manifest.title} has no automated ${action} path — Golem ships none of its bytes and has ` +
        `no pinned invocation of its installer. Documented route: ${manifest.install}`,
    );
  }

  const declared =
    action === "install"
      ? installer.install
      : action === "remove"
        ? installer.remove
        : installer.upgrade;
  const steps = resolveSteps(installer.install, declared);
  if (steps === null || steps.length === 0) {
    return refuse(
      `${manifest.title} has no ${action} contract upstream (${installer.upstream} offers none), ` +
        `so Golem will not improvise one. Documented route: ${manifest.install}`,
    );
  }

  return {
    kind: "runnable",
    id: manifest.id,
    title: manifest.title,
    action,
    upstream: installer.upstream,
    pin: manifest.pin ?? null,
    pinPolicy: manifest.pinPolicy ?? null,
    steps,
    caveat: installer.caveat ?? null,
    reinstall: action === "upgrade" && installer.upgrade === "reinstall",
  };
}

/** Expand a `"reinstall"` upgrade to the install steps; `null` when absent. */
function resolveSteps(
  install: readonly PkgInstallStep[],
  declared: readonly PkgInstallStep[] | "reinstall" | undefined,
): readonly PkgInstallStep[] | null {
  if (declared === undefined) return null;
  if (declared === "reinstall") return install;
  return declared;
}

export type PkgStepState =
  /** Exit 0. */
  | "ok"
  /** Non-zero, but the output matched a `tolerate` substring — already done. */
  | "tolerated"
  /** Non-zero and not tolerated. Stops the run. */
  | "failed"
  /** The installer itself is not on PATH; nothing was spawned. */
  | "not-found"
  /** An earlier step failed, so this one never ran. */
  | "skipped";

export interface PkgStepOutcome {
  readonly step: PkgInstallStep;
  /** Absolute path the command resolved to, or `null` when it was not found. */
  readonly resolved: string | null;
  readonly state: PkgStepState;
  readonly code: number | null;
  readonly output: string;
}

export type PkgRunStatus =
  | "refused"
  /** The plan is runnable and a human has not approved it yet. Nothing ran. */
  | "needs-consent"
  /** `--dry-run`: the plan is printed and nothing ran. */
  | "dry-run"
  | "ok"
  | "failed";

export interface PkgRunOutcome {
  readonly plan: PkgPlan;
  readonly status: PkgRunStatus;
  readonly steps: readonly PkgStepOutcome[];
  readonly message: string;
}

export interface PkgSpawnResult {
  readonly code: number | null;
  readonly output: string;
}

/** Injectable so tests exercise the whole flow without spawning an installer. */
export type PkgStepRunner = (step: PkgInstallStep, resolved: string) => Promise<PkgSpawnResult>;

export interface PkgRunOptions {
  readonly projectDir: string;
  /** A human said yes to THIS action on THIS package. Never defaulted to true. */
  readonly consent?: boolean;
  readonly dryRun?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly resolveCommand?: (
    name: string,
    env: Readonly<Record<string, string | undefined>>,
  ) => string | null;
  readonly runStep?: PkgStepRunner;
  readonly timeoutMs?: number;
  /** Live output sink — an install can take minutes. */
  readonly onOutput?: (chunk: string) => void;
  /** Escape hatch for tests; production writes a real audit line. */
  readonly audit?: boolean;
}

/** Installers and plugin fetches are slow; a probe-sized timeout would be wrong. */
export const DEFAULT_PKG_STEP_TIMEOUT_MS = 10 * 60_000;

/**
 * Plan, gate, then (only with consent) run.
 *
 * The autonomy gate is consulted rather than assumed: `decideGate(level,
 * "outward")` is `ask` at every level, and that answer — not a local `if` — is
 * what makes consent mandatory here. Its reason is quoted back to the user.
 */
export async function runPkgAction(
  id: string,
  action: PkgAction,
  opts: PkgRunOptions,
): Promise<PkgRunOutcome> {
  const plan = planPkgAction(id, action);
  if (plan.kind === "refused") {
    return { plan, status: "refused", steps: [], message: plan.reason };
  }

  if (opts.dryRun === true) {
    return {
      plan,
      status: "dry-run",
      steps: [],
      message: `Nothing ran (--dry-run). ${plan.steps.length} step(s) planned.`,
    };
  }

  // ADR-0002: installing leaves the machine and executes third-party code, so it
  // classifies `outward`, and no autonomy level auto-approves outward actions.
  const level = await readAutonomyLevel(opts.projectDir);
  const decision = decideGate(level, "outward");
  if (decision.emit === "ask" && opts.consent !== true) {
    if (opts.audit !== false) {
      await appendActionLog(opts.projectDir, {
        ts: new Date().toISOString(),
        tool: `golem pkg ${action} ${plan.id}`,
        action: "outward",
        level,
        decision: decisionLabel(decision.emit),
      });
    }
    return {
      plan,
      status: "needs-consent",
      steps: [],
      message:
        `${plan.title}: ${plan.steps.length} step(s) would run ${plan.upstream}'s own installer. ` +
        `${decision.reason ?? ""} Approve it explicitly (\`--yes\`, or answer the prompt).`.trim(),
    };
  }

  if (opts.audit !== false) {
    await appendActionLog(opts.projectDir, {
      ts: new Date().toISOString(),
      tool: `golem pkg ${action} ${plan.id}`,
      action: "outward",
      level,
      decision: "allow",
    });
  }

  const env = opts.env ?? process.env;
  const resolve = opts.resolveCommand ?? commandOnPath;
  const run = opts.runStep ?? createPkgStepRunner(opts);

  const outcomes: PkgStepOutcome[] = [];
  let halted = false;
  for (const step of plan.steps) {
    if (halted) {
      outcomes.push({ step, resolved: null, state: "skipped", code: null, output: "" });
      continue;
    }
    const resolved = resolve(step.command, env);
    if (resolved === null) {
      outcomes.push({ step, resolved: null, state: "not-found", code: null, output: "" });
      halted = true;
      continue;
    }
    const result = await run(step, resolved);
    const state: PkgStepState =
      result.code === 0 ? "ok" : tolerated(step, result.output) ? "tolerated" : "failed";
    outcomes.push({ step, resolved, state, code: result.code, output: result.output });
    if (state === "failed") halted = true;
  }

  const bad = outcomes.find((o) => o.state === "failed" || o.state === "not-found");
  if (bad !== undefined) {
    const why =
      bad.state === "not-found"
        ? `\`${bad.step.command}\` is not on PATH, so ${plan.upstream}'s installer could not be ` +
          `invoked. Nothing was changed. Install ${bad.step.command} first, or use the documented ` +
          "route from `golem pkg list --verbose`."
        : `${plan.upstream} exited ${bad.code ?? "abnormally"}: ${firstLine(bad.output)}`;
    return { plan, status: "failed", steps: outcomes, message: `${plan.action} failed — ${why}` };
  }

  return {
    plan,
    status: "ok",
    steps: outcomes,
    message: `${plan.title}: ${plan.action} complete via ${plan.upstream}.`,
  };
}

function tolerated(step: PkgInstallStep, output: string): boolean {
  const lower = output.toLowerCase();
  return (step.tolerate ?? []).some((needle) => lower.includes(needle.toLowerCase()));
}

function firstLine(output: string): string {
  const line = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? "(no output)";
}

/**
 * The real runner: argument array, `shell: false`, output buffered *and*
 * streamed.
 *
 * On Windows an npm-installed CLI is a `.cmd` shim, which Node refuses to spawn
 * directly since the argument-injection fix — so it goes through `cmd.exe /c`,
 * still as an argument ARRAY and still with no shell string anywhere (the same
 * treatment `src/inference/claude-cli.ts` already uses).
 */
export function createPkgStepRunner(opts: PkgRunOptions = { projectDir: "." }): PkgStepRunner {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PKG_STEP_TIMEOUT_MS;
  return (step, resolved) =>
    new Promise<PkgSpawnResult>((settle) => {
      const lower = resolved.toLowerCase();
      const viaCmd =
        process.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"));
      const file = viaCmd ? (process.env.ComSpec ?? "cmd.exe") : resolved;
      const argv = viaCmd ? ["/d", "/s", "/c", resolved, ...step.args] : [...step.args];

      let output = "";
      let settled = false;
      const done = (result: PkgSpawnResult): void => {
        if (settled) return;
        settled = true;
        settle(result);
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(file, argv, {
          shell: false,
          // An installer may pop a UAC/consent window; do not hide it.
          windowsHide: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        done({ code: null, output: err instanceof Error ? err.message : String(err) });
        return;
      }

      const timer = setTimeout(() => {
        child.kill();
        done({ code: null, output: `${output}\ntimed out after ${timeoutMs}ms` });
      }, timeoutMs);
      timer.unref?.();

      const absorb = (chunk: Buffer | string): void => {
        const text = String(chunk);
        output += text;
        opts.onOutput?.(text);
      };
      child.stdout?.on("data", absorb);
      child.stderr?.on("data", absorb);
      child.on("error", (err: Error) => {
        clearTimeout(timer);
        done({ code: null, output: `${output}${err.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ code, output });
      });
    });
}
