/**
 * R12.2 — the blocked-state READ MODEL.
 *
 * `session-state.test.ts` covers the original flag (round-trip, corrupt files,
 * the two hooks). This file covers what R12.2 added: redaction on the way to
 * disk, v1 back-compat, the `waiting`/`abandoned`/`clear`/`unknown` distinction,
 * the pending-tool correlation, and the project/session identity.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyNotification,
  markBlocked,
  markUnblocked,
  pendingToolPath,
  readPendingToolCall,
  readSessionState,
  resolveBlock,
  runNotificationHook,
  type SessionState,
  sessionStatePath,
  writePendingToolCall,
} from "../../../src/hooks/index.js";
import { useTempDirs } from "../../helpers/tmp.js";

let dir: string;
const newTempDir = useTempDirs("golem-blocked-");

beforeEach(async () => {
  dir = await newTempDir();
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

describe("redaction is unconditional (ADR-0006 §1)", () => {
  // Built at runtime: a literal secret in the source would be redacted from
  // under the test by Golem's own pipeline, and a literal `[REDACTED:…]` would
  // pass vacuously.
  const secret = `sk-ant-${"A1b2C3d4E5f6G7h8".repeat(2)}`;

  it("redacts a verbatim tool argument BEFORE it reaches the disk", async () => {
    // The brief's exact scenario: a curl command carrying a credential. This is
    // the first Golem-written artefact whose *purpose* is to carry such a
    // string, and R12.4 will put it on a wire.
    await markBlocked(dir, "Claude needs your permission", "2026-08-21T00:00:00Z", "s1", {
      kind: "permission",
      tool: {
        name: "Bash",
        argument: `curl -H "Authorization: Bearer ${secret}" https://example.test/`,
        actionClass: "unknown",
      },
    });

    // Asserted against the RAW BYTES, not the parsed model: the requirement is
    // that the secret never lands on disk, which a reader-side check could not
    // prove.
    const raw = await readFile(sessionStatePath(dir), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("[REDACTED:anthropic-key:1]");

    const state = await readSessionState(dir);
    expect(state?.tool?.argument).toContain("[REDACTED:anthropic-key:1]");
    // The rest of the command survives — a redacted argument is still meant to
    // be judged by a human.
    expect(state?.tool?.argument).toContain("curl -H");
  });

  it("redacts the reason string too, not only the tool argument", async () => {
    await markBlocked(dir, `token ${secret} needs approval`, "2026-08-21T00:00:00Z");
    const raw = await readFile(sessionStatePath(dir), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("[REDACTED:anthropic-key:1]");
  });

  it("redacts the pending-tool record on the same terms", async () => {
    await writePendingToolCall(dir, {
      name: "Bash",
      argument: `curl -H "Authorization: Bearer ${secret}"`,
      ts: "2026-08-21T00:00:00Z",
    });
    const raw = await readFile(pendingToolPath(dir), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("[REDACTED:anthropic-key:1]");
  });
});

describe("v1 back-compat", () => {
  it("upgrades a pre-R12.2 file to v2 with the new fields simply absent", async () => {
    const file = sessionStatePath(dir);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ blocked: true, ts: "2026-08-21T00:00:00Z", reason: "x", sessionId: "s1" }),
      "utf8",
    );
    const state = await readSessionState(dir);
    expect(state?.v).toBe(2);
    expect(state?.blocked).toBe(true);
    expect(state?.reason).toBe("x");
    expect(state?.sessionId).toBe("s1");
    // Degrades to the old, merely incomplete display — never to nothing.
    expect(state?.kind).toBeUndefined();
    expect(state?.tool).toBeUndefined();
    expect(state?.project).toBeUndefined();
  });

  it("omits a malformed sub-object rather than rejecting the whole file", async () => {
    const file = sessionStatePath(dir);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        blocked: true,
        ts: "2026-08-21T00:00:00Z",
        tool: { name: 42 },
        project: { dir: "/x" },
        kind: "nonsense",
        lastEvent: "nonsense",
      }),
      "utf8",
    );
    const state = await readSessionState(dir);
    expect(state?.blocked).toBe(true);
    expect(state?.tool).toBeUndefined();
    expect(state?.project).toBeUndefined();
    expect(state?.kind).toBeUndefined();
    expect(state?.lastEvent).toBeUndefined();
  });
});

describe("resolveBlock tells unblocked from nobody-ever-wrote-again", () => {
  const at = (ageMs: number): string => new Date(Date.now() - ageMs).toISOString();

  it("has no answer at all when there is no file", () => {
    expect(resolveBlock(null).status).toBe("unknown");
  });

  it("is waiting while the flag is fresh", () => {
    const state: SessionState = { v: 2, blocked: true, ts: at(1_000) };
    expect(resolveBlock(state).status).toBe("waiting");
  });

  it("is ABANDONED — not clear — when a block went stale unanswered", () => {
    // The distinction the old model could not express: a stale `blocked: true`
    // was hidden, and therefore read as if nothing were happening.
    const state: SessionState = { v: 2, blocked: true, ts: at(20 * 60_000) };
    expect(resolveBlock(state).status).toBe("abandoned");
  });

  it("is clear only when a writer said the human responded", () => {
    const state: SessionState = { v: 2, blocked: false, ts: at(1_000), lastEvent: "responded" };
    expect(resolveBlock(state).status).toBe("clear");
  });

  it("reports the age, so a stale block is visibly stale", () => {
    const state: SessionState = { v: 2, blocked: true, ts: at(30_000) };
    expect(resolveBlock(state).ageMs).toBeGreaterThanOrEqual(30_000);
  });

  it("carries no age for an unparseable timestamp, and never calls it fresh", () => {
    const state: SessionState = { v: 2, blocked: true, ts: "not a date" };
    const resolved = resolveBlock(state);
    expect(resolved.ageMs).toBeUndefined();
    expect(resolved.status).toBe("abandoned");
  });
});

describe("the pending tool call", () => {
  it("round-trips every field", async () => {
    const call = {
      name: "Bash",
      argument: "ls -la",
      actionClass: "read",
      sessionId: "s1",
      ts: "2026-08-21T00:00:00Z",
    };
    await writePendingToolCall(dir, call);
    expect(await readPendingToolCall(dir)).toEqual(call);
  });

  it("returns null when nothing is pending (never throws)", async () => {
    expect(await readPendingToolCall(dir)).toBeNull();
  });
});

describe("which project, which session", () => {
  it("names the working tree, because a session id does not", async () => {
    // The redaction sweep covers the project path too (see `session-state.ts`),
    // and a `mkdtemp` segment is high-entropy - so the raw temp path is NOT a
    // stable expectation: it survives one platform's tmp shape and lands as a
    // placeholder on another's (this failed on ubuntu CI, passed on Windows).
    // Assert the property instead, under a benign nested name.
    const project = path.join(dir, "my-project");
    await mkdir(project, { recursive: true });
    await markBlocked(project, "r", "2026-08-21T00:00:00Z", "s1");
    const state = await readSessionState(project);
    expect(state?.project?.name).toBe("my-project");
    expect(state?.project?.dir.endsWith("my-project")).toBe(true);
    expect(state?.sessionId).toBe("s1");
  });

  it("records WHY the state last changed, on the clearing path too", async () => {
    await markBlocked(dir, "r", "2026-08-21T00:00:00Z", "s1");
    expect((await readSessionState(dir))?.lastEvent).toBe("blocked");
    await markUnblocked(dir, "2026-08-21T00:01:00Z", "s1");
    const cleared = await readSessionState(dir);
    expect(cleared?.blocked).toBe(false);
    expect(cleared?.lastEvent).toBe("responded");
  });
});

describe("the Notification hook names what the block IS", () => {
  const nowIso = "2026-08-21T00:00:00Z";
  const pending = {
    name: "Bash",
    argument: "rm -rf ./build",
    actionClass: "destructive",
    sessionId: "s1",
    ts: nowIso,
  };
  const notify = (payload: Record<string, unknown>): { io: never } =>
    io(JSON.stringify(payload)) as { io: never };

  it("attaches the tool and argument to a permission block", async () => {
    // The whole point: Claude Code's own Notification message is the generic
    // "Claude needs your permission" and names no tool (verified 2026-08-21).
    await writePendingToolCall(dir, pending);
    const { io: hookIo } = notify({
      cwd: dir,
      notification_type: "permission_prompt",
      message: "Claude needs your permission",
      session_id: "s1",
    });
    expect(await runNotificationHook(hookIo, nowIso)).toBe(0);
    const state = await readSessionState(dir);
    expect(state?.kind).toBe("permission");
    expect(state?.tool?.name).toBe("Bash");
    expect(state?.tool?.argument).toBe("rm -rf ./build");
    // ADR-0006 §2 decides remote-approvability off this class.
    expect(state?.tool?.actionClass).toBe("destructive");
  });

  it("attaches NO tool to an idle turn — nobody was asked about one", async () => {
    await writePendingToolCall(dir, pending);
    const { io: hookIo } = notify({
      cwd: dir,
      notification_type: "idle_prompt",
      message: "Claude is waiting for your input",
      session_id: "s1",
    });
    await runNotificationHook(hookIo, nowIso);
    const state = await readSessionState(dir);
    expect(state?.blocked).toBe(true);
    expect(state?.kind).toBe("idle");
    expect(state?.tool).toBeUndefined();
  });

  it("does not light up a block for a notification that is not one", async () => {
    // Before R12.2 every notification set `blocked: true`, so an auth
    // confirmation alone could show "waiting" with nothing waiting.
    const { io: hookIo } = notify({
      cwd: dir,
      notification_type: "auth_success",
      message: "Login successful",
    });
    expect(await runNotificationHook(hookIo, nowIso)).toBe(0);
    expect(await readSessionState(dir)).toBeNull();
  });

  it("ignores a pending call from a DIFFERENT session", async () => {
    await writePendingToolCall(dir, { ...pending, sessionId: "other" });
    const { io: hookIo } = notify({
      cwd: dir,
      notification_type: "permission_prompt",
      message: "Claude needs your permission",
      session_id: "s1",
    });
    await runNotificationHook(hookIo, nowIso);
    expect((await readSessionState(dir))?.tool).toBeUndefined();
  });

  it("ignores a pending call too old to be this question", async () => {
    await writePendingToolCall(dir, { ...pending, ts: "2026-08-20T00:00:00Z" });
    const { io: hookIo } = notify({
      cwd: dir,
      notification_type: "permission_prompt",
      message: "Claude needs your permission",
      session_id: "s1",
    });
    await runNotificationHook(hookIo, nowIso);
    expect((await readSessionState(dir))?.tool).toBeUndefined();
  });

  it("still blocks on an unrecognised notification_type (older or newer client)", async () => {
    const { io: hookIo } = notify({
      cwd: dir,
      notification_type: "some_future_type",
      message: "Claude needs your permission to use Bash",
    });
    await runNotificationHook(hookIo, nowIso);
    const state = await readSessionState(dir);
    expect(state?.blocked).toBe(true);
    expect(state?.kind).toBe("permission");
  });
});

describe("classifyNotification", () => {
  it.each([
    ["permission_prompt", "permission"],
    ["idle_prompt", "idle"],
    ["agent_needs_input", "question"],
    ["elicitation_dialog", "question"],
    ["elicitation_url_dialog", "question"],
  ])("treats %s as a block of kind %s", (type, kind) => {
    const c = classifyNotification(type, "m");
    expect(c.block).toBe(true);
    expect(c.kind).toBe(kind);
  });

  it.each([
    "auth_success",
    "elicitation_complete",
    "elicitation_response",
    "agent_completed",
  ])("treats %s as NOT a block", (type) => {
    expect(classifyNotification(type, "m").block).toBe(false);
  });

  it("falls back to the message when the client sends no type", () => {
    expect(classifyNotification(undefined, "Claude needs your permission")).toEqual({
      block: true,
      kind: "permission",
    });
    expect(classifyNotification(undefined, "Claude is waiting for your input")).toEqual({
      block: true,
      kind: "idle",
    });
    expect(classifyNotification(undefined, "Something else")).toEqual({
      block: true,
      kind: "question",
    });
    // No type and no text: still a block, kind unknown — the pre-R12.2 shape.
    expect(classifyNotification(undefined, "")).toEqual({ block: true });
  });
});
