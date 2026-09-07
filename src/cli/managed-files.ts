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
 * ## The record has to travel with the files it describes
 *
 * `skill-provenance-on-clone`: the record used to live under `.golem/state/`,
 * which is **gitignored** — while every file it accounts for is **committed**
 * (`.claude/skills/golem-<cmd>/SKILL.md`, `.claude/rules/golem-<name>.md`,
 * `.golem/personas/<name>.md`). The hash therefore never reached a teammate's
 * clone. Same Golem version, the clone was fine by luck (`onDisk === shipped` →
 * `current`); one version later, every skill on every machine except the one
 * that originally ran `golem init` classified as `owned` — a permanent conflict
 * whose stated remedy was to delete a version-controlled file.
 *
 * So the record now lives at `.golem/managed-files.json`: committed, beside the
 * project's `.golem/settings.json` and deliberately OUTSIDE the gitignored
 * `.golem/state/`. It becomes as portable as {@link managedKey} always claimed
 * it was, and a file that arrived via git carries its own provenance with it.
 *
 * Two details keep that from regressing an existing project:
 *
 * - the machine-local record is still read, and the two are consulted as one
 *   set — matching *either* is proof Golem wrote the bytes, so nothing that was
 *   `stale` yesterday becomes `owned` today. {@link rememberManaged} folds its
 *   entries into the portable record as it writes, so a project migrates simply
 *   by being used. It keeps one live job of its own: a managed file OUTSIDE the
 *   project (see {@link travelsWithTheProject}) is recorded there and nowhere
 *   else, because it cannot travel and its key is a home-directory path.
 * - keys are sorted on write and the file is left untouched when nothing
 *   changed, because a committed file that churns on every `golem init` is a
 *   diff nobody asked for.
 *
 * `no record → owned` is untouched: it is the guard that stopped R9.5's
 * data-loss bug, and a file Golem genuinely cannot account for is still the
 * user's. What changed is only which files Golem *can* account for.
 *
 * `golem uninit` removes both records.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where the hashes live: committed with the project, so the provenance reaches
 * every clone of the files it describes. Removed by `uninit`.
 */
export function managedRecordPath(projectDir: string): string {
  return path.join(projectDir, ".golem", "managed-files.json");
}

/**
 * The machine-local, gitignored record. It was where everything lived before
 * `skill-provenance-on-clone`, so it is still read (an already-initialized
 * project keeps the provenance it has), and it is still WRITTEN for the one
 * kind of managed file that cannot travel: one outside the project directory.
 */
export function managedStatePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "managed-files.json");
}

/** What Golem should do with one managed file. */
export type ManagedDisposition = "current" | "absent" | "stale" | "owned";

export function hashManaged(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

type ManagedRecord = Record<string, string>;

async function readRecordAt(file: string): Promise<ManagedRecord> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
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

/**
 * Both records, portable first. They are consulted as a SET rather than one
 * overriding the other: each entry is a claim "Golem wrote exactly these bytes
 * here", and a claim from either source is equally good evidence. Picking a
 * winner would mean deciding whether a teammate's committed hash or this
 * machine's local one is fresher — a question with no honest answer, and
 * getting it wrong in the `owned` direction is a false conflict while getting
 * it wrong in the `stale` direction is data loss.
 */
async function readRecords(projectDir: string): Promise<ManagedRecord[]> {
  return [
    await readRecordAt(managedRecordPath(projectDir)),
    await readRecordAt(managedStatePath(projectDir)),
  ];
}

/** Stable key order, so two machines writing the same facts produce the same file. */
function sortKeys(record: ManagedRecord): ManagedRecord {
  const out: ManagedRecord = {};
  const byKey = Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, value] of byKey) out[key] = value;
  return out;
}

async function writeRecord(file: string, record: ManagedRecord): Promise<void> {
  const serialized = `${JSON.stringify(sortKeys(record), null, 2)}\n`;
  try {
    // The portable record is committed: rewriting identical bytes would dirty
    // the user's working tree on every init for no reason.
    if ((await readFile(file, "utf8")) === serialized) return;
  } catch {
    // Not there yet — fall through and create it.
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, serialized, "utf8");
}

/** Key files by project-relative POSIX path, so the record is portable. */
export function managedKey(projectDir: string, file: string): string {
  return path.relative(projectDir, file).split(path.sep).join("/");
}

/**
 * Does this key describe a file INSIDE the project — one a clone would receive?
 *
 * Not every managed file is: a user-scope install lands under the user's home,
 * and `path.relative` then yields `../..`-style or, across Windows drives, a
 * fully absolute key. Two reasons those must never reach the committed record,
 * and the second is the serious one:
 *
 * - the hash describes a file the clone does not have, so it is noise;
 * - the KEY is an absolute path containing the user's home directory, and
 *   committing `C:/Users/<name>/...` publishes their username to everyone with
 *   access to the repo. Found by generating this repo's own record: the
 *   machine-local record being migrated held 22 such keys.
 *
 * They stay in the machine-local record, which is exactly where a machine-local
 * fact belongs.
 */
function travelsWithTheProject(key: string): boolean {
  return key !== "" && !key.startsWith("../") && !path.isAbsolute(key) && !/^[A-Za-z]:/.test(key);
}

/** Did Golem write exactly these bytes to this path, per either record? */
async function wroteExactly(projectDir: string, file: string, onDisk: string): Promise<boolean> {
  const key = managedKey(projectDir, file);
  const hash = hashManaged(onDisk);
  for (const record of await readRecords(projectDir)) {
    if (record[key] === hash) return true;
  }
  return false;
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
  return (await wroteExactly(projectDir, file, onDisk)) ? "stale" : "owned";
}

/** Record that Golem just wrote `content` to `file`. */
export async function rememberManaged(
  projectDir: string,
  file: string,
  content: string,
): Promise<void> {
  const key = managedKey(projectDir, file);
  const hash = hashManaged(content);
  const local = managedStatePath(projectDir);
  if (!travelsWithTheProject(key)) {
    const record = await readRecordAt(local);
    record[key] = hash;
    await writeRecord(local, record);
    return;
  }
  const target = managedRecordPath(projectDir);
  const next = await readRecordAt(target);
  // Fold the machine-local record in as we go, so a project that pre-dates the
  // portable one migrates by being used rather than by being re-initialized —
  // but only the entries a clone could actually use.
  for (const [legacyKey, legacyHash] of Object.entries(await readRecordAt(local))) {
    if (travelsWithTheProject(legacyKey) && !(legacyKey in next)) next[legacyKey] = legacyHash;
  }
  next[key] = hash;
  await writeRecord(target, next);
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
  return wroteExactly(projectDir, file, onDisk);
}

/** Drop one file's record (it is being removed). */
export async function forgetManaged(projectDir: string, file: string): Promise<void> {
  const key = managedKey(projectDir, file);
  // Both records: a hash left behind in either one still reads as proof that
  // Golem wrote a file it has just removed.
  for (const recordFile of [managedRecordPath(projectDir), managedStatePath(projectDir)]) {
    const record = await readRecordAt(recordFile);
    if (!(key in record)) continue;
    delete record[key];
    await writeRecord(recordFile, record);
  }
}

/** Remove both records (uninit). */
export async function removeManagedState(projectDir: string): Promise<void> {
  await rm(managedRecordPath(projectDir), { force: true });
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
