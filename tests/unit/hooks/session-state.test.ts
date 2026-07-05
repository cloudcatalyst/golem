/**
 * Decision 21b groundwork — session blocked-state + Notification/UserPromptSubmit
 * hooks. Temp dirs; hook I/O injected.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  markBlocked,
  markUnblocked,
  readSessionState,
  runNotificationHook,
  runUserPromptSubmitHook,
} from "../../../src/hooks/index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-state-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function io(input: string) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdin: Readable.from([Buffer.from(input, "utf8")]),
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
    } as never,
    out,
    err,
  };
}

describe("session state read/write", () => {
  it("round-trips blocked then unblocked", async () => {
    expect(await readSessionState(dir)).toBeNull();
    await markBlocked(dir, "Bash(rm -rf) needs approval", "2026-07-04T00:00:00Z", "s1");
    const blocked = await readSessionState(dir);
    expect(blocked?.blocked).toBe(true);
    expect(blocked?.reason).toContain("approval");
    expect(blocked?.sessionId).toBe("s1");

    await markUnblocked(dir, "2026-07-04T00:01:00Z");
    expect((await readSessionState(dir))?.blocked).toBe(false);
  });

  it("returns null on a missing/corrupt file (never throws)", async () => {
    expect(await readSessionState(dir)).toBeNull();
  });
});

describe("Notification / UserPromptSubmit hooks", () => {
  it("Notification records blocked-state from the payload cwd + message", async () => {
    const { io: hookIo, out } = io(
      JSON.stringify({
        cwd: dir,
        message: "Claude needs permission to run Bash",
        session_id: "s9",
      }),
    );
    const code = await runNotificationHook(hookIo, "2026-07-04T00:00:00Z");
    expect(code).toBe(0);
    expect(out).toHaveLength(0); // no stdout — no behavior change
    const s = await readSessionState(dir);
    expect(s?.blocked).toBe(true);
    expect(s?.reason).toContain("permission");
  });

  it("UserPromptSubmit clears the blocked-state", async () => {
    await markBlocked(dir, "x", "2026-07-04T00:00:00Z");
    const { io: hookIo } = io(JSON.stringify({ cwd: dir }));
    const code = await runUserPromptSubmitHook(hookIo, "2026-07-04T00:01:00Z");
    expect(code).toBe(0);
    expect((await readSessionState(dir))?.blocked).toBe(false);
  });

  it("hooks never throw on malformed stdin (exit 0)", async () => {
    const { io: hookIo } = io("{not json");
    expect(await runNotificationHook(hookIo, "t")).toBe(0);
  });
});
