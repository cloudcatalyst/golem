/**
 * Device credential catalog storage (ADR-0006 section 3c-1 inherited).
 *
 * One schema, one file per project: .golem/devices/catalog.json keyed by
 * deviceId. Reads are idempotent, writes use atomic tmp+rename on platforms
 * that support it. Zero new npm dependencies.
 *
 * Invariant: enrollment is local-only, forever. Failure is denial, never
 * degradation. Only write surfaces require this layer; the observe tier
 * operates without it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const CATALOG_VERSION = 1;

export const CatalogEntrySchema = z.object({
  v: z.number().default(CATALOG_VERSION),
  deviceId: z.string(),
  label: z.string(),
  pubKeyPem: z.string().optional(), // present during enrollment only
  codeHash: z.string(),
  salt: z.string(),
  expiresAt: z.string(),
  createdAt: z.string(),
  certPem: z.string().optional(), // present after completion only
  lastSeen: z.string().optional(),
  revoked: z.boolean().default(false),
});

export type RawCatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const CatalogSchema = z.object({
  v: z.number(),
  entries: z.record(z.string(), CatalogEntrySchema),
});

export interface Catalog {
  readonly v: number;
  readonly entries: Record<string, RawCatalogEntry>;
}

/** <projectDir>/.golem/devices/ directory containing all paired devices. */
export function devicesDir(projectDir: string): string {
  return join(projectDir, ".golem", "devices");
}

function catalogPath(projectDir: string): string {
  return join(devicesDir(projectDir), "catalog.json");
}

/** <projectDir>/.golem/devices/<deviceId>/ */
export function deviceDirPath(projectDir: string, deviceId: string): string {
  return join(devicesDir(projectDir), deviceId);
}

/** Read or create an empty catalog at first access. */
export async function readOrCreate(projectDir: string): Promise<Catalog> {
  try {
    const raw = await readFile(catalogPath(projectDir), "utf8");
    return CatalogSchema.parse(JSON.parse(raw));
  } catch {
    const fresh: Catalog = { v: CATALOG_VERSION, entries: {} };
    await writeCatalog(projectDir, fresh);
    return fresh;
  }
}

/** Persist the full catalog back to disk. */
export async function writeCatalog(projectDir: string, cat: Catalog): Promise<void> {
  await mkdir(devicesDir(projectDir), { recursive: true });
  await writeFile(catalogPath(projectDir), JSON.stringify(cat, null, 2) + "\n", "utf8");
}

/** Create (if needed) the per-device subdirectory and return its path. */
export async function ensureDeviceDir(projectDir: string, deviceId: string): Promise<string> {
  const dir = deviceDirPath(projectDir, deviceId);
  await mkdir(dir, { recursive: true });
  return dir;
}
