/**
 * R13.7 — the whole path, end to end: an authenticated device sends a message,
 * and it lands on a running conversation's next request.
 *
 * Both halves of the gate are exercised against real servers rather than mocks:
 *
 * - the **device half** goes through R13.4's mutual-TLS write surface, with a
 *   real client certificate and a real unlock window, into the file-backed queue;
 * - the **delivery half** goes through the real `GolemProxy` and pipeline to a
 *   recording upstream, so the assertion is about the bytes that were actually
 *   forwarded.
 *
 * The client driving the proxy here is **not Claude Code** — it is a plain HTTP
 * client speaking `POST /v1/messages`. That is the point of §3b's
 * harness-agnostic claim, and this file is the demonstration of it: no launch
 * flag, no channel, no client cooperation, nothing the second harness had to
 * know about Golem.
 */

import https from "node:https";
import { beforeEach, describe, expect, it } from "vitest";
import { NativeLosslessCompression } from "../../src/compression/index.js";
import { policyFor } from "../../src/interfaces/policy.js";
import { createGolemPipeline } from "../../src/pipeline/index.js";
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
  createJoinedTransport,
  FileJoinQueue,
  LiveConversationRegistry,
  resetLedgers,
  sessionTransportHandler,
} from "../../src/session/index.js";
import { useTempDirs } from "../helpers/tmp.js";
import { rawRequest, startProxy, startUpstream } from "./helpers/test-servers.js";

const newTempDir = useTempDirs("golem-join-e2e-");

let ca: DeviceCa;
let tls: LoopbackPair;
let projectDir: string;

beforeEach(async () => {
  projectDir = await newTempDir();
  ca ??= await generateDeviceCa();
  tls ??= await generateLoopbackPair();
  resetLedgers();
});

/** A fake upstream that records every body it was forwarded, verbatim. */
function recordingUpstream() {
  const bodies: string[] = [];
  return {
    bodies,
    handler: (_req: unknown, res: import("node:http").ServerResponse, body: Buffer): void => {
      bodies.push(body.toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  };
}

/** The write surface a phone talks to, with a paired device and an open unlock window. */
async function writeSurface(
  registry: LiveConversationRegistry,
  injectionEnabled = true,
): Promise<{ handle: WriteServerHandle; creds: { cert: string; key: string } }> {
  // The device-facing process reads the proxy's SNAPSHOT — it observes no
  // requests itself. Flushing here stands in for the proxy having written one.
  await registry.flush();
  const joined = await createJoinedTransport({ projectDir, injectionEnabled });
  const handle = await startWriteServer({
    projectDir,
    port: 0,
    serverKeyPem: tls.leafKeyPem,
    serverCertPem: tls.chainPem,
    deviceCa: ca,
    handler: sessionTransportHandler({
      lookup: (id) => joined.lookup(id),
      listSessions: () => joined.listSessions(),
    }),
  });
  const pending = await startEnrolment(projectDir, { label: "Pixel" });
  const claim = await claimEnrolment(projectDir, pending.code, { ca });
  if (!claim.ok) throw new Error("fixture: enrolment failed");
  await setPasscode(projectDir, "correct-horse");
  await unlock(projectDir, "correct-horse");
  return { handle, creds: { cert: claim.cert.certPem, key: claim.cert.keyPem } };
}

function device(
  handle: WriteServerHandle,
  creds: { cert: string; key: string } | null,
  path: string,
  method: string,
  payload?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    const req = https.request(
      {
        host: "127.0.0.1",
        port: handle.port,
        path,
        method,
        ca: [tls.caPem],
        ...(creds !== null ? { cert: creds.cert, key: creds.key } : {}),
        checkServerIdentity: () => undefined,
        ...(data !== undefined
          ? { headers: { "content-type": "application/json", "content-length": data.length } }
          : {}),
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
    if (data !== undefined) req.write(data);
    req.end();
  });
}

/** The "second harness": any client that speaks the Messages API. */
const TURN_1 = {
  model: "claude-opus-5",
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: "start the migration" }],
};
const TURN_2 = {
  ...TURN_1,
  messages: [
    ...TURN_1.messages,
    { role: "assistant", content: "working on it" },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
  ],
};

describe("R13.7 end to end — device message onto a live conversation's next request", () => {
  it("lands on the NEXT request, exactly once, and leaves the other requests byte-identical", async () => {
    const up = recordingUpstream();
    const upstream = await startUpstream(up.handler);
    const registry = new LiveConversationRegistry({ projectDir });
    const queue = new FileJoinQueue({
      projectDir,
      resolve: async (id) => registry.addressable(id),
    });
    const proxy = await startProxy({
      upstreamBaseUrl: upstream.origin,
      pipeline: createGolemPipeline({
        compression: NativeLosslessCompression.forProjectDir(projectDir),
        policy: () => policyFor(1),
        projectId: projectDir,
        liveConversations: registry,
        joinQueue: queue,
      }),
    });
    let surface: { handle: WriteServerHandle; creds: { cert: string; key: string } } | undefined;
    try {
      // 1 — the second harness opens a conversation. Nothing is queued, so the
      // upstream must receive exactly the bytes the client sent (invariant 6).
      const firstBody = JSON.stringify(TURN_1);
      await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: firstBody,
      });
      expect(up.bodies[0]).toBe(firstBody);

      // 2 — the phone lists what it may address, and sends into it.
      surface = await writeSurface(registry);
      const listed = await device(surface.handle, surface.creds, "/sessions", "GET");
      expect(listed.status).toBe(200);
      const sessions = JSON.parse(listed.body) as {
        joined: { conversationId: string; ambiguous: boolean }[];
        injectionEnabled: boolean;
      };
      expect(sessions.injectionEnabled).toBe(true);
      expect(sessions.joined).toHaveLength(1);
      const conversationId = sessions.joined[0]?.conversationId as string;

      const sent = await device(
        surface.handle,
        surface.creds,
        `/session/${conversationId}/message`,
        "POST",
        { messageId: "from-the-sofa", text: "also update the changelog" },
      );
      expect(sent.status).toBe(200);
      const acceptance = JSON.parse(sent.body) as { status: string; condition?: string };
      // QUEUED, never "delivered": the proxy speaks only when the harness does.
      expect(acceptance.status).toBe("queued");
      expect(acceptance.condition).toContain("next request");

      // Visible to the device as waiting, before it lands.
      const queued = await device(
        surface.handle,
        surface.creds,
        `/session/${conversationId}/queue`,
        "GET",
      );
      expect(JSON.parse(queued.body).pending).toHaveLength(1);

      // 3 — the harness takes its next turn. The message lands on THIS request.
      await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(TURN_2),
      });
      const delivered = JSON.parse(up.bodies[1] as string) as {
        messages: { role: string; content: { text: string }[] }[];
      };
      expect(delivered.messages).toHaveLength(TURN_2.messages.length + 1);
      expect(delivered.messages.slice(0, 3)).toEqual(TURN_2.messages);
      const appended = delivered.messages[3];
      expect(appended?.role).toBe("user");
      expect(appended?.content[0]?.text).toContain("also update the changelog");
      expect(appended?.content[0]?.text).toContain("<golem-remote-message");

      // 4 — the next turn carries nothing extra: delivered EXACTLY once.
      const thirdBody = JSON.stringify(TURN_2);
      await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: thirdBody,
      });
      expect(up.bodies[2]).toBe(thirdBody);

      // 5 — and the device is told it landed, with when.
      const after = await device(
        surface.handle,
        surface.creds,
        `/session/${conversationId}/queue`,
        "GET",
      );
      expect(JSON.parse(after.body).pending).toHaveLength(0);
      const settled = await queue.list();
      expect(settled[0]?.deliveredAt).toBeTypeOf("string");
      expect(settled[0]?.deviceId).not.toBe("");
    } finally {
      await surface?.handle.close();
      await proxy.close();
      await upstream.close();
    }
  });

  it("a resent messageId is answered `duplicate` and delivered only once", async () => {
    const up = recordingUpstream();
    const upstream = await startUpstream(up.handler);
    const registry = new LiveConversationRegistry({ projectDir });
    const queue = new FileJoinQueue({
      projectDir,
      resolve: async (id) => registry.addressable(id),
    });
    const proxy = await startProxy({
      upstreamBaseUrl: upstream.origin,
      pipeline: createGolemPipeline({
        compression: NativeLosslessCompression.forProjectDir(projectDir),
        policy: () => policyFor(1),
        projectId: projectDir,
        liveConversations: registry,
        joinQueue: queue,
      }),
    });
    let surface: { handle: WriteServerHandle; creds: { cert: string; key: string } } | undefined;
    try {
      await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(TURN_1),
      });
      surface = await writeSurface(registry);
      const conversationId = registry.list()[0]?.conversationId as string;
      const payload = { messageId: "retried", text: "run the tests" };

      const first = await device(
        surface.handle,
        surface.creds,
        `/session/${conversationId}/message`,
        "POST",
        payload,
      );
      const retry = await device(
        surface.handle,
        surface.creds,
        `/session/${conversationId}/message`,
        "POST",
        payload,
      );
      expect(JSON.parse(first.body).status).toBe("queued");
      expect(JSON.parse(retry.body).status).toBe("duplicate");

      await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(TURN_2),
      });
      const forwarded = up.bodies[1] as string;
      // One occurrence of the text, not two: a duplicated instruction to an
      // agent is not a duplicated packet.
      expect(forwarded.split("run the tests").length - 1).toBe(1);
    } finally {
      await surface?.handle.close();
      await proxy.close();
      await upstream.close();
    }
  });

  it("refuses the send outright when injection is off, rather than queueing what will never land", async () => {
    const registry = new LiveConversationRegistry({ projectDir });
    registry.observe(TURN_1 as unknown as Record<string, unknown>);
    const surface = await writeSurface(registry, false);
    try {
      const conversationId = registry.list()[0]?.conversationId as string;
      const sent = await device(
        surface.handle,
        surface.creds,
        `/session/${conversationId}/message`,
        "POST",
        { messageId: "m1", text: "hello" },
      );
      expect(sent.status).toBe(409);
      expect(JSON.parse(sent.body).error).toContain("join_injection");
      expect(await new FileJoinQueue({ projectDir }).pending(conversationId)).toHaveLength(0);
    } finally {
      await surface.handle.close();
    }
  });

  it("does not carry a message for an UNPAIRED device at all", async () => {
    const registry = new LiveConversationRegistry({ projectDir });
    registry.observe(TURN_1 as unknown as Record<string, unknown>);
    const surface = await writeSurface(registry);
    try {
      const conversationId = registry.list()[0]?.conversationId as string;
      const sent = await device(
        surface.handle,
        null,
        `/session/${conversationId}/message`,
        "POST",
        { messageId: "m1", text: "hello" },
      );
      expect(sent.status === 0 || sent.status >= 400).toBe(true);
      expect(await new FileJoinQueue({ projectDir }).pending(conversationId)).toHaveLength(0);
    } finally {
      await surface.handle.close();
    }
  });
});
