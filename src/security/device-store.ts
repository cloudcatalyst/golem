/**
 * R13.4 — the enrolled-device catalog.
 *
 * One JSON file listing every device that has ever been enrolled, keyed by its
 * certificate fingerprint. Revocation is a field on the record, not a deletion:
 * "this device was revoked on the 3rd" is a fact worth keeping, and a catalog
 * that forgets revoked devices cannot tell a revoked credential from an unknown
 * one — which is the difference between "you were removed" and "who are you".
 *
 * **The catalog is read on EVERY authorization and never cached.** R13.4's gate
 * says revocation takes effect on the next request, and the cheapest way to be
 * sure of that is to have nothing that could be stale. This file is a few
 * hundred bytes; a cache would be an optimisation bought with the one property
 * the gate names.
 */

import { mkdir, readFile } from "node:fs/promises";
import { writeAtomic } from "../config/file-io.js";
import { deviceCatalogPath, deviceDir } from "./paths.js";

/** Current on-disk schema version. */
export const CATALOG_VERSION = 1;

export interface DeviceRecord {
  /** Stable id; also the certificate CN suffix. */
  readonly id: string;
  /** Human label the developer typed at enrolment ("Pixel", "work iPhone"). */
  readonly label: string;
  /** SHA-256 certificate fingerprint, colon-separated uppercase hex. */
  readonly fingerprint: string;
  readonly enrolled_at: string;
  /** ISO time the certificate stops being valid, so `list` can warn before it does. */
  readonly not_after: string;
  /** Last time this device was seen on an authorised request. */
  readonly last_seen_at?: string;
  /** Set once, never unset — re-enrolling issues a NEW record, not a resurrection. */
  readonly revoked_at?: string;
}

export interface DeviceCatalog {
  readonly version: number;
  readonly devices: readonly DeviceRecord[];
}

const EMPTY: DeviceCatalog = { version: CATALOG_VERSION, devices: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the catalog. A missing file is an empty catalog (no devices enrolled).
 *
 * A MALFORMED file is also an empty catalog, and that direction is deliberate:
 * the failure mode of guessing is "a device that should not be trusted is", and
 * the failure mode of returning empty is "every device must be re-enrolled".
 * The second is recoverable by the developer at the keyboard; the first is not.
 */
export async function readCatalog(projectDir: string): Promise<DeviceCatalog> {
  let raw: string;
  try {
    raw = await readFile(deviceCatalogPath(projectDir), "utf8");
  } catch {
    return EMPTY;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.devices)) return EMPTY;
    const devices = parsed.devices.filter(
      (d): d is DeviceRecord =>
        isRecord(d) && typeof d.id === "string" && typeof d.fingerprint === "string",
    );
    return { version: CATALOG_VERSION, devices };
  } catch {
    return EMPTY;
  }
}

async function writeCatalog(projectDir: string, catalog: DeviceCatalog): Promise<void> {
  await mkdir(deviceDir(projectDir), { recursive: true });
  await writeAtomic(deviceCatalogPath(projectDir), `${JSON.stringify(catalog, null, 2)}\n`);
}

/** Append a newly enrolled device. */
export async function addDevice(projectDir: string, record: DeviceRecord): Promise<void> {
  const catalog = await readCatalog(projectDir);
  await writeCatalog(projectDir, {
    version: CATALOG_VERSION,
    devices: [...catalog.devices, record],
  });
}

/** The record for a fingerprint, revoked or not — `null` when the device is unknown. */
export async function findByFingerprint(
  projectDir: string,
  fingerprint: string,
): Promise<DeviceRecord | null> {
  const catalog = await readCatalog(projectDir);
  return catalog.devices.find((d) => d.fingerprint === fingerprint) ?? null;
}

/** Every device, newest enrolment last. */
export async function listDevices(projectDir: string): Promise<readonly DeviceRecord[]> {
  return (await readCatalog(projectDir)).devices;
}

/** How many devices could authenticate right now (enrolled, not revoked, unexpired). */
export async function activeDeviceCount(
  projectDir: string,
  nowMs: number = Date.now(),
): Promise<number> {
  const devices = await listDevices(projectDir);
  return devices.filter((d) => d.revoked_at === undefined && Date.parse(d.not_after) > nowMs)
    .length;
}

/**
 * Record that a device was seen. Best-effort by design: last-seen is an audit
 * convenience, and a write failure here must never turn an authorised request
 * into a refused one.
 */
export async function touchLastSeen(
  projectDir: string,
  fingerprint: string,
  nowIso: string,
): Promise<void> {
  try {
    const catalog = await readCatalog(projectDir);
    let changed = false;
    const devices = catalog.devices.map((d) => {
      if (d.fingerprint !== fingerprint) return d;
      changed = true;
      return { ...d, last_seen_at: nowIso };
    });
    if (changed) await writeCatalog(projectDir, { version: CATALOG_VERSION, devices });
  } catch {
    // deliberately swallowed — see the doc comment
  }
}

export type RevokeOutcome = "revoked" | "already-revoked" | "not-found";

/** Revoke by id or by fingerprint. Effective on the next request; nothing caches. */
export async function revokeDevice(
  projectDir: string,
  idOrFingerprint: string,
  nowIso: string,
): Promise<RevokeOutcome> {
  const catalog = await readCatalog(projectDir);
  const target = catalog.devices.find(
    (d) => d.id === idOrFingerprint || d.fingerprint === idOrFingerprint,
  );
  if (target === undefined) return "not-found";
  if (target.revoked_at !== undefined) return "already-revoked";
  await writeCatalog(projectDir, {
    version: CATALOG_VERSION,
    devices: catalog.devices.map((d) => (d === target ? { ...d, revoked_at: nowIso } : d)),
  });
  return "revoked";
}
