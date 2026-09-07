/**
 * `team-skills-sync` — the team's skills into their own managed namespace, and a
 * skill deleted in the portal disappearing locally.
 *
 * `src/portal/team-skills.ts` owns the wire. This owns the disk, and the whole
 * difficulty is three cases that a naive "download and write" collapses into
 * one:
 *
 * | on disk | in the manifest | what happens |
 * |---|---|---|
 * | Golem's own bytes | present, same hash | nothing at all — no write, no mtime |
 * | Golem's own bytes | present, new hash | refreshed |
 * | Golem's own bytes | **absent** | **removed** — this is what "managed" means |
 * | edited by the user | either | reported as a `conflict` and KEPT |
 * | no provenance record | either | never touched |
 *
 * Provenance decides all five rows, exactly as it does for Golem's own skills
 * (R9.5, `./managed-files.ts`). "Differs from what the portal sent" cannot tell
 * a stale file from an edited one, and guessing in the wrong direction destroys
 * someone's work.
 *
 * ## The namespace, and why a collision is impossible rather than unlikely
 *
 * A team skill lands at `.claude/skills/golem-team-<name>/SKILL.md` — flat, a
 * sibling of Golem's own `golem-<cmd>` directories, never nested (§159 item 1:
 * Claude Code discovers exactly one level, so a nested layout syncs perfectly
 * and never loads). Three independent guards keep a team skill off any other
 * system's file, and they are independent on purpose — each one alone would be
 * a single point of failure:
 *
 * 1. **The prefix.** Every path this module writes is built by
 *    {@link teamSkillDirName}, which prepends `golem-team-`. Golem's own
 *    commands never begin `team-`, and `init-skills.ts`'s `ourSkillDirs`
 *    excludes `golem-team-*` from both prune and uninit — so neither side can
 *    reach the other's directories even in principle.
 * 2. **The name is refused, not sanitised.** `name` arrives from the portal and
 *    becomes a directory name, so it must match `isValidTeamSkillName` before
 *    any path is built from it. A row named `../golem-ship` is rejected and
 *    reported; it is never cleaned up into something writable.
 * 3. **The path is re-checked after it is built.** {@link teamSkillFile}
 *    asserts the resolved file sits directly under `.claude/skills/` in a
 *    directory carrying the prefix. A future refactor that reintroduces a
 *    traversal fails here rather than in a user's repo.
 *
 * And beneath all three, provenance: even inside its own namespace this module
 * will not overwrite or delete a file it cannot prove Golem wrote.
 *
 * ## Committed or gitignored — the one question this task had to settle
 *
 * **Committed**, like every other managed file, and it is now the cheap answer
 * rather than the risky one. `skill-provenance-on-clone` made the record travel
 * with the project (`.golem/managed-files.json`), so a clone receives both the
 * skill and the hash that accounts for it: a teammate who has never linked gets
 * working team skills from git, and a teammate who has linked refreshes them
 * without every file classifying as `owned`.
 *
 * Gitignoring them was the alternative and is worse in both directions: every
 * member would need a portal round trip before the skills existed at all — so a
 * clone is broken offline, which is the opposite of local-first — and CI, which
 * has no keychain, would never see the standards it is meant to enforce.
 *
 * ## Decision 64 lives at the top of {@link syncTeamSkills}
 *
 * No `team.org_id` means the function returns before `transport` or `readLocal`
 * is consulted: zero portal I/O, no token lookup, and not even a directory
 * listing. Both are injected precisely so a test can prove they were never
 * called, because "no network happened" is easy to claim and hard to
 * demonstrate.
 *
 * And the two failures that look alike: **unreachable keeps what is on disk and
 * says how old it is; `402`/`403` DROPS the team skills.** For settings the
 * cache is a file; here the cache *is* the working tree, so "do not use the
 * cache" has to mean removing the files — a lapsed subscription that left a
 * team's skills installed and loading would be the free team layer this rule
 * exists to prevent. Provenance still applies to every removal, so an edited
 * skill survives a lapse as the user's own file.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  describeCacheAge,
  describeTeamOutcome,
  mayUseCachedTeamLayer,
  readTeamBinding,
  TEAM_SKILLS_DIR,
  TEAM_SKILLS_PREFIX,
  type TeamBinding,
  type TeamLayerDisposition,
  type TeamSettings,
} from "../portal/index.js";
import {
  fetchTeamSkills,
  isValidTeamSkillName,
  type RejectedTeamSkill,
  type TeamSkillEntry,
  type TeamSkillsTransport,
} from "../portal/team-skills.js";
import type { InitAction } from "./init.js";
import { rel } from "./json-file.js";
import {
  forgetManaged,
  hashManaged,
  isUnmodifiedManaged,
  ownedDetail,
  rememberManaged,
} from "./managed-files.js";

/** `golem-team-<name>`. The only place a team skill directory name is formed. */
export function teamSkillDirName(name: string): string {
  if (!isValidTeamSkillName(name)) {
    // Unreachable through the public API: every caller filters on
    // `isValidTeamSkillName` first. It throws rather than returning a sanitised
    // string so that a future caller which forgets fails loudly here instead of
    // writing outside the namespace.
    throw new Error(
      `refusing to build a skill path from an unusable name: ${JSON.stringify(name)}`,
    );
  }
  return `${TEAM_SKILLS_PREFIX}${name}`;
}

/** Where a team skill's `SKILL.md` lives, re-checked after it is built. */
export function teamSkillFile(projectDir: string, name: string): string {
  const skillsRoot = path.resolve(projectDir, ".claude", "skills");
  const file = path.resolve(skillsRoot, teamSkillDirName(name), "SKILL.md");
  const dir = path.dirname(file);
  if (path.dirname(dir) !== skillsRoot || !path.basename(dir).startsWith(TEAM_SKILLS_PREFIX)) {
    throw new Error(`refusing to write a team skill outside its namespace: ${file}`);
  }
  return file;
}

/** One `golem-team-*` directory as it exists on disk right now. */
interface LocalTeamSkill {
  readonly name: string;
  readonly file: string;
  /** `null` for a directory with no readable `SKILL.md` — not ours to interpret. */
  readonly content: string | null;
  readonly mtimeMs: number | null;
}

export interface SyncTeamSkillsOptions {
  readonly projectDir: string;
  /**
   * The already-resolved `team` settings section, passed in rather than loaded
   * here so the unlinked path does no I/O at all — not even a settings read
   * this function would otherwise have to be trusted to skip.
   */
  readonly team: TeamSettings;
  readonly dryRun: boolean;
  /**
   * The authorized request. In production this is `PortalClient.request`, with
   * its refresh ladder and its keychain lookup; in a test it is a `vi.fn()`.
   *
   * **Only ever called for a linked project with `team.skills` on.** Absent
   * means there is no way to reach the portal, which is reported honestly
   * rather than treated as an empty manifest — an empty manifest would delete
   * every team skill in the project.
   */
  readonly transport?: TeamSkillsTransport;
  /**
   * Read the team skills already on disk. Injected for the same reason as
   * `transport`: it is the local cache, and the invariant says an unlinked
   * project reads no cache. A spy is the only way to prove that.
   */
  readonly readLocal?: (projectDir: string) => Promise<readonly LocalTeamSkill[]>;
  readonly now?: () => number;
}

export type TeamSkillsOutcome =
  /** No team named: the free tier, and the default. Nothing was touched. */
  | { readonly kind: "unlinked" }
  /** A team named in a shape no path may be built from. Degrades to unlinked. */
  | { readonly kind: "invalid"; readonly orgId: string; readonly reason: string }
  /** `team.skills` is off for this project, so the namespace is left as it is. */
  | { readonly kind: "disabled"; readonly orgId: string }
  /** No transport was supplied, so nothing could be fetched or removed. */
  | { readonly kind: "no_transport"; readonly orgId: string }
  /** The manifest was read and the namespace now matches it. */
  | {
      readonly kind: "synced";
      readonly orgId: string;
      readonly created: readonly string[];
      readonly refreshed: readonly string[];
      readonly removed: readonly string[];
      readonly unchanged: readonly string[];
      readonly conflicts: readonly string[];
      readonly rejected: readonly RejectedTeamSkill[];
    }
  /** No verdict was rendered, so what is on disk stands. Nothing was written. */
  | {
      readonly kind: "kept_cached";
      readonly orgId: string;
      readonly kept: readonly string[];
      readonly disposition: TeamLayerDisposition;
    }
  /** A verdict was rendered and it is no. The team skills are withdrawn. */
  | {
      readonly kind: "dropped";
      readonly orgId: string;
      readonly removed: readonly string[];
      readonly conflicts: readonly string[];
      readonly disposition: TeamLayerDisposition;
    };

export interface SyncTeamSkillsResult {
  readonly outcome: TeamSkillsOutcome;
  readonly actions: readonly InitAction[];
  /** Lines for the caller to print. Never a silent degradation. */
  readonly notices: readonly string[];
}

/** Read every `golem-team-*` skill currently in the project. */
async function readLocalTeamSkills(projectDir: string): Promise<LocalTeamSkill[]> {
  const skillsRoot = path.join(projectDir, ".claude", "skills");
  let dirNames: string[];
  try {
    dirNames = (await readdir(skillsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith(TEAM_SKILLS_PREFIX))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: LocalTeamSkill[] = [];
  for (const dirName of dirNames) {
    const name = dirName.slice(TEAM_SKILLS_PREFIX.length);
    // A directory whose suffix is not a usable name cannot have been written by
    // this module, so it is somebody else's file and is reported, never touched.
    const file = path.join(skillsRoot, dirName, "SKILL.md");
    let content: string | null = null;
    let mtimeMs: number | null = null;
    try {
      content = await readFile(file, "utf8");
      mtimeMs = (await stat(file)).mtimeMs;
    } catch {
      content = null;
    }
    out.push({ name, file, content, mtimeMs });
  }
  return out;
}

/** Is there a stray nested `golem-team/` — the shape the portal's docs describe? */
async function nestedTeamDirPresent(projectDir: string): Promise<boolean> {
  try {
    const dir = path.join(projectDir, ".claude", "skills", TEAM_SKILLS_DIR);
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Remove one team skill, if and only if Golem can prove it wrote the bytes.
 *
 * The shared half of two very different situations — a skill deleted upstream
 * and a subscription that lapsed — because the rule is identical in both: an
 * edited file is the user's, and the answer to "the team took this away" is
 * never "so discard your work".
 */
async function removeIfOurs(
  projectDir: string,
  local: LocalTeamSkill,
  dryRun: boolean,
  why: string,
): Promise<{ readonly action: InitAction; readonly removed: boolean }> {
  if (local.content === null) {
    // A directory with no readable SKILL.md is not ours to interpret, exactly as
    // in `init-skills.ts`. Leave it and say it is there.
    return {
      removed: false,
      action: {
        kind: "skip",
        path: rel(projectDir, path.dirname(local.file)),
        detail: `team skill directory with no readable SKILL.md — left alone`,
      },
    };
  }
  if (!(await isUnmodifiedManaged(projectDir, local.file, local.content))) {
    return {
      removed: false,
      action: {
        kind: "conflict",
        path: rel(projectDir, local.file),
        detail: ownedDetail(`team skill /${teamSkillDirName(local.name)} (${why})`),
      },
    };
  }
  if (!dryRun) {
    await rm(path.dirname(local.file), { recursive: true, force: true });
    await forgetManaged(projectDir, local.file);
  }
  return {
    removed: true,
    action: {
      kind: "remove",
      path: rel(projectDir, local.file),
      detail: `team skill /${teamSkillDirName(local.name)} — ${why}, and unmodified since Golem wrote it`,
    },
  };
}

/**
 * Sync `.claude/skills/golem-team-*` against the team's skills in the portal.
 *
 * Never throws. Every outcome — unlinked, malformed, offline, lapsed, a portal
 * that answers nonsense — is a result with notices, because nothing in the team
 * layer may stop the proxy starting, fail `golem init`, or fail a build.
 */
export async function syncTeamSkills(
  options: SyncTeamSkillsOptions,
): Promise<SyncTeamSkillsResult> {
  const { projectDir, dryRun } = options;
  const state = readTeamBinding(options.team);

  if (state.kind === "unlinked") {
    // Decision 64's invariant, structural rather than aspirational: this
    // returns before `transport` or `readLocal` is consulted, so there is no
    // portal request, no keychain lookup and no cache read to go wrong.
    return { outcome: { kind: "unlinked" }, actions: [], notices: [] };
  }

  if (state.kind === "invalid") {
    return {
      outcome: { kind: "invalid", orgId: state.orgId, reason: state.reason },
      actions: [],
      notices: [
        `Team skills: ${state.orgId} is named in this project's settings but ${state.reason}. ` +
          "No team skills were synced, and nothing on disk was changed.",
      ],
    };
  }

  const binding: TeamBinding = state.binding;
  if (!binding.skills) {
    // Off for this project. The namespace is left exactly as it is rather than
    // cleared: turning the sync off is not the same statement as unlinking, and
    // `golem team unlink` is the command that removes the files.
    return {
      outcome: { kind: "disabled", orgId: binding.orgId },
      actions: [],
      notices: [
        `Team ${binding.orgId}: \`team.skills\` is off for this project, so its skills are ` +
          "neither synced nor removed.",
      ],
    };
  }

  const readLocal = options.readLocal ?? readLocalTeamSkills;
  const now = options.now ?? Date.now;

  if (options.transport === undefined) {
    return {
      outcome: { kind: "no_transport", orgId: binding.orgId },
      actions: [],
      notices: [
        `Team ${binding.orgId}: this machine has no way to reach the portal, so team skills ` +
          "were not synced. Whatever is already installed is untouched — run `golem team link` " +
          "to sign in.",
      ],
    };
  }

  const notices: string[] = [];
  if (await nestedTeamDirPresent(projectDir)) {
    notices.push(
      `\`.claude/skills/${TEAM_SKILLS_DIR}/\` exists and is NOT where team skills live — ` +
        "Claude Code discovers exactly one level, so nothing in it ever loaded. Team skills " +
        `are at \`.claude/skills/${TEAM_SKILLS_PREFIX}<name>/SKILL.md\`; that directory can be deleted.`,
    );
  }

  const manifest = await fetchTeamSkills(options.transport, binding.orgId, { manifest: true });

  if (manifest.kind === "failed") {
    return await handleFailure(options, binding, manifest.disposition, readLocal, now, notices);
  }

  const local = await readLocal(projectDir);
  const localByName = new Map(local.map((s) => [s.name, s]));
  const actions: InitAction[] = [];
  const created: string[] = [];
  const refreshed: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  // Rejections accumulate from BOTH fetches: the manifest may reject a name
  // and the body fetch may reject a size, and a user needs to hear either.
  const rejected: RejectedTeamSkill[] = [...manifest.rejected];

  /** Names whose body must actually be downloaded. */
  const wanted: TeamSkillEntry[] = [];

  for (const entry of manifest.entries) {
    const existing = localByName.get(entry.name);
    if (existing === undefined || existing.content === null) {
      wanted.push(entry);
      continue;
    }
    if (hashManaged(existing.content) === entry.contentSha256) {
      // Byte-identical to what the portal holds. Nothing is written and no
      // mtime moves — R11.2's index sync is mtime-driven and would read a
      // rewrite as a change.
      unchanged.push(entry.name);
      actions.push({
        kind: "skip",
        path: rel(projectDir, existing.file),
        detail: `team skill /${teamSkillDirName(entry.name)} — up to date`,
      });
      // Nothing was written, but something was learned: bytes matching the
      // portal's own hash are provably the team's text, whoever put them there.
      // Without this a skill that arrived via git before this machine ever
      // linked would classify as `owned` forever (skill-provenance-on-clone).
      if (!dryRun) await rememberManaged(projectDir, existing.file, existing.content);
      continue;
    }
    if (!(await isUnmodifiedManaged(projectDir, existing.file, existing.content))) {
      // Edited by the user, or written by something Golem has no record of.
      // Reported and KEPT — never overwritten.
      conflicts.push(entry.name);
      actions.push({
        kind: "conflict",
        path: rel(projectDir, existing.file),
        detail: ownedDetail(`team skill /${teamSkillDirName(entry.name)}`),
      });
      continue;
    }
    wanted.push(entry);
  }

  // Deletions propagate: anything in the namespace the manifest does not list
  // has been removed by the team. This is the difference between a managed
  // namespace and a one-way copy.
  const inManifest = new Set(manifest.entries.map((e) => e.name));
  for (const existing of local) {
    if (inManifest.has(existing.name)) continue;
    const { action, removed: didRemove } = await removeIfOurs(
      projectDir,
      existing,
      dryRun,
      "removed by the team",
    );
    actions.push(action);
    if (didRemove) removed.push(existing.name);
    else if (action.kind === "conflict") conflicts.push(existing.name);
  }

  // Only now, and only for what differs, is a body downloaded.
  if (wanted.length > 0) {
    const bodies = await fetchTeamSkills(options.transport, binding.orgId, { manifest: false });
    if (bodies.kind === "failed") {
      // The manifest was readable and the bodies were not. Nothing already
      // decided is undone — the removals above stand, because the manifest that
      // authorised them was a real answer from the portal.
      notices.push(
        describeTeamOutcome(bodies.disposition, { orgId: binding.orgId }),
        `Team ${binding.orgId}: ${wanted.length} skill${wanted.length === 1 ? "" : "s"} ` +
          "could not be downloaded and are unchanged on disk.",
      );
    } else {
      const bodyByName = new Map(bodies.entries.map((e) => [e.name, e]));
      for (const entry of wanted) {
        const body = bodyByName.get(entry.name);
        if (body === undefined || body.content === undefined) {
          notices.push(
            `Team ${binding.orgId}: skill \`${entry.name}\` is listed but its content was not ` +
              "returned, so it was skipped.",
          );
          continue;
        }
        const content = body.content;
        if (hashManaged(content) !== body.contentSha256) {
          // The two values come from the same server, so agreement proves
          // little — but disagreement proves something went wrong in between,
          // and a SKILL.md is an instruction file handed to an agent.
          notices.push(
            `Team ${binding.orgId}: skill \`${entry.name}\` did not match the hash the portal ` +
              "advertised for it, so it was NOT written.",
          );
          continue;
        }
        const file = teamSkillFile(projectDir, entry.name);
        const existed = localByName.get(entry.name)?.content != null;
        actions.push({
          kind: existed ? "modify" : "create",
          path: rel(projectDir, file),
          detail: existed
            ? `team skill /${teamSkillDirName(entry.name)} — refreshed from the portal`
            : `team skill /${teamSkillDirName(entry.name)}`,
        });
        if (existed) refreshed.push(entry.name);
        else created.push(entry.name);
        if (!dryRun) {
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, content, "utf8");
          await rememberManaged(projectDir, file, content);
        }
      }
      for (const reject of bodies.rejected) {
        if (rejected.some((r) => r.name === reject.name)) continue;
        rejected.push(reject);
      }
    }
  }

  for (const reject of rejected) {
    notices.push(
      `Team ${binding.orgId}: skill \`${reject.name}\` was not installed because ${reject.reason}.`,
    );
  }

  notices.push(summarise(binding.orgId, { created, refreshed, removed, unchanged, conflicts }));

  return {
    outcome: {
      kind: "synced",
      orgId: binding.orgId,
      created,
      refreshed,
      removed,
      unchanged,
      conflicts,
      rejected,
    },
    actions,
    notices,
  };
}

/**
 * The fork that Decision 64 exists for: *was a verdict rendered?*
 *
 * `unreachable` and `auth_failed` → no verdict, so what is on disk stands and
 * its age is reported. Anything else → a verdict, and the team skills are
 * withdrawn. {@link mayUseCachedTeamLayer} is the single place that answer
 * lives; this function must never form a second opinion about it.
 */
async function handleFailure(
  options: SyncTeamSkillsOptions,
  binding: TeamBinding,
  disposition: TeamLayerDisposition,
  readLocal: (projectDir: string) => Promise<readonly LocalTeamSkill[]>,
  now: () => number,
  notices: string[],
): Promise<SyncTeamSkillsResult> {
  const { projectDir, dryRun } = options;
  const local = await readLocal(projectDir);

  if (mayUseCachedTeamLayer(disposition)) {
    const kept = local.filter((s) => s.content !== null).map((s) => s.name);
    const newest = local.reduce<number | null>(
      (acc, s) => (s.mtimeMs === null ? acc : acc === null ? s.mtimeMs : Math.max(acc, s.mtimeMs)),
      null,
    );
    notices.push(
      describeTeamOutcome(disposition, {
        orgId: binding.orgId,
        ...(newest === null ? {} : { cacheAge: describeCacheAge(newest, now()) }),
      }),
    );
    notices.push(
      kept.length === 0
        ? `Team ${binding.orgId}: no team skills are installed, and none could be fetched.`
        : `Team ${binding.orgId}: keeping the ${kept.length} team skill${
            kept.length === 1 ? "" : "s"
          } already installed` +
            `${newest === null ? "" : `, last synced ${describeCacheAge(newest, now())}`} — ` +
            `${kept.join(", ")}.`,
    );
    return {
      outcome: { kind: "kept_cached", orgId: binding.orgId, kept, disposition },
      actions: [],
      notices,
    };
  }

  // A verdict, and it is no. Withdraw the namespace — provenance-gated, so an
  // edited skill survives as the user's own file rather than being destroyed by
  // a billing event.
  const actions: InitAction[] = [];
  const removed: string[] = [];
  const conflicts: string[] = [];
  for (const existing of local) {
    const { action, removed: didRemove } = await removeIfOurs(
      projectDir,
      existing,
      dryRun,
      "the team layer is not being applied",
    );
    actions.push(action);
    if (didRemove) removed.push(existing.name);
    else if (action.kind === "conflict") conflicts.push(existing.name);
  }
  notices.push(describeTeamOutcome(disposition, { orgId: binding.orgId }));
  if (removed.length > 0) {
    notices.push(
      `Team ${binding.orgId}: removed ${removed.length} team skill${
        removed.length === 1 ? "" : "s"
      } — ${removed.join(", ")}. Golem's own skills and your own are untouched.`,
    );
  }
  if (conflicts.length > 0) {
    notices.push(
      `Team ${binding.orgId}: kept ${conflicts.length} edited team skill${
        conflicts.length === 1 ? "" : "s"
      } — ${conflicts.join(", ")} — because Golem does not delete a file you have changed.`,
    );
  }
  return {
    outcome: { kind: "dropped", orgId: binding.orgId, removed, conflicts, disposition },
    actions,
    notices,
  };
}

function summarise(
  orgId: string,
  counts: {
    readonly created: readonly string[];
    readonly refreshed: readonly string[];
    readonly removed: readonly string[];
    readonly unchanged: readonly string[];
    readonly conflicts: readonly string[];
  },
): string {
  const parts: string[] = [];
  if (counts.created.length > 0) parts.push(`${counts.created.length} added`);
  if (counts.refreshed.length > 0) parts.push(`${counts.refreshed.length} updated`);
  if (counts.removed.length > 0) parts.push(`${counts.removed.length} removed by the team`);
  if (counts.conflicts.length > 0) parts.push(`${counts.conflicts.length} kept as your own`);
  if (parts.length === 0) {
    return `Team ${orgId}: team skills are up to date (${counts.unchanged.length} installed).`;
  }
  return `Team ${orgId}: team skills synced — ${parts.join(", ")}.`;
}

/**
 * Adapter for `init-team.ts`'s `syncTeamLayer` seam, which reports what landed
 * as a list of strings and expects a throw to mean "degraded".
 *
 * Offered rather than wired: the call site in `golem init` composes the settings
 * layer (`team-layer-fetch`) and this together, and that composition belongs
 * with whoever owns the layer fetch. This keeps the shape it needs to one line.
 */
export function teamSkillsSyncLayer(
  options: Omit<SyncTeamSkillsOptions, "team">,
): (binding: TeamBinding, team: TeamSettings) => Promise<readonly string[]> {
  return async (_binding, team) => {
    const result = await syncTeamSkills({ ...options, team });
    return result.notices;
  };
}

export type { LocalTeamSkill };
/** Exported for tests: the real local read, so a spy can be compared to it. */
export { readLocalTeamSkills };
