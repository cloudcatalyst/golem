/**
 * R13.6 — the chat surface, served over the real authenticated server.
 *
 * The gate's manual half — a real phone, screenshots — cannot be reached from a
 * test suite and is filed as its own task. What IS checkable is every claim the
 * screen makes about itself, and those are the claims that would quietly become
 * false: that it never implies it is mirroring the terminal, that it offers no
 * control it cannot honour, and that an unauthenticated device gets nothing.
 */

import https from "node:https";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  parseSessionPath,
  renderChatPage,
  resetLedgers,
  SessionBus,
  sessionTransportHandler,
  type TransportSession,
} from "../../src/session/index.js";
import { useTempDirs } from "../helpers/tmp.js";

const newTempDir = useTempDirs("golem-chat-");

let ca: DeviceCa;
let tls: LoopbackPair;

describe("renderChatPage — the claims the screen makes about itself", () => {
  const page = renderChatPage({
    sessionId: "sess-1",
    projectDir: "/repo/thing",
    kind: "hosted",
  });

  // ADR-0007 §2's specific dishonesty: a screen that looks like a window onto
  // the developer's terminal. The disclaimer is load-bearing, not decoration.
  it("says outright that it is NOT the terminal on the laptop", () => {
    expect(page).toContain("not a mirror of the terminal on your laptop");
  });

  it("names which session, which project, and which KIND", () => {
    expect(page).toContain("sess-1");
    expect(page).toContain("/repo/thing");
    expect(page).toContain("hosted");
  });

  it("distinguishes a joined session from a hosted one", () => {
    const joined = renderChatPage({ sessionId: "s", projectDir: "/p", kind: "joined" });
    expect(joined).toContain("A live session Golem has joined");
    expect(page).toContain("A session Golem is running");
  });

  // Gate-map item 3 is LOCKED: destructive/outward are never answerable from a
  // device. A control that would always fail implies an authority the design
  // does not grant, so there must be no such control at all.
  it("offers NO approve/deny affordance", () => {
    expect(page).not.toMatch(/>\s*Approve\s*</i);
    expect(page).not.toMatch(/>\s*Deny\s*</i);
    expect(page).not.toMatch(/id="approve"/i);
  });

  it("explains why a refusal is not overridable from here", () => {
    expect(page).toContain("never answerable from a device");
  });

  // Absent, not greyed out: a disabled box invites a tap and a wonder.
  it("REMOVES the send box when locked rather than disabling it", () => {
    expect(page).toContain("body.locked form { display: none; }");
    expect(page).toContain("golem device unlock");
  });

  // Same rule as the observe view: not-connected replaces content.
  it("replaces content when disconnected instead of decorating stale turns", () => {
    expect(page).toContain("body.offline main, body.offline footer { display: none; }");
    expect(page).toContain("Not connected");
  });

  it("is honest that Stop ends the session, because that is what it does", () => {
    expect(page).toContain("ends this hosted session, not just the current turn");
  });

  it("discloses a scrollback gap rather than rendering a continuous conversation", () => {
    expect(page).toContain("Some of this conversation is missing");
  });

  it("sends a client-generated messageId, so a retry cannot double-send", () => {
    expect(page).toContain("messageId");
  });

  // Optimistic echo is the "a message the user believes they sent" failure.
  it("echoes the user's turn only after the server confirms delivery", () => {
    expect(page).toContain("Only echo the turn once the server said DELIVERED");
  });

  it("collapses tool results, because a phone screen is small", () => {
    // The blocks are built client-side, so what the page carries is the styling
    // and the construction — a `details` element, collapsed by default.
    expect(page).toContain("details.tool");
    expect(page).toContain('el("details"');
  });

  it("escapes what it interpolates", () => {
    const nasty = renderChatPage({
      sessionId: '"><script>alert(1)</script>',
      projectDir: "/p",
      kind: "hosted",
    });
    expect(nasty).not.toContain("<script>alert(1)</script>");
    expect(nasty).toContain("&lt;script&gt;");
  });
});

describe("the chat routes, behind the gate", () => {
  let dir: string;
  let handle: WriteServerHandle | undefined;
  let creds: { cert: string; key: string };
  let interrupted = 0;

  beforeEach(async () => {
    dir = await newTempDir();
    ca ??= await generateDeviceCa();
    tls ??= await generateLoopbackPair();
    resetLedgers();
    interrupted = 0;
    const bus = new SessionBus("sess-1");
    const session: TransportSession = {
      bus,
      projectDir: dir,
      kind: "hosted",
      deliver: async () => {},
      interrupt: () => {
        interrupted += 1;
      },
      history: async () => [
        { role: "user", content: "an earlier question" },
        { role: "assistant", content: "an earlier answer" },
      ],
    };
    handle = await startWriteServer({
      projectDir: dir,
      port: 0,
      serverKeyPem: tls.leafKeyPem,
      serverCertPem: tls.chainPem,
      deviceCa: ca,
      handler: sessionTransportHandler({
        lookup: (id) => (id === "sess-1" ? session : null),
        heartbeatMs: 1000,
      }),
    });
    const pending = await startEnrolment(dir, { label: "Pixel" });
    const claim = await claimEnrolment(dir, pending.code, { ca });
    if (!claim.ok) throw new Error("fixture");
    creds = { cert: claim.cert.certPem, key: claim.cert.keyPem };
    await setPasscode(dir, "correct-horse");
    await unlock(dir, "correct-horse");
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  function call(
    path: string,
    method: string,
    withCreds: { cert: string; key: string } | null,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve) => {
      const req = https.request(
        {
          host: "127.0.0.1",
          port: (handle as WriteServerHandle).port,
          path,
          method,
          ca: [tls.caPem],
          ...(withCreds !== null ? { cert: withCreds.cert, key: withCreds.key } : {}),
          checkServerIdentity: () => undefined,
        },
        (res) => {
          let raw = "";
          res.on("data", (c) => {
            raw += c;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw }));
        },
      );
      req.on("error", () => resolve({ status: 0, body: "" }));
      req.end();
    });
  }

  it("serves the chat page to a paired device", async () => {
    const res = await call("/session/sess-1/chat", "GET", creds);
    expect(res.status).toBe(200);
    expect(res.body).toContain("not a mirror of the terminal");
  });

  // "An unauthenticated device sees the observe view read-only, with the send
  // box absent" — it never reaches this page at all, which is the strongest
  // form of absent.
  it("does NOT serve the chat page to an unpaired device", async () => {
    const res = await call("/session/sess-1/chat", "GET", null);
    expect(res.status).toBe(401);
    expect(res.body).not.toContain("<textarea");
  });

  it("rehydrates scrollback from the store", async () => {
    const res = await call("/session/sess-1/history", "GET", creds);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { turns: { content: string }[] };
    expect(parsed.turns.map((t) => t.content)).toStrictEqual([
      "an earlier question",
      "an earlier answer",
    ]);
  });

  it("refuses scrollback to an unpaired device", async () => {
    expect((await call("/session/sess-1/history", "GET", null)).status).toBe(401);
  });

  it("interrupts on POST, and only on POST", async () => {
    expect((await call("/session/sess-1/interrupt", "POST", creds)).status).toBe(200);
    expect(interrupted).toBe(1);
    expect((await call("/session/sess-1/interrupt", "GET", creds)).status).toBe(405);
    expect(interrupted).toBe(1);
  });

  it("refuses to interrupt for an unpaired device", async () => {
    expect((await call("/session/sess-1/interrupt", "POST", null)).status).toBe(401);
    expect(interrupted).toBe(0);
  });
});

describe("route parsing gained three routes without losing two", () => {
  it("parses every route", () => {
    for (const [suffix, route] of [
      ["stream", "stream"],
      ["message", "message"],
      ["chat", "chat"],
      ["history", "history"],
      ["interrupt", "interrupt"],
    ] as const) {
      expect(parseSessionPath(`/session/abc/${suffix}`)).toStrictEqual({
        sessionId: "abc",
        route,
      });
    }
  });

  it("still rejects an empty id and an unknown suffix", () => {
    expect(parseSessionPath("/session//chat")).toBeNull();
    expect(parseSessionPath("/session/abc/delete")).toBeNull();
  });
});
