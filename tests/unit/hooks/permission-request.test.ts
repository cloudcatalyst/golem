/**
 * R12.12 — the PermissionRequest gate hook: emits a real `deny` (not an `ask`)
 * for destructive/outward, defers on everything else, and NEVER auto-allows.
 *
 * Recorded-shape only, by design. What these tests CANNOT prove is that a
 * `PermissionRequest` deny pre-empts a connected channel's `permission_request`
 * relay in a live interactive session — that needs a real terminal and a real
 * channel, and is filed as `R12.13` (owner: user).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { setAutonomyGateEnabled } from "../../../src/autonomy/index.js";
import { runPermissionRequestHook } from "../../../src/hooks/permission-request.js";
import { runPreToolUseHook } from "../../../src/hooks/pre-tool-use.js";
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

/**
 * The documented `PermissionRequest` payload shape (hooks reference): like
 * `PreToolUse` but with NO `tool_use_id`, plus an optional `permission_suggestions`
 * array carrying the dialog's "always allow" options.
 */
function payload(toolName: string, toolInput: unknown, cwd: string): string {
  return JSON.stringify({
    session_id: "abc123",
    transcript_path: "/tmp/t.jsonl",
    cwd,
    permission_mode: "default",
    hook_event_name: "PermissionRequest",
    tool_name: toolName,
    tool_input: toolInput,
  });
}

const newTempDir = useTempDirs("golem-permreq-");

describe("runPermissionRequestHook", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await newTempDir();
  });

  it("DENIES an outward Bash with the documented decision envelope", async () => {
    const h = io(payload("Bash", { command: "git push origin main" }, dir));
    const code = await runPermissionRequestHook(h, { projectDir: dir });
    expect(code).toBe(0);
    const out = JSON.parse(h.stdout.text);
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: expect.any(String) },
      },
    });
    expect(out.hookSpecificOutput.decision.message).toContain("leaves the machine");
  });

  it("DENIES a destructive Bash", async () => {
    const h = io(payload("Bash", { command: "rm -rf node_modules" }, dir));
    await runPermissionRequestHook(h, { projectDir: dir });
    const out = JSON.parse(h.stdout.text);
    expect(out.hookSpecificOutput.decision.behavior).toBe("deny");
    expect(out.hookSpecificOutput.decision.message).toContain("destructive");
  });

  // The nesting is the whole point: `PreToolUse` uses a FLAT `permissionDecision`,
  // `PermissionRequest` uses `decision.behavior`. Emitting the wrong one is a
  // silent no-op, which is exactly the failure this shape test exists to catch.
  it("uses decision.behavior, NOT PreToolUse's flat permissionDecision", async () => {
    const h = io(payload("Bash", { command: "rm -rf /tmp/x" }, dir));
    await runPermissionRequestHook(h, { projectDir: dir });
    const out = JSON.parse(h.stdout.text);
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.decision.behavior).toBe("deny");
  });

  it("never emits `allow` — no class, no input, grants a permission", async () => {
    for (const [tool, input] of [
      ["Read", { file_path: "x" }],
      ["Write", { file_path: "x" }],
      ["Bash", { command: "ls -la" }],
      ["Bash", { command: "rm -rf x" }],
      ["Bash", { command: "git push" }],
      ["SomeUnknownTool", {}],
    ] as const) {
      const h = io(payload(tool, input, dir));
      await runPermissionRequestHook(h, { projectDir: dir });
      expect(h.stdout.text, `${tool} ${JSON.stringify(input)}`).not.toContain("allow");
    }
  });

  it("DEFERS (no stdout) for a read", async () => {
    const h = io(payload("Read", { file_path: "x" }, dir));
    expect(await runPermissionRequestHook(h, { projectDir: dir })).toBe(0);
    expect(h.stdout.text).toBe("");
  });

  it("DEFERS (no stdout) for a write", async () => {
    const h = io(payload("Write", { file_path: "x" }, dir));
    await runPermissionRequestHook(h, { projectDir: dir });
    expect(h.stdout.text).toBe("");
  });

  // Fail-closed at PreToolUse means `ask` — make the human decide. It does NOT
  // mean deciding for them one event earlier, so `unknown` defers here.
  it("DEFERS for an unknown action — fail-closed is the human's `ask`, not our deny", async () => {
    const h = io(payload("SomeUnknownTool", { whatever: 1 }, dir));
    await runPermissionRequestHook(h, { projectDir: dir });
    expect(h.stdout.text).toBe("");
  });

  it("DEFERS entirely when the autonomy gate is disabled", async () => {
    await setAutonomyGateEnabled(dir, false);
    const h = io(payload("Bash", { command: "rm -rf node_modules" }, dir));
    await runPermissionRequestHook(h, { projectDir: dir });
    expect(h.stdout.text).toBe("");
  });

  it("NEVER emits a decision on unparseable stdin", async () => {
    const h = io("{ not json");
    expect(await runPermissionRequestHook(h, { projectDir: dir })).toBe(0);
    expect(h.stdout.text).toBe("");
  });

  it("NEVER emits a decision on a payload with no tool_name", async () => {
    const h = io(JSON.stringify({ cwd: dir, tool_input: { command: "rm -rf /" } }));
    expect(await runPermissionRequestHook(h, { projectDir: dir })).toBe(0);
    expect(h.stdout.text).toBe("");
  });

  it("NEVER emits a decision on a JSON array payload", async () => {
    const h = io("[1,2,3]");
    await runPermissionRequestHook(h, { projectDir: dir });
    expect(h.stdout.text).toBe("");
  });

  it("fails SAFE (exit 0, no stdout) when the gate-enabled read throws", async () => {
    const h = io(payload("Bash", { command: "rm -rf node_modules" }, dir));
    const code = await runPermissionRequestHook(h, {
      projectDir: dir,
      readGateEnabled: () => Promise.reject(new Error("disk gone")),
    });
    expect(code).toBe(0);
    expect(h.stdout.text).toBe("");
    expect(h.stderr.text).toContain("permission-request");
  });
});

describe("the PreToolUse layer is unchanged by R12.12", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await newTempDir();
  });

  // Defense in depth: R12.12 adds a decision one event EARLIER, it does not
  // replace the `ask`. If `PermissionRequest` is ever unwired, unsupported, or
  // beaten by a foreign hook, this is still what stands between a destructive
  // step and the machine.
  it("still emits `ask` for a destructive Bash, byte-for-byte", async () => {
    const h = io(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "rm -rf node_modules" },
        cwd: dir,
        session_id: "s1",
      }),
    );
    await runPreToolUseHook(h, { projectDir: dir, readLevel: () => Promise.resolve("outcome") });
    const out = JSON.parse(h.stdout.text);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("still emits `ask` for an outward Bash, byte-for-byte", async () => {
    const h = io(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "git push origin main" },
        cwd: dir,
        session_id: "s1",
      }),
    );
    await runPreToolUseHook(h, { projectDir: dir, readLevel: () => Promise.resolve("outcome") });
    const out = JSON.parse(h.stdout.text);
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
  });

  // The two hooks quote the SAME text. A drift here would mean the human is told
  // one thing at the dialog and Claude another at the deny.
  it("emits the same reason text as the PermissionRequest deny message", async () => {
    const pre = io(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "git push origin main" },
        cwd: dir,
        session_id: "s1",
      }),
    );
    await runPreToolUseHook(pre, { projectDir: dir, readLevel: () => Promise.resolve("manual") });
    const perm = io(payload("Bash", { command: "git push origin main" }, dir));
    await runPermissionRequestHook(perm, { projectDir: dir });
    expect(JSON.parse(perm.stdout.text).hookSpecificOutput.decision.message).toBe(
      JSON.parse(pre.stdout.text).hookSpecificOutput.permissionDecisionReason,
    );
  });
});
