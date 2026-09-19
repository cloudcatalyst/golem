/**
 * The wire half of `team-skills-sync`: `GET /api/v1/orgs/{orgId}/skills`.
 *
 * This module knows the endpoint, its schema, and how to turn a response into a
 * {@link TeamLayerDisposition}. It does **no** filesystem work and holds no
 * opinion about where a skill lands — `src/cli/team-skills.ts` owns that. The
 * split is deliberate: the rules that matter here are about *trusting a remote
 * payload*, and the rules that matter there are about *not destroying a user's
 * file*. Mixing them produced the class of bug this task exists to avoid.
 *
 * ## Two hashes, one round trip saved
 *
 * Every row carries `content_sha256`, and `?manifest=1` returns the rows
 * **without** `content`. So a sync is: fetch the manifest, compare hashes
 * against local provenance, fetch bodies only for what differs. That is not
 * merely a bandwidth optimisation — `R11.2`'s session-start index sync is
 * mtime-driven, so a sync that rewrote twenty byte-identical files on every
 * launch would feed it twenty phantom changes.
 *
 * The hash is also **checked**, not just compared. A body whose sha256 does not
 * match the hash the manifest advertised is refused rather than written: the
 * two values come from the same server, so agreement proves little about
 * authenticity, but disagreement proves something went wrong between them and a
 * SKILL.md is an instruction file handed to an agent.
 *
 * ## `name` is a path component, so it is refused rather than sanitised
 *
 * `name` arrives from the portal and this client interpolates it into
 * `.claude/skills/golem-team-<name>/SKILL.md`. That is exactly the shape
 * verification-notes §159 item 2 found on `org_id`: a remote string used as a
 * path. The answer is the same one — **validate and refuse**, never sanitise
 * and continue — because a sanitiser is how two distinct names collide on one
 * file, and because a name like `../../rules/golem-x` is a write outside the
 * namespace with a JSON field as the delivery mechanism.
 *
 * A refused row is reported and skipped. It never fails the sync, because
 * nothing in the team layer may break anything (Decision 64).
 *
 * ## The path in the portal's own docs is wrong, and flat wins
 *
 * `docs/api-contract.md` §3 and `docs/team-config.md` §4 both describe
 * `.claude/skills/golem-team/<name>/SKILL.md` — **nested**. Claude Code
 * discovers exactly one level under `.claude/skills/`, so every skill written
 * there would sync perfectly and never load. Recorded as verification-notes
 * §159 item 1 and filed against the portal as `portal-team-skills-path-drift`.
 * The API is unaffected: it returns a `name` and the client decides the path.
 */

import { z } from "zod";
import {
  classifyPortalError,
  classifyPortalResponse,
  type TeamLayerDisposition,
} from "./entitlement.js";

/**
 * A team skill name, as it may appear in a **directory name**.
 *
 * Lowercase letters, digits and hyphens, starting alphanumeric — the Agent
 * Skills shape, and narrow enough that no member of the set can escape a
 * directory: no `.`, no `/`, no `\`, no `..`, no drive letter, no NUL, no
 * leading hyphen to be read as a flag.
 */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidTeamSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

/**
 * Caps on what a response may ask this client to write.
 *
 * Not a security boundary — an org's admins can already put anything they like
 * inside a SKILL.md, and a team that does not trust its own admins has a
 * different problem. It is a bound on the damage a *broken* portal response can
 * do to a working tree: filling a repo with ten thousand directories is a bad
 * afternoon whether or not anyone meant it.
 */
export const MAX_TEAM_SKILLS = 500;
/** 512 KiB. A SKILL.md is prose; anything this size is a mistake. */
export const MAX_TEAM_SKILL_BYTES = 512 * 1024;

const skillRowSchema = z.object({
  name: z.string(),
  content: z.string().optional(),
  content_sha256: z.string(),
  updated_by: z.string().optional(),
  updated_at: z.string().optional(),
});

/**
 * Unknown fields are **ignored, not rejected**: the contract's §5 reserves the
 * right to add response fields within v1, so a client that fails on one is a
 * client that breaks on the portal's next deploy.
 */
const skillsResponseSchema = z.object({
  skills: z.array(skillRowSchema).default([]),
});

export type TeamSkillRow = z.infer<typeof skillRowSchema>;

/** One row that arrived, was well-formed, and has a usable name. */
export interface TeamSkillEntry {
  readonly name: string;
  /** Absent on a manifest fetch, present on a body fetch. */
  readonly content?: string;
  readonly contentSha256: string;
  readonly updatedAt?: string;
}

/** A row that arrived and will NOT be written, with the reason to report. */
export interface RejectedTeamSkill {
  readonly name: string;
  readonly reason: string;
}

export type TeamSkillsFetch =
  | {
      readonly kind: "ok";
      readonly entries: readonly TeamSkillEntry[];
      readonly rejected: readonly RejectedTeamSkill[];
    }
  | { readonly kind: "failed"; readonly disposition: TeamLayerDisposition };

/**
 * The one call this module makes on the outside world.
 *
 * A `path` under `/api/v1/`, exactly the shape of
 * {@link PortalClient.request} — so the real transport is the shipped portal
 * client with its refresh ladder, and a test's transport is a `vi.fn()` that
 * never opens a socket.
 */
export type TeamSkillsTransport = (path: string) => Promise<Response>;

/** `/api/v1/orgs/<orgId>/skills`, optionally the manifest form. */
export function teamSkillsPath(orgId: string, manifest: boolean): string {
  const base = `/api/v1/orgs/${encodeURIComponent(orgId)}/skills`;
  return manifest ? `${base}?manifest=1` : base;
}

/**
 * The body's stable `code`, if there is one.
 *
 * Best-effort by design: the disposition is decided by the STATUS, and `code`
 * only refines a 403. An error page that is HTML, empty, or truncated must
 * therefore not change the outcome — so every failure to parse yields
 * `undefined` and the status still decides.
 */
async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const code = (parsed as Record<string, unknown>).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch the team's skills — the manifest (hashes only) or the full bodies.
 *
 * Never throws. Every failure becomes a {@link TeamLayerDisposition}, because
 * the caller's decision tree is "may I use what is on disk?" and that question
 * is answered by {@link mayUseCachedTeamLayer} for every outcome including the
 * ones that arrive as exceptions.
 */
export async function fetchTeamSkills(
  transport: TeamSkillsTransport,
  orgId: string,
  options: { readonly manifest: boolean },
): Promise<TeamSkillsFetch> {
  let response: Response;
  try {
    response = await transport(teamSkillsPath(orgId, options.manifest));
  } catch (err) {
    // Offline, DNS, a timeout, or anything `src/portal/` raises — including a
    // refresh that could not be done, which is `auth_failed` and not a verdict.
    return { kind: "failed", disposition: classifyPortalError(err) };
  }

  if (!response.ok) {
    return {
      kind: "failed",
      disposition: classifyPortalResponse(response.status, await errorCode(response)),
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      kind: "failed",
      // A 200 that is not JSON is not a verdict on entitlement, and it is not
      // this client's bug either — most often it is a captive portal or a proxy
      // answering on the portal's behalf. `unreachable` keeps what is on disk,
      // which is the safe side: a stale team layer unlocks nothing.
      disposition: {
        kind: "unreachable",
        detail: "the portal answered 200 with a body that is not JSON, so nothing could be read",
      },
    };
  }

  const parsed = skillsResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      kind: "failed",
      disposition: {
        kind: "api_error",
        status: response.status,
        detail: `the portal's skills response did not match the contract (${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")})`,
      },
    };
  }

  const entries: TeamSkillEntry[] = [];
  const rejected: RejectedTeamSkill[] = [];
  const seen = new Set<string>();

  for (const row of parsed.data.skills) {
    if (entries.length + rejected.length >= MAX_TEAM_SKILLS) {
      rejected.push({
        name: row.name,
        reason: `the response listed more than ${MAX_TEAM_SKILLS} skills, so the rest were ignored`,
      });
      break;
    }
    if (!isValidTeamSkillName(row.name)) {
      rejected.push({
        name: row.name,
        // Quoted back verbatim so an admin can see what they typed. It is not
        // interpolated into any path — that is the whole point of being here.
        reason:
          "its name is not usable as a directory name (lowercase letters, digits and hyphens only)",
      });
      continue;
    }
    if (seen.has(row.name)) {
      // Two rows, one path. Neither is obviously the winner, so the first wins
      // and the collision is reported rather than silently resolved.
      rejected.push({ name: row.name, reason: "the response listed that name twice" });
      continue;
    }
    if (
      row.content !== undefined &&
      Buffer.byteLength(row.content, "utf8") > MAX_TEAM_SKILL_BYTES
    ) {
      rejected.push({
        name: row.name,
        reason: `its content is larger than ${Math.round(MAX_TEAM_SKILL_BYTES / 1024)} KiB`,
      });
      continue;
    }
    seen.add(row.name);
    entries.push({
      name: row.name,
      ...(row.content === undefined ? {} : { content: row.content }),
      contentSha256: row.content_sha256.trim().toLowerCase(),
      ...(row.updated_at === undefined ? {} : { updatedAt: row.updated_at }),
    });
  }

  return { kind: "ok", entries, rejected };
}
