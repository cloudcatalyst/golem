/**
 * Mount mTLS authentication middleware onto a GoLem proxy server.
 *
 * Wraps the request handler so that every POST to an Anthropic write surface
 * requires:
 *   1. A valid client certificate signed by the constrained loopback CA.
 *   2. An active user-factor session (passcode window).
 * GET requests pass through unauthenticated (observe tier — ADR-0006).
 *
 * Invariant: enrollment is local-only, forever. There is no relay-mediated
 * pairing and no message type for one.
 */

import crypto, { type X509Certificate, createHash } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";

import { loadDevice, isDeviceRevoked } from "../security/device-credentials.js";
import { DEVICE_CN_PREFIX } from "../security/device-cert-builder.js";
import { checkStatus } from "../security/user-factor.js";

export interface MtlsAuthConfig {
  /** Project root under which the device catalog lives (.golem/devices/). */
  readonly projectDir: string;
  /** User home directory under which the user-factor session lives. */
  readonly userDir: string;
  /** PEM-encoded trusted CA cert used to verify client certificates. */
  readonly trustedCaCert: string;
}

/** Return true when the request targets a writable Anthropic surface. */
export function isWriteSurface(req: IncomingMessage): boolean {
  return req.method === "POST";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function respondUnauth(
  res: ServerResponse,
  reason: string,
): void {
  if (res.headersSent) return;
  const body = JSON.stringify({ error: reason });
  res.writeHead(401, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Extract the full peer leaf cert as PEM from Node's tls socket.
 * `getPeerCertificate(true)` returns raw DER in .raw; we re-wrap it.
 */
function peerCertAsPem(socket: TLSSocket | typeof IncomingMessage.prototype.socket): string | null {
  if (!socket || typeof (socket as TLSSocket).getPeerCertificate !== "function") return null;
  try {
    const raw = (socket as TLSSocket).getPeerCertificate(true)?.raw;
    if (!raw || !Buffer.isBuffer(raw)) return null;
    const b64 = raw.toString("base64");
    const line = b64.replace(/(.{64})/g, "$1\n").trimEnd();
    return `-----BEGIN CERTIFICATE-----\n${line}\n-----END CERTIFICATE-----`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Replace the server's 'request' listener with one that gates POST endpoints.
 *
 * Read-only endpoints (GET) pass through immediately. Write surfaces first:
 * 1. Validate the client certificate against the known CA.
 * 2. Check that the cert CN matches the GoLem device convention.
 * 3. Load the device record and confirm it is not revoked / expired.
 * 4. Confirm the user-factor session is active.
 * On any failure the request receives a 401 explaining what was missing.
 */
export function mountMtlsAuth(
  server: Server<typeof IncomingMessage, typeof ServerResponse>,
  config: MtlsAuthConfig,
): void {
  let caX509: X509Certificate;
  try {
    caX509 = new crypto.X509Certificate(config.trustedCaCert);
  } catch {
    throw new Error(
      "[mTLS] provided trustedCaCert is not a valid X.509 PEM certificate",
    );
  }

  // Snapshot the existing handler(s) so we delegate after auth passes.
  const originalHandlers = server.listeners("request") as Array<
    (req: IncomingMessage, res: ServerResponse) => void
  >;
  if (originalHandlers.length === 0) {
    throw new Error(
      "[mTLS] cannot mount: the server has no 'request' listener attached",
    );
  }

  server.removeAllListeners("request");

  server.on("request", async (req, res) => {
    // Read surface — always allowed.
    if (!isWriteSurface(req)) {
      for (const h of originalHandlers) h(req, res);
      return;
    }

    // --- 1. Client certificate extraction ---
    const peerPem = peerCertAsPem(req.socket);
    if (!peerPem) {
      respondUnauth(res, "no client certificate presented");
      return;
    }

    let clientCert: X509Certificate;
    try {
      clientCert = new crypto.X509Certificate(peerPem);
    } catch {
      respondUnauth(res, "client certificate could not be parsed");
      return;
    }

    // --- 2. Verify against the known CA ---
    const verified = clientCert.verify(caX509.publicKey);
    if (!verified) {
      respondUnauth(res, "certificate not signed by the trusted GoLem CA");
      return;
    }

    // --- 3. CN format check ---
    const subjectLines = clientCert.subject.split(",");
    const cnEntry = subjectLines.find((line) => line.startsWith("CN="));
    const cn = cnEntry ? cnEntry.slice(3) : "";
    if (!cn.startsWith(DEVICE_CN_PREFIX)) {
      respondUnauth(res, "certificate CN does not match a registered device");
      return;
    }

    // --- 4. Device lookup and revocation check ---
    // Scan the catalog looking for this cert's SHA-256 fingerprint.
    // Compare .fingerprint directly — identical X509Certificate → identical string.
    const fingerprint = clientCert.fingerprint;
    const deviceRecord = await findDeviceByFingerprint(
      config.projectDir,
      fingerprint,
    );

    if (!deviceRecord) {
      respondUnauth(res, "certificate not found in device catalog");
      return;
    }

    if (await isDeviceRevoked(config.projectDir, deviceRecord.deviceId)) {
      respondUnauth(res, "device has been revoked");
      return;
    }

    const certExpiry = new Date(clientCert.validTo);
    if (certExpiry <= new Date()) {
      respondUnauth(res, "client certificate has expired");
      return;
    }

    // --- 5. User-factor session ---
    const ufStatus = await checkStatus(config.userDir);
    if (ufStatus !== "granted") {
      respondUnauth(
        res,
        `user session required for writes (current state: ${ufStatus})`,
      );
      return;
    }

    // All checks passed — delegate to the real handler.
    for (const h of originalHandlers) h(req, res);
  });
}

/** Scan the device catalog looking for a matching cert fingerprint. */
async function findDeviceByFingerprint(
  projectDir: string,
  targetFingerprint: string,
): Promise<{ deviceId: string } | null> {
  const fs = await import("node:fs/promises");
  const { devicesDir } = await import("../security/device-catalog.js");
  const catPath = `${devicesDir(projectDir)}/catalog.json`;

  try {
    const raw = await fs.readFile(catPath, "utf8");
    const catalog = JSON.parse(raw) as {
      v: number;
      entries: Record<string, { certPem?: string; revoked?: boolean }>;
    };
    for (const [id, entry] of Object.entries(catalog.entries)) {
      if (!entry.certPem) continue;
      const cert = new crypto.X509Certificate(entry.certPem);
      const certFingerprint = cert.fingerprint.replace("SHA256:", "");
      if (certFingerprint === targetFingerprint) {
        return { deviceId: id };
      }
    }
  } catch {
    // Empty or corrupt catalog — no match.
  }
  return null;
}
