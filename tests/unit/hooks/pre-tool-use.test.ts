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
});
