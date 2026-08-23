/**
 * Device credential store — mTLS client certificate lifecycle for paired devices.
 *
 * A device pairs once, locally (invariant 8), and is issued a client certificate.
 * The server requires and verifies a client certificate on every write endpoint.
 * Certificates are enumerable, revocable with immediate effect, and carry a
 * device label and last-seen so a stale one is visible.
 *
 * Invariant: **Enrolment is local-only, forever.** There is no relay-mediated
 * pairing and no message type for one, so a compromised relay or account cannot
 * introduce a device any laptop will accept.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { generateSelfSignedLeaf } from "./loopback-cert.js";

// ---------------------------------------------------------------------------
// Types & schema
// ---------------------------------------------------------------------------

/** Duration in days before cert expiry; default 365. */
const DEFAULT_CERT_DAYS = 365;

export interface DeviceMetadata {
  readonly deviceId: string;
  readonly label: string;
  readonly notAfter: string; // ISO
  readonly createdAt: string; // ISO
  readonly lastSeen: string; // ISO
  readonly revoked: boolean;
}

export interface DeviceCertificate {
  readonly certPath: string;
  readonly keyPath: string;
  readonly certPem: string;
  readonly keyPem: string;
}

const metadataSchema = z.object({
  deviceId: z.string().min(1),
  label: z.string().min(1),
  notAfter: z.string(),
  createdAt: z.string(),
  lastSeen: z.string(),
  revoked: z.boolean(),
});

type RawMetadata = z.infer<typeof metadataSchema>;

// ---------------------------------------------------------------------------
// Storage paths
// ---------------------------------------------------------------------------

/** `.golem/state/devices/` — parent for per-device directories. */
export function devicesStateDir(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "devices");
}

/** Full path to a device's directory. */
function deviceDir(projectDir: string, deviceId: string): string {
  return path.join(devicesStateDir(projectDir), deviceId);
}

function certPath(projectDir: string, deviceId: string): string {
  return path.join(deviceDir(projectDir, deviceId), "cert.pem");
}

function keyPath(projectDir: string, deviceId: string): string {
  return path.join(deviceDir(projectDir, deviceId), "key.pem");
}

function metaPath(projectDir: string, deviceId: string): string {
  return path.join(deviceDir(projectDir, deviceId), "metadata.json");
}

// ---------------------------------------------------------------------------
// Certificate issuance
// ---------------------------------------------------------------------------

/**
 * Issue a client certificate for a new device pairing.
 *
 * Generates a self-signed leaf scoped to loopback SANs (same CA constraints
 * as the loopback serve cert), saves it alongside its private key, and writes
 * device metadata.
 */
export async function issueDeviceCertificate(
  deviceId: string,
  label: string,
  projectDir: string,
  opts?: { caCertPem?: string; caKeyPem?: string; days?: number },
): Promise<DeviceCertificate> {
  const nowMs = Date.now();
  const notAfterDays = opts?.days ?? DEFAULT_CERT_DAYS;

  const leaf = generateSelfSignedLeaf({
    dnsNames: ["localhost"],
    ipAddresses: ["127.0.0.1"],
    nowMs,
  });

  const dir = deviceDir(projectDir, deviceId);
  await mkdir(dir, { recursive: true });

  const cPath = certPath(projectDir, deviceId);
  const kPath = keyPath(projectDir, deviceId);
  const mPath = metaPath(projectDir, deviceId);

  await Promise.all([
    writeFile(cPath, leaf.certPem, { encoding: "utf8", mode: 0o644 }),
    writeFile(kPath, leaf.keyPem, { encoding: "utf8", mode: 0o600 }),
  ]);

  const created = new Date(nowMs).toISOString();
  const meta: RawMetadata = {
    deviceId,
    label,
    notAfter: leaf.notAfter.toISOString(),
    createdAt: created,
    lastSeen: created,
    revoked: false,
  };
  await writeFile(mPath, JSON.stringify(meta, null, 2) + "\n", "utf8");

  return {
    certPath: cPath,
    keyPath: kPath,
    certPem: leaf.certPem,
    keyPem: leaf.keyPem,
  };
}

// ---------------------------------------------------------------------------
// Metadata reads / writes
// ---------------------------------------------------------------------------

async function readRawMetadata(projectDir: string, deviceId: string): Promise<RawMetadata | null> {
  try {
    const raw = await readFile(metaPath(projectDir, deviceId), "utf8");
    const parsed = metadataSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Read device metadata. Returns null when missing, malformed, or revoked.
 * Only non-revoked devices are considered valid.
 */
export async function getDeviceMetadata(
  projectDir: string,
  deviceId: string,
): Promise<DeviceMetadata | null> {
  const raw = await readRawMetadata(projectDir, deviceId);
  if (!raw || raw.revoked) return null;
  return { ...raw };
}

/** List all non-revoked paired devices, newest first. */
export async function listDevices(projectDir: string): Promise<DeviceMetadata[]> {
  const devicesDir = devicesStateDir(projectDir);
  try {
    const entries = await readdirSorted(devicesDir);
    const result: DeviceMetadata[] = [];
    for (const name of entries) {
      const meta = await readRawMetadata(projectDir, name);
      if (meta && !meta.revoked) {
        result.push({ ...meta });
      }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

/** Generate a fresh device ID. */
export function generateDeviceId(): string {
  return randomBytes(16).toString("hex");
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/** Mark a device as revoked. Takes effect on next request. */
export async function revokeDevice(projectDir: string, deviceId: string): Promise<boolean> {
  const raw = await readRawMetadata(projectDir, deviceId);
  if (!raw || raw.revoked) return false;
  const updated: RawMetadata = { ...raw, revoked: true };
  await writeFile(metaPath(projectDir, deviceId), JSON.stringify(updated, null, 2) + "\n", "utf8");
  return true;
}

/** Update the last-seen timestamp. No-op if device absent. */
export async function touchLastSeen(projectDir: string, deviceId: string): Promise<void> {
  const raw = await readRawMetadata(projectDir, deviceId);
  if (!raw) return;
  const updated: RawMetadata = { ...raw, lastSeen: new Date().toISOString() };
  await writeFile(metaPath(projectDir, deviceId), JSON.stringify(updated, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a directory sorted by name. Filters to dot-file-safe names.
 * Wrapped in try/catch so a missing dir never throws upstream.
 */
async function readdirSorted(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir);
  return entries.filter(isSafeDeviceName).sort();
}

/**
 * A directory entry is safe only if it is a lowercase hex string matching
 * the device-ID format. Prevents directory-traversal or unexpected entries.
 */
function isSafeDeviceName(name: string): boolean {
  return /^[0-9a-f]{32}$/.test(name);
}
