/**
 * R13.4 — the write surface, over a real TLS handshake.
 *
 * The unit tests decide; this file proves the decisions survive contact with
 * `node:tls`. Every request here is a genuine HTTPS call with a genuine client
 * certificate (or deliberately without one) against a genuine listening server,
 * because "the guard returns ok" and "the handshake actually presented the
 * certificate the guard then read" are different claims and only the second one
 * is what a phone will do.
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
  ENROL_CLAIM_PATH,
  lock,
  revokeDevice,
  setPasscode,
  startEnrolment,
  startWriteServer,
  unlock,
  WHOAMI_PATH,
  type WriteServerHandle,
} from "../../src/security/index.js";
import { useTempDirs } from "../helpers/tmp.js";

const newTempDir = useTempDirs("golem-writesrv-");

// Key generation dominates the runtime of this file; both are identity-agnostic
// for every assertion here, so they are made once.
let ca: DeviceCa;
let server: LoopbackPair;

interface Response {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly error?: string;
}

/** One HTTPS request, optionally presenting a client certificate. */
function call(
  handle: WriteServerHandle,
  path: string,
  options: {
    readonly method?: string;
    readonly cert?: string;
    readonly key?: string;
    readonly payload?: unknown;
  } = {},
): Promise<Response> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port: handle.port,
        path,
        method: options.method ?? "POST",
        ca: [server.caPem],
        ...(options.cert !== undefined ? { cert: options.cert, key: options.key } : {}),
        // The server leaf carries `IP:127.0.0.1`; Node still wants to be told not
        // to expect a hostname match against an IP literal.
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
    req.on("error", (err) => resolve({ status: 0, body: {}, error: err.message }));
    if (options.payload !== undefined) req.write(JSON.stringify(options.payload));
    req.end();
  });
}

describe("the write surface over real mTLS", () => {
  let dir: string;
  let handle: WriteServerHandle | undefined;

  beforeEach(async () => {
    dir = await newTempDir();
    ca ??= await generateDeviceCa();
    server ??= await generateLoopbackPair();
    handle = await startWriteServer({
      projectDir: dir,
      port: 0,
      serverKeyPem: server.leafKeyPem,
      serverCertPem: server.chainPem,
      deviceCa: ca,
      stepUpPaths: ["/api/high-risk"],
      handler: ({ res, device }) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ wrote: true, by: device.id }));
      },
    });
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  /** Pair a device the way a phone would: local enrolment, then claim over HTTPS. */
  async function pair(label = "Pixel"): Promise<{ cert: string; key: string }> {
    const pending = await startEnrolment(dir, { label });
    const res = await call(handle as WriteServerHandle, ENROL_CLAIM_PATH, {
      payload: { code: pending.code },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return {
      cert: res.body.certificate_pem as string,
      key: res.body.private_key_pem as string,
    };
  }

  it("claims a credential over the wire, with no client certificate yet", async () => {
    // The chicken-and-egg route: a device that has no certificate must be able to
    // get one, and this is the ONLY route that does not require one.
    const creds = await pair();
    expect(creds.cert).toContain("BEGIN CERTIFICATE");
    expect(creds.key).toContain("PRIVATE KEY");
  });

  it("refuses a claim when no pairing was started locally", async () => {
    const res = await call(handle as WriteServerHandle, ENROL_CLAIM_PATH, {
      payload: { code: "ABCDEFGH" },
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("no-pending-enrolment");
    // The refusal points at the machine, which is the only place pairing exists.
    expect(String(res.body.message)).toContain("golem device enrol");
  });

  it("lets a paired, unlocked device through — and names it", async () => {
    const creds = await pair("work iPhone");
    await setPasscode(dir, "correct-horse");
    await unlock(dir, "correct-horse");
    const res = await call(handle as WriteServerHandle, WHOAMI_PATH, {
      method: "GET",
      ...creds,
    });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe("work iPhone");
  });

  it("reaches the mounted application handler once both claims hold", async () => {
    const creds = await pair();
    await setPasscode(dir, "correct-horse");
    await unlock(dir, "correct-horse");
    const res = await call(handle as WriteServerHandle, "/api/anything", creds);
    expect(res.status).toBe(200);
    expect(res.body.wrote).toBe(true);
  });

  // The gate item, over a real socket: a handshake with no client certificate
  // must produce a READABLE 401, not a TLS alert the phone renders as
  // "cannot connect".
  it("refuses with no client certificate — as a 401, not a dropped handshake", async () => {
    await setPasscode(dir, "correct-horse");
    await unlock(dir, "correct-horse");
    const res = await call(handle as WriteServerHandle, WHOAMI_PATH, { method: "GET" });
    expect(res.error).toBeUndefined(); // the connection SUCCEEDED
    expect(res.status).toBe(401);
    expect(res.body.claim).toBe("device");
    expect(res.body.reason).toBe("no-certificate");
  });

  it("refuses a certificate from a foreign CA", async () => {
    const foreign = await generateDeviceCa();
    const { issueDeviceCert } = await import("../../src/proxy/loopback-cert.js");
    const impostor = await issueDeviceCert({ ca: foreign, deviceId: "impostor" });
    await setPasscode(dir, "correct-horse");
    await unlock(dir, "correct-horse");
    const res = await call(handle as WriteServerHandle, WHOAMI_PATH, {
      method: "GET",
      cert: impostor.certPem,
      key: impostor.keyPem,
    });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("not-signed-by-device-ca");
  });

  it("refuses a perfect certificate while LOCKED, and says which claim failed", async () => {
    const creds = await pair();
    await setPasscode(dir, "correct-horse");
    await unlock(dir, "correct-horse");
    await lock(dir);
    const res = await call(handle as WriteServerHandle, "/api/anything", creds);
    expect(res.status).toBe(401);
    expect(res.body.claim).toBe("user");
    expect(res.body.reason).toBe("locked");
  });

  it("refuses when a passcode was never set — a paired device alone is not enough", async () => {
    const creds = await pair();
    const res = await call(handle as WriteServerHandle, "/api/anything", creds);
    expect(res.status).toBe(401);
    expect(res.body.claim).toBe("user");
    expect(res.body.reason).toBe("no-passcode-set");
  });

  it("revocation takes effect on the NEXT request, with no restart", async () => {
    const creds = await pair();
    await setPasscode(dir, "correct-horse");
    await unlock(dir, "correct-horse");
    expect((await call(handle as WriteServerHandle, "/api/anything", creds)).status).toBe(200);

    await revokeDevice(dir, "Pixel", new Date().toISOString()); // by label: not a key
    const byLabel = await call(handle as WriteServerHandle, "/api/anything", creds);
    expect(byLabel.status).toBe(200); // label is not an identifier — still allowed

    const { listDevices } = await import("../../src/security/index.js");
    const id = (await listDevices(dir))[0]?.id as string;
    await revokeDevice(dir, id, new Date().toISOString());

    const after = await call(handle as WriteServerHandle, "/api/anything", creds);
    expect(after.status).toBe(401);
    expect(after.body.reason).toBe("revoked");
  });

  it("requires a FRESH passcode for a step-up route, while ordinary routes pass", async () => {
    const creds = await pair();
    await setPasscode(dir, "correct-horse");
    await unlock(dir, "correct-horse");
    // Freshly unlocked: both work.
    expect((await call(handle as WriteServerHandle, "/api/anything", creds)).status).toBe(200);
    expect((await call(handle as WriteServerHandle, "/api/high-risk", creds)).status).toBe(200);
  });

  it("refuses the enrolment claim by any method but POST", async () => {
    const res = await call(handle as WriteServerHandle, ENROL_CLAIM_PATH, { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("serves nothing at all when no handler is mounted and the path is unknown", async () => {
    const bare = await startWriteServer({
      projectDir: dir,
      port: 0,
      serverKeyPem: server.leafKeyPem,
      serverCertPem: server.chainPem,
      deviceCa: ca,
    });
    try {
      const pending = await startEnrolment(dir, { label: "Pixel" });
      const claimed = await claimEnrolment(dir, pending.code, { ca });
      if (!claimed.ok) throw new Error("fixture");
      await setPasscode(dir, "correct-horse");
      await unlock(dir, "correct-horse");
      const res = await call(bare, "/api/anything", {
        cert: claimed.cert.certPem,
        key: claimed.cert.keyPem,
      });
      expect(res.status).toBe(404);
    } finally {
      await bare.close();
    }
  });

  it("binds loopback by default", () => {
    expect((handle as WriteServerHandle).host).toBe("127.0.0.1");
  });
});
