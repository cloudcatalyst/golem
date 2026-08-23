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
import { signDeviceCertificate } from "./loopback-cert.js";

// ---------------------------------------------------------------------------
// Types & schema
// ---------------------------------------------------------------------------

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

function deviceDir(projectDir: string, deviceId: string): string {
  return path.join(devicesStateDir(projectDir), deviceId);
}

function resolveFile(name: string, projectDir: string, deviceId: string): string {
  return path.join(deviceDir(projectDir, deviceId), name);
}

// ---------------------------------------------------------------------------
// Certificate issuance
// ---------------------------------------------------------------------------

/** Issue a CA-signed client certificate for a new device pairing. */
export async function issueDeviceCertificate(
  deviceId: string,
  label: string,
  projectDir: string,
  opts?: { days?: number },
): Promise<DeviceCertificate> {
  const nowMs = Date.now();

  // Sign with the constrained CA (ensureLoopbackCert must have been called first).
  const caSigned = await signDeviceCertificate(projectDir, opts);

  const dir = deviceDir(projectDir, deviceId);
  await mkdir(dir, { recursive: true });

  const cPath = resolveFile("cert.pem", projectDir, deviceId);
  const kPath = resolveFile("key.pem", projectDir, deviceId);
  const mPath = resolveFile("metadata.json", projectDir, deviceId);

  await Promise.all([
    writeFile(cPath, caSigned.certPem, { encoding: "utf8", mode: 0o644 }),
    writeFile(kPath, caSigned.keyPem, { encoding: "utf8", mode: 0o600 }),
  ]);

  const created = new Date(nowMs).toISOString();
  const meta: RawMetadata = {
    deviceId,
    label,
    notAfter: caSigned.notAfter.toISOString(),
    createdAt: created,
    lastSeen: created,
    revoked: false,
  };
  await writeFile(mPath, JSON.stringify(meta, null, 2) + "\n", "utf8");

  return { certPath: cPath, keyPath: kPath, certPem: caSigned.certPem, keyPem: caSigned.keyPem };
}

// ---------------------------------------------------------------------------
// Metadata reads / writes
// ---------------------------------------------------------------------------

async function readRawMetadata(
  projectDir: string,
  deviceId: string,
): Promise<RawMetadata | null> {
  try {
    const raw = await readFile(resolveFile("metadata.json", projectDir, deviceId), "utf8");
    const parsed = metadataSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Read device metadata. Returns null when missing, malformed, or revoked.
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

/** Generate a fresh device ID (32 hex chars). */
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
  await writeFile(
    resolveFile("metadata.json", projectDir, deviceId),
    JSON.stringify(updated, null, 2) + "\n",
    "utf8",
  );
  return true;
}

/** Update the last-seen timestamp. No-op if device absent. */
export async function touchLastSeen(
  projectDir: string,
  deviceId: string,
): Promise<void> {
  const raw = await readRawMetadata(projectDir, deviceId);
  if (!raw) return;
  const updated: RawMetadata = { ...raw, lastSeen: new Date().toISOString() };
  await writeFile(
    resolveFile("metadata.json", projectDir, deviceId),
    JSON.stringify(updated, null, 2) + "\n",
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readdirSorted(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(dir)).filter(isSafeDeviceName).sort();
}

function isSafeDeviceName(name: string): boolean {
  return /^[0-9a-f]{32}$/.test(name);
}
