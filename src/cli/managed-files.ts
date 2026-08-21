/**
 * R9.5 — provenance for the files Golem writes into a user's project.
 *
 * Golem writes two kinds of managed file and treated them **inversely wrong**:
 *
 * | file | on re-init | consequence |
 * |---|---|---|
 * | `.claude/skills/golem/<cmd>/SKILL.md` | content compare → overwrite | a hand-edited skill was silently destroyed |
 * | `.claude/rules/golem-<name>.md` | seed-once, sentinel-gated | an improved rule never reached an existing project |
 *
 * Both fall out of asking one question where there are two: *does this file
 * differ from what Golem ships?* That cannot distinguish "Golem's text moved on"
 * from "the user edited it", so each surface picked an answer and was wrong half
 * the time.
 *
 * The fix is to record the hash of what Golem last wrote. Then a managed file is
 * exactly one of:
 *
 * - **current** — identical to what Golem ships; nothing to do.
 * - **absent** — not on disk.
 * - **stale** — differs from what Golem ships, but still matches what Golem last
 *   wrote. The user never touched it, so refreshing loses nothing.
 * - **owned** — differs from what Golem last wrote (or Golem has no record of
 *   writing it). The user's edit is theirs; Golem reports and stands aside.
 *
 * **No record means owned, deliberately.** A project initialized before this
 * mechanism has no hashes, so its drifted files classify as owned and are left
 * alone with a note. Refreshing them would be the old data-loss bug wearing a
 * new mechanism: Golem cannot prove it wrote that content, so it must not
 * discard it. The record self-heals — every write from here on records a hash.
 *
 * The record lives under `.golem/state/` (gitignored), like the guidance
 * sentinel, and `golem uninit` removes it.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Where the hashes live. Gitignored, per-project, removed by `uninit`. */
export function managedStatePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "managed-files.json");
}

/** What Golem should do with one managed file. */
export type ManagedDisposition = "current" | "absent" | "stale" | "owned";

export function hashManaged(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

type ManagedRecord = Record<string, string>;

async function readRecord(projectDir: string): Promise<ManagedRecord> {
  try {
    const parsed: unknown = JSON.parse(await readFile(managedStatePath(projectDir), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: ManagedRecord = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    // Missing or corrupt: an unreadable record must not break init, and it
    // degrades to "owned" (leave the user's files alone), never to "overwrite".
    return {};
  }
}

async function writeRecord(projectDir: string, record: ManagedRecord): Promise<void> {
  const file = managedStatePath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/** Key files by project-relative POSIX path, so the record is portable. */
export function managedKey(projectDir: string, file: string): string {
  return path.relative(projectDir, file).split(path.sep).join("/");
}

/**
 * Classify one managed file against the content Golem currently ships.
 *
 * `onDisk` is passed in rather than read here so callers that already read the
 * file (every one of them does) do not read it twice.
 */
export async function classifyManaged(
  projectDir: string,
  file: string,
  shipped: string,
  onDisk: string | null,
): Promise<ManagedDisposition> {
  if (onDisk === null) return "absent";
  if (onDisk === shipped) return "current";
  const record = await readRecord(projectDir);
  const lastWritten = record[managedKey(projectDir, file)];
  return lastWritten !== undefined && lastWritten === hashManaged(onDisk) ? "stale" : "owned";
}

/** Record that Golem just wrote `content` to `file`. */
export async function rememberManaged(
  projectDir: string,
  file: string,
  content: string,
): Promise<void> {
  const record = await readRecord(projectDir);
  record[managedKey(projectDir, file)] = hashManaged(content);
  await writeRecord(projectDir, record);
}

/**
 * Did Golem write exactly this content, and has nobody touched it since?
 *
 * `classifyManaged` answers "is the file current?", which needs the content
 * Golem SHIPS. A retired managed file has none — it is gone from the table —
 * so the only question left is whether the bytes on disk are still the ones
 * Golem last wrote. `false` for an edited file and for one Golem has no record
 * of, which is what keeps a prune from deleting the user's work.
 */
export async function isUnmodifiedManaged(
  projectDir: string,
  file: string,
  onDisk: string,
): Promise<boolean> {
  const record = await readRecord(projectDir);
  const lastWritten = record[managedKey(projectDir, file)];
  return lastWritten !== undefined && lastWritten === hashManaged(onDisk);
}

/** Drop one file's record (it is being removed). */
export async function forgetManaged(projectDir: string, file: string): Promise<void> {
  const record = await readRecord(projectDir);
  const key = managedKey(projectDir, file);
  if (!(key in record)) return;
  delete record[key];
  await writeRecord(projectDir, record);
}

/** Remove the whole record (uninit). */
export async function removeManagedState(projectDir: string): Promise<void> {
  await rm(managedStatePath(projectDir), { force: true });
}

/**
 * The note shown for an `owned` file — it must say why Golem stopped and what to
 * do, because "conflict" with no instruction is just an unexplained refusal.
 */
export function ownedDetail(what: string): string {
  return (
    `${what}: kept your version — Golem has newer text but will not overwrite an ` +
    "edited file. Delete it and re-run `golem init` to take the update."
  );
}
