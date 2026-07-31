/**
 * R8.9 — the change ledger: checkpoint / restore over **shadow git refs**.
 *
 * Why this is a context-economy feature and not a git feature: a failed attempt
 * that has to be *repaired* costs a read-diagnose-edit cycle and then sits in
 * the context window for every remaining turn (§93 — ~83% of input cost is
 * re-reading). Discarding is cheaper than repairing, and until now there was no
 * mechanism for it.
 *
 * ## The invariants (this repo commits only when asked)
 *
 * - Snapshots are commits, but they live ONLY under `refs/golem/ledger/*`. No
 *   branch is created, `HEAD` never moves, and git's default fetch/push
 *   refspecs do not carry `refs/golem/*`, so a checkpoint cannot leave the
 *   machine by accident.
 * - Staging happens in a **throwaway index** (`GIT_INDEX_FILE`), so the user's
 *   real index is never written. A restore therefore only ever touches worktree
 *   files.
 * - A restore is refused — not partially applied — on no git, no repo, a
 *   detached HEAD, or a dirty index. Every refusal names its reason.
 * - A restore takes its own `pre-restore` checkpoint first, so the destructive
 *   act is itself undoable.
 * - Golem's own `.golem/` state is out of scope by pathspec, ignored or not —
 *   a restore rewinds the user's attempt, never Golem's machine state.
 *
 * The ref is a real commit parented on HEAD, which means the ordinary git tools
 * work on it unchanged: `git diff refs/golem/ledger/<id>`, `git show <id>`.
 *
 * ## One documented consequence: line endings
 *
 * Snapshot and restore go through git's own clean/smudge filters, so a restored
 * file has the line endings **git would give it** (`core.autocrlf`,
 * `core.eol`, `.gitattributes`) rather than byte-for-byte whatever was on disk.
 * On a machine with `autocrlf=true`, an LF-only working copy of a text file
 * therefore comes back CRLF — identical to what `git checkout` does, which is
 * the behaviour to match, but worth knowing before blaming the ledger for a
 * whitespace diff.
 */

import { copyFile, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { PROJECT_DIR_NAME } from "../config/paths.js";
import { gitOk, inspectRepo, type RepoFacts, runGit } from "./git.js";

/** Namespace for every snapshot ref. Deliberately outside `refs/heads`. */
export const LEDGER_REF_PREFIX = "refs/golem/ledger/";

/** How many checkpoints survive a create; older ones are pruned. */
export const DEFAULT_KEEP = 50;

/** Trailer key carrying the checkpoint kind in the snapshot commit message. */
const KIND_TRAILER = "golem-kind";

/**
 * What a snapshot covers: the whole worktree, minus Golem's own state dir.
 *
 * `PROJECT_DIR_NAME` (`.golem/`) holds telemetry, tasks, CCR blobs and the
 * knowledge index — machine state that belongs to *now*, not to the attempt
 * being discarded. `golem init` gitignores it, but a project that never ran
 * init (or that committed it deliberately) would otherwise have it snapshotted
 * and then deleted by a restore. Excluding it in the pathspec means both the
 * checkpoint and the plan agree it is out of scope, so no diff ever mentions it.
 */
const SNAPSHOT_PATHSPEC: readonly string[] = ["--", ".", `:(exclude)${PROJECT_DIR_NAME}`];

/**
 * Committer identity for snapshot commits, pinned rather than inherited.
 *
 * Two reasons: `commit-tree` fails outright when `user.email` is unset (a fresh
 * machine would get "checkpoint failed" for a config reason nobody would
 * guess), and a snapshot is Golem's object, not the user's authorship — it
 * should say so in `git log`.
 */
const LEDGER_IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "Golem (checkpoint)",
  GIT_AUTHOR_EMAIL: "checkpoint@golem.local",
  GIT_COMMITTER_NAME: "Golem (checkpoint)",
  GIT_COMMITTER_EMAIL: "checkpoint@golem.local",
};

export type CheckpointKind = "manual" | "pre-restore";

export interface Checkpoint {
  /** `YYYYMMDDTHHMMSSZ` (+ `-N` on a same-second collision) — sorts as time. */
  readonly id: string;
  readonly ref: string;
  readonly commit: string;
  readonly tree: string;
  readonly createdIso: string;
  readonly note: string;
  readonly kind: CheckpointKind;
}

/**
 * Success-or-reason, never a throw. Every unavailable state in this module is
 * an expected outcome the CLI prints verbatim, so it is data.
 */
export type LedgerOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

function fail(reason: string): { readonly ok: false; readonly reason: string } {
  return { ok: false, reason };
}

function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

/** Compact UTC stamp used as the checkpoint id (lexical order == time order). */
export function checkpointId(now: Date): string {
  return `${now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")}Z`;
}

// ---------------------------------------------------------------------------
// listing
// ---------------------------------------------------------------------------

/** Tab-separated `for-each-ref` fields, parsed positionally by `parseRefLine`. */
const REF_FORMAT = [
  "%(refname)",
  "%(objectname)",
  "%(tree)",
  "%(creatordate:iso-strict)",
  "%(contents:subject)",
  `%(trailers:key=${KIND_TRAILER},valueonly)`,
].join("%09");

function parseKind(raw: string): CheckpointKind {
  return raw.trim() === "pre-restore" ? "pre-restore" : "manual";
}

function parseRefLine(line: string): Checkpoint | null {
  const [ref, commit, tree, createdIso, subject, kind] = line.split("\t");
  if (ref === undefined || commit === undefined || tree === undefined) return null;
  if (!ref.startsWith(LEDGER_REF_PREFIX)) return null;
  return {
    id: ref.slice(LEDGER_REF_PREFIX.length),
    ref,
    commit,
    tree,
    createdIso: createdIso ?? "",
    note: (subject ?? "").trim(),
    kind: parseKind(kind ?? ""),
  };
}

/** Every checkpoint, newest first. Sorted by refname because the id IS the time. */
export async function listCheckpoints(cwd: string): Promise<LedgerOutcome<readonly Checkpoint[]>> {
  const repo = await inspectRepo(cwd);
  if (repo.kind !== "repo") return fail(repo.reason);
  return ok(await listFrom(repo));
}

async function listFrom(repo: RepoFacts): Promise<readonly Checkpoint[]> {
  const res = await runGit(repo.root, [
    "for-each-ref",
    "--sort=-refname",
    `--format=${REF_FORMAT}`,
    LEDGER_REF_PREFIX.replace(/\/$/, ""),
  ]);
  if (res.code !== 0) return [];
  const out: Checkpoint[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    if (line === "") continue;
    const parsed = parseRefLine(line);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// snapshotting (the temp-index routine both create and plan depend on)
// ---------------------------------------------------------------------------

let tempIndexCounter = 0;

/**
 * Stage the whole worktree into a throwaway index and write its tree.
 *
 * The real index is **copied in first** when it exists — purely for speed: git
 * reuses its stat cache and rehashes only what changed, which on a large repo
 * is the difference between milliseconds and seconds. Copying is safe because
 * `add --all` then overwrites every entry from the worktree, so the snapshot
 * describes the worktree and not anyone's staged state. (One documented
 * consequence: `assume-unchanged`/`skip-worktree` entries inherited from the
 * copy are trusted as-is, exactly as a normal `git add` would.)
 *
 * `.gitignore` applies, so `node_modules/` is never snapshotted — and
 * {@link SNAPSHOT_PATHSPEC} excludes Golem's own `.golem/` state directory
 * *whether or not* it is ignored, because a restore that deleted the telemetry,
 * task and CCR state written since the checkpoint would be rewinding Golem
 * rather than the user's attempt. (Found in R8.9's own smoke test, in a repo
 * with no `.gitignore`.)
 */
async function withSnapshotTree<T>(
  repo: RepoFacts,
  use: (tree: string) => Promise<T>,
): Promise<LedgerOutcome<T>> {
  const indexFile = path.join(repo.gitDir, `golem-index-${process.pid}-${++tempIndexCounter}`);
  try {
    try {
      await copyFile(path.join(repo.gitDir, "index"), indexFile);
    } catch {
      // No index yet (fresh repo) or unreadable — start from an empty one.
    }
    const add = await runGit(repo.root, ["add", "--all", ...SNAPSHOT_PATHSPEC], { indexFile });
    if (add.code !== 0) {
      return fail(`could not stage the worktree into a temporary index: ${gitError(add.stderr)}`);
    }
    const tree = await gitOk(repo.root, ["write-tree"], { indexFile });
    if (tree === null) return fail("git write-tree failed — nothing was checkpointed");
    return ok(await use(tree));
  } finally {
    await rm(indexFile, { force: true });
    await rm(`${indexFile}.lock`, { force: true });
  }
}

function gitError(stderr: string): string {
  const first = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  return first ?? "no output";
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export interface CreateCheckpointOptions {
  readonly note?: string;
  readonly kind?: CheckpointKind;
  readonly now?: Date;
  /** Retain this many newest checkpoints after creating (default {@link DEFAULT_KEEP}). */
  readonly keep?: number;
}

export interface CreateCheckpointResult {
  readonly checkpoint: Checkpoint;
  /** True when the worktree already matched the newest checkpoint — no ref written. */
  readonly unchanged: boolean;
  readonly pruned: number;
}

function snapshotMessage(note: string, kind: CheckpointKind, id: string): string {
  const subject = note === "" ? `checkpoint ${id}` : note;
  return `${subject}\n\n${KIND_TRAILER}: ${kind}\n`;
}

/**
 * Snapshot the worktree under a new shadow ref.
 *
 * Re-checkpointing an unchanged worktree returns the existing checkpoint rather
 * than writing a second ref for the same tree: the model calling this before
 * every attempt should not pay for ref spam, and an honest "nothing changed" is
 * more useful than a duplicate.
 */
export async function createCheckpoint(
  cwd: string,
  opts: CreateCheckpointOptions = {},
): Promise<LedgerOutcome<CreateCheckpointResult>> {
  const repo = await inspectRepo(cwd);
  if (repo.kind !== "repo") return fail(repo.reason);

  const now = opts.now ?? new Date();
  const kind = opts.kind ?? "manual";
  const note = (opts.note ?? "").replace(/\s+/g, " ").trim();
  const keep = opts.keep ?? DEFAULT_KEEP;
  const existing = await listFrom(repo);

  const built = await withSnapshotTree(repo, async (tree) => {
    const newest = existing[0];
    if (newest !== undefined && newest.tree === tree) {
      return { kind: "unchanged" as const, checkpoint: newest };
    }
    const id = uniqueId(checkpointId(now), existing);
    const ref = `${LEDGER_REF_PREFIX}${id}`;
    const args = ["commit-tree", tree];
    if (repo.head !== null) args.push("-p", repo.head);
    const commit = await gitOk(repo.root, args, {
      stdin: snapshotMessage(note, kind, id),
      extraEnv: LEDGER_IDENTITY,
    });
    if (commit === null) return { kind: "commit-failed" as const };
    const update = await runGit(repo.root, ["update-ref", ref, commit]);
    if (update.code !== 0) {
      return { kind: "ref-failed" as const, stderr: update.stderr };
    }
    return {
      kind: "created" as const,
      checkpoint: {
        id,
        ref,
        commit,
        tree,
        createdIso: now.toISOString(),
        note: note === "" ? `checkpoint ${id}` : note,
        kind,
      } satisfies Checkpoint,
    };
  });

  if (!built.ok) return built;
  const outcome = built.value;
  if (outcome.kind === "commit-failed") {
    return fail("git commit-tree failed — no checkpoint was written");
  }
  if (outcome.kind === "ref-failed") {
    return fail(`could not write the shadow ref: ${gitError(outcome.stderr)}`);
  }
  if (outcome.kind === "unchanged") {
    return ok({ checkpoint: outcome.checkpoint, unchanged: true, pruned: 0 });
  }

  const pruned = await pruneFrom(repo, keep);
  return ok({ checkpoint: outcome.checkpoint, unchanged: false, pruned });
}

/** Disambiguate a same-second id by suffixing `-2`, `-3`, … (never reuse a ref). */
function uniqueId(base: string, existing: readonly Checkpoint[]): string {
  const taken = new Set(existing.map((c) => c.id));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// resolve / drop / prune
// ---------------------------------------------------------------------------

/** Resolve `latest`, an exact id, or an unambiguous id prefix. */
export async function resolveCheckpoint(
  cwd: string,
  selector: string,
): Promise<LedgerOutcome<Checkpoint>> {
  const list = await listCheckpoints(cwd);
  if (!list.ok) return list;
  const all = list.value;
  if (all.length === 0) {
    return fail("no checkpoints yet — create one with: golem checkpoint create");
  }

  const want = selector.trim();
  if (want === "" || want === "latest") {
    const newest = all[0];
    return newest === undefined ? fail("no checkpoints yet") : ok(newest);
  }
  const exact = all.find((c) => c.id === want);
  if (exact !== undefined) return ok(exact);

  const matches = all.filter((c) => c.id.startsWith(want));
  const only = matches[0];
  if (only === undefined) {
    return fail(`no checkpoint matches "${want}" (see: golem checkpoint list)`);
  }
  if (matches.length > 1) {
    return fail(
      `"${want}" is ambiguous — ${matches.length} checkpoints match (${matches
        .slice(0, 3)
        .map((c) => c.id)
        .join(", ")}…)`,
    );
  }
  return ok(only);
}

/** Delete one checkpoint's ref. Loses a snapshot; touches no worktree file. */
export async function dropCheckpoint(
  cwd: string,
  selector: string,
): Promise<LedgerOutcome<Checkpoint>> {
  const found = await resolveCheckpoint(cwd, selector);
  if (!found.ok) return found;
  const repo = await inspectRepo(cwd);
  if (repo.kind !== "repo") return fail(repo.reason);
  const res = await runGit(repo.root, ["update-ref", "-d", found.value.ref]);
  if (res.code !== 0) return fail(`could not delete ${found.value.ref}: ${gitError(res.stderr)}`);
  return ok(found.value);
}

/** Keep the `keep` newest checkpoints; delete the rest. Returns how many went. */
export async function pruneCheckpoints(cwd: string, keep: number): Promise<LedgerOutcome<number>> {
  const repo = await inspectRepo(cwd);
  if (repo.kind !== "repo") return fail(repo.reason);
  return ok(await pruneFrom(repo, keep));
}

async function pruneFrom(repo: RepoFacts, keep: number): Promise<number> {
  if (keep < 0) return 0;
  const all = await listFrom(repo);
  const doomed = all.slice(keep);
  let deleted = 0;
  for (const c of doomed) {
    const res = await runGit(repo.root, ["update-ref", "-d", c.ref]);
    if (res.code === 0) deleted++;
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

export interface RestorePlan {
  readonly target: Checkpoint;
  /** Worktree-relative paths to write back from the checkpoint. */
  readonly restore: readonly string[];
  /** Worktree-relative paths created since the checkpoint — deleted on apply. */
  readonly delete: readonly string[];
}

/**
 * What a restore would do, without doing it.
 *
 * The diff runs `target → current`, so git's own letters read naturally: `A`
 * means the path was ADDED after the checkpoint (so restoring means deleting
 * it), everything else means it differs or is missing (so restoring means
 * writing the checkpoint's copy back).
 */
export async function planRestore(
  cwd: string,
  target: Checkpoint,
): Promise<LedgerOutcome<RestorePlan>> {
  const repo = await inspectRepo(cwd);
  if (repo.kind !== "repo") return fail(repo.reason);
  return withSnapshotTree(repo, async (currentTree) => {
    const res = await runGit(repo.root, [
      "diff-tree",
      "-r",
      "-z",
      "--no-renames",
      "--name-status",
      target.tree,
      currentTree,
    ]);
    const { restore, remove } = parseNameStatusZ(res.code === 0 ? res.stdout : "");
    return { target, restore, delete: remove } satisfies RestorePlan;
  });
}

/**
 * Parse `--name-status -z` records (`status NUL path NUL`). Renames are disabled
 * upstream (`--no-renames`) so every record is exactly two fields.
 */
function parseNameStatusZ(raw: string): { restore: string[]; remove: string[] } {
  const fields = raw.split("\0").filter((f) => f !== "");
  const restore: string[] = [];
  const remove: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = (fields[i] ?? "").charAt(0);
    const file = fields[i + 1] ?? "";
    if (file === "") continue;
    if (status === "A") remove.push(file);
    else restore.push(file);
  }
  return { restore, remove };
}

export interface RestoreResult {
  readonly plan: RestorePlan;
  /** The automatic `pre-restore` snapshot taken first (null if nothing changed). */
  readonly safety: Checkpoint | null;
  readonly restored: number;
  readonly deleted: number;
}

/**
 * Discard everything since `selector` and put the worktree back.
 *
 * Refuses rather than half-acting: a detached HEAD or a dirty index means the
 * user has state Golem would be describing incorrectly afterwards (staged
 * content that no longer matches the files), and the brief for this task makes
 * that a no-op with a reason. Consent and the ADR-0002 gate live at the CLI /
 * hook layer, not here — this function assumes the caller already has it.
 */
export async function restoreCheckpoint(
  cwd: string,
  selector: string,
  opts: { readonly now?: Date } = {},
): Promise<LedgerOutcome<RestoreResult>> {
  const repo = await inspectRepo(cwd);
  if (repo.kind !== "repo") return fail(repo.reason);
  if (repo.detached) {
    return fail(
      "HEAD is detached — refusing to restore (a checkpoint restores worktree files, and " +
        "a detached HEAD makes the resulting state hard to reason about). Check out a branch first.",
    );
  }
  if (repo.indexDirty) {
    return fail(
      "the index has staged changes — refusing to restore, because it would leave the index " +
        "and the files describing different states. Commit, unstage (git restore --staged), or stash first.",
    );
  }

  const found = await resolveCheckpoint(cwd, selector);
  if (!found.ok) return found;
  const target = found.value;

  const plan = await planRestore(cwd, target);
  if (!plan.ok) return plan;
  if (plan.value.restore.length === 0 && plan.value.delete.length === 0) {
    return ok({ plan: plan.value, safety: null, restored: 0, deleted: 0 });
  }

  // A destructive act must itself be undoable: snapshot the current state first.
  const safety = await createCheckpoint(cwd, {
    kind: "pre-restore",
    note: `before restoring ${target.id}`,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  if (!safety.ok) return fail(`could not take the pre-restore safety checkpoint: ${safety.reason}`);

  const applied = await applyRestore(repo, plan.value);
  if (!applied.ok) return applied;
  return ok({
    plan: plan.value,
    safety: safety.value.checkpoint,
    restored: plan.value.restore.length,
    deleted: plan.value.delete.length,
  });
}

/**
 * Write the checkpoint's copies back and delete what was added.
 *
 * `checkout-index --stdin -z` (against a temp index read from the target tree)
 * is what keeps this off the real index — and the `-z --stdin` form is also why
 * a thousand changed paths do not blow Windows' ~8k command-line limit.
 */
async function applyRestore(repo: RepoFacts, plan: RestorePlan): Promise<LedgerOutcome<null>> {
  const indexFile = path.join(repo.gitDir, `golem-index-${process.pid}-${++tempIndexCounter}`);
  try {
    const read = await runGit(repo.root, ["read-tree", plan.target.tree], { indexFile });
    if (read.code !== 0) {
      return fail(`git read-tree failed — nothing was restored: ${gitError(read.stderr)}`);
    }
    if (plan.restore.length > 0) {
      const checkout = await runGit(repo.root, ["checkout-index", "-f", "-z", "--stdin"], {
        indexFile,
        stdin: `${plan.restore.join("\0")}\0`,
      });
      if (checkout.code !== 0) {
        return fail(`git checkout-index failed: ${gitError(checkout.stderr)}`);
      }
    }
    for (const rel of plan.delete) {
      const abs = path.join(repo.root, rel);
      await rm(abs, { force: true });
      await pruneEmptyParents(repo.root, path.dirname(abs));
    }
    return ok(null);
  } finally {
    await rm(indexFile, { force: true });
    await rm(`${indexFile}.lock`, { force: true });
  }
}

/**
 * Remove directories left empty by a deletion, up to (never including) `root`.
 *
 * git does not track directories, so a restore that only deleted files would
 * otherwise leave a trail of empty ones the checkpoint never had.
 */
async function pruneEmptyParents(root: string, start: string): Promise<void> {
  let dir = start;
  const stop = path.resolve(root);
  while (path.resolve(dir) !== stop && path.resolve(dir).startsWith(stop)) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    if (entries.length > 0) return;
    try {
      await rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}
