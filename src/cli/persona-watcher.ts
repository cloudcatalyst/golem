/**
 * R14.x — a live settings watcher for `.golem/settings.json` and
 * `.golem/settings.local.json`, so a persona-roster edit reaches
 * `.claude/agents/golem-<id>.md` / `.claude/rules/golem-prefer-persona-agents.md`
 * without needing a new Claude Code session (that path is `version-sync.ts`'s
 * unconditional `syncPersonaArtifacts` call, which only runs once per session
 * start / daemon start). This is the polling half: `golem proxy` is long-lived,
 * so it is the one place that can notice a mid-session settings edit at all.
 *
 * IMPORTANT — this does not promise a running session can hot-swap a persona
 * it has ALREADY dispatched. It only keeps the FILES on disk current; a
 * session that hasn't dispatched a given persona yet may pick up the change
 * (unverified — Claude Code decides when it re-reads `.claude/agents/`, not
 * Golem). Do not oversell this in logs or docs.
 *
 * ## Why polling, not `fs.watch`/`fs.watchFile`
 *
 * Same reason as `src/knowledge/file-watcher.ts`: libuv's Windows/macOS
 * fs-event backend can abort the whole Node process — uncatchable, no `error`
 * event — via an assertion in `uv__relative_path` (verification-notes §68).
 * Polling can't crash and needs no per-platform branch. This file mirrors that
 * module's self-scheduling `setTimeout` poll + debounce shape, but is written
 * fresh rather than reusing its internals: that module watches an arbitrary
 * directory TREE for chunkable files; this one watches exactly two known
 * absolute file paths and always runs the same action (a full persona-artifact
 * sync) regardless of which of the two changed, so there is no tree scan, no
 * extension filter, and no per-path batch to report — a single dirty flag is
 * enough where `file-watcher.ts` needs a `Set<string>`.
 *
 * ## Why exactly these two paths, never a directory
 *
 * `.golem/managed-files.json` — the provenance ledger `syncPersonaArtifacts`
 * itself reads and writes on every call — lives INSIDE `.golem/`. Watching
 * `.golem/` as a whole (or any directory containing the ledger) would make
 * this watcher notice its own writes and re-trigger itself: not infinite (the
 * ledger write is idempotent once nothing else changed, so the next sync is a
 * no-op), but a needless extra cycle on every single flush, forever. Watching
 * the two settings files by exact path sidesteps that feedback loop entirely —
 * a ledger write never touches either of them.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import type { InitAction } from "./init.js";
import { syncPersonaArtifacts } from "./persona-sync.js";

export interface PersonaWatcherOptions {
  /** Debounce window in ms — edits to both files within this window collapse into one sync. Default 500. */
  readonly debounceMs?: number;
  /** Poll interval in ms — how often the two settings files are re-stat'd. Default 1000. */
  readonly pollMs?: number;
  /** Called after every completed sync (including a no-op one) with the resulting actions. */
  readonly onSync?: (actions: readonly InitAction[]) => void;
  /** Test-only override for the user config layer — see `persona-sync.ts`'s `resolveDesiredAgents`. Never set by the real daemon. */
  readonly userDir?: string;
}

export interface PersonaWatcher {
  /** Stop watching and release every underlying timer. */
  close(): void;
  /** How many poll cycles have COMPLETED — see `file-watcher.ts`'s `cycles` for the same rationale. */
  readonly cycles: number;
}

// No config-slice hashing here to suppress a no-op flush (e.g. a rewrite that
// changes mtime but not the persona roster). `syncPersonaArtifacts` already
// returns `skip` InitActions for anything unchanged, so the caller (the
// proxy's own logging, R14.x step 4) can tell a genuine no-op from a real
// change by checking `actions.every(a => a.kind === "skip")` without this
// module hashing the same information a second time.

/** The exact two absolute paths this watcher polls — never a directory. See the module doc comment. */
export function personaSettingsPaths(projectDir: string): string[] {
  return [
    path.join(projectDir, ".golem", "settings.json"),
    path.join(projectDir, ".golem", "settings.local.json"),
  ];
}

/** A sentinel that can never collide with a real `mtimeMs:size` pair, for a path that doesn't exist. */
const ABSENT = "absent";

async function fileSignature(absPath: string): Promise<string> {
  try {
    const st = await stat(absPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return ABSENT;
  }
}

/**
 * Start polling `.golem/settings.json` and `.golem/settings.local.json` for
 * `projectDir`, resyncing the persona-generated artifacts whenever either
 * changes. Runs one sync immediately, before the poll loop is armed, so a
 * daemon that starts against a settings file edited while it was down
 * self-heals on its own next start — the same idempotent call
 * `version-sync.ts` makes on every session start, so the two can safely
 * overlap (both no-op on an already-current tree).
 */
export async function startPersonaWatcher(
  projectDir: string,
  options: PersonaWatcherOptions = {},
): Promise<PersonaWatcher> {
  const debounceMs = options.debounceMs ?? 500;
  const pollMs = options.pollMs ?? 1000;
  const paths = personaSettingsPaths(projectDir);

  const sync = async (): Promise<void> => {
    // Defensive, even though `syncPersonaArtifacts` already isolates a
    // malformed config into a `conflict` InitAction internally (see
    // persona-sync.ts) rather than throwing — this poll loop must survive a
    // failure anywhere in that call, not just the one it currently expects.
    let actions: readonly InitAction[] = [];
    try {
      actions = await syncPersonaArtifacts(projectDir, false, options.userDir);
    } catch {
      actions = [];
    }
    options.onSync?.(actions);
  };

  let dirty = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = async (): Promise<void> => {
    debounceTimer = null;
    if (!dirty) return;
    dirty = false;
    await sync();
  };

  const onChange = (): void => {
    dirty = true;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void flush(), debounceMs);
  };

  // Baseline signatures: only a change AFTER the watcher starts is polled for
  // (the immediate sync above already covers whatever is on disk at start).
  let prev = await Promise.all(paths.map((p) => fileSignature(p)));
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const poll = async (): Promise<void> => {
    let cur: string[];
    try {
      cur = await Promise.all(paths.map((p) => fileSignature(p)));
    } catch {
      return; // one of the two briefly unreadable (mid-write) — try again next tick
    }
    if (cur.some((sig, i) => sig !== prev[i])) onChange();
    prev = cur;
  };

  // Self-scheduling (not setInterval), same reason as file-watcher.ts: a slow
  // sync must never overlap the next poll.
  let cycles = 0;
  const loop = async (): Promise<void> => {
    if (stopped) return;
    await poll();
    // Counted AFTER the poll resolves and any resulting debounce has been
    // (re)armed — see file-watcher.ts's `cycles` doc comment for why this
    // ordering, not "before", is what makes it a useful test condition.
    cycles += 1;
    if (!stopped) pollTimer = setTimeout(() => void loop(), pollMs);
  };

  await sync(); // daemon self-heal — see the function doc comment.
  pollTimer = setTimeout(() => void loop(), pollMs);

  return {
    get cycles(): number {
      return cycles;
    },
    close(): void {
      stopped = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (debounceTimer !== null) clearTimeout(debounceTimer);
    },
  };
}
