/**
 * R8.14 — the write half of the managed-package registry.
 *
 * The three properties this surface exists to hold are asserted directly, and
 * none of them needs a real installer to run:
 *
 * 1. Golem ships no third-party bytes — every planned step spawns a tool the
 *    user already has, and planning is pure (nothing runs until consent).
 * 2. Consent is explicit at EVERY autonomy level, including the most permissive.
 * 3. `upgrade` cannot move a pin outside its playbook.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTONOMY_LEVELS, actionLogPath, writeAutonomyLevel } from "../../../src/autonomy/index.js";
import {
  type PkgInstallStep,
  type PkgSpawnResult,
  type PkgStepRunner,
  pkgManifest,
  planPkgAction,
  runPkgAction,
} from "../../../src/pkg/index.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-pkg-install-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A runner that records what it was asked to spawn and answers from a script. */
function scriptedRunner(results: readonly PkgSpawnResult[]): {
  readonly run: PkgStepRunner;
  readonly calls: { step: PkgInstallStep; resolved: string }[];
} {
  const calls: { step: PkgInstallStep; resolved: string }[] = [];
  let i = 0;
  const run: PkgStepRunner = async (step, resolved) => {
    calls.push({ step, resolved });
    return results[i++] ?? { code: 0, output: "" };
  };
  return { run, calls };
}

/** Everything is on PATH, at a predictable place. */
const resolveAll = (name: string): string => `/usr/bin/${name}`;

describe("planPkgAction — refusals are explanations, never error paths", () => {
  it("refuses an unknown id and points at the read surface", () => {
    const plan = planPkgAction("no-such-thing", "install");
    expect(plan.kind).toBe("refused");
    if (plan.kind !== "refused") return;
    expect(plan.reason).toContain("golem pkg list");
  });

  it("refuses every verb for bundled data — there is nothing to install", () => {
    for (const action of ["install", "remove", "upgrade"] as const) {
      const plan = planPkgAction("brevity-profiles", action);
      expect(plan.kind, action).toBe("refused");
      if (plan.kind !== "refused") continue;
      expect(plan.reason).toMatch(/bundled data/);
    }
  });

  it("refuses a row with no installer and quotes the documented human route", () => {
    const plan = planPkgAction("uv", "install");
    expect(plan.kind).toBe("refused");
    if (plan.kind !== "refused") return;
    const documented = pkgManifest("uv")?.install ?? "";
    expect(documented.length).toBeGreaterThan(0);
    expect(plan.reason).toContain(documented);
    expect(plan.reason).toContain("no automated install path");
  });
});

describe("planPkgAction — the pin guard (constraint 3)", () => {
  it("refuses `upgrade` on a playbook-pinned row and names the playbook", () => {
    for (const id of ["headroom", "headroom-memory"]) {
      const plan = planPkgAction(id, "upgrade");
      expect(plan.kind, id).toBe("refused");
      if (plan.kind !== "refused") continue;
      expect(plan.reason).toContain("T-C4");
      expect(plan.reason).toContain("pins.ts");
    }
  });

  it("upgrades a manifest-pinned row by re-running install at the SAME pin", () => {
    const install = planPkgAction("typescript-language-server", "install");
    const upgrade = planPkgAction("typescript-language-server", "upgrade");
    expect(install.kind).toBe("runnable");
    expect(upgrade.kind).toBe("runnable");
    if (install.kind !== "runnable" || upgrade.kind !== "runnable") return;

    expect(upgrade.reinstall).toBe(true);
    expect(upgrade.steps).toEqual(install.steps);
    // The whole point: an upgrade's argv is byte-identical to install's, so
    // there is no argument in it that could name a newer version.
    const pin = install.pin ?? "";
    expect(pin).not.toBe("");
    expect(upgrade.steps.flatMap((s) => s.args)).toContain(pin);
  });

  it("never plans a step whose version spec is a range or `latest`", () => {
    for (const id of ["caveman", "typescript-language-server"]) {
      for (const action of ["install", "remove", "upgrade"] as const) {
        const plan = planPkgAction(id, action);
        if (plan.kind !== "runnable") continue;
        for (const arg of plan.steps.flatMap((s) => s.args)) {
          expect(arg, `${id} ${action}: ${arg}`).not.toMatch(/@(latest|\^|~|\*)/);
        }
      }
    }
  });
});

describe("planPkgAction — plans spawn only tools the user already has", () => {
  it("plans caveman through Claude Code's own plugin installer", () => {
    const plan = planPkgAction("caveman", "install");
    expect(plan.kind).toBe("runnable");
    if (plan.kind !== "runnable") return;
    expect(plan.upstream).toBe("claude plugin");
    expect(plan.steps.map((s) => s.command)).toEqual(["claude", "claude"]);
    expect(plan.steps[1]?.args).toContain("caveman@caveman");
    // The row deliberately fails admission criterion 1; the caveat says so
    // before anyone consents.
    expect(plan.caveat).toContain("criterion 1");
  });

  it("gives every runnable step a reason and no shell metacharacters", () => {
    for (const id of ["caveman", "typescript-language-server"]) {
      for (const action of ["install", "remove", "upgrade"] as const) {
        const plan = planPkgAction(id, action);
        if (plan.kind !== "runnable") continue;
        for (const step of plan.steps) {
          expect(step.why.length, `${id} ${action}`).toBeGreaterThan(0);
          expect(step.command).not.toMatch(/[\s&|;><]/);
          for (const arg of step.args) expect(arg).not.toMatch(/[&|;><]/);
        }
      }
    }
  });
});

describe("runPkgAction — consent (constraint 2)", () => {
  it("requires consent at EVERY autonomy level, the most permissive included", async () => {
    for (const level of AUTONOMY_LEVELS) {
      await writeAutonomyLevel(dir, level);
      const { run, calls } = scriptedRunner([]);
      const outcome = await runPkgAction("caveman", "install", {
        projectDir: dir,
        runStep: run,
        resolveCommand: resolveAll,
      });
      expect(outcome.status, level).toBe("needs-consent");
      expect(calls, level).toHaveLength(0);
      expect(outcome.message).toMatch(/approve it explicitly/i);
    }
  });

  it("runs nothing on --dry-run, even with consent", async () => {
    const { run, calls } = scriptedRunner([]);
    const outcome = await runPkgAction("caveman", "install", {
      projectDir: dir,
      consent: true,
      dryRun: true,
      runStep: run,
      resolveCommand: resolveAll,
    });
    expect(outcome.status).toBe("dry-run");
    expect(calls).toHaveLength(0);
  });

  it("records the outward action in the autonomy log, both refused and allowed", async () => {
    await runPkgAction("caveman", "install", { projectDir: dir, resolveCommand: resolveAll });
    const { run } = scriptedRunner([]);
    await runPkgAction("caveman", "install", {
      projectDir: dir,
      consent: true,
      runStep: run,
      resolveCommand: resolveAll,
    });

    const lines = (await readFile(actionLogPath(dir), "utf8"))
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { tool: string; action: string; decision: string });
    expect(lines).toHaveLength(2);
    for (const entry of lines) {
      expect(entry.tool).toBe("golem pkg install caveman");
      expect(entry.action).toBe("outward");
    }
    expect(lines[0]?.decision).toBe("ask");
    expect(lines[1]?.decision).toBe("allow");
  });
});

describe("runPkgAction — execution", () => {
  it("runs each step in order once consent is given", async () => {
    const { run, calls } = scriptedRunner([
      { code: 0, output: "added" },
      { code: 0, output: "installed" },
    ]);
    const outcome = await runPkgAction("caveman", "install", {
      projectDir: dir,
      consent: true,
      runStep: run,
      resolveCommand: resolveAll,
    });
    expect(outcome.status).toBe("ok");
    expect(calls.map((c) => c.step.args[1])).toEqual(["marketplace", "install"]);
    expect(calls[0]?.resolved).toBe("/usr/bin/claude");
    expect(outcome.steps.map((s) => s.state)).toEqual(["ok", "ok"]);
  });

  it("treats a `tolerate` match as already-done rather than failure", async () => {
    const { run } = scriptedRunner([
      { code: 1, output: "error: marketplace already exists" },
      { code: 0, output: "installed" },
    ]);
    const outcome = await runPkgAction("caveman", "install", {
      projectDir: dir,
      consent: true,
      runStep: run,
      resolveCommand: resolveAll,
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.steps.map((s) => s.state)).toEqual(["tolerated", "ok"]);
  });

  it("stops at the first real failure and skips the rest", async () => {
    const { run, calls } = scriptedRunner([{ code: 2, output: "network unreachable" }]);
    const outcome = await runPkgAction("caveman", "install", {
      projectDir: dir,
      consent: true,
      runStep: run,
      resolveCommand: resolveAll,
    });
    expect(outcome.status).toBe("failed");
    expect(calls).toHaveLength(1);
    expect(outcome.steps.map((s) => s.state)).toEqual(["failed", "skipped"]);
    expect(outcome.message).toContain("network unreachable");
  });

  it("degrades to a no-op when the upstream installer is not on PATH", async () => {
    const { run, calls } = scriptedRunner([]);
    const outcome = await runPkgAction("caveman", "install", {
      projectDir: dir,
      consent: true,
      runStep: run,
      resolveCommand: () => null,
    });
    expect(outcome.status).toBe("failed");
    expect(calls).toHaveLength(0);
    expect(outcome.steps[0]?.state).toBe("not-found");
    expect(outcome.message).toContain("Nothing was changed");
  });

  it("passes the manifest pin through to the spawned argv, unmodified", async () => {
    const { run, calls } = scriptedRunner([{ code: 0, output: "" }]);
    await runPkgAction("typescript-language-server", "upgrade", {
      projectDir: dir,
      consent: true,
      runStep: run,
      resolveCommand: resolveAll,
    });
    const pin = pkgManifest("typescript-language-server")?.pin ?? "";
    expect(calls.flatMap((c) => c.step.args)).toContain(pin);
  });
});
