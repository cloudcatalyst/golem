/**
 * The project-to-team binding: reading it, writing it, and removing it.
 *
 * `project-team-binding`. This module owns exactly one fact — **which team this
 * project belongs to** — and the two commands that change it. It does not
 * authenticate (`team-portal-auth`, `./link.ts`), does not fetch the team
 * settings layer (`team-layer-fetch`), and does not sync skills
 * (`team-skills-sync`). It writes and removes the key, and names the cache file
 * those tasks will use.
 *
 * ## Why the project and not the machine
 *
 * Which team a project belongs to is a property of the project. A
 * machine-scoped "current team" is wrong the same way a global skills install
 * is wrong: one setting silently colours every repo, and anyone working across
 * two teams either has it wrong for one of them or is flipping it by hand all
 * day. One machine routinely holds repos belonging to different teams, or to
 * none. The portal reached the same conclusion independently
 * (`docs/team-config.md` §4b), so this is a shared decision, not a proposal.
 *
 * ## The Decision 64 gate lives here
 *
 * {@link readTeamBinding} returning `unlinked` is the ONLY thing that gates the
 * team code path, and it is a pure function of already-loaded settings: it
 * opens no socket, reads no file and touches no keychain. That is deliberate.
 * The invariant — *a project with no `team.org_id` performs zero portal I/O,
 * reads no cache and looks up no token* — is only checkable if the check itself
 * is free, so every caller asks this first and does nothing at all when the
 * answer is `unlinked`.
 *
 * ## No credential is anywhere near this file
 *
 * The binding is a public organization id and a URL, which is why it is
 * committed. Tokens stay per person, per machine, in the OS keychain (ADR-0003)
 * — the project says which team, the keychain says who you are, and the two are
 * combined at sync time. Nothing in this module reads, writes or renders a
 * token.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { defaultUserDir } from "../config/paths.js";
import { writeSetting } from "../config/write-setting.js";
import type { PortalIdentity } from "./client.js";

/** The `team` settings section, structurally (snake_case, as on disk). */
export interface TeamSettings {
  readonly org_id: string;
  readonly portal_url: string;
  readonly sync: boolean;
  readonly skills: boolean;
}

/** A resolved binding — only ever produced for a project that names a team. */
export interface TeamBinding {
  readonly orgId: string;
  /** Empty means "use `portal.url`" — {@link teamApiBaseUrl} applies that. */
  readonly portalUrl: string;
  readonly sync: boolean;
  readonly skills: boolean;
}

/**
 * What a project's settings say about its team.
 *
 * `invalid` exists because "nothing here may break anything" outranks being
 * strict: a malformed `org_id` (a hand-edit, a bad `GOLEM_TEAM_ORG_ID`, a merge
 * artefact) must degrade to the free path with a reason, not throw out of
 * `golem init`.
 */
export type TeamBindingState =
  | { readonly kind: "unlinked" }
  | { readonly kind: "linked"; readonly binding: TeamBinding }
  | { readonly kind: "invalid"; readonly orgId: string; readonly reason: string };

/**
 * A portal organization id, as it may appear in a **file path**.
 *
 * Clerk ids are `org_` followed by base-something alphanumerics, but the value
 * arrives from a committed file or an environment variable, and
 * {@link teamCachePath} interpolates it into a path under the user's config
 * directory. An `org_id` of `../../../.ssh/authorized_keys` is a path traversal
 * with a settings key for a delivery mechanism, so the shape is checked once,
 * here, before any path is built from it.
 */
const ORG_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidOrgId(orgId: string): boolean {
  return ORG_ID_PATTERN.test(orgId);
}

/**
 * Read the binding out of already-loaded settings. Pure: no I/O of any kind.
 *
 * Pass `settings.team`. An empty or whitespace-only `org_id` is `unlinked`,
 * which is the default and the whole of the free tier.
 */
export function readTeamBinding(team: TeamSettings): TeamBindingState {
  const orgId = team.org_id.trim();
  if (orgId === "") return { kind: "unlinked" };
  if (!isValidOrgId(orgId)) {
    return {
      kind: "invalid",
      orgId,
      reason:
        "it is not a valid organization id (letters, digits, hyphen and underscore only). " +
        "Re-run `golem team link` to set it, or `golem team unlink` to clear it",
    };
  }
  return {
    kind: "linked",
    binding: {
      orgId,
      portalUrl: team.portal_url.trim().replace(/\/+$/, ""),
      sync: team.sync,
      skills: team.skills,
    },
  };
}

/**
 * Which portal API base a linked project talks to.
 *
 * `team.portal_url` wins because it is committed alongside the org id: a clone
 * should be able to reach its team's portal without every member configuring
 * `portal.url` by hand. Empty falls back to `portal.url`, which is the normal
 * case, and an empty result means no portal is configured at all — the caller
 * reports that rather than guessing at a host.
 */
export function teamApiBaseUrl(binding: TeamBinding, portalUrl: string): string {
  const fromBinding = binding.portalUrl.trim().replace(/\/+$/, "");
  if (fromBinding !== "") return fromBinding;
  return portalUrl.trim().replace(/\/+$/, "");
}

/** Directory holding the per-org team caches, under the user config dir. */
export const TEAM_CACHE_DIR_NAME = "teams";

/**
 * `~/.golem/teams/<org_id>.json` — the cached team layer for ONE org.
 *
 * Per org, not one `team.json` (Decision 63). One machine holds many projects
 * and they may belong to different teams, so a single file would be
 * last-writer-wins between two repos that are both correctly configured.
 *
 * This function only names the path. Writing it is `team-layer-fetch`; reading
 * it is gated on {@link readTeamBinding} being `linked`; and **`golem team
 * unlink` never deletes it** — see {@link unbindTeam}.
 */
export function teamCachePath(userDir: string, orgId: string): string {
  if (!isValidOrgId(orgId)) {
    // Unreachable through readTeamBinding, which rejects first. Kept as a hard
    // stop because this is the function that turns a settings value into a path.
    throw new Error(`refusing to build a cache path from an invalid organization id`);
  }
  return path.join(userDir, TEAM_CACHE_DIR_NAME, `${orgId}.json`);
}

// ---------------------------------------------------------------------------
// Choosing an organization
// ---------------------------------------------------------------------------

export type PortalOrganization = PortalIdentity["organizations"][number];

/**
 * The outcome of picking a team from what `GET /api/v1/me` returned.
 *
 * Pure, so the rule — *one team links silently; several prompt* — is testable
 * without a terminal. The prompting itself belongs to the CLI.
 */
export type OrganizationChoice =
  | { readonly kind: "chosen"; readonly org: PortalOrganization }
  | { readonly kind: "ambiguous"; readonly candidates: readonly PortalOrganization[] }
  | { readonly kind: "none" }
  | { readonly kind: "unknown"; readonly requested: string };

/**
 * Choose the org to bind. `requested` is `--org`, matched against id or slug.
 *
 * An org with `entitled: false` is still a legitimate choice: it exists and the
 * caller is a member, it just has no live subscription, so every config call
 * against it answers `402`. Refusing to link it would be this task deciding an
 * entitlement question that belongs to the portal, and the 402 path already
 * degrades correctly and says why. Recording the link and reporting the lapse
 * is more useful than pretending the team is not there.
 */
export function chooseOrganization(
  organizations: readonly PortalOrganization[],
  requested?: string,
): OrganizationChoice {
  const wanted = requested?.trim() ?? "";
  if (wanted !== "") {
    const match = organizations.find((org) => org.id === wanted || org.slug === wanted);
    return match === undefined
      ? { kind: "unknown", requested: wanted }
      : { kind: "chosen", org: match };
  }
  if (organizations.length === 0) return { kind: "none" };
  if (organizations.length === 1) {
    const only = organizations[0];
    if (only !== undefined) return { kind: "chosen", org: only };
    return { kind: "none" };
  }
  return { kind: "ambiguous", candidates: organizations };
}

// ---------------------------------------------------------------------------
// Writing and removing the binding
// ---------------------------------------------------------------------------

export interface BindTeamOptions {
  readonly projectDir: string;
  readonly orgId: string;
  /**
   * The portal API base to commit alongside the org id. Optional, and worth
   * passing: at link time it is necessarily the same as the `portal.url` this
   * machine already has, but the point of the key is the machine that does NOT
   * have one. A clone should be able to reach its team's portal without every
   * member configuring `portal.url` by hand, and that only works if the value
   * travelled with the repo.
   */
  readonly portalUrl?: string;
  readonly userDir?: string;
}

export interface BindTeamResult {
  readonly orgId: string;
  /** The settings file that was written — always the PROJECT-scope one. */
  readonly settingsFile: string;
  readonly wrotePortalUrl: boolean;
}

/**
 * Write `team.org_id` at **project** scope, so it is committed.
 *
 * Project scope is the point: the binding travels with the repo. Writing it to
 * `settings.local.json` would make it machine-local, which is the
 * machine-scoped "current team" this design rejects; writing it to the user
 * file would colour every repo on the machine.
 */
export async function bindTeam(options: BindTeamOptions): Promise<BindTeamResult> {
  const orgId = options.orgId.trim();
  if (!isValidOrgId(orgId)) {
    throw new Error(
      `the portal returned an organization id this harness will not write to a settings ` +
        `file (${JSON.stringify(orgId)}); expected letters, digits, hyphen and underscore only`,
    );
  }
  const scopeOptions = {
    projectDir: options.projectDir,
    ...(options.userDir === undefined ? {} : { userDir: options.userDir }),
  };
  const settingsFile = await writeSetting("project", "team.org_id", orgId, scopeOptions);
  const portalUrl = options.portalUrl?.trim() ?? "";
  if (portalUrl !== "") {
    await writeSetting("project", "team.portal_url", portalUrl, scopeOptions);
  }
  return { orgId, settingsFile, wrotePortalUrl: portalUrl !== "" };
}

/** Where the managed team skills live, and both shapes `unlink` must clear. */
export const TEAM_SKILLS_PREFIX = "golem-team-";
export const TEAM_SKILLS_DIR = "golem-team";

export interface UnbindTeamOptions {
  readonly projectDir: string;
  readonly userDir?: string;
  /**
   * Called for each managed file removed, with a project-relative POSIX path,
   * so the CLI can drop its `managed-files.json` record. A hook rather than a
   * direct import because `src/portal/` must not depend on `src/cli/`.
   */
  readonly forget?: (relativePath: string) => Promise<void>;
}

export interface UnbindTeamResult {
  /** The org the project was bound to, or null if it was never bound. */
  readonly orgId: string | null;
  readonly settingsFile: string;
  /** Project-relative POSIX paths of the skill directories removed. */
  readonly removedSkillDirs: readonly string[];
  /**
   * The cache file left ON DISK, when the project named an org. Reported so the
   * command can say out loud that it was kept and why.
   */
  readonly cacheKept: string | null;
}

/**
 * Remove the binding: the key, and the managed team skills that came with it.
 *
 * Two removals, one omission, and the omission is the interesting part.
 *
 * **Removed: the key.** Only from the project-scope file, which is the only
 * scope {@link bindTeam} writes.
 *
 * **Removed: `.claude/skills/golem-team-*`.** A team that no longer applies must
 * not leave its instructions behind — a stale team skill is an instruction the
 * agent still follows on behalf of an organization this project has left. Both
 * layouts are cleared: the flat `golem-team-<name>/` directories this harness
 * actually installs (Claude Code discovers exactly one level under
 * `.claude/skills/`, so the nesting the portal's doc shows would never be
 * loaded), and a literal `golem-team/` directory if an older or differently
 * shaped sync left one.
 *
 * **NOT removed: `~/.golem/teams/<org_id>.json`.** The cache is machine scope
 * and the link is project scope, so another project on this machine may still
 * be linked to this team, and deleting the file would take away that project's
 * offline policy — a silent downgrade to user defaults, which is the one
 * outcome the failure rule forbids. An unreferenced cache is stale at worst,
 * and its own fetch timestamp says so.
 */
export async function unbindTeam(options: UnbindTeamOptions): Promise<UnbindTeamResult> {
  const { projectDir } = options;
  const scopeOptions = {
    projectDir,
    ...(options.userDir === undefined ? {} : { userDir: options.userDir }),
  };

  // Read the org id from the project file BEFORE removing the key, so the
  // report can name the team that was unlinked and the cache that was kept.
  const orgId = await readProjectOrgId(projectDir);

  const settingsFile = await writeSetting("project", "team.org_id", undefined, scopeOptions);
  await writeSetting("project", "team.portal_url", undefined, scopeOptions);

  const removedSkillDirs = await removeTeamSkills(projectDir, options.forget);

  // Named, not deleted. The report says the cache was KEPT, so it has to be
  // able to point at the file it kept even when no userDir was passed in.
  const cacheKept =
    orgId !== null && isValidOrgId(orgId)
      ? teamCachePath(options.userDir ?? defaultUserDir(), orgId)
      : null;

  return { orgId, settingsFile, removedSkillDirs, cacheKept };
}

/**
 * The org id as written in the PROJECT file specifically.
 *
 * Deliberately not the resolved value: `golem team unlink` removes a key from
 * one file, so what it reports must be what that file says. An `org_id` arriving
 * from `GOLEM_TEAM_ORG_ID` is not something unlinking can remove, and naming it
 * would make the command look like it had failed.
 */
async function readProjectOrgId(projectDir: string): Promise<string | null> {
  const file = path.join(projectDir, ".golem", "settings.json");
  try {
    const text = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const team = (parsed as Record<string, unknown>).team;
    if (typeof team !== "object" || team === null) return null;
    const value = (team as Record<string, unknown>).org_id;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    // A missing or malformed file is not a failure of unlinking: writeSetting
    // below is what would refuse to clobber unparseable JSON, and it says so.
    return null;
  }
}

/** Remove both team-skill layouts. Returns project-relative POSIX paths. */
async function removeTeamSkills(
  projectDir: string,
  forget?: (relativePath: string) => Promise<void>,
): Promise<string[]> {
  const skillsRoot = path.join(projectDir, ".claude", "skills");
  const removed: string[] = [];

  let entries: Dirent[] = [];
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return removed; // no .claude/skills at all: nothing to do
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const isFlat = entry.name.startsWith(TEAM_SKILLS_PREFIX);
    const isNested = entry.name === TEAM_SKILLS_DIR;
    if (!isFlat && !isNested) continue;
    const dir = path.join(skillsRoot, entry.name);
    if (forget !== undefined) {
      for (const file of await skillFilesUnder(dir)) {
        await forget(path.relative(projectDir, file).split(path.sep).join("/"));
      }
    }
    await rm(dir, { recursive: true, force: true });
    removed.push(path.relative(projectDir, dir).split(path.sep).join("/"));
  }
  return removed.sort();
}

/** Every `SKILL.md` at or one level under `dir` — what a sync could have written. */
async function skillFilesUnder(dir: string): Promise<string[]> {
  const files: string[] = [];
  const direct = path.join(dir, "SKILL.md");
  try {
    if ((await stat(direct)).isFile()) files.push(direct);
  } catch {
    // not there; the nested layout is checked below
  }
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(dir, entry.name, "SKILL.md");
      try {
        if ((await stat(nested)).isFile()) files.push(nested);
      } catch {
        // a directory with no SKILL.md is not ours to account for
      }
    }
  } catch {
    // unreadable directory: the rm below still removes what it can
  }
  return files;
}
