/**
 * R13.4 — the write surface: HTTPS with mutual TLS, gated by the write guard.
 *
 * This is a SEPARATE server from the observe-tier dashboard (R12.5), on its own
 * port, and that separation is the design rather than an accident of layout:
 *
 *   * the dashboard is plain HTTP, optionally LAN-bound, and has **no write
 *     route at all** — an unpaired browser still gets it, which is R13.4's gate
 *     item "an unpaired browser still gets the read-only dashboard";
 *   * this server requires a client certificate for everything except the one
 *     enrolment-claim route, and refuses rather than degrades.
 *
 * Merging them would mean one process where "read-only" is a property of a route
 * table instead of a property of the server, and route tables grow.
 *
 * ## Why `rejectUnauthorized: false`
 *
 * With `requestCert: true, rejectUnauthorized: true`, Node terminates a bad
 * client certificate during the handshake. The phone then shows "cannot connect
 * to server" — indistinguishable, to the person holding it, from Golem being
 * off, the Wi-Fi being wrong, or the port being closed. Turning it off moves the
 * decision into {@link authorizeWrite}, which answers with a 401 that says
 * *which* claim failed. The certificate is not trusted any less: it is verified
 * explicitly by `verifyDeviceCert` on every request, and no route runs before
 * the guard except the enrolment claim.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import type { DeviceCa } from "../proxy/loopback-cert.js";
import type { DeviceRecord } from "./device-store.js";
import { claimEnrolment, normaliseCode } from "./enrolment.js";
import { authorizeWrite, denialMessage } from "./write-guard.js";

/** The one route that does not require a client certificate. */
export const ENROL_CLAIM_PATH = "/enrol/claim";

/** Identity echo — the smallest possible authenticated route, and a real one. */
export const WHOAMI_PATH = "/api/whoami";

/** Largest body this server will read. An enrolment claim is a few dozen bytes. */
const MAX_BODY_BYTES = 8 * 1024;

/** A request that has already passed the guard. */
export interface AuthenticatedRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly device: DeviceRecord;
  readonly body: string;
}

export interface WriteServerOptions {
  readonly projectDir: string;
  readonly port: number;
  /** Defaults to loopback; the companion app needs the LAN bind. */
  readonly host?: string;
  /** Server TLS identity — the loopback pair, or any key/cert the device trusts. */
  readonly serverKeyPem: string;
  readonly serverCertPem: string;
  /** The device CA, for verifying and for issuing during an enrolment claim. */
  readonly deviceCa: DeviceCa;
  /**
   * The application R13.5+ mounts behind the guard. Everything it receives has
   * already presented a valid, unrevoked device certificate AND a live user
   * factor. Absent means only {@link WHOAMI_PATH} is served, which is enough to
   * demonstrate the gate and nothing more.
   */
  readonly handler?: (request: AuthenticatedRequest) => Promise<void> | void;
  /** Routes needing a freshly-entered passcode (gate-map item 5). */
  readonly stepUpPaths?: readonly string[];
  readonly nowMs?: () => number;
}

export interface WriteServerHandle {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The peer certificate as PEM, or `null` when none was presented.
 *
 * `getPeerCertificate()` returns a parsed object with a `raw` DER buffer;
 * `verifyDeviceCert` wants PEM, so the DER is re-wrapped here rather than
 * trusting the parsed object's fields — the parsed `subject` is convenient and
 * is exactly the sort of thing that should not be the basis of an authorization
 * decision when the signed bytes are right there.
 */
export function peerCertificatePem(socket: TLSSocket): string | null {
  const peer = socket.getPeerCertificate();
  if (peer === null || peer.raw === undefined || peer.raw.length === 0) return null;
  const b64 = peer.raw.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN CERTIFICATE-----\n${b64}${b64.endsWith("\n") ? "" : "\n"}-----END CERTIFICATE-----\n`;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

export async function startWriteServer(options: WriteServerOptions): Promise<WriteServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const now = options.nowMs ?? Date.now;
  const stepUpPaths = options.stepUpPaths ?? [];

  const server = https.createServer(
    {
      key: options.serverKeyPem,
      cert: options.serverCertPem,
      ca: [options.deviceCa.caPem],
      requestCert: true,
      // See the module header: a handshake-level rejection is unreadable on a
      // phone. The certificate is still verified, explicitly, per request.
      rejectUnauthorized: false,
    },
    (req, res) => {
      void handle(req, res).catch(() => {
        if (!res.headersSent) json(res, 500, { error: "internal error" });
      });
    },
  );

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "https://localhost");
    const nowMs = now();

    // --- the one unauthenticated route ------------------------------------
    // It can only succeed because a human ran `golem device enrol` locally in
    // the last few minutes. With no pending enrolment on disk there is nothing
    // to check a code against and every request is refused. See enrolment.ts.
    if (url.pathname === ENROL_CLAIM_PATH) {
      if (req.method !== "POST") {
        json(res, 405, { error: "method not allowed" });
        return;
      }
      let code = "";
      try {
        const parsed: unknown = JSON.parse(await readBody(req));
        if (typeof parsed === "object" && parsed !== null && "code" in parsed) {
          code = normaliseCode(String((parsed as { code: unknown }).code));
        }
      } catch {
        json(res, 400, { error: "expected a JSON body with a `code`" });
        return;
      }
      const claim = await claimEnrolment(options.projectDir, code, {
        ca: options.deviceCa,
        nowMs,
      });
      if (!claim.ok) {
        json(res, 401, {
          error: claim.reason,
          message:
            claim.reason === "no-pending-enrolment"
              ? "No pairing is open. Run `golem device enrol` on the machine running Golem."
              : claim.reason === "expired"
                ? "That pairing code has expired. Start a new one with `golem device enrol`."
                : "That code is not right.",
        });
        return;
      }
      json(res, 200, {
        device_id: claim.deviceId,
        label: claim.label,
        certificate_pem: claim.cert.certPem,
        private_key_pem: claim.cert.keyPem,
        ca_pem: options.deviceCa.caPem,
        fingerprint: claim.cert.fingerprint,
        not_after: claim.cert.notAfter.toISOString(),
      });
      return;
    }

    // --- everything else is behind BOTH claims ----------------------------
    const auth = await authorizeWrite({
      projectDir: options.projectDir,
      peerCertPem: peerCertificatePem(req.socket as TLSSocket),
      deviceCaPem: options.deviceCa.caPem,
      requireFreshFactor: stepUpPaths.includes(url.pathname),
      nowMs,
    });
    if (!auth.ok) {
      json(res, 401, {
        error: `${auth.denial.claim}:${auth.denial.reason}`,
        claim: auth.denial.claim,
        reason: auth.denial.reason,
        message: denialMessage(auth.denial),
      });
      return;
    }

    if (url.pathname === WHOAMI_PATH) {
      json(res, 200, {
        device_id: auth.device.id,
        label: auth.device.label,
        fingerprint: auth.device.fingerprint,
      });
      return;
    }

    if (options.handler === undefined) {
      json(res, 404, { error: "not found" });
      return;
    }
    await options.handler({ req, res, device: auth.device, body: await readBody(req) });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  return {
    port,
    host,
    url: `https://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
