/**
 * R5.4 — the PreToolUse gate hook: emits allow/ask correctly, defers safely,
 * and NEVER auto-allows on error (ADR-0002 default-deny proofs).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AutonomyLevel } from "../../../src/autonomy/index.js";
import { readActionLog } from "../../../src/autonomy/index.js";
import { runPreToolUseHook } from "../../../src/hooks/pre-tool-use.js";
import type { LimitPrediction } from "../../../src/proxy/limit-prediction.js";

/** Minimal HookIo capturing stdout/stderr, feeding a fixed stdin string. */
function io(input: string) {
  const out = {
    text: "",
    write(s: string) {
      this.text += s;
    },
  };
  const err = {
    text: "",
    write(s: string) {
      this.text += s;
    },
  };
  return {
    stdin: (async function* () {
      yield input;
    })(),
    stdout: out,
    stderr: err,
  };
}

function payload(toolName: string, toolInput: unknown, cwd: string): string {
  return JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd, session_id: "s1" });
}

describe("runPreToolUseHook", () => {
  let dir: string;
  const level = (l: AutonomyLevel) => ({ readLevel: () => Promise.resolve(l) });
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-pre-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("auto-allows a read at outcome level", async () => {
    const h = io(payload("Read", { file_path: "x" }, dir));
    await runPreToolUseHook(h, { projectDir: dir, ...level("outcome") });
    const out = JSON.parse(h.stdout.text);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("stays SILENT for a write at assisted level (defers to native prompt)", async () => {
    const h = io(payload("Write", { file_path: "x" }, dir));
    await runPreToolUseHook(h, { projectDir: dir, ...level("assisted") });
    expect(h.stdout.text).toBe("");
  });

  it("forces ask for an outward Bash at any level", async () => {
    const h = io(payload("Bash", { command: "git push origin main" }, dir));
    await runPreToolUseHook(h, { projectDir: dir, ...level("outcome") });
    const out = JSON.parse(h.stdout.text);
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("NEVER emits output (→ native prompt) on unparseable stdin", async () => {
    const h = io("{ not json");
    const code = await runPreToolUseHook(h, { projectDir: dir, ...level("outcome") });
    expect(h.stdout.text).toBe("");
    expect(code).toBe(0);
  });

  it("NEVER auto-allows when the level read throws (fail-closed)", async () => {
    const h = io(payload("Read", {}, dir));
    const code = await runPreToolUseHook(h, {
      projectDir: dir,
      readLevel: () => Promise.reject(new Error("disk gone")),
    });
    expect(h.stdout.text).toBe(""); // no allow — defers to human
    expect(code).toBe(0);
  });

  it("writes an auditable action-log entry", async () => {
    const h = io(payload("Read", {}, dir));
    await runPreToolUseHook(h, { projectDir: dir, ...level("outcome") });
    const log = await readActionLog(dir);
    expect(log).toHaveLength(1);
    expect(log[0]?.tool).toBe("Read");
    expect(log[0]?.decision).toBe("allow");
  });

  // --- Document-and-hold nudge (P2b) ---
  const NOW_MS = Date.parse("2026-07-18T00:00:00.000Z");
  const nearLimit: LimitPrediction = {
    observedAtIso: "2026-07-18T00:00:00.000Z",
    fiveHour: { utilization: 0.95, resetAtIso: "2026-07-18T02:00:00.000Z" },
  };
  // Advisory by default in these tests (enforce is a separate, explicitly-set
  // case below). Real default is now enforce=true (Decision 45); the enforce
  // test overrides isSnoozeEnforced back to true.
  const withPrediction = (p: LimitPrediction | null) => ({
    readPrediction: () => Promise.resolve(p),
    now: () => NOW_MS,
    isSnoozeEnforced: () => Promise.resolve(false),
  });

  it("denies a non-snooze tool near-limit, instructing document-and-hold", async () => {
    const h = io(payload("Read", {}, dir));
    await runPreToolUseHook(h, {
      projectDir: dir,
      ...level("manual"),
      ...withPrediction(nearLimit),
    });
    const out = JSON.parse(h.stdout.text);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("mcp__golem__snooze");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("golem task add");
  });

  it("is one-shot: the second near-limit call in the same window is not denied", async () => {
    const first = io(payload("Read", {}, dir));
    await runPreToolUseHook(first, {
      projectDir: dir,
      ...level("manual"),
      ...withPrediction(nearLimit),
    });
    expect(JSON.parse(first.stdout.text).hookSpecificOutput.permissionDecision).toBe("deny");

    const second = io(payload("Read", {}, dir));
    await runPreToolUseHook(second, {
      projectDir: dir,
      ...level("manual"),
      ...withPrediction(nearLimit),
    });
    expect(second.stdout.text).toBe(""); // one-shot consumed; Read at manual → silent
  });

  it("exempts the snooze tool itself from the nudge", async () => {
    const h = io(payload("mcp__golem__snooze", { until: "2026-07-18T02:00:00.000Z" }, dir));
    await runPreToolUseHook(h, {
      projectDir: dir,
      ...level("manual"),
      ...withPrediction(nearLimit),
    });
    expect(h.stdout.text).toBe(""); // not denied — never park the parking call
  });

  it("does not nudge below the utilization threshold", async () => {
    const low: LimitPrediction = {
      observedAtIso: "2026-07-18T00:00:00.000Z",
      fiveHour: { utilization: 0.5, resetAtIso: "2026-07-18T02:00:00.000Z" },
    };
    const h = io(payload("Read", {}, dir));
    await runPreToolUseHook(h, { projectDir: dir, ...level("manual"), ...withPrediction(low) });
    expect(h.stdout.text).toBe("");
  });

  it("enforce mode: denies EVERY near-limit call (not one-shot) with the enforce reason", async () => {
    const enforced = { isSnoozeEnforced: () => Promise.resolve(true) };
    const first = io(payload("Read", {}, dir));
    await runPreToolUseHook(first, {
      projectDir: dir,
      ...level("manual"),
      ...withPrediction(nearLimit),
      ...enforced,
    });
    const out1 = JSON.parse(first.stdout.text);
    expect(out1.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out1.hookSpecificOutput.permissionDecisionReason).toContain("ENFORCEMENT");

    // Second call in the SAME window is ALSO denied (persistent, unlike advisory).
    const second = io(payload("Read", {}, dir));
    await runPreToolUseHook(second, {
      projectDir: dir,
      ...level("manual"),
      ...withPrediction(nearLimit),
      ...enforced,
    });
    expect(JSON.parse(second.stdout.text).hookSpecificOutput.permissionDecision).toBe("deny");

    // The snooze tool itself is still exempt even under enforcement.
    const snooze = io(payload("mcp__golem__snooze", { until: "2026-07-18T02:00:00.000Z" }, dir));
    await runPreToolUseHook(snooze, {
      projectDir: dir,
      ...level("manual"),
      ...withPrediction(nearLimit),
      ...enforced,
    });
    expect(snooze.stdout.text).toBe("");
  });

  it("warns once when the rate-limit feed is stale (auto-park is blind)", async () => {
    // Observed ~24h before NOW → well past the staleness window (the feed went
    // cold, e.g. an account switch), even though the recorded reset is future.
    const staleP: LimitPrediction = {
      observedAtIso: "2026-07-17T00:00:00.000Z",
      fiveHour: { utilization: 0.17, resetAtIso: "2026-07-18T02:00:00.000Z" },
    };
    const first = io(payload("Read", {}, dir));
    await runPreToolUseHook(first, {
      projectDir: dir,
      ...level("manual"),
      ...withPrediction(staleP),
    });
    const out = JSON.parse(first.stdout.text);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("BLIND");

    // One-shot: the second identical call is silent (already warned this reading).
    const second = io(payload("Read", {}, dir));
    await runPreToolUseHook(second, {
      projectDir: dir,
      ...level("manual"),
      ...withPrediction(staleP),
    });
    expect(second.stdout.text).toBe("");
  });

  // --- Coder-first enforcement (Decision 39) ---
  const bigCode = { file_path: "src/x.ts", content: "x".repeat(400) };
  const guided = (on: boolean) => ({ isGuidanceEnabled: () => Promise.resolve(on) });

  it("denies the first non-trivial code write when local-coder guidance is active", async () => {
    const h = io(payload("Write", bigCode, dir));
    await runPreToolUseHook(h, { projectDir: dir, ...level("manual"), ...guided(true) });
    const out = JSON.parse(h.stdout.text);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("`coder`");
  });

  it("is one-shot: the second code write in the same session is not denied by coder-first", async () => {
    const first = io(payload("Write", bigCode, dir));
    await runPreToolUseHook(first, { projectDir: dir, ...level("manual"), ...guided(true) });
    expect(JSON.parse(first.stdout.text).hookSpecificOutput.permissionDecision).toBe("deny");

    const second = io(payload("Write", bigCode, dir));
    await runPreToolUseHook(second, { projectDir: dir, ...level("manual"), ...guided(true) });
    // one-shot consumed → falls through to the autonomy gate; a write at manual
    // level stays silent (defers to native prompt), so no coder-first deny.
    expect(second.stdout.text).toBe("");
  });

  it("does NOT enforce coder-first when the guidance is disabled", async () => {
    const h = io(payload("Write", bigCode, dir));
    await runPreToolUseHook(h, { projectDir: dir, ...level("manual"), ...guided(false) });
    expect(h.stdout.text).toBe(""); // guidance off → no enforcement
  });

  it("does not enforce coder-first on a trivial (small) code write", async () => {
    const h = io(payload("Write", { file_path: "src/x.ts", content: "x" }, dir));
    await runPreToolUseHook(h, { projectDir: dir, ...level("manual"), ...guided(true) });
    expect(h.stdout.text).toBe("");
  });

  it("does not enforce coder-first on a non-code file", async () => {
    const h = io(payload("Write", { file_path: "docs/x.md", content: "x".repeat(400) }, dir));
    await runPreToolUseHook(h, { projectDir: dir, ...level("manual"), ...guided(true) });
    expect(h.stdout.text).toBe("");
  });

  // --- Autonomy gate enable/disable (Decision 40) ---
  const gate = (on: boolean) => ({ readGateEnabled: () => Promise.resolve(on) });

  it("forces ask for an outward Bash when the gate is ENABLED (default)", async () => {
    const h = io(payload("Bash", { command: "git push origin main" }, dir));
    await runPreToolUseHook(h, { projectDir: dir, ...level("manual"), ...gate(true) });
    expect(JSON.parse(h.stdout.text).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("does NOT ask for an outward Bash when the gate is DISABLED (allow-list governs)", async () => {
    const h = io(payload("Bash", { command: "git push origin main" }, dir));
    await runPreToolUseHook(h, { projectDir: dir, ...level("manual"), ...gate(false) });
    expect(h.stdout.text).toBe(""); // gate off → emit nothing → native/allow-list governs
  });

  it("disabling the gate does NOT disable the snooze nudge", async () => {
    const h = io(payload("Read", {}, dir));
    await runPreToolUseHook(h, {
      projectDir: dir,
      ...level("manual"),
      ...gate(false),
      ...withPrediction(nearLimit),
    });
    // snooze runs before the gate → still denies near-limit even with the gate off.
    expect(JSON.parse(h.stdout.text).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
