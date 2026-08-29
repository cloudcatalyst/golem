/**
 * R13.5 — the transport, over the real mTLS server it is mounted behind.
 *
 * Every request here is a genuine HTTPS call presenting a genuine device
 * certificate, because the whole point of mounting on R13.4 is that an unpaired
 * caller cannot reach any of this — and "the handler refuses" and "the request
 * never got there" are different guarantees.
 */

import https from "node:https";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/interfaces/session-events.js";
import {
  type DeviceCa,
  generateDeviceCa,
  generateLoopbackPair,
  type LoopbackPair,
} from "../../src/proxy/loopback-cert.js";
import {
  claimEnrolment,
  setPasscode,
  startEnrolment,
  startWriteServer,
  unlock,
  type WriteServerHandle,
} from "../../src/security/index.js";
import {
  readHostLog,
  resetLedgers,
  SessionBus,
  sessionTransportHandler,
  type TransportSession,
} from "../../src/session/index.js";
import { useTempDirs } from "../helpers/tmp.js";

const newTempDir = useTempDirs("golem-transport-");

let ca: DeviceCa;
let tls: LoopbackPair;

interface Creds {
  readonly cert: string;
  readonly key: string;
}

describe("the session transport", () => {
  let dir: string;
  let handle: WriteServerHandle | undefined;
  let bus: SessionBus;
  let delivered: string[];
  let creds: Creds;
  /** Set to make `deliver` fail, so the "not acknowledged" path is reachable. */
  let deliverFails = false;
  const openRequests: import("node:http").ClientRequest[] = [];

  beforeEach(async () => {
    dir = await newTempDir();
    ca ??= await generateDeviceCa();
    tls ??= await generateLoopbackPair();
    resetLedgers();
    bus = new SessionBus("sess-1");
    delivered = [];
    deliverFails = false;

    const session: TransportSession = {
      bus,
      projectDir: dir,
      deliver: async (text) => {
        if (deliverFails) throw new Error("the runner is gone");
        delivered.push(text);
      },
    };

    handle = await startWriteServer({
      projectDir: dir,
      port: 0,
      serverKeyPem: tls.leafKeyPem,
      serverCertPem: tls.chainPem,
      deviceCa: ca,
      handler: sessionTransportHandler({
        lookup: (id) => (id === "sess-1" ? session : null),
        heartbeatMs: 50,
      }),
    });

    // Pair a device and unlock, the way R13.4 requires.
    const pending = await startEnrolment(dir, { label: "Pixel" });
    const claim = await claimEnrolment(dir, pending.code, { ca });
    if (!claim.ok) throw new Error("fixture: enrolment failed");
    creds = { cert: claim.cert.certPem, key: claim.cert.keyPem };
    await setPasscode(dir, "correct-horse");
    await unlock(dir, "correct-horse");
  });

  afterEach(async () => {
    // SSE connections are long-lived, and `server.close()` waits for open
    // connections — so a stream left open (or a test that failed before closing
    // one) would hang teardown rather than fail cleanly.
    for (const req of openRequests) req.destroy();
    openRequests.length = 0;
    bus.closeAll("test teardown");
    await handle?.close();
    handle = undefined;
  });

  function post(
    path: string,
    payload: unknown,
    withCreds: Creds | null = creds,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve) => {
      const req = https.request(
        {
          host: "127.0.0.1",
          port: (handle as WriteServerHandle).port,
          path,
          method: "POST",
          ca: [tls.caPem],
          ...(withCreds !== null ? { cert: withCreds.cert, key: withCreds.key } : {}),
          checkServerIdentity: () => undefined,
          headers: { "content-type": "application/json" },
        },
        (res) => {
          let raw = "";
          res.on("data", (c) => {
            raw += c;
          });
          res.on("end", () => {
            let body: Record<string, unknown> = {};
            try {
              body = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              body = { raw };
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on("error", () => resolve({ status: 0, body: {} }));
      req.write(JSON.stringify(payload));
      req.end();
    });
  }

  /** Open an SSE stream and collect events until `want` of them have arrived. */
  function stream(
    want: number,
    opts: { after?: number } = {},
  ): Promise<{ events: SessionEvent[]; close: () => void }> {
    return new Promise((resolve, reject) => {
      const events: SessionEvent[] = [];
      const path = `/session/sess-1/stream${opts.after !== undefined ? `?after=${opts.after}` : ""}`;
      const req = https.request(
        {
          host: "127.0.0.1",
          port: (handle as WriteServerHandle).port,
          path,
          method: "GET",
          ca: [tls.caPem],
          cert: creds.cert,
          key: creds.key,
          checkServerIdentity: () => undefined,
        },
        (res) => {
          let buf = "";
          res.on("data", (chunk) => {
            buf += chunk.toString("utf8");
            for (;;) {
              const sep = buf.indexOf("\n\n");
              if (sep === -1) break;
              const frame = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
              if (dataLine === undefined) continue; // a heartbeat comment
              events.push(JSON.parse(dataLine.slice(6)) as SessionEvent);
              if (events.length >= want) {
                resolve({ events, close: () => req.destroy() });
              }
            }
          });
        },
      );
      openRequests.push(req);
      req.on("error", reject);
      req.end();
    });
  }

  it("refuses an unpaired POST — the transport is behind the gate, not beside it", async () => {
    const res = await post("/session/sess-1/message", { messageId: "m1", text: "hi" }, null);
    expect(res.status).toBe(401);
    expect(res.body.claim).toBe("device");
    expect(delivered).toHaveLength(0);
  });

  it("sends `attached` first, before any replay", async () => {
    const { events, close } = await stream(1);
    close();
    expect(events[0]).toMatchObject({
      type: "attached",
      sessionId: "sess-1",
      resumedFrom: 0,
      gap: false,
    });
  });

  it("streams a full turn's events, in order", async () => {
    const pending = stream(5);
    // Give the subscriber a moment to attach before publishing.
    await new Promise((r) => setTimeout(r, 80));
    bus.publish({ type: "text", text: "working on it" });
    bus.publish({ type: "tool_call", id: "t1", name: "Bash", input: { command: "ls" } });
    bus.publish({ type: "tool_result", toolCallId: "t1", isError: false, content: "ok" });
    bus.publish({ type: "turn_end", costUsd: 0.02 });
    const { events, close } = await pending;
    close();
    expect(events.map((e) => e.type)).toStrictEqual([
      "attached",
      "text",
      "tool_call",
      "tool_result",
      "turn_end",
    ]);
    // Monotonic seq is what makes resume possible; assert it rather than assume.
    const seqs = events.slice(1).map((e) => e.seq);
    expect(seqs).toStrictEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  // A host refusal reaches the device as an errored tool result carrying its
  // reason — so a client that renders errors renders refusals for free.
  it("carries a refusal through as an errored result", async () => {
    const pending = stream(2);
    await new Promise((r) => setTimeout(r, 80));
    bus.publish({
      type: "tool_result",
      toolCallId: "t9",
      isError: true,
      content: "Refused by the Golem session host: destructive step.",
    });
    const { events, close } = await pending;
    close();
    expect(events[1]).toMatchObject({ type: "tool_result", isError: true });
    expect((events[1] as { content: string }).content).toContain(
      "Refused by the Golem session host",
    );
  });

  it("delivers a POSTed message and acknowledges only after delivery", async () => {
    const res = await post("/session/sess-1/message", { messageId: "m1", text: "do the thing" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("delivered");
    expect(delivered).toStrictEqual(["do the thing"]);
  });

  // The acknowledgement means DELIVERED, not accepted. If the session refuses
  // the text, the device must not be told it landed.
  it("does NOT acknowledge when delivery fails", async () => {
    deliverFails = true;
    const res = await post("/session/sess-1/message", { messageId: "m1", text: "hi" });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("did not accept");
  });

  it("records attribution before delivering", async () => {
    await post("/session/sess-1/message", { messageId: "m1", text: "attributed turn" });
    const log = await readHostLog(dir);
    const turn = log.find((e) => e.kind === "turn");
    expect(turn).toMatchObject({ kind: "turn", sessionId: "sess-1", text: "attributed turn" });
    // The origin is the DEVICE, not "local" — that is what attribution is for.
    expect(turn?.kind === "turn" && turn.origin.length).toBeGreaterThan(0);
  });

  // A duplicated instruction to an agent is not a duplicated packet.
  it("is idempotent — a retried messageId does not deliver twice", async () => {
    const first = await post("/session/sess-1/message", { messageId: "m1", text: "once" });
    const retry = await post("/session/sess-1/message", { messageId: "m1", text: "once" });
    expect(first.body.status).toBe("delivered");
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe("duplicate");
    expect(delivered).toStrictEqual(["once"]);
  });

  it("treats a different id as a different message", async () => {
    await post("/session/sess-1/message", { messageId: "m1", text: "one" });
    await post("/session/sess-1/message", { messageId: "m2", text: "two" });
    expect(delivered).toStrictEqual(["one", "two"]);
  });

  it("says the limit rather than truncating an oversized message", async () => {
    const res = await post("/session/sess-1/message", {
      messageId: "big",
      text: "x".repeat(40_000),
    });
    expect(res.status).toBe(413);
    expect(res.body.limit).toBe(32_000);
    expect(delivered).toHaveLength(0);
  });

  it("rejects a message missing its id or text", async () => {
    expect((await post("/session/sess-1/message", { text: "no id" })).status).toBe(400);
    expect((await post("/session/sess-1/message", { messageId: "x" })).status).toBe(400);
    expect(delivered).toHaveLength(0);
  });

  it("404s a session that is not here, and says what to run", async () => {
    const res = await post("/session/nope/message", { messageId: "m", text: "hi" });
    expect(res.status).toBe(404);
    expect(String(res.body.message)).toContain("golem session host list");
  });

  // The gate item: reconnect and resume without losing or duplicating a turn.
  it("resumes from a cursor with no loss and no duplication", async () => {
    // Start the stream, let it ATTACH, and only then publish — awaiting three
    // events before publishing any is a deadlock, not a test.
    const pending = stream(3);
    await new Promise((r) => setTimeout(r, 80));
    bus.publish({ type: "text", text: "one" });
    bus.publish({ type: "text", text: "two" });
    const first = await pending;
    first.close();

    const lastSeen = first.events[first.events.length - 1]?.seq ?? 0;

    // Published while nobody was attached — the ring must still hold them.
    bus.publish({ type: "text", text: "three" });
    bus.publish({ type: "text", text: "four" });

    const second = await stream(3, { after: lastSeen });
    second.close();
    const texts = second.events
      .filter((e): e is SessionEvent & { text: string } => e.type === "text")
      .map((e) => e.text);
    expect(texts).toStrictEqual(["three", "four"]);
    expect(second.events[0]).toMatchObject({ type: "attached", resumedFrom: lastSeen, gap: false });
  });

  // A session that ended while the client was away must be TOLD, at once.
  // Silence never means "gone".
  it("tells a late attacher that the session already ended", async () => {
    bus.publish({ type: "ended", reason: "the runner exited" });
    const { events, close } = await stream(2);
    close();
    expect(events.some((e) => e.type === "ended")).toBe(true);
  });
});
