/**
 * R13.5 — the ring, the cursor, the gap and the ledger, without a socket.
 */

import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../../src/interfaces/session-events.js";
import {
  MessageLedger,
  parseSessionPath,
  SessionBus,
  SUBSCRIBER_QUEUE_LIMIT,
  sseFrame,
} from "../../../src/session/index.js";

function sink() {
  const got: SessionEvent[] = [];
  const closed: string[] = [];
  return {
    got,
    closed,
    sub: {
      send: (e: SessionEvent) => {
        got.push(e);
        return true;
      },
      close: (r: string) => void closed.push(r),
    },
  };
}

describe("SessionBus", () => {
  it("stamps a monotonically increasing seq nobody else can choose", () => {
    const bus = new SessionBus("s");
    const a = bus.publish({ type: "text", text: "one" });
    const b = bus.publish({ type: "text", text: "two" });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(bus.cursor).toBe(2);
  });

  it("fans out to every subscriber", () => {
    const bus = new SessionBus("s");
    const one = sink();
    const two = sink();
    bus.subscribe(one.sub);
    bus.subscribe(two.sub);
    bus.publish({ type: "text", text: "hi" });
    expect(one.got).toHaveLength(1);
    expect(two.got).toHaveLength(1);
  });

  it("replays only what came AFTER the cursor — no duplication", () => {
    const bus = new SessionBus("s");
    bus.publish({ type: "text", text: "one" });
    bus.publish({ type: "text", text: "two" });
    bus.publish({ type: "text", text: "three" });
    const late = sink();
    const { replay, gap } = bus.subscribe(late.sub, 2);
    expect(gap).toBe(false);
    expect(replay.map((e) => (e as { text: string }).text)).toStrictEqual(["three"]);
  });

  it("replays everything on a fresh attach", () => {
    const bus = new SessionBus("s");
    bus.publish({ type: "text", text: "one" });
    const { replay, gap } = bus.subscribe(sink().sub);
    expect(replay).toHaveLength(1);
    // A fresh attach is not a failed resume, so it is not a gap.
    expect(gap).toBe(false);
  });

  // A gap the user can see is recoverable; a gap they cannot is a conversation
  // they will misread.
  it("REPORTS a gap when the cursor has fallen out of the ring", () => {
    const bus = new SessionBus("s", 3);
    for (let i = 0; i < 10; i += 1) bus.publish({ type: "text", text: `t${i}` });
    const { gap, replay } = bus.subscribe(sink().sub, 1);
    expect(gap).toBe(true);
    expect(replay).toHaveLength(3); // only what the bounded ring still holds
  });

  it("bounds the ring rather than growing without limit", () => {
    const bus = new SessionBus("s", 5);
    for (let i = 0; i < 50; i += 1) bus.publish({ type: "text", text: `t${i}` });
    expect(bus.subscribe(sink().sub).replay).toHaveLength(5);
  });

  // One phone's backpressure must not stall the agent. The ring still holds the
  // events, so dropping the client costs a reconnect, not data.
  it("drops a persistently backed-up subscriber instead of stalling", () => {
    const bus = new SessionBus("s", 10_000);
    const closed: string[] = [];
    bus.subscribe({ send: () => false, close: (r) => void closed.push(r) });
    for (let i = 0; i <= SUBSCRIBER_QUEUE_LIMIT + 1; i += 1) {
      bus.publish({ type: "text", text: `t${i}` });
    }
    expect(closed).toHaveLength(1);
    expect(closed[0]).toContain("Reconnect with Last-Event-ID");
    expect(bus.subscriberCount).toBe(0);
  });

  it("forgives a subscriber that catches up", () => {
    const bus = new SessionBus("s");
    let ok = false;
    const closed: string[] = [];
    bus.subscribe({ send: () => ok, close: (r) => void closed.push(r) });
    for (let i = 0; i < 10; i += 1) bus.publish({ type: "text", text: "x" });
    ok = true; // caught up
    for (let i = 0; i < 10; i += 1) bus.publish({ type: "text", text: "x" });
    ok = false;
    for (let i = 0; i < 10; i += 1) bus.publish({ type: "text", text: "x" });
    expect(closed).toHaveLength(0); // the counter reset on the good run
  });

  it("remembers that it ended, so a late attacher can be told at once", () => {
    const bus = new SessionBus("s");
    expect(bus.endedEvent).toBeUndefined();
    bus.publish({ type: "ended", reason: "the runner exited" });
    expect(bus.endedEvent).toMatchObject({ type: "ended", reason: "the runner exited" });
  });

  it("detaches cleanly", () => {
    const bus = new SessionBus("s");
    const s = sink();
    const { detach } = bus.subscribe(s.sub);
    detach();
    bus.publish({ type: "text", text: "after" });
    expect(s.got).toHaveLength(0);
  });
});

describe("MessageLedger", () => {
  it("remembers an id and its seq", () => {
    const ledger = new MessageLedger();
    expect(ledger.lookup("m1")).toBeUndefined();
    ledger.record("m1", 7);
    expect(ledger.lookup("m1")).toBe(7);
  });

  // A retry window, not a history.
  it("evicts oldest past capacity", () => {
    const ledger = new MessageLedger(3);
    for (const id of ["a", "b", "c", "d"]) ledger.record(id, 1);
    expect(ledger.size).toBe(3);
    expect(ledger.lookup("a")).toBeUndefined();
    expect(ledger.lookup("d")).toBe(1);
  });
});

describe("the wire", () => {
  it("frames an event with its seq as the SSE id", () => {
    const frame = sseFrame({ type: "text", seq: 42, text: "hi" });
    expect(frame).toContain("id: 42\n");
    expect(frame).toContain("event: text\n");
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(JSON.parse(frame.split("data: ")[1] as string)).toMatchObject({ seq: 42 });
  });

  it("parses both routes, and rejects everything else", () => {
    expect(parseSessionPath("/session/abc/stream")).toStrictEqual({
      sessionId: "abc",
      route: "stream",
    });
    expect(parseSessionPath("/session/abc/message")).toStrictEqual({
      sessionId: "abc",
      route: "message",
    });
    expect(parseSessionPath("/session//stream")).toBeNull();
    expect(parseSessionPath("/session/abc")).toBeNull();
    expect(parseSessionPath("/api/whoami")).toBeNull();
  });
});
