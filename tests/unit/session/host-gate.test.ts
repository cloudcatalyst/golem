/**
 * R13.3 — the host's decision, and the things that make it different from the
 * guest hook's.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { ActionClass, AutonomyLevel } from "../../../src/autonomy/index.js";
import { decideGate } from "../../../src/autonomy/index.js";
import { runHostGateHook } from "../../../src/hooks/host-gate.js";
import {
  decideHostGate,
  hostSettings,
  NOBODY_ATTACHED,
  readHostLog,
  resolveHostGate,
} from "../../../src/session/index.js";
import { useTempDirs } from "../../helpers/tmp.js";

const LEVELS: AutonomyLevel[] = ["manual", "assisted", "outcome"];
const ACTIONS: ActionClass[] = ["read", "write", "destructive", "outward", "unknown"];

describe("decideHostGate", () => {
  it("DENIES the never-auto set at every level", () => {
    for (const level of LEVELS) {
      expect(decideHostGate(level, "destructive").decision, level).toBe("deny");
      expect(decideHostGate(level, "outward").decision, level).toBe("deny");
    }
  });

  it("never denies anything OUTSIDE the never-auto set", () => {
    for (const level of LEVELS) {
      for (const action of ["read", "write", "unknown"] as ActionClass[]) {
        expect(decideHostGate(level, action).decision, `${level}/${action}`).not.toBe("deny");
      }
    }
  });

  // The host must not be a MORE permissive place than a guest session. Derived
  // rather than restated, so the two matrices cannot drift.
  it("agrees with decideGate everywhere except the never-auto set", () => {
    for (const level of LEVELS) {
      for (const action of ACTIONS) {
        const guest = decideGate(level, action);
        const host = decideHostGate(level, action);
        if (action === "destructive" || action === "outward") {
          expect(guest.emit).toBe("ask");
          expect(host.decision).toBe("deny");
          continue;
        }
        // `null` (defer) and `allow` both mean "Golem adds no restriction".
        expect(host.decision, `${level}/${action}`).toBe(guest.emit === "ask" ? "ask" : "allow");
      }
    }
  });

  // The bug this pins: mapping `manual`'s defer to `ask` denied every read,
  // because nobody is ever attached in R13.3 — a hosted session that could not
  // read a file at the DEFAULT autonomy level.
  it("lets a read through at the default `manual` level", () => {
    const decision = resolveHostGate(decideHostGate("manual", "read"));
    expect(decision.decision).toBe("allow");
  });

  it("carries a reason on every decision", () => {
    for (const level of LEVELS) {
      for (const action of ACTIONS) {
        expect(decideHostGate(level, action).reason.length).toBeGreaterThan(20);
      }
    }
  });
});

describe("resolveHostGate — an unanswered ask is a denial, not a wait", () => {
  it("turns `ask` into `deny` when nobody is attached", () => {
    const asked = decideHostGate("outcome", "unknown");
    expect(asked.decision).toBe("ask");
    const resolved = resolveHostGate(asked, NOBODY_ATTACHED);
    expect(resolved.decision).toBe("deny");
    expect(resolved.reason).toContain("Nobody is attached");
  });

  it("leaves `ask` alone when somebody IS attached (the R13.5/R13.6 seam)", () => {
    const asked = decideHostGate("outcome", "unknown");
    expect(resolveHostGate(asked, { attached: true, who: "device-1" }).decision).toBe("ask");
  });

  it("never turns a deny into anything softer", () => {
    for (const attachment of [NOBODY_ATTACHED, { attached: true, who: "d" }]) {
      expect(resolveHostGate(decideHostGate("outcome", "destructive"), attachment).decision).toBe(
        "deny",
      );
    }
  });
});

describe("hostSettings — the blob the runner is spawned with", () => {
  // Measured (§147): `PermissionRequest` never fires for a call that does not
  // request permission, and in a headless session most do not. Enforcing there
  // would be enforcement that silently does nothing.
  it("gates PreToolUse, NOT PermissionRequest", () => {
    const s = hostSettings({ sessionId: "abc" }) as {
      hooks: Record<string, unknown>;
    };
    expect(Object.keys(s.hooks)).toStrictEqual(["PreToolUse"]);
    expect(s.hooks.PermissionRequest).toBeUndefined();
  });

  it("threads the session id so log lines are attributable", () => {
    const json = JSON.stringify(hostSettings({ sessionId: "sess-42" }));
    expect(json).toContain("--session sess-42");
  });

  // An async hook does not block, and a gate that does not block is a log.
  it("is synchronous", () => {
    const s = hostSettings({ sessionId: "abc" }) as {
      hooks: { PreToolUse: { hooks: { async: boolean }[] }[] };
    };
    expect(s.hooks.PreToolUse[0]?.hooks[0]?.async).toBe(false);
  });
});

const newTempDir = useTempDirs("golem-hostgate-");

function io(input: string) {
  const mk = () => ({
    text: "",
    write(s: string) {
      this.text += s;
    },
  });
  const out = mk();
  const err = mk();
  return {
    stdin: (async function* () {
      yield input;
    })(),
    stdout: out,
    stderr: err,
  };
}

const payload = (tool: string, input: unknown, cwd: string) =>
  JSON.stringify({ tool_name: tool, tool_input: input, cwd, session_id: "s1" });

describe("the host-gate hook handler", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await newTempDir();
  });

  it("emits the FLAT PreToolUse deny shape, not PermissionRequest's nested one", async () => {
    const h = io(payload("Bash", { command: "rm -rf x" }, dir));
    expect(await runHostGateHook(h, { projectDir: dir, sessionId: "s1" })).toBe(0);
    const out = JSON.parse(h.stdout.text);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("destructive");
    // The nested shape would be a silent no-op here.
    expect(out.hookSpecificOutput.decision).toBeUndefined();
  });

  it("denies an outward call", async () => {
    const h = io(payload("Bash", { command: "git push origin main" }, dir));
    await runHostGateHook(h, { projectDir: dir, sessionId: "s1" });
    expect(JSON.parse(h.stdout.text).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  // Emitting `allow` would REMOVE prompts the runner would otherwise raise.
  // Silence means "the runner's own flow governs", which is what allow means here.
  it("emits NOTHING for an allowed call", async () => {
    const h = io(payload("Read", { file_path: "x" }, dir));
    await runHostGateHook(h, { projectDir: dir, sessionId: "s1" });
    expect(h.stdout.text).toBe("");
  });

  // The OPPOSITE of the guest hooks: there is no human permission flow to fall
  // back to in a hosted session, so a gate that cannot evaluate must refuse.
  it("fails CLOSED on unparseable input", async () => {
    const h = io("{ not json");
    expect(await runHostGateHook(h, { projectDir: dir, sessionId: "s1" })).toBe(0);
    expect(JSON.parse(h.stdout.text).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("fails CLOSED when the level read throws", async () => {
    const h = io(payload("Read", { file_path: "x" }, dir));
    await runHostGateHook(h, {
      projectDir: dir,
      sessionId: "s1",
      readLevel: () => Promise.reject(new Error("disk gone")),
    });
    expect(JSON.parse(h.stdout.text).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("fails CLOSED on a payload with no tool name", async () => {
    const h = io(JSON.stringify({ cwd: dir }));
    await runHostGateHook(h, { projectDir: dir, sessionId: "s1" });
    expect(JSON.parse(h.stdout.text).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  // An audit log that only records refusals cannot answer "what did this
  // session do", so every decision is written — allow included.
  it("writes an attributable line for an ALLOW as well as a DENY", async () => {
    await runHostGateHook(io(payload("Read", { file_path: "x" }, dir)), {
      projectDir: dir,
      sessionId: "s1",
    });
    await runHostGateHook(io(payload("Bash", { command: "rm -rf x" }, dir)), {
      projectDir: dir,
      sessionId: "s1",
    });
    const log = await readHostLog(dir);
    const decisions = log.filter((e) => e.kind === "decision");
    expect(decisions).toHaveLength(2);
    expect(decisions.map((d) => (d.kind === "decision" ? d.decision : ""))).toStrictEqual([
      "allow",
      "deny",
    ]);
    expect(decisions.every((d) => d.kind === "decision" && d.sessionId === "s1")).toBe(true);
  });
});
