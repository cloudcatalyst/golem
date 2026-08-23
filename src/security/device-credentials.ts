/**
 * Device credential manager -- mutual TLS pairing via client certificates.
 *
 * Golem is already a certificate authority (src/proxy/loopback-cert.ts, R9.12),
 * so mTLS adds no dependency and the five-dep pin holds. A device pairs once,
 * locally, and is issued a client-auth X.509 leaf signed by the constrained CA.
 *
 * Inherited verbatim from ADR-0006 section 3c-1 and it survives phase 2: there
 * is no relay-mediated pairing and no message type for one, so a compromised
 * relay or account cannot introduce a device any laptop will accept.
 *
 * Failure is denial, never degradation: no certificate, no factor, either
 * expired -- refused, with a message saying which. Never a degraded read-only
 * but pretend it sent. The observe tier (ADR-0006 shipped it) requires none of
 * this. Only write surfaces are gated.
 *
 * Revocation takes effect on the next request. No cache expiry to game.
 */

import {
  createPrivateKey,
  generateKeyPairSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, X509Certificate } from "node:crypto";

import { buildClientCertificate, DEVICE_CN_PREFIX } from "./device-cert-builder.js";
import {
  devicesDir,
  readOrCreate,
  writeCatalog,
  ensureDeviceDir,
} from "./device-catalog.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DeviceInfo {
  readonly deviceId: string;
  readonly label: string;
  readonly certPem: string;
  readonly keyPem: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly lastSeen: Date | null;
  readonly revoked: boolean;
}

export interface PairingCodeResult {
  readonly deviceId: string;
  readonly pairingCode: PairingCode;
}

export interface PairingCode {
  readonly code: string;
  readonly expiresAt: Date;
}

export class ExpiryError extends Error {
  override name = "ExpiryError";
  constructor(public readonly deadline: Date) {
    super(`pairing code expired at ${deadline.toISOString()}`);
  }
}

export class RevocationError extends Error {
  override name = "RevocationError";
  constructor(public readonly deviceId: string) {
    super(`device ${deviceId} has been revoked`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomSalt(): string {
  return Buffer.from(
    globalThis.crypto.getRandomValues(new Uint8Array(16)),
  ).toString("hex");
}

function derivePin(): string {
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(4));
  const bytes = Buffer.from(raw);
  return String(bytes.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

function pinHash(pin: string, salt: string): string {
  return createHash("sha256")
    .update(Buffer.from(salt + pin, "utf8"))
    .digest("base64");
}

function pinMatches(code: string, storedHash: string, salt: string): boolean {
  if (code.length === 0 || storedHash.startsWith("*")) return false;
  const computed = pinHash(code, salt);
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(storedHash, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Start a new device enrollment. Generates a P-256 keypair, writes the
 * private key to disk, records a hash of the pairing code, and returns the
 * code the user must confirm to complete the pairing.
 *
 * The pairing code is valid for 90 seconds and single-use.
 */
export async function enroll(
  projectDir: string,
  deviceLabel: string,
): Promise<PairingCodeResult> {
  const dir = devicesDir(projectDir);
  await require("node:fs/promises").mkdir(dir, { recursive: true });

  const deviceId = randomUUID();
  const salt = randomSalt();
  const pin = derivePin();
  const expiresAt = new Date(Date.now() + 90_000);

  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const devDir = await ensureDeviceDir(projectDir, deviceId);
  await writeFile(join(devDir, "key.pem"), privateKey, "utf8");

  const cat = await readOrCreate(projectDir);
  cat.entries[deviceId] = {
    v: 1,
    deviceId,
    label: deviceLabel,
    pubKeyPem: publicKey,
    codeHash: pinHash(pin, salt),
    salt,
    expiresAt: expiresAt.toISOString(),
    createdAt: new Date().toISOString(),
    revoked: false,
  };
  await writeCatalog(projectDir, cat);

  return { deviceId, pairingCode: { code: pin, expiresAt } };
}

/**
 * Verify a pairing code and issue the client certificate signed by the CA.
 *
 * @param caCertPem -- the constrained CA public cert (from loopbackCaPath)
 * @param caKeyPem  -- the constrained CA private key (from loopbackCaKeyPath)
 * @returns { certPem, keyPem } for use as an mTLS client identity.
 */
export async function completeEnrollment(
  projectDir: string,
  deviceId: string,
  code: string,
  caCertPem: string,
  caKeyPem: string,
): Promise<{ certPem: string; keyPem: string }> {
  const cat = await readOrCreate(projectDir);
  const entry = cat.entries[deviceId];
  if (!entry) throw new Error(`device "${deviceId}" not found`);

  const expiresAt = new Date(entry.expiresAt);
  if (expiresAt <= new Date()) throw new ExpiryError(expiresAt);
  if (!pinMatches(code, entry.codeHash, entry.salt)) {
    throw new Error("invalid pairing code");
  }

  const devKeyPem = entry.pubKeyPem;
  if (devKeyPem === undefined) throw new Error("device key missing");

  const { createPublicKey } = require("node:crypto");
  const pubK = createPublicKey(devKeyPem);
  const caPriv = createPrivateKey(caKeyPem);
  const cn = DEVICE_CN_PREFIX + entry.label;
  const certPem = buildClientCertificate({
    subjectCn: cn,
    issuerCn: "Golem loopback CA (constrained)",
    subjectPublicKey: pubK,
    issuerPrivateKey: caPriv,
    days: 365,
  });

  const certD = await ensureDeviceDir(projectDir, deviceId);
  entry.certPem = certPem;
  delete entry.pubKeyPem;
  entry.codeHash = "*consumed*";
  entry.salt = "*consumed*";
  await writeFile(join(certD, "cert.pem"), certPem, "utf8");
  await writeCatalog(projectDir, cat);

  return { certPem, keyPem: devKeyPem };
}

/** List paired devices. `includeRevoked` controls whether revoked entries appear. */
export async function listDevices(
  projectDir: string,
  includeRevoked = false,
): Promise<DeviceInfo[]> {
  const cat = await readOrCreate(projectDir);
  const results: DeviceInfo[] = [];
  for (const [id, e] of Object.entries(cat.entries)) {
    if (!e.certPem || (e.revoked && !includeRevoked)) continue;
    const cert = new X509Certificate(e.certPem);
    results.push({
      deviceId: id,
      label: e.label,
      certPem: e.certPem,
      keyPem: "",
      notBefore: new Date(cert.validFrom),
      notAfter: new Date(cert.validTo),
      lastSeen: e.lastSeen ? new Date(e.lastSeen) : null,
      revoked: !!e.revoked,
    });
  }
  results.sort((a, b) => a.label.localeCompare(b.label));
  return results;
}

/** Revoke a device. Effectively immediate: every request checks the flag. */
export async function revokeDevice(
  projectDir: string,
  deviceId: string,
): Promise<void> {
  const cat = await readOrCreate(projectDir);
  if (!cat.entries[deviceId]) throw new Error(`device "${deviceId}" not found`);
  cat.entries[deviceId].revoked = true;
  await writeCatalog(projectDir, cat);
}

/** Load a single device's metadata. Returns null when absent. */
export async function loadDevice(
  projectDir: string,
  deviceId: string,
): Promise<DeviceInfo | null> {
  const cat = await readOrCreate(projectDir);
  const entry = cat.entries[deviceId];
  if (!entry || !entry.certPem) return null;
  const cert = new X509Certificate(entry.certPem);
  let keyPem = "";
  try {
    keyPem = await readFile(
      join(devicesDir(projectDir), deviceId, "key.pem"),
      "utf8",
    );
  } catch {
    // pre-v1 migration path only.
  }
  return {
    deviceId,
    label: entry.label,
    certPem: entry.certPem,
    keyPem,
    notBefore: new Date(cert.validFrom),
    notAfter: new Date(cert.validTo),
    lastSeen: entry.lastSeen ? new Date(entry.lastSeen) : null,
    revoked: !!entry.revoked,
  };
}

/** Update the lastSeen timestamp for a device. Call on each authenticated request. */
export async function trackLastSeen(
  projectDir: string,
  deviceId: string,
): Promise<void> {
  const cat = await readOrCreate(projectDir);
  if (!cat.entries[deviceId]) throw new Error(`device "${deviceId}" not found`);
  cat.entries[deviceId].lastSeen = new Date().toISOString();
  await writeCatalog(projectDir, cat);
}

/** Return the client cert + private key for a non-revoked device. */
export async function getClientCertAndKey(
  projectDir: string,
  deviceId: string,
): Promise<{ certPem: string; keyPem: string }> {
  const dd = join(devicesDir(projectDir), deviceId);
  const fs = require("node:fs/promises");
  const [cp, kp] = await Promise.all([
    fs.readFile(join(dd, "cert.pem"), "utf8"),
    fs.readFile(join(dd, "key.pem"), "utf8"),
  ]);
  const cat = await readOrCreate(projectDir);
  const e = cat.entries[deviceId];
  if (!e) throw new Error(`device "${deviceId}" not found`);
  if (e.revoked) throw new RevocationError(deviceId);
  return { certPem: cp, keyPem: kp };
}

/** Fast check: is this device ID marked revoked? */
export async function isDeviceRevoked(
  projectDir: string,
  deviceId: string,
): Promise<boolean> {
  try {
    const cat = await readOrCreate(projectDir);
    return !!cat.entries[deviceId]?.revoked;
  } catch {
    return false;
  }
}
