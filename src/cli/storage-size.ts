/**
 * R5.2 — on-disk storage sizing for the sidecar session-state report.
 *
 * The dashboard / `golem watch` / future remote app all want to show how much
 * local disk Golem's stores occupy (CCR blobs, the knowledge index, telemetry,
 * the web cache). Cross-platform (`node:path`, `node:fs/promises`) and fully
 * defensive: a missing directory or any read error just contributes 0 — a
 * storage figure is never worth failing a status read over.
 */

import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

/** The four gitignored zone-1 stores under `<project>/.golem/`. */
export interface GolemStorageSizes {
  readonly ccr_bytes: number;
  readonly knowledge_bytes: number;
  readonly telemetry_bytes: number;
  readonly webcache_bytes: number;
}

/**
 * Total size in bytes of everything under `dir`, recursively. Symlinks are
 * counted by their own (link) size and never followed — no directory cycles,
 * no escaping the tree. Returns 0 for a missing directory or on any error.
 */
export async function dirSizeBytes(dir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // missing or unreadable directory contributes nothing
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSizeBytes(full);
    } else {
      try {
        // lstat, not stat: count the symlink itself, never follow it.
        const st = await lstat(full);
        if (st.isFile() || st.isSymbolicLink()) total += st.size;
      } catch {
        // vanished between readdir and lstat — skip it
      }
    }
  }
  return total;
}

/** Sizes of the four `.golem/` stores, measured in parallel. Never throws. */
export async function golemStorageSizes(projectDir: string): Promise<GolemStorageSizes> {
  const base = path.join(projectDir, ".golem");
  const [ccr, knowledge, telemetry, webcache] = await Promise.all([
    dirSizeBytes(path.join(base, "ccr")),
    dirSizeBytes(path.join(base, "knowledge")),
    dirSizeBytes(path.join(base, "telemetry")),
    dirSizeBytes(path.join(base, "webcache")),
  ]);
  return {
    ccr_bytes: ccr,
    knowledge_bytes: knowledge,
    telemetry_bytes: telemetry,
    webcache_bytes: webcache,
  };
}
