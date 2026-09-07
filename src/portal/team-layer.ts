/**
 * Filling the `team` origin: fetch the org's settings, cache them per org, and
 * let a lost network keep policy.
 *
 * `team-layer-fetch`. `settings-cascade-importance` built the `team` origin as
 * a **slot** — a {@link import("../config/loader.js").LayerName} value, a rank
 * between `user` and `project`, and `LoadConfigOptions.teamLayer` for an
 * already-resolved payload. Nothing put anything in it. This module is what
 * does, and it is deliberately the ONLY thing that does.
 *
 * ## The two halves, and why they are separate functions
 *
 * A team layer is fetched RARELY and read on EVERY config load, so those are
 * not the same operation:
 *
 * - {@link syncTeamLayer} talks to the portal. It runs from `golem init` and
 *   `golem team sync` — a project-scoped, user-initiated moment. It writes
 *   `~/.golem/teams/<org_id>.json` and returns the line to say out loud.
 * - {@link resolveTeamLayer} reads that file and nothing else. It runs wherever
 *   configuration is loaded, opens no socket, and cannot block or fail.
 *
 * Collapsing them would put a network round trip behind every `golem` command
 * and every proxy request, which is the opposite of local-first — and it would
 * make an offline machine slower than an online one at reading its own config.
 * The cache is therefore not a fallback bolted onto a fetch; it is the primary
 * read path, and the fetch is what refreshes it. "Stale policy beats absent
 * policy" is easier to hold when stale is the normal case.
 *
 * ## What this module refuses to decide
 *
 * - **Whether the cache may be used** — {@link mayUseCachedTeamLayer} in
 *   `./entitlement.ts` is the single answer, and there is no second opinion
 *   here. A `402` is a verdict; a timeout is not (Decision 64(e)/(e2)).
 * - **Whether the project has a team at all** — {@link readTeamBinding} in
 *   `./binding.ts` is the Decision 64 gate, and it is pure. Every entry point
 *   below returns on `unlinked` *before* touching a file, a socket or a
 *   keychain.
 * - **Which keys a remote origin may set** — `REMOTE_DENIED_SETTINGS` in
 *   `src/config/loader.ts` is the floor, and this module's job is to hand the
 *   payload over MARKED REMOTE so the floor actually applies. It does not
 *   pre-filter: a key dropped quietly is a key an admin still believes they
 *   set, so the loader's loud `REFUSED` warning has to be the thing that
 *   happens.
 *
 * ## `enforced: true` means `"!important"`
 *
 * The wire format did not change; its meaning did. ADR-0008 §Portal
 * consequences chose the `"!important"` syntax partly because it maps 1:1 onto
 * the flag the portal already sends, so {@link translateTeamRows} is the whole
 * of the translation: flat dotted rows in, a settings-file-shaped object with a
 * top-level `"!important"` array out.
 *
 * ADR-0003: no token is read, written or logged here. The cache holds SETTINGS,
 * which are not a secret and belong in a plain file; the credential stays in
 * the OS keychain behind `./tokens.ts`.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type GolemConfig, type LoadConfigOptions, loadConfig } from "../config/loader.js";
import { defaultUserDir } from "../config/paths.js";
import { SECTION_NAMES } from "../config/schema.js";
import { VERSION } from "../version.js";
import {
  readTeamBinding,
  TEAM_CACHE_DIR_NAME,
  type TeamBinding,
  type TeamSettings,
  teamCachePath,
} from "./binding.js";
import type { PortalClient } from "./client.js";
import {
  classifyPortalError,
  classifyPortalResponse,
  describeCacheAge,
  describeTeamOutcome,
  mayUseCachedTeamLayer,
  type TeamLayerDisposition,
} from "./entitlement.js";

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/**
 * One row of `GET /api/v1/orgs/{orgId}/settings`.
 *
 * `value` is `unknown` on purpose. The portal is versioned independently and
 * may carry a key this Golem has never heard of, at a type this Golem does not
 * expect; validating the VALUE here would reject a whole payload over one row.
 * `src/config/loader.ts` already type-checks every leaf against
 * `SETTINGS_LEAVES` and warns per key, so the value's only job on the wire is
 * to survive the trip.
 */
const teamSettingRowSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  /** ADR-0008: `true` places the key in the IMPORTANT band at `team` rank. */
  enforced: z.boolean().default(false),
  schema_version: z.string().optional(),
});

export type TeamSettingRow = z.infer<typeof teamSettingRowSchema>;

const teamSettingsResponseSchema = z.object({
  settings: z.array(teamSettingRowSchema).default([]),
  schema_version: z.string().optional(),
});

export type TeamSettingsResponse = z.infer<typeof teamSettingsResponseSchema>;

/** `GET /api/v1/orgs/{orgId}/settings`, with the client describing itself. */
export function teamSettingsPath(orgId: string, schemaVersion: string = VERSION): string {
  const query = new URLSearchParams({
    golem_version: VERSION,
    schema_version: schemaVersion,
  });
  return `/api/v1/orgs/${encodeURIComponent(orgId)}/settings?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// `enforced: true` → `"!important"`
// ---------------------------------------------------------------------------

/**
 * How long a team-settings fetch may take before it counts as unreachable.
 *
 * Short on purpose. This runs during `golem init`, and the cost of waiting is
 * paid by a developer watching a prompt; the cost of giving up early is a cache
 * read. Those are not symmetric.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/** The `"!important"` declaration list, as the loader spells it. */
const IMPORTANT_KEY = "!important";

export interface TranslatedTeamLayer {
  /**
   * Settings-file-shaped: two-level sections plus an optional top-level
   * `"!important"` array. Ready for `LoadConfigOptions.teamLayer.settings`.
   */
  readonly settings: Record<string, unknown>;
  /** Dotted keys placed, in wire order, each marked when it is enforced. */
  readonly applied: readonly string[];
  /**
   * Rows this Golem could not place, with the reason. Reported, never thrown:
   * the portal may add a key or a shape at any time, and one unplaceable row
   * must not cost a team its entire layer.
   */
  readonly skipped: readonly { readonly key: string; readonly reason: string }[];
}

/**
 * Turn the portal's flat rows into one settings-file-shaped object.
 *
 * The whole translation, and the only place `enforced` is read. Two rules:
 *
 * 1. A key must be `section.key` — exactly two levels, because that is the
 *    shape every settings origin has. A row that is not is SKIPPED with a
 *    reason rather than coerced, since guessing at `a.b.c` would either invent
 *    a section or silently drop a level.
 * 2. Nothing is filtered for policy. `proxy.bypass_all` arriving here is
 *    translated like any other key and handed to the loader, which refuses it
 *    LOUDLY as a remote origin's key. Dropping it quietly here would leave an
 *    admin believing the portal set it — see the module note on the floor.
 *
 * A later row wins over an earlier one for the same key: the wire is a list and
 * the loader takes an object, so a duplicate has to resolve somehow, and
 * last-wins is what every other origin's re-declaration does.
 */
export function translateTeamRows(rows: readonly TeamSettingRow[]): TranslatedTeamLayer {
  const settings: Record<string, Record<string, unknown>> = {};
  const important: string[] = [];
  const applied: string[] = [];
  const skipped: { key: string; reason: string }[] = [];

  for (const row of rows) {
    const key = row.key.trim();
    const parts = key.split(".");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
      skipped.push({
        key: row.key,
        reason: 'it is not a "section.key" name, which is the shape every settings origin has',
      });
      continue;
    }
    const [section, leaf] = parts as [string, string];
    if (!(SECTION_NAMES as readonly string[]).includes(section)) {
      // Named early so the message says "no such section" rather than letting
      // the loader report an unknown key inside a section it also invented.
      skipped.push({
        key,
        reason: `this version of Golem has no "${section}" settings section`,
      });
      continue;
    }

    settings[section] ??= {};
    const bucket = settings[section];
    bucket[leaf] = row.value;

    // `enforced` is the whole contract: the important band at `team` rank.
    if (row.enforced && !important.includes(key)) important.push(key);
    const label = row.enforced ? `${key} (enforced)` : key;
    if (!applied.includes(label)) applied.push(label);
  }

  const out: Record<string, unknown> = { ...settings };
  if (important.length > 0) out[IMPORTANT_KEY] = important;
  return { settings: out, applied, skipped };
}

// ---------------------------------------------------------------------------
// The cache — `~/.golem/teams/<org_id>.json`, one file per org
// ---------------------------------------------------------------------------

/**
 * An entitlement verdict of NO, recorded against the cache it withdraws.
 *
 * Decision 64(d) is emphatic: *"a lapsed licence must not keep exerting
 * control, and a cache that outlives the subscription is exactly how it
 * would."* With a cache-only read path that is not automatic — nothing on a
 * `loadConfig` asks the portal anything, so an org whose subscription lapsed in
 * March would keep enforcing its March policy until somebody happened to run a
 * sync.
 *
 * So the verdict is PERSISTED, and the read path refuses a stamped cache. The
 * alternative — deleting the file — was rejected twice over: it destroys the
 * reason (a user seeing policy vanish gets no explanation), and a file that
 * disappears by itself is indistinguishable from a bug. A successful sync
 * rewrites the file whole, which clears the stamp, so re-subscribing needs no
 * repair step.
 *
 * Only `not_entitled` stamps. An `api_error` must not: Golem failing to
 * understand its own portal is not a verdict, and persisting our bug as an
 * organization's policy withdrawal is the same class of mistake in the other
 * direction.
 */
const cacheDenialSchema = z.object({
  /** The entitlement `code`, e.g. `subscription_required`. */
  code: z.string(),
  status: z.number(),
  detail: z.string(),
  /** ISO 8601 — when the portal said no. */
  at: z.string(),
});

export type TeamCacheDenial = z.infer<typeof cacheDenialSchema>;

const teamCacheSchema = z.object({
  org_id: z.string(),
  /** ISO 8601, so a human reading the file can date it without a tool. */
  fetched_at: z.string(),
  schema_version: z.string().optional(),
  settings: z.array(teamSettingRowSchema).default([]),
  /** Present once the portal has denied this org. See {@link cacheDenialSchema}. */
  denied: cacheDenialSchema.optional(),
});

/**
 * What is on disk.
 *
 * The WIRE ROWS are cached, not the translated object, so
 * {@link translateTeamRows} stays the single translation and a cache written by
 * an older Golem is re-translated by the current one. Caching the translated
 * shape would freeze one version's idea of `enforced` into a file that outlives
 * it.
 */
export type TeamLayerCache = z.infer<typeof teamCacheSchema>;

/**
 * Read one org's cache. `null` for absent, unreadable, or malformed.
 *
 * Never throws and never distinguishes those three, because the caller's next
 * move is identical for all of them: fall back to local config, out loud. A
 * corrupt cache is not an error condition to be handled, it is an absent one.
 */
export async function readTeamLayerCache(
  userDir: string,
  orgId: string,
): Promise<TeamLayerCache | null> {
  let raw: string;
  try {
    raw = await readFile(teamCachePath(userDir, orgId), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = teamCacheSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Write one org's cache, creating `~/.golem/teams/` if it is not there. */
export async function writeTeamLayerCache(userDir: string, cache: TeamLayerCache): Promise<string> {
  const file = teamCachePath(userDir, cache.org_id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  return file;
}

/** One cached team, as `golem status` reports it (Decision 63(c)). */
export interface TeamCacheStatus {
  readonly org_id: string;
  readonly fetched_at: string;
  /** Whole minutes since the fetch; `null` when `fetched_at` is unparseable. */
  readonly age_minutes: number | null;
  /** The same age in words, so a renderer does not re-derive the phrasing. */
  readonly age: string | null;
  readonly settings_count: number;
  readonly enforced_count: number;
  readonly path: string;
  /**
   * The portal's verdict of NO, when one has been recorded. A denied cache is
   * on disk but is NOT applied, and a status line that showed only its age
   * would say the opposite of what is happening.
   */
  readonly denied?: TeamCacheDenial;
}

/**
 * Every cached team on this machine, for `golem status`.
 *
 * **Per team, not one figure** (Decision 63(c)): with several caches a single
 * age is a number that describes none of them, and 63(d) guarantees caches
 * outlive the links that made them — `golem team unlink` deliberately leaves
 * them, because another project on this machine may still be using one. So the
 * report is machine-scoped, and the honest form is a row each.
 *
 * This is a deliberate boundary against Decision 64(c)'s "no link, no cache
 * read": that invariant governs the CONFIG path — whether a project applies
 * team policy — and is held by {@link resolveTeamLayer}. `golem status`
 * describes the machine, so it lists what the machine holds regardless of which
 * project it was run in. It opens no socket and looks up no token, and a machine
 * that has never linked has no directory to read.
 */
export async function listTeamLayerCaches(
  userDir: string,
  nowMs: number = Date.now(),
): Promise<readonly TeamCacheStatus[]> {
  const dir = path.join(userDir, TEAM_CACHE_DIR_NAME);
  let entries: readonly string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const out: TeamCacheStatus[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const orgId = entry.slice(0, -".json".length);
    const cache = await readTeamLayerCache(userDir, orgId).catch(() => null);
    if (cache === null) continue;
    const fetchedMs = Date.parse(cache.fetched_at);
    const dateable = Number.isFinite(fetchedMs);
    out.push({
      org_id: cache.org_id,
      fetched_at: cache.fetched_at,
      age_minutes: dateable ? Math.max(0, Math.floor((nowMs - fetchedMs) / 60_000)) : null,
      age: dateable ? describeCacheAge(fetchedMs, nowMs) : null,
      settings_count: cache.settings.length,
      enforced_count: cache.settings.filter((row) => row.enforced).length,
      path: teamCachePath(userDir, orgId),
      ...(cache.denied === undefined ? {} : { denied: cache.denied }),
    });
  }
  // Stable order so a status snapshot diffs cleanly between runs.
  return out.sort((a, b) => a.org_id.localeCompare(b.org_id));
}

// ---------------------------------------------------------------------------
// Provenance that names the TEAM
// ---------------------------------------------------------------------------

/**
 * The `source` a team value's provenance carries.
 *
 * ADR-0008 requires a team value's provenance to name the TEAM rather than the
 * cache path, and that requirement predates the ADR: a developer reading
 * `golem status` needs to know *whose* policy is in force, and
 * `C:\Users\me\.golem\teams\org_2abc.json` answers a different question. The
 * cache's date rides along on the cached form because "team policy" and
 * "three-week-old team policy" are not the same claim.
 */
export function teamLayerSource(orgId: string, fetchedAt?: string): string {
  return fetchedAt === undefined
    ? `team ${orgId} (portal)`
    : `team ${orgId} (cached copy, fetched ${fetchedAt})`;
}

// ---------------------------------------------------------------------------
// Resolving — the read path, no network, no failure
// ---------------------------------------------------------------------------

/** Ready for `LoadConfigOptions.teamLayer`. */
export interface TeamLayerForConfig {
  readonly settings: unknown;
  readonly source: string;
}

export interface TeamLayerResolution {
  /** Absent means: no team layer applies. Fall back to local, out loud. */
  readonly teamLayer?: TeamLayerForConfig;
  readonly fromCache: boolean;
  /** Age in words, when a cache supplied the layer. */
  readonly cacheAge?: string;
  /** Dotted keys placed, each marked when enforced. */
  readonly applied: readonly string[];
  readonly skipped: readonly { readonly key: string; readonly reason: string }[];
  /**
   * The line to say out loud. `undefined` ONLY for an unlinked project, which
   * gets its single mention from `golem init` and nothing further — Decision
   * 64(c)'s "no nag".
   */
  readonly notice?: string;
}

/** Nothing applies, and nothing was touched to find out. */
const NO_TEAM_LAYER: TeamLayerResolution = {
  fromCache: false,
  applied: [],
  skipped: [],
};

export interface ResolveTeamLayerOptions {
  /** The project's already-loaded `team` section, read via `readTeamBinding`. */
  readonly binding: TeamBinding;
  readonly userDir: string;
  readonly now?: () => number;
}

/**
 * The read path: cache only, no network, cannot fail.
 *
 * Called wherever configuration is loaded, so it is allowed to do exactly one
 * thing — read one file — and is allowed to fail at nothing. A missing cache is
 * the normal state of a freshly cloned repo and resolves to "no team layer",
 * which is local config.
 *
 * The caller must already have a `linked` binding. That is the Decision 64
 * gate, and it lives in {@link readTeamBinding} so that this function's
 * signature cannot be satisfied by an unlinked project: there is no `org_id` to
 * pass. {@link resolveTeamLayerForProject} is the gated wrapper.
 */
export async function resolveTeamLayer(
  options: ResolveTeamLayerOptions,
): Promise<TeamLayerResolution> {
  const { binding, userDir } = options;
  const now = options.now ?? Date.now;

  if (!binding.sync) {
    // `team.sync` off is a local choice, not a portal verdict: the team stays
    // linked (skills may still sync) and its settings are simply not applied.
    return {
      ...NO_TEAM_LAYER,
      notice:
        `Team ${binding.orgId} is linked but \`team.sync\` is off, so its settings are not ` +
        `being applied on this machine.`,
    };
  }

  const cache = await readTeamLayerCache(userDir, binding.orgId);
  if (cache === null) {
    return {
      ...NO_TEAM_LAYER,
      notice:
        `Team ${binding.orgId} is linked but this machine has no cached team settings — ` +
        `using local configuration. Run \`golem team sync\` to fetch them.`,
    };
  }

  if (cache.denied !== undefined) {
    // Decision 64(d), enforced on the read path rather than only at the moment
    // of the verdict — otherwise a lapsed subscription's policy would stand
    // until the next sync, which might be never.
    return {
      ...NO_TEAM_LAYER,
      notice:
        `Team ${binding.orgId}: the portal denied this team on ${cache.denied.at} ` +
        `(${cache.denied.code}) — ${cache.denied.detail}. The cached team settings are NOT ` +
        `being applied. Using local configuration. \`golem team sync\` re-checks.`,
    };
  }

  return cachedResolution(binding.orgId, cache, now());
}

function cachedResolution(
  orgId: string,
  cache: TeamLayerCache,
  nowMs: number,
): TeamLayerResolution {
  const translated = translateTeamRows(cache.settings);
  const fetchedMs = Date.parse(cache.fetched_at);
  const age = Number.isFinite(fetchedMs) ? describeCacheAge(fetchedMs, nowMs) : "of unknown age";
  return {
    teamLayer: {
      settings: translated.settings,
      source: teamLayerSource(orgId, cache.fetched_at),
    },
    fromCache: true,
    cacheAge: age,
    applied: translated.applied,
    skipped: translated.skipped,
    notice: `Team ${orgId}: using the cached team settings, which are ${age}.`,
  };
}

export interface ResolveForProjectOptions {
  /** The project's effective `team` section — pass `settings.team`. */
  readonly team: TeamSettings;
  readonly userDir: string;
  readonly now?: () => number;
}

/**
 * The Decision 64 gate, applied: resolve a team layer for a project, or return
 * nothing having touched nothing.
 *
 * **This is the function with the invariant.** A project whose committed config
 * has no `team.org_id` gets {@link NO_TEAM_LAYER} — no cache read, no socket,
 * no keychain lookup and no notice — and it gets it from a `return` that
 * happens before any of those exist, not from a branch that skips them. That is
 * why {@link readTeamBinding} is pure: the check itself must not be the thing
 * that does the I/O.
 *
 * An `invalid` `org_id` degrades the same way, with a reason. "Nothing here may
 * break anything" outranks being strict, and a merge artefact in a committed
 * settings file must not take a process down.
 */
export async function resolveTeamLayerForProject(
  options: ResolveForProjectOptions,
): Promise<TeamLayerResolution> {
  const state = readTeamBinding(options.team);

  if (state.kind === "unlinked") return NO_TEAM_LAYER;

  if (state.kind === "invalid") {
    return {
      ...NO_TEAM_LAYER,
      notice:
        `Team ${state.orgId} is named in this project's settings but ${state.reason}. ` +
        `Carrying on with local configuration.`,
    };
  }

  return await resolveTeamLayer({
    binding: state.binding,
    userDir: options.userDir,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export interface LoadConfigWithTeamOptions extends LoadConfigOptions {
  readonly now?: () => number;
}

export interface ConfigWithTeam extends GolemConfig {
  /** How the team layer resolved. Always present; usually "nothing applies". */
  readonly team: TeamLayerResolution;
}

/**
 * `loadConfig`, with the `team` origin actually populated.
 *
 * Two passes, and the second one is not optional: the `team` section itself
 * lives in the settings being loaded, so the binding cannot be known until a
 * first load has resolved it. The first pass is the ordinary six-origin load;
 * the second re-runs it with `teamLayer` supplied.
 *
 * **For an unlinked project the second pass never happens** — the common case
 * costs exactly one load and one pure function call, which is what keeps
 * Decision 64(a) ("free and complete") true of the code and not just the
 * pricing page. `resolveTeamLayerForProject` reads at most one already-written
 * file, so even a linked project pays no network here; refreshing that file is
 * {@link syncTeamLayer}, which runs from `golem init` and `golem team sync`.
 *
 * The resolver is untouched. `LoadConfigOptions.teamLayer` already marks the
 * origin REMOTE, so `REMOTE_DENIED_SETTINGS` applies to whatever this hands
 * over and a denied key is dropped with the loader's loud `REFUSED` warning.
 * That is the floor being armed in production: not new code, but a real payload
 * finally arriving at the check that was built for it.
 */
export async function loadConfigWithTeamLayer(
  options: LoadConfigWithTeamOptions = {},
): Promise<ConfigWithTeam> {
  const { now, ...loadOptions } = options;
  const first = await loadConfig(loadOptions);

  // An explicitly supplied layer is the caller's business, not ours — do not
  // second-guess a test or a caller that resolved one already.
  if (loadOptions.teamLayer !== undefined) return { ...first, team: NO_TEAM_LAYER };

  const team = await resolveTeamLayerForProject({
    team: first.settings.team,
    userDir: loadOptions.userDir ?? defaultUserDir(),
    ...(now === undefined ? {} : { now }),
  });

  if (team.teamLayer === undefined) return { ...first, team };

  const second = await loadConfig({ ...loadOptions, teamLayer: team.teamLayer });
  return { ...second, team };
}

// ---------------------------------------------------------------------------
// Syncing — the write path, the only place a socket is opened
// ---------------------------------------------------------------------------

export interface SyncTeamLayerOptions {
  readonly binding: TeamBinding;
  readonly userDir: string;
  /**
   * An authorized client for this team's portal. Built by the caller because
   * building one needs `portal.*` config and the credential store, and neither
   * belongs to this module.
   */
  readonly client: PortalClient;
  /**
   * Post the sync report (`POST .../settings`) so a team admin can see which
   * keys this client did not understand. Best effort by contract — *"nothing
   * about a sync depends on this call succeeding"* — so it is off unless asked
   * for, and its failure is invisible.
   */
  readonly report?: boolean;
  /** Abort the settings request after this long. See {@link DEFAULT_FETCH_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export interface SyncTeamLayerResult extends TeamLayerResolution {
  /** How the portal answered. `entitled` is the only success. */
  readonly disposition: TeamLayerDisposition;
  /** Absolute path written, when the fetch succeeded. */
  readonly cacheWritten?: string;
  /**
   * Absolute path STAMPED as denied, when the portal rendered a verdict of no
   * and a cache existed to withdraw. See {@link TeamCacheDenial}.
   */
  readonly cacheDenied?: string;
}

/**
 * Record a `not_entitled` verdict against an existing cache.
 *
 * Nothing is created: with no cache there is nothing to withdraw, and writing
 * one here would put an organization's *name* on a machine as a side effect of
 * being told it has no subscription.
 */
async function stampCacheDenied(
  userDir: string,
  orgId: string,
  disposition: Extract<TeamLayerDisposition, { kind: "not_entitled" }>,
  nowMs: number,
): Promise<string | undefined> {
  const cache = await readTeamLayerCache(userDir, orgId);
  if (cache === null) return undefined;
  try {
    return await writeTeamLayerCache(userDir, {
      ...cache,
      denied: {
        code: disposition.code,
        status: disposition.status,
        detail: disposition.detail,
        at: new Date(nowMs).toISOString(),
      },
    });
  } catch {
    // An unwritable cache dir cannot make the verdict wrong, and the caller has
    // already been told the layer is not being applied.
    return undefined;
  }
}

/**
 * Fetch the team layer, cache it, and return what applies.
 *
 * **Nothing here throws.** Every outcome — offline, lapsed, not a member, a
 * malformed payload, an unwritable cache — resolves to a `TeamLayerResolution`
 * with a sentence to say out loud, because Decision 64(f) puts "may not stop
 * the proxy starting, fail `golem init`, or fail a build" above every other
 * consideration in this file, and because the hazard is someone believing team
 * policy is in force when it is not.
 *
 * The disposition decides whether the cache may stand in, and it decides that
 * in {@link mayUseCachedTeamLayer} rather than here:
 *
 * - **unreachable** (offline, DNS, timeout, `5xx`) → cache, and report its age.
 * - **auth_failed** (`401`, refresh failed) → cache (Decision 64(e2)): the
 *   portal never judged the team, so no verdict exists to respect.
 * - **not_entitled** (`402`, `403`) → the cache is NOT used. This is the
 *   withdrawal, not a fallback.
 * - **api_error** → the cache is NOT used. If Golem cannot tell what the portal
 *   said, it must not assume the answer was yes.
 */
export async function syncTeamLayer(options: SyncTeamLayerOptions): Promise<SyncTeamLayerResult> {
  const { binding, userDir, client } = options;
  const now = options.now ?? Date.now;

  const fetched = await fetchTeamSettings(client, binding.orgId, options.timeoutMs);
  const { disposition } = fetched;

  if (disposition.kind === "entitled" && fetched.response !== undefined) {
    const rows = fetched.response.settings;
    const translated = translateTeamRows(rows);
    const fetchedAt = new Date(now()).toISOString();
    const cache: TeamLayerCache = {
      org_id: binding.orgId,
      fetched_at: fetchedAt,
      ...(fetched.response.schema_version === undefined
        ? {}
        : { schema_version: fetched.response.schema_version }),
      settings: rows,
    };

    // A cache that cannot be written is a machine that will be offline-blind
    // later, not a failed sync: the layer just fetched still applies now.
    let cacheWritten: string | undefined;
    try {
      cacheWritten = await writeTeamLayerCache(userDir, cache);
    } catch {
      cacheWritten = undefined;
    }

    if (options.report === true) await postSyncReport(client, binding.orgId, translated.skipped);

    return {
      disposition,
      teamLayer: {
        settings: translated.settings,
        source: teamLayerSource(binding.orgId),
      },
      fromCache: false,
      applied: translated.applied,
      skipped: translated.skipped,
      notice: describeTeamOutcome(disposition, { orgId: binding.orgId }),
      ...(cacheWritten === undefined ? {} : { cacheWritten }),
    };
  }

  // No usable payload. Whether the cache may stand in is decided in exactly
  // one place, and it is not this one.
  if (!mayUseCachedTeamLayer(disposition)) {
    // A VERDICT of no is recorded against the cache, so it stops applying on
    // every later config load and not merely on this one (Decision 64(d)). Our
    // own `api_error` is not a verdict and stamps nothing.
    let cacheDenied: string | undefined;
    if (disposition.kind === "not_entitled") {
      cacheDenied = await stampCacheDenied(userDir, binding.orgId, disposition, now());
    }
    return {
      disposition,
      ...NO_TEAM_LAYER,
      notice: describeTeamOutcome(disposition, { orgId: binding.orgId }),
      ...(cacheDenied === undefined ? {} : { cacheDenied }),
    };
  }

  const cache = await readTeamLayerCache(userDir, binding.orgId);
  if (cache === null) {
    return {
      disposition,
      ...NO_TEAM_LAYER,
      notice: describeTeamOutcome(disposition, { orgId: binding.orgId }),
    };
  }

  const resolution = cachedResolution(binding.orgId, cache, now());
  return {
    ...resolution,
    disposition,
    // The entitlement module owns this wording, and it says something the plain
    // cached line does not: WHY the cache is being used.
    notice: describeTeamOutcome(disposition, {
      orgId: binding.orgId,
      ...(resolution.cacheAge === undefined ? {} : { cacheAge: resolution.cacheAge }),
    }),
  };
}

export interface FetchTeamSettingsResult {
  readonly disposition: TeamLayerDisposition;
  /** Present only when the disposition is `entitled` and the body parsed. */
  readonly response?: TeamSettingsResponse;
}

/**
 * One `GET /api/v1/orgs/{orgId}/settings`, classified.
 *
 * Every exit is a disposition; nothing propagates. A `200` whose body is not
 * JSON, or is JSON of the wrong shape, is an `api_error` and NOT a reason to
 * serve the cache — that is the {@link mayUseCachedTeamLayer} rule about not
 * assuming the answer was yes when Golem cannot tell what was said.
 */
export async function fetchTeamSettings(
  client: PortalClient,
  orgId: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<FetchTeamSettingsResult> {
  let response: Response;
  try {
    // Bounded, because this runs inside `golem init`: a portal that accepts the
    // connection and then says nothing would otherwise hang an init for as long
    // as the OS lets it, and "a project must initialise without a network" has
    // to hold for a network that is *present and unhelpful*, not just absent.
    // An abort throws, so it classifies as `unreachable` — the cache path.
    response = await client.request(teamSettingsPath(orgId), {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { disposition: classifyPortalError(err) };
  }

  if (!response.ok) {
    // Match on the body's `code`, never on `error` — the prose is for humans
    // and will be reworded (the portal's contract is explicit about this).
    let code: string | undefined;
    try {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null && "code" in body) {
        const value = (body as { code?: unknown }).code;
        if (typeof value === "string") code = value;
      }
    } catch {
      // An error body that is not JSON leaves the status to decide, which is
      // what `classifyPortalResponse` does with no code.
    }
    return { disposition: classifyPortalResponse(response.status, code) };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      disposition: {
        kind: "api_error",
        status: response.status,
        detail: "the team settings response was not JSON",
      },
    };
  }

  const parsed = teamSettingsResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      disposition: {
        kind: "api_error",
        status: response.status,
        detail: "the team settings response did not have the shape this version expects",
      },
    };
  }

  return { disposition: { kind: "entitled" }, response: parsed.data };
}

/**
 * Tell the portal which keys this client could not place.
 *
 * *"Always answers `{ "recorded": true }`. Nothing about a sync depends on this
 * call succeeding."* — so this swallows everything. It exists so a team admin
 * can see who is behind rather than wonder why a key had no effect.
 */
async function postSyncReport(
  client: PortalClient,
  orgId: string,
  skipped: readonly { readonly key: string }[],
): Promise<void> {
  try {
    await client.request(`/api/v1/orgs/${encodeURIComponent(orgId)}/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        golem_version: VERSION,
        schema_version: VERSION,
        unknown_keys: skipped.map((row) => row.key),
      }),
    });
  } catch {
    // By contract, invisible.
  }
}
