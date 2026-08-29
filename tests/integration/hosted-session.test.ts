/**
 * R13.3 — the hosted session, spawning a REAL process.
 *
 * ## What is and is not mocked, and why
 *
 * The runner here is a small node script that speaks the real
 * `--output-format stream-json` protocol on stdout and reads the real
 * `--input-format stream-json` envelopes on stdin. So the spawn, the argument
 * array, the environment, the JSONL framing, the partial-chunk buffering, the
 * event normalisation, the lifecycle and the kill path are all exercised for
 * real — the parts that break.
 *
 * What it is NOT is the `claude` binary, deliberately. Spawning that costs real
 * money per run, needs credentials, and would make the suite non-hermetic. The
 * real-runner demonstration is a LIVE run recorded with its commands and output
 * in `docs/plan/verification-notes.md` §147 — including the destructive refusal,
 * the surviving file, and the audit trail. That is the honest split: the
 * protocol is tested here, the integration with the real binary is measured
 * there and dated.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendHostLog,
  forgetHostSession,
  HostedSession,
  type HostStreamEvent,
  listHostSessions,
  normaliseEvent,
  readHostLog,
  reapDeadSessions,
  registerHostSession,
  runnerArgs,
  userMessageLine,
} from "../../src/session/index.js";
import { useTempDirs } from "../helpers/tmp.js";

const newTempDir = useTempDirs("golem-hosted-");

/**
 * A stand-in runner. Echoes back one assistant turn with a tool call, a tool
 * result and a result event — the shape §142/§147 recorded from the real one.
 */
const FAKE_RUNNER = `
let buf = "";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "system", subtype: "init", session_id: "runner-sess-1" });
process.stdin.on("data", (c) => {
  buf += c.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const text = msg.message.content;
    if (String(process.env.GOLEM_FAKE_MODE) === "hang") return; // never answers
    emit({ type: "assistant", session_id: "runner-sess-1", message: { content: [
      { type: "text", text: "ack: " + text },
      { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "echo hi" } },
    ] } });
    emit({ type: "user", session_id: "runner-sess-1", message: { content: [
      { type: "tool_result", tool_use_id: "tu_1", is_error: false, content: "hi" },
    ] } });
    emit({ type: "rate_limit_event", session_id: "runner-sess-1", note: "pressure" });
    emit({ type: "result", subtype: "success", session_id: "runner-sess-1", is_error: false, num_turns: 2, total_cost_usd: 0.01 });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

async function writeFakeRunner(dir: string): Promise<string> {
  const file = path.join(dir, "fake-runner.mjs");
  await writeFile(file, FAKE_RUNNER, "utf8");
  return file;
}

describe("normaliseEvent — the fragile half, without a process", () => {
  it("pulls text and tool_use out of an assistant event", () => {
    const events = normaliseEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hello" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    expect(events).toStrictEqual([
      { type: "text", text: "hello" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ]);
  });

  it("marks a tool_result error — how a host refusal reaches the model", () => {
    const [event] = normaliseEvent({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", is_error: true, content: "Refused by …" },
        ],
      },
    });
    expect(event).toStrictEqual({
      type: "tool_result",
      toolUseId: "t1",
      isError: true,
      content: "Refused by …",
    });
  });

  // The runner's OWN guard, which is a different fact from a hook denial and
  // must not be reported as one.
  it("distinguishes the runner's own permission_denied", () => {
    const [event] = normaliseEvent({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      message: "blocked by the working-directory guard",
    });
    expect(event).toStrictEqual({
      type: "permission_denied",
      tool: "Bash",
      message: "blocked by the working-directory guard",
    });
  });

  it("surfaces rate-limit pressure — the park's signal (invariant 8)", () => {
    expect(normaliseEvent({ type: "rate_limit_event", x: 1 })[0]?.type).toBe("rate_limit");
  });

  it("ignores events it has no vocabulary for, rather than throwing", () => {
    expect(normaliseEvent({ type: "system", subtype: "thinking_tokens" })).toStrictEqual([]);
    expect(normaliseEvent({})).toStrictEqual([]);
  });

  it("builds the stdin envelope the runner expects", () => {
    const parsed = JSON.parse(userMessageLine("hi"));
    expect(parsed).toStrictEqual({
      type: "user",
      message: { role: "user", content: "hi" },
      parent_tool_use_id: null,
    });
  });
});

describe("runnerArgs", () => {
  // Without `--verbose` the stream-json output does not emit per-event lines
  // (§142 item 2), so the host would see a result and no visible tool calls —
  // and ADR-0007 §2 promises visible tool calls.
  it("includes --verbose, which is required not cosmetic", () => {
    expect(runnerArgs("{}")).toContain("--verbose");
  });

  it("drives ONE process over stream-json in both directions", () => {
    const args = runnerArgs("{}");
    expect(args).toContain("--input-format");
    expect(args).toContain("--output-format");
    expect(args.filter((a) => a === "stream-json")).toHaveLength(2);
  });

  it("passes the settings blob through --settings", () => {
    const args = runnerArgs('{"hooks":{}}');
    expect(args[args.indexOf("--settings") + 1]).toBe('{"hooks":{}}');
  });
});

describe("HostedSession over a real spawned process", () => {
  let dir: string;
  let session: HostedSession | undefined;

  beforeEach(async () => {
    dir = await newTempDir();
    await mkdir(path.join(dir, ".golem", "state"), { recursive: true });
  });

  afterEach(() => {
    session?.kill();
    session = undefined;
  });

  function collect(s: HostedSession): HostStreamEvent[] {
    const events: HostStreamEvent[] = [];
    s.on("event", (e: HostStreamEvent) => events.push(e));
    return events;
  }

  it("streams an assistant turn, its tool call, and the result", async () => {
    const runner = await writeFakeRunner(dir);
    session = new HostedSession({
      projectDir: dir,
      proxyBaseUrl: "http://localhost:4653",
      settingsJson: "{}",
      runnerBin: process.execPath,
      runnerArgsOverride: [runner],
    });
    const events = collect(session);
    session.start();
    session.send("hello there");
    await new Promise<void>((resolve) => {
      session?.on("event", (e: HostStreamEvent) => {
        if (e.type === "result") resolve();
      });
    });
    expect(events.map((e) => e.type)).toStrictEqual([
      "text",
      "tool_use",
      "tool_result",
      "rate_limit",
      "result",
    ]);
    expect((events[0] as { text: string }).text).toContain("hello there");
  });

  it("learns the runner's own session id from the stream", async () => {
    const runner = await writeFakeRunner(dir);
    session = new HostedSession({
      projectDir: dir,
      proxyBaseUrl: "http://localhost:4653",
      settingsJson: "{}",
      runnerBin: process.execPath,
      runnerArgsOverride: [runner],
    });
    session.start();
    session.send("hi");
    await new Promise<void>((resolve) =>
      session?.on("event", (e: HostStreamEvent) => e.type === "result" && resolve()),
    );
    expect(session.runnerSessionId).toBe("runner-sess-1");
  });

  it("refuses to send once the session is not running", async () => {
    const runner = await writeFakeRunner(dir);
    session = new HostedSession({
      projectDir: dir,
      proxyBaseUrl: "http://localhost:4653",
      settingsJson: "{}",
      runnerBin: process.execPath,
      runnerArgsOverride: [runner],
    });
    session.start();
    session.kill();
    await new Promise<void>((r) => session?.on("exit", () => r()));
    expect(() => session?.send("too late")).toThrow(/not running/);
  });

  // "Killing the link mid-turn denies rather than dangles": the process dies,
  // `exit` fires, and nothing is left awaiting an answer that will not come.
  it("emits exit when killed mid-turn, rather than hanging", async () => {
    const runner = await writeFakeRunner(dir);
    session = new HostedSession({
      projectDir: dir,
      proxyBaseUrl: "http://localhost:4653",
      settingsJson: "{}",
      runnerBin: process.execPath,
      runnerArgsOverride: [runner],
      env: { GOLEM_FAKE_MODE: "hang" },
    });
    session.start();
    session.send("this will never be answered");
    const exited = new Promise<void>((r) => session?.on("exit", () => r()));
    session.kill();
    await exited;
    expect(session.running).toBe(false);
  });
});

describe("the audit trail and the registry", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await newTempDir();
  });

  it("records a turn with its origin, and reads it back", async () => {
    await appendHostLog(dir, {
      kind: "turn",
      ts: "2026-08-29T00:00:00.000Z",
      sessionId: "s1",
      origin: "device-7",
      text: "do the thing",
    });
    const [entry] = await readHostLog(dir);
    expect(entry).toStrictEqual({
      kind: "turn",
      ts: "2026-08-29T00:00:00.000Z",
      sessionId: "s1",
      origin: "device-7",
      text: "do the thing",
    });
  });

  // A kill mid-append leaves a truncated final line. That is expected, not
  // exceptional, and must not make the whole log unreadable.
  it("skips a truncated final line instead of failing the read", async () => {
    await appendHostLog(dir, {
      kind: "lifecycle",
      ts: "2026-08-29T00:00:00.000Z",
      sessionId: "s1",
      event: "started",
    });
    const { hostLogPath } = await import("../../src/session/index.js");
    const file = hostLogPath(dir);
    await writeFile(file, `${await readFile(file, "utf8")}{"kind":"turn","ts`, "utf8");
    expect(await readHostLog(dir)).toHaveLength(1);
  });

  it("reports a dead pid as not alive, and reaps it", async () => {
    await registerHostSession(dir, {
      id: "gone",
      projectDir: dir,
      startedAt: "2026-08-29T00:00:00.000Z",
      // Pid 1 exists but is not ours; a pid that cannot exist is the honest
      // stand-in for "the process is gone".
      pid: 2_147_483_646,
    });
    const before = await listHostSessions(dir);
    expect(before[0]?.alive).toBe(false);

    const reaped = await reapDeadSessions(dir, "2026-08-29T01:00:00.000Z");
    expect(reaped).toBe(1);
    const after = await listHostSessions(dir);
    expect(after[0]?.stoppedAt).toBe("2026-08-29T01:00:00.000Z");
    expect(after[0]?.lastError).toContain("reaped");
  });

  it("counts the CURRENT process as alive", async () => {
    await registerHostSession(dir, {
      id: "live",
      projectDir: dir,
      startedAt: "2026-08-29T00:00:00.000Z",
      pid: process.pid,
    });
    expect((await listHostSessions(dir))[0]?.alive).toBe(true);
    expect(await reapDeadSessions(dir, "2026-08-29T01:00:00.000Z")).toBe(0);
  });

  it("forgets a session, and says whether there was one", async () => {
    await registerHostSession(dir, {
      id: "x",
      projectDir: dir,
      startedAt: "2026-08-29T00:00:00.000Z",
      pid: process.pid,
    });
    expect(await forgetHostSession(dir, "x")).toBe(true);
    expect(await forgetHostSession(dir, "x")).toBe(false);
    expect(await listHostSessions(dir)).toHaveLength(0);
  });
});
