/**
 * R5.4 — the PreToolUse gate hook: emits allow/ask correctly, defers safely,
 * and NEVER auto-allows on error (ADR-0002 default-deny proofs).
 */

import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import type { AutonomyLevel } from "../../../src/autonomy/index.js";
import { readActionLog } from "../../../src/autonomy/index.js";
import { runPreToolUseHook } from "../../../src/hooks/pre-tool-use.js";
import { pendingToolPath, readPendingToolCall } from "../../../src/hooks/session-state.js";
import type { LimitPrediction } from "../../../src/proxy/limit-prediction.js";
import { useTempDirs } from "../../helpers/tmp.js";

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

const newTempDir = useTempDirs("golem-pre-");

describe("runPreToolUseHook", () => {
  let dir: string;
  const level = (l: AutonomyLevel) => ({ readLevel: () => Promise.resolve(l) });
  beforeEach(async () => {
    dir = await newTempDir();
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
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("note=");
  });

  // Task `snooze-taskadd`, reproduced: the documenting step the guidance rule asked
  // for FIRST was itself a `Bash` call, so enforcement denied it — the procedure's
  // step 1 was blocked by its own step 2. It must stay denied (no command-matched
  // exemption); the note now rides on the snooze call instead.
  it("enforce mode: still denies `golem task add` — and says to use snooze's note", async () => {
    const h = io(payload("Bash", { command: 'golem task add "where I am + next steps"' }, dir));
    await runPreToolUseHook(h, {
      projectDir: dir,
      ...level("manual"),
      ...withPrediction(nearLimit),
      isSnoozeEnforced: () => Promise.resolve(true),
    });
    const out = JSON.parse(h.stdout.text);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("note=");
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

  /**
   * R9.23 — the deadlock. Hit live twice (2026-08-10, 2026-08-13): enforcement
   * denied everything except `mcp__golem__snooze`, which is a DEFERRED tool — so
   * calling it needs `ToolSearch` to load its schema first, and that was denied.
   * The only permitted tool could not be called, so the agent could not park and
   * the note meant to survive the session was never written.
   *
   * `expand` is on the list for the same reason one level along: it is the way back
   * from a CCR reference, and it too is deferred.
   */
  it("enforce mode: permits the tools needed to REACH the park (R9.23)", async () => {
    const enforced = { isSnoozeEnforced: () => Promise.resolve(true) };
    for (const tool of ["ToolSearch", "mcp__golem__expand"]) {
      const h = io(payload(tool, { query: "select:mcp__golem__snooze" }, dir));
      await runPreToolUseHook(h, {
        projectDir: dir,
        ...level("manual"),
        ...withPrediction(nearLimit),
        ...enforced,
      });
      expect(h.stdout.text, `${tool} must not be denied — it is how snooze is reached`).toBe("");
    }
  });

  it("enforce mode: the exemption is a short list, not a hole", async () => {
    // The park still has to bite. A neighbouring MCP tool is denied like any other.
    const enforced = { isSnoozeEnforced: () => Promise.resolve(true) };
    for (const tool of ["mcp__golem__search", "mcp__golem__coder", "Read"]) {
      const h = io(payload(tool, {}, dir));
      await runPreToolUseHook(h, {
        projectDir: dir,
        ...level("manual"),
        ...withPrediction(nearLimit),
        ...enforced,
      });
      expect(JSON.parse(h.stdout.text).hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });

  it("enforce mode: the deny reason names the parameters AND the escape hatch", async () => {
    // Both halves matter. The 2026-08-13 session escaped the deadlock only because
    // it knew `until`/`note` from a project rule file — which is a workaround that
    // works solely for projects shipping that rule. The reason text has to carry
    // them itself, and say a schema can still be loaded.
    const h = io(payload("Read", {}, dir));
    await runPreToolUseHook(h, {
      projectDir: dir,
      ...level("manual"),
      ...withPrediction(nearLimit),
      isSnoozeEnforced: () => Promise.resolve(true),
    });
    const reason = JSON.parse(h.stdout.text).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("until=");
    expect(reason).toContain("note=");
    expect(reason).toContain("ToolSearch");
    expect(reason).toContain("mcp__golem__expand");
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

  /**
   * R12.2 — the pending-tool record.
   *
   * Claude Code's Notification payload names no tool, so the only place the tool
   * and its argument can be captured is here, before the prompt appears. Written
   * only on the paths that actually end in a human being asked.
   */
  describe("pending-tool record (R12.2)", () => {
    it("records a call the gate DEFERS (silence → native prompt)", async () => {
      const h = io(payload("Write", { file_path: "/repo/x.ts" }, dir));
      await runPreToolUseHook(h, { projectDir: dir, ...level("assisted") });
      expect(h.stdout.text).toBe("");
      expect((await readPendingToolCall(dir))?.name).toBe("Write");
    });

    it("records a FORCED ask too — that is the prompt that matters most", async () => {
      // `ask` is not a refusal: Claude Code shows the prompt, so the human is
      // being asked about exactly this command. A destructive step forced to
      // `ask` is the highest-stakes question the model can carry, and skipping
      // it here would leave the remote surface saying "waiting" with no subject.
      const h = io(payload("Bash", { command: "rm -rf ./build" }, dir));
      await runPreToolUseHook(h, { projectDir: dir, ...level("assisted") });
      expect(JSON.parse(h.stdout.text).hookSpecificOutput.permissionDecision).toBe("ask");
      const pending = await readPendingToolCall(dir);
      expect(pending?.name).toBe("Bash");
      expect(pending?.argument).toBe("rm -rf ./build");
      expect(pending?.actionClass).toBe("destructive");
      expect(pending?.sessionId).toBe("s1");
    });

    it("records it when the GATE IS OFF too — every call can prompt then", async () => {
      const h = io(payload("Read", { file_path: "/repo/x.ts" }, dir));
      await runPreToolUseHook(h, { projectDir: dir, ...level("manual"), ...gate(false) });
      expect((await readPendingToolCall(dir))?.argument).toBe("/repo/x.ts");
    });

    it("does NOT record an auto-ALLOWED call — nobody is asked about it", async () => {
      // The newest record must describe the call under judgement. Recording
      // decisions the gate made alone would overwrite it with noise.
      const h = io(payload("Read", { file_path: "/repo/x.ts" }, dir));
      await runPreToolUseHook(h, { projectDir: dir, ...level("outcome") });
      expect(JSON.parse(h.stdout.text).hookSpecificOutput.permissionDecision).toBe("allow");
      expect(await readPendingToolCall(dir)).toBeNull();
    });

    it("does NOT record a snooze-park DENY — that is a refusal, not a question", async () => {
      const h = io(payload("Read", {}, dir));
      await runPreToolUseHook(h, {
        projectDir: dir,
        ...level("manual"),
        ...withPrediction(nearLimit),
      });
      expect(JSON.parse(h.stdout.text).hookSpecificOutput.permissionDecision).toBe("deny");
      expect(await readPendingToolCall(dir)).toBeNull();
    });

    it("redacts the argument on the way to disk (ADR-0006 §1)", async () => {
      const secret = `sk-ant-${"A1b2C3d4E5f6G7h8".repeat(2)}`;
      const h = io(payload("Bash", { command: `curl -H "Authorization: Bearer ${secret}"` }, dir));
      await runPreToolUseHook(h, { projectDir: dir, ...level("assisted") });
      const raw = await readFile(pendingToolPath(dir), "utf8");
      expect(raw).not.toContain(secret);
      expect(raw).toContain("[REDACTED:anthropic-key:1]");
    });
  });

  /**
   * Task `subagent-park` — the SPAWN gate.
   *
   * The park above is a tool-call gate and a subagent never reaches it: the child
   * hits the limit on a model request and dies before it can propose a call to be
   * denied, losing anything uncommitted. The parent's spawn IS a tool call, so
   * that is where the refusal goes. Driven here with an injected utilization —
   * the same shape the park's tests use — because the gate has to be demonstrated,
   * not argued from the code.
   */
  describe("spawn gate (subagent-park)", () => {
    const spawnSettings = (enabled: boolean, costFraction = 0.18) => ({
      readSpawnGateSettings: () => Promise.resolve({ enabled, costFraction }),
    });
    /**
     * `Agent`/`Task` are UNCLASSIFIED actions, so once the spawn gate lets one
     * through the autonomy gate asks the human (ADR-0002 fail-closed) — that is
     * the unchanged behaviour these tests are protecting, not silence.
     */
    const decisionOf = (text: string): string =>
      text === "" ? "" : JSON.parse(text).hookSpecificOutput.permissionDecision;
    const atUtilization = (u: number, observedAtIso = "2026-07-18T00:00:00.000Z") => ({
      readPrediction: () =>
        Promise.resolve({
          observedAtIso,
          fiveHour: { utilization: u, resetAtIso: "2026-07-18T02:00:00.000Z" },
        } satisfies LimitPrediction),
      now: () => NOW_MS,
      isSnoozeEnforced: () => Promise.resolve(false),
    });

    it("refuses a spawn with no headroom, and says what it measured", async () => {
      const h = io(payload("Agent", { prompt: "go do R12.2" }, dir));
      await runPreToolUseHook(h, {
        projectDir: dir,
        ...level("outcome"),
        ...atUtilization(0.86),
        ...spawnSettings(true),
      });
      const out = JSON.parse(h.stdout.text);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      const reason = out.hookSpecificOutput.permissionDecisionReason;
      expect(reason).toContain("86%");
      expect(reason).toContain("18%");
      expect(reason).toContain("104%");
    });

    it("gates the spawn tool under BOTH its names", async () => {
      for (const tool of ["Task", "Agent"]) {
        const h = io(payload(tool, { prompt: "go" }, dir));
        await runPreToolUseHook(h, {
          projectDir: dir,
          ...level("outcome"),
          ...atUtilization(0.86),
          ...spawnSettings(true),
        });
        expect(JSON.parse(h.stdout.text).hookSpecificOutput.permissionDecision, tool).toBe("deny");
      }
    });

    it("leaves the path with headroom exactly as it is today", async () => {
      const h = io(payload("Agent", { prompt: "go" }, dir));
      await runPreToolUseHook(h, {
        projectDir: dir,
        ...level("outcome"),
        ...atUtilization(0.4),
        ...spawnSettings(true),
      });
      // Not refused: falls through to the autonomy gate, which asks the human for
      // an unclassified action exactly as it did before this gate existed.
      expect(decisionOf(h.stdout.text)).toBe("ask");
    });

    it("does not touch non-spawn tools", async () => {
      const h = io(payload("Read", { file_path: "x" }, dir));
      await runPreToolUseHook(h, {
        projectDir: dir,
        ...level("outcome"),
        ...atUtilization(0.86),
        ...spawnSettings(true),
      });
      // 86% refuses a spawn outright; an ordinary read is untouched by it. (Kept
      // under the 90% park threshold so the park is not what is being observed.)
      expect(JSON.parse(h.stdout.text).hookSpecificOutput.permissionDecision).toBe("allow");
    });

    /**
     * The fan-out that lost two agents: three spawns in one turn, all reading the
     * same pre-batch utilization. The first is affordable; by the third it is not.
     */
    it("charges for siblings dispatched since the reading", async () => {
      const opts = {
        projectDir: dir,
        ...level("outcome"),
        ...atUtilization(0.5),
        ...spawnSettings(true, 0.2),
        nowIso: "2026-07-18T00:00:10.000Z",
      };
      const first = io(payload("Agent", { prompt: "a" }, dir));
      await runPreToolUseHook(first, opts);
      expect(decisionOf(first.stdout.text)).toBe("ask");
      const second = io(payload("Agent", { prompt: "b" }, dir));
      await runPreToolUseHook(second, opts);
      expect(decisionOf(second.stdout.text)).toBe("ask");
      const third = io(payload("Agent", { prompt: "c" }, dir));
      await runPreToolUseHook(third, opts);
      // 0.5 + 0.2 x 3 = 1.1
      const out = JSON.parse(third.stdout.text);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
        "2 spawns dispatched since that reading",
      );
    });

    it("never silently allows a spawn it cannot measure — warns once, then proceeds", async () => {
      const blind = {
        projectDir: dir,
        ...level("outcome"),
        ...spawnSettings(true),
        readPrediction: () => Promise.resolve(null),
        now: () => NOW_MS,
        isSnoozeEnforced: () => Promise.resolve(false),
      };
      const first = io(payload("Agent", { prompt: "a" }, dir));
      await runPreToolUseHook(first, blind);
      const out = JSON.parse(first.stdout.text);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain("BLIND");
      // One-shot: re-issuing proceeds, so a cold feed informs but never deadlocks.
      const second = io(payload("Agent", { prompt: "a" }, dir));
      await runPreToolUseHook(second, blind);
      expect(decisionOf(second.stdout.text)).toBe("ask");
    });

    it("is skipped entirely when the gate is turned off", async () => {
      // 0.86 refuses with the gate on (see above) and is under the park threshold,
      // so the only thing that could deny here is the spawn gate itself.
      const h = io(payload("Agent", { prompt: "go" }, dir));
      await runPreToolUseHook(h, {
        projectDir: dir,
        ...level("outcome"),
        ...atUtilization(0.86),
        ...spawnSettings(false),
      });
      expect(decisionOf(h.stdout.text)).toBe("ask");
    });

    /**
     * At/above the park threshold the spawn is denied by the PARK, not by this
     * gate — and being told to park is the more useful instruction, so the
     * ordering is deliberate.
     */
    it("yields to the park above the park threshold", async () => {
      const h = io(payload("Agent", { prompt: "go" }, dir));
      await runPreToolUseHook(h, {
        projectDir: dir,
        ...level("outcome"),
        ...atUtilization(0.95),
        ...spawnSettings(true),
        isSnoozeEnforced: () => Promise.resolve(true),
      });
      const reason = JSON.parse(h.stdout.text).hookSpecificOutput.permissionDecisionReason;
      expect(reason).toContain("ENFORCEMENT");
      expect(reason).not.toContain("Not enough headroom");
    });
  });
});
