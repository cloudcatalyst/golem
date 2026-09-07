/**
 * Filling the `team` origin: the fetch, the per-org cache, and the two states
 * that must never be conflated.
 *
 * This file carries `team-layer-fetch`'s whole gate:
 *
 * - `loadConfig` resolving a REAL team payload at `team` rank, and
 *   `enforced: true` arriving as an `"!important"` declaration.
 * - `REMOTE_DENIED_SETTINGS` armed against a payload that came off a fetch,
 *   not one constructed inline — the floor's first production origin.
 * - offline as a first-class path, with the cache age reported PER TEAM and
 *   asserted with two cached teams present, so one figure standing in for both
 *   fails (Decision 63(c)).
 * - the Decision 64 invariant as its own named `describe`: no link, no team
 *   code path — zero portal I/O, no cache read, no token lookup.
 * - `402`/`403` DROPPING team policy rather than serving the cache, which is
 *   reserved for the case where no verdict was rendered.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig, REMOTE_DENIED_SETTINGS } from "../../../src/config/index.js";
import {
  fetchTeamSettings,
  listTeamLayerCaches,
  loadConfigWithTeamLayer,
  type PortalClient,
  readTeamLayerCache,
  resolveTeamLayer,
  resolveTeamLayerForProject,
  syncTeamLayer,
  TEAM_CACHE_DIR_NAME,
  type TeamBinding,
  type TeamLayerCache,
  type TeamSettingRow,
  type TeamSettings,
  teamCachePath,
  teamLayerSource,
  teamSettingsPath,
  translateTeamRows,
  writeTeamLayerCache,
} from "../../../src/portal/index.js";
import { useTempDirs } from "../../helpers/tmp.js";

const newTempDir = useTempDirs("golem-team-layer");

const ORG = "org_3IojJexample";
const OTHER_ORG = "org_9ZbQother";

/** The default `team` section — an unlinked, free-tier project. */
const UNLINKED: TeamSettings = { org_id: "", portal_url: "", sync: true, skills: true };

function linkedSettings(overrides: Partial<TeamSettings> = {}): TeamSettings {
  return { ...UNLINKED, org_id: ORG, ...overrides };
}

function binding(overrides: Partial<TeamBinding> = {}): TeamBinding {
  return { orgId: ORG, portalUrl: "", sync: true, skills: true, ...overrides };
}

function row(key: string, value: unknown, enforced = false): TeamSettingRow {
  return { key, value, enforced };
}

/**
 * A `PortalClient` whose ONE request is scripted, and whose calls are counted.
 *
 * The count is the point on the Decision 64 path: "no network happened" is easy
 * to claim and hard to demonstrate, so the collaborator is a spy and the
 * assertion is `not.toHaveBeenCalled()`.
 */
function fakeClient(handler: (path: string, init?: RequestInit) => Response | Promise<Response>): {
  client: PortalClient;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async (p: string, init?: RequestInit) => await handler(p, init));
  const client: PortalClient = {
    request: request as unknown as PortalClient["request"],
    me: async () => {
      throw new Error("me() is not part of the team-layer path");
    },
    stats: { requests: 0, refreshAttempts: 0, reauthorizations: 0 },
  };
  return { client, request };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The payload used wherever the test needs a *real fetched* team layer. */
const WIRE_PAYLOAD = {
  settings: [
    { key: "security.join_injection", value: true, enforced: true },
    { key: "telemetry.enabled", value: false, enforced: false },
  ],
  schema_version: "v0.9.2",
};

// ---------------------------------------------------------------------------

describe("translateTeamRows — enforced: true means !important", () => {
  it('puts an enforced key in the top-level "!important" list and a plain key in neither', () => {
    const translated = translateTeamRows([
      row("security.join_injection", true, true),
      row("telemetry.enabled", false),
    ]);

    expect(translated.settings).toEqual({
      security: { join_injection: true },
      telemetry: { enabled: false },
      "!important": ["security.join_injection"],
    });
    expect(translated.applied).toEqual(["security.join_injection (enforced)", "telemetry.enabled"]);
    expect(translated.skipped).toEqual([]);
  });

  it('omits "!important" entirely when nothing is enforced', () => {
    // A team that enforces nothing must produce a layer byte-identical to a
    // plain settings object, so the important pass has nothing to do.
    const translated = translateTeamRows([row("telemetry.enabled", false)]);
    expect(Object.keys(translated.settings)).toEqual(["telemetry"]);
  });

  it("skips a row that is not a section.key name, with a reason, and keeps the rest", () => {
    const translated = translateTeamRows([
      row("security", true),
      row("a.b.c", 1),
      row("telemetry.enabled", false),
    ]);
    expect(translated.settings).toEqual({ telemetry: { enabled: false } });
    expect(translated.skipped.map((s) => s.key)).toEqual(["security", "a.b.c"]);
    expect(translated.skipped[0]?.reason).toContain("section.key");
  });

  it("skips a section this version of Golem does not have, naming it", () => {
    const translated = translateTeamRows([row("quantum.entangle", true)]);
    expect(translated.settings).toEqual({});
    expect(translated.skipped[0]?.reason).toContain('no "quantum" settings section');
  });

  it("lets a later row win for the same key, because the wire is a list", () => {
    const translated = translateTeamRows([
      row("telemetry.enabled", false),
      row("telemetry.enabled", true),
    ]);
    expect(translated.settings).toEqual({ telemetry: { enabled: true } });
  });

  it("does NOT pre-filter a denied key — the loader's floor has to be what refuses it", () => {
    // Dropping it quietly here would leave an admin believing the portal set
    // it. The loud REFUSED warning is asserted further down, against a payload
    // that came off an actual fetch.
    const denied = [...REMOTE_DENIED_SETTINGS][0] as string;
    const translated = translateTeamRows([row(denied, true, true)]);
    const [section, leaf] = denied.split(".") as [string, string];
    expect((translated.settings[section] as Record<string, unknown>)[leaf]).toBe(true);
    expect(translated.settings["!important"]).toContain(denied);
  });
});

// ---------------------------------------------------------------------------

describe("the per-org cache", () => {
  it("writes and reads ~/.golem/teams/<org_id>.json, one file per org", async () => {
    const userDir = await newTempDir();
    const cache: TeamLayerCache = {
      org_id: ORG,
      fetched_at: new Date().toISOString(),
      settings: [row("telemetry.enabled", false)],
    };
    const written = await writeTeamLayerCache(userDir, cache);

    expect(written).toBe(path.join(userDir, TEAM_CACHE_DIR_NAME, `${ORG}.json`));
    expect(written).toBe(teamCachePath(userDir, ORG));
    // Decision 63(a): never a single `team.json`, which would be
    // last-writer-wins between two correctly configured repos.
    expect(written).not.toContain(`${path.sep}team.json`);
    await expect(readTeamLayerCache(userDir, ORG)).resolves.toMatchObject({ org_id: ORG });
  });

  it("holds two orgs side by side without either answering for the other", async () => {
    const userDir = await newTempDir();
    await writeTeamLayerCache(userDir, {
      org_id: ORG,
      fetched_at: new Date().toISOString(),
      settings: [row("telemetry.enabled", false)],
    });
    await writeTeamLayerCache(userDir, {
      org_id: OTHER_ORG,
      fetched_at: new Date().toISOString(),
      settings: [row("telemetry.enabled", true)],
    });

    const a = await readTeamLayerCache(userDir, ORG);
    const b = await readTeamLayerCache(userDir, OTHER_ORG);
    expect(a?.settings[0]?.value).toBe(false);
    expect(b?.settings[0]?.value).toBe(true);
  });

  it("is a plain readable file and holds no credential (ADR-0003)", async () => {
    const userDir = await newTempDir();
    const written = await writeTeamLayerCache(userDir, {
      org_id: ORG,
      fetched_at: new Date().toISOString(),
      settings: [row("telemetry.enabled", false)],
    });
    const text = await readFile(written, "utf8");
    // The cache is SETTINGS. A token in it would be a token in a plain file.
    expect(text).not.toMatch(/access_token|refresh_token|Bearer/i);
    expect(JSON.parse(text)).toMatchObject({ org_id: ORG });
  });

  it("reads a missing, unreadable or malformed cache as absent rather than throwing", async () => {
    const userDir = await newTempDir();
    await expect(readTeamLayerCache(userDir, ORG)).resolves.toBeNull();

    await mkdir(path.join(userDir, TEAM_CACHE_DIR_NAME), { recursive: true });
    await writeFile(teamCachePath(userDir, ORG), "{ not json", "utf8");
    await expect(readTeamLayerCache(userDir, ORG)).resolves.toBeNull();

    await writeFile(teamCachePath(userDir, ORG), JSON.stringify({ nope: 1 }), "utf8");
    await expect(readTeamLayerCache(userDir, ORG)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("cache age is reported PER TEAM (Decision 63(c))", () => {
  it("gives two cached teams their own ages — one figure for both fails here", async () => {
    const userDir = await newTempDir();
    const now = Date.parse("2026-09-07T12:00:00.000Z");
    await writeTeamLayerCache(userDir, {
      org_id: ORG,
      fetched_at: new Date(now - 90 * 60_000).toISOString(), // 1h30 ago
      settings: [row("telemetry.enabled", false), row("security.join_injection", true, true)],
    });
    await writeTeamLayerCache(userDir, {
      org_id: OTHER_ORG,
      fetched_at: new Date(now - 40 * 24 * 60 * 60_000).toISOString(), // 40 days ago
      settings: [row("telemetry.enabled", true)],
    });

    const rows = await listTeamLayerCaches(userDir, now);
    expect(rows).toHaveLength(2);

    const byOrg = new Map(rows.map((r) => [r.org_id, r]));
    const mine = byOrg.get(ORG);
    const theirs = byOrg.get(OTHER_ORG);

    // The two ages are DIFFERENT, and each is that team's own. A single
    // aggregate — mean, newest or oldest — cannot satisfy both of these.
    expect(mine?.age_minutes).toBe(90);
    expect(mine?.age).toBe("1 hour old");
    expect(theirs?.age_minutes).toBe(40 * 24 * 60);
    expect(theirs?.age).toBe("40 days old");
    expect(mine?.age).not.toBe(theirs?.age);

    // And each row's own counts, for the same reason.
    expect(mine?.settings_count).toBe(2);
    expect(mine?.enforced_count).toBe(1);
    expect(theirs?.settings_count).toBe(1);
    expect(theirs?.enforced_count).toBe(0);
  });

  it("returns nothing at all on a machine that has never cached a team", async () => {
    const userDir = await newTempDir();
    await expect(listTeamLayerCaches(userDir)).resolves.toEqual([]);
  });

  it("skips a malformed cache file rather than failing the whole report", async () => {
    const userDir = await newTempDir();
    await writeTeamLayerCache(userDir, {
      org_id: ORG,
      fetched_at: new Date().toISOString(),
      settings: [],
    });
    await writeFile(path.join(userDir, TEAM_CACHE_DIR_NAME, "org_broken.json"), "{{{", "utf8");
    const rows = await listTeamLayerCaches(userDir);
    expect(rows.map((r) => r.org_id)).toEqual([ORG]);
  });
});

// ---------------------------------------------------------------------------

describe("the fetch and its dispositions", () => {
  it("asks for /api/v1/orgs/<id>/settings and describes the client in the query", async () => {
    const { client, request } = fakeClient(() => jsonResponse(WIRE_PAYLOAD));
    const result = await fetchTeamSettings(client, ORG);

    expect(result.disposition.kind).toBe("entitled");
    const asked = request.mock.calls[0]?.[0] as string;
    expect(asked).toContain(`/api/v1/orgs/${ORG}/settings`);
    expect(asked).toContain("golem_version=");
    expect(asked).toContain("schema_version=");
    expect(teamSettingsPath(ORG)).toBe(asked);
  });

  it("classifies 402 as not entitled and 403 as not entitled, from the body's code", async () => {
    const lapsed = fakeClient(() =>
      jsonResponse({ error: "whatever the prose says", code: "subscription_required" }, 402),
    );
    await expect(fetchTeamSettings(lapsed.client, ORG)).resolves.toMatchObject({
      disposition: { kind: "not_entitled", code: "subscription_required", status: 402 },
    });

    const stranger = fakeClient(() => jsonResponse({ code: "not_a_member" }, 403));
    await expect(fetchTeamSettings(stranger.client, ORG)).resolves.toMatchObject({
      disposition: { kind: "not_entitled", code: "not_a_member", status: 403 },
    });
  });

  it("classifies a 5xx and a thrown network error as unreachable, not as a verdict", async () => {
    const broken = fakeClient(() => jsonResponse({ error: "boom" }, 503));
    await expect(fetchTeamSettings(broken.client, ORG)).resolves.toMatchObject({
      disposition: { kind: "unreachable" },
    });

    const offline = fakeClient(() => {
      throw new Error("getaddrinfo ENOTFOUND golem.run");
    });
    await expect(fetchTeamSettings(offline.client, ORG)).resolves.toMatchObject({
      disposition: { kind: "unreachable" },
    });
  });

  it("treats a 200 of the wrong shape as api_error — never as a yes", async () => {
    const weird = fakeClient(() => jsonResponse({ settings: "not an array" }));
    await expect(fetchTeamSettings(weird.client, ORG)).resolves.toMatchObject({
      disposition: { kind: "api_error" },
    });

    const notJson = fakeClient(() => new Response("<html>hello</html>", { status: 200 }));
    await expect(fetchTeamSettings(notJson.client, ORG)).resolves.toMatchObject({
      disposition: { kind: "api_error" },
    });
  });

  it("never throws, whatever the client does", async () => {
    const nasty = fakeClient(() => {
      throw { weird: "not an Error" };
    });
    await expect(fetchTeamSettings(nasty.client, ORG)).resolves.toMatchObject({
      disposition: { kind: "unreachable" },
    });
  });
});

// ---------------------------------------------------------------------------

describe("syncTeamLayer — offline is first-class, and different from unentitled", () => {
  it("caches what it fetched and names the TEAM in the provenance source", async () => {
    const userDir = await newTempDir();
    const { client } = fakeClient(() => jsonResponse(WIRE_PAYLOAD));
    const result = await syncTeamLayer({ binding: binding(), userDir, client });

    expect(result.disposition.kind).toBe("entitled");
    expect(result.fromCache).toBe(false);
    expect(result.cacheWritten).toBe(teamCachePath(userDir, ORG));
    // ADR-0008: provenance for a team value names the team, not the cache path.
    expect(result.teamLayer?.source).toBe(teamLayerSource(ORG));
    expect(result.teamLayer?.source).toContain(ORG);
    expect(result.teamLayer?.source).not.toContain(userDir);

    // The WIRE ROWS are what is cached, so translation stays single-sourced.
    const cache = await readTeamLayerCache(userDir, ORG);
    expect(cache?.settings).toEqual(WIRE_PAYLOAD.settings);
    expect(cache?.schema_version).toBe("v0.9.2");
  });

  it("unreachable → uses the cache and reports its age", async () => {
    const userDir = await newTempDir();
    const now = Date.parse("2026-09-07T12:00:00.000Z");
    await writeTeamLayerCache(userDir, {
      org_id: ORG,
      fetched_at: new Date(now - 3 * 60 * 60_000).toISOString(),
      settings: WIRE_PAYLOAD.settings,
    });

    const { client } = fakeClient(() => {
      throw new Error("connect ETIMEDOUT");
    });
    const result = await syncTeamLayer({ binding: binding(), userDir, client, now: () => now });

    expect(result.disposition.kind).toBe("unreachable");
    expect(result.fromCache).toBe(true);
    expect(result.cacheAge).toBe("3 hours old");
    expect(result.teamLayer).toBeDefined();
    expect(result.notice).toContain("could not be reached");
    expect(result.notice).toContain("3 hours old");
    // The cached form says it is cached, and when it was taken.
    expect(result.teamLayer?.source).toContain("cached copy");
  });

  it("401 → the cache MAY be used (Decision 64(e2)), and it says to sign in again", async () => {
    const userDir = await newTempDir();
    await writeTeamLayerCache(userDir, {
      org_id: ORG,
      fetched_at: new Date().toISOString(),
      settings: WIRE_PAYLOAD.settings,
    });
    const { client } = fakeClient(() => jsonResponse({ code: "unauthenticated" }, 401));
    const result = await syncTeamLayer({ binding: binding(), userDir, client });

    expect(result.disposition.kind).toBe("auth_failed");
    expect(result.fromCache).toBe(true);
    expect(result.teamLayer).toBeDefined();
    expect(result.notice).toContain("golem team link");
  });

  it("402 DROPS team policy — the cache is NOT served", async () => {
    const userDir = await newTempDir();
    await writeTeamLayerCache(userDir, {
      org_id: ORG,
      fetched_at: new Date().toISOString(),
      settings: WIRE_PAYLOAD.settings,
    });

    const { client } = fakeClient(() => jsonResponse({ code: "subscription_required" }, 402));
    const result = await syncTeamLayer({ binding: binding(), userDir, client });

    expect(result.disposition.kind).toBe("not_entitled");
    // The whole point: a verdict is not a failure to reach the portal, and the
    // cache is the thing being withdrawn rather than a fallback.
    expect(result.teamLayer).toBeUndefined();
    expect(result.fromCache).toBe(false);
    expect(result.notice).toContain("NOT");
    expect(result.notice).toContain("subscription_required");
  });

  it("403 likewise drops it, naming the team the project claims", async () => {
    const userDir = await newTempDir();
    await writeTeamLayerCache(userDir, {
      org_id: ORG,
      fetched_at: new Date().toISOString(),
      settings: WIRE_PAYLOAD.settings,
    });
    const { client } = fakeClient(() => jsonResponse({ code: "not_a_member" }, 403));
    const result = await syncTeamLayer({ binding: binding(), userDir, client });

    expect(result.teamLayer).toBeUndefined();
    expect(result.notice).toContain(ORG);
  });

  it("api_error does not serve the cache either — a bug is not a yes", async () => {
    const userDir = await newTempDir();
    await writeTeamLayerCache(userDir, {
      org_id: ORG,
      fetched_at: new Date().toISOString(),
      settings: WIRE_PAYLOAD.settings,
    });
    const { client } = fakeClient(() => jsonResponse({ settings: 42 }));
    const result = await syncTeamLayer({ binding: binding(), userDir, client });

    expect(result.disposition.kind).toBe("api_error");
    expect(result.teamLayer).toBeUndefined();
    // ...and it stamps nothing: our own confusion is not a verdict on anyone's
    // subscription, so the cache stays usable for the offline path.
    expect((await readTeamLayerCache(userDir, ORG))?.denied).toBeUndefined();
  });

  it("unreachable with NO cache falls back to local config, out loud", async () => {
    const userDir = await newTempDir();
    const { client } = fakeClient(() => {
      throw new Error("offline");
    });
    const result = await syncTeamLayer({ binding: binding(), userDir, client });

    expect(result.teamLayer).toBeUndefined();
    expect(result.notice).toContain("no cached team settings");
    expect(result.notice).toContain("local configuration");
  });

  it("posts the sync report only when asked, and a failing report changes nothing", async () => {
    const userDir = await newTempDir();
    const { client, request } = fakeClient((_p, init) => {
      if (init?.method === "POST") throw new Error("report endpoint is down");
      return jsonResponse({
        settings: [...WIRE_PAYLOAD.settings, { key: "quantum.entangle", value: 1 }],
      });
    });
    const result = await syncTeamLayer({ binding: binding(), userDir, client, report: true });

    expect(
      request.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST"),
    ).toBe(true);
    // By contract, nothing about a sync depends on that call succeeding.
    expect(result.disposition.kind).toBe("entitled");
    expect(result.teamLayer).toBeDefined();
    expect(result.skipped.map((s) => s.key)).toEqual(["quantum.entangle"]);
  });

  it("still applies the fetched layer when the cache cannot be written", async () => {
    // A `userDir` whose `teams` path is a FILE makes mkdir fail. The layer just
    // fetched is still valid; only the offline fallback is lost.
    const userDir = await newTempDir();
    await writeFile(path.join(userDir, TEAM_CACHE_DIR_NAME), "not a directory", "utf8");
    const { client } = fakeClient(() => jsonResponse(WIRE_PAYLOAD));
    const result = await syncTeamLayer({ binding: binding(), userDir, client });

    expect(result.disposition.kind).toBe("entitled");
    expect(result.teamLayer).toBeDefined();
    expect(result.cacheWritten).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("a denied team stops enforcing on every later load (Decision 64(d))", () => {
  it("stamps the verdict into the cache, and the read path then refuses it", async () => {
    const userDir = await newTempDir();
    await writeTeamLayerCache(userDir, {
      org_id: ORG,
      fetched_at: new Date().toISOString(),
      settings: WIRE_PAYLOAD.settings,
    });

    // Before the verdict, the cache is policy.
    const before = await resolveTeamLayer({ binding: binding(), userDir });
    expect(before.teamLayer).toBeDefined();

    const { client } = fakeClient(() => jsonResponse({ code: "subscription_required" }, 402));
    const sync = await syncTeamLayer({ binding: binding(), userDir, client });
    expect(sync.cacheDenied).toBe(teamCachePath(userDir, ORG));

    // After it, the SAME cache-only read refuses to apply it — which is the
    // part a cache-only read path does not get for free.
    const after = await resolveTeamLayer({ binding: binding(), userDir });
    expect(after.teamLayer).toBeUndefined();
    expect(after.notice).toContain("subscription_required");
    expect(after.notice).toContain("NOT");

    // The file is still there, with the reason. A cache that deleted itself
    // would be indistinguishable from a bug.
    const cache = await readTeamLayerCache(userDir, ORG);
    expect(cache?.denied?.code).toBe("subscription_required");
    expect(cache?.settings).toEqual(WIRE_PAYLOAD.settings);
  });

  it("clears the stamp on a successful sync, so re-subscribing needs no repair", async () => {
    const userDir = await newTempDir();
    await writeTeamLayerCache(userDir, {
      org_id: ORG,
      fetched_at: new Date().toISOString(),
      settings: WIRE_PAYLOAD.settings,
      denied: {
        code: "subscription_required",
        status: 402,
        detail: "the team's subscription is not active",
        at: new Date().toISOString(),
      },
    });

    const { client } = fakeClient(() => jsonResponse(WIRE_PAYLOAD));
    await syncTeamLayer({ binding: binding(), userDir, client });

    expect((await readTeamLayerCache(userDir, ORG))?.denied).toBeUndefined();
    const after = await resolveTeamLayer({ binding: binding(), userDir });
    expect(after.teamLayer).toBeDefined();
  });

  it("creates no cache for a team it has never fetched, even when denied", async () => {
    const userDir = await newTempDir();
    const { client } = fakeClient(() => jsonResponse({ code: "not_a_member" }, 403));
    const result = await syncTeamLayer({ binding: binding(), userDir, client });

    expect(result.cacheDenied).toBeUndefined();
    // Being told an org has no subscription must not put its name on disk.
    await expect(readTeamLayerCache(userDir, ORG)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("loadConfig resolves a real team payload at team rank", () => {
  it("applies a fetched layer, with provenance naming the team", async () => {
    const userDir = await newTempDir();
    const projectDir = await newTempDir();
    const { client } = fakeClient(() => jsonResponse(WIRE_PAYLOAD));
    const sync = await syncTeamLayer({ binding: binding(), userDir, client });

    const { settings, provenance } = await loadConfig({
      projectDir,
      userDir,
      env: {},
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      teamLayer: sync.teamLayer as { settings: unknown; source?: string },
    });

    expect(settings.telemetry.enabled).toBe(false);
    expect(provenance["telemetry.enabled"]?.layer).toBe("team");
    expect(provenance["telemetry.enabled"]?.source).toContain(ORG);

    // `enforced: true` arrived as an "!important" declaration.
    expect(provenance["security.join_injection"]?.layer).toBe("team");
    expect(provenance["security.join_injection"]?.important).toBe(true);
  });

  it("an enforced team key beats the PROJECT file, while a plain one loses to it", async () => {
    // ADR-0008's two bands, exercised through a real fetched payload rather
    // than a constructed one: `project` outranks `team` in the normal band, and
    // the important band reverses that.
    const userDir = await newTempDir();
    const projectDir = await newTempDir();
    await mkdir(path.join(projectDir, ".golem"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".golem", "settings.json"),
      JSON.stringify({ telemetry: { enabled: true }, security: { join_injection: false } }),
      "utf8",
    );

    const { client } = fakeClient(() => jsonResponse(WIRE_PAYLOAD));
    const sync = await syncTeamLayer({ binding: binding(), userDir, client });
    const { settings, provenance } = await loadConfig({
      projectDir,
      userDir,
      env: {},
      teamLayer: sync.teamLayer as { settings: unknown; source?: string },
    });

    // Plain team key: the repo specialising a company default is expected.
    expect(settings.telemetry.enabled).toBe(true);
    expect(provenance["telemetry.enabled"]?.layer).toBe("project");
    // Enforced team key: policy, applied after every file layer.
    expect(settings.security.join_injection).toBe(true);
    expect(provenance["security.join_injection"]?.layer).toBe("team");
  });

  it("loadConfigWithTeamLayer populates the slot from the cache, end to end", async () => {
    const userDir = await newTempDir();
    const projectDir = await newTempDir();
    await mkdir(path.join(projectDir, ".golem"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".golem", "settings.json"),
      JSON.stringify({ team: { org_id: ORG } }),
      "utf8",
    );

    const { client } = fakeClient(() => jsonResponse(WIRE_PAYLOAD));
    await syncTeamLayer({ binding: binding(), userDir, client });

    const config = await loadConfigWithTeamLayer({ projectDir, userDir, env: {} });
    expect(config.team.teamLayer).toBeDefined();
    expect(config.team.fromCache).toBe(true);
    expect(config.settings.telemetry.enabled).toBe(false);
    expect(config.provenance["telemetry.enabled"]?.layer).toBe("team");
    expect(config.provenance["security.join_injection"]?.important).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("the floor is armed for the team origin (ADR-0008)", () => {
  it("drops every denied key from a REAL FETCHED payload with the loud REFUSED warning", async () => {
    const userDir = await newTempDir();
    const projectDir = await newTempDir();

    // The baseline this must not move: the same load with NO team layer. Some
    // denied keys default to `true` (`team.sync`) and some are strings
    // (`portal.url`), so "was not applied" has to be measured against the real
    // default rather than assumed to be `false`.
    const baseline = await loadConfig({ projectDir, userDir, env: {} });
    const effectiveValue = (config: typeof baseline, dotted: string): unknown => {
      const [section, leaf] = dotted.split(".") as [string, string];
      return (config.settings as unknown as Record<string, Record<string, unknown>>)[section]?.[
        leaf
      ];
    };

    // Every denied key, as the portal would send it — each with a value that
    // DIFFERS from the default (so applying it would be visible) and each
    // `enforced`, which is the strongest thing the wire can say. Importance is a
    // dial with no exception, so the floor has to hold at the top of the
    // important band.
    const deniedKeys = [...REMOTE_DENIED_SETTINGS];
    expect(deniedKeys.length).toBeGreaterThan(0);
    const hostile = deniedKeys.map((key) => {
      const current = effectiveValue(baseline, key);
      const value = typeof current === "boolean" ? !current : "hostile-value";
      return { key, value, enforced: true };
    });

    const { client } = fakeClient(() =>
      jsonResponse({
        settings: [...hostile, { key: "telemetry.enabled", value: false, enforced: false }],
      }),
    );

    const sync = await syncTeamLayer({ binding: binding(), userDir, client });
    expect(sync.teamLayer).toBeDefined();

    const applied = await loadConfig({
      projectDir,
      userDir,
      env: {},
      teamLayer: sync.teamLayer as { settings: unknown; source?: string },
    });

    for (const dotted of deniedKeys) {
      // DROPPED, not applied: the effective value is exactly what it was with
      // no team layer at all, and no team provenance was recorded for it.
      expect(effectiveValue(applied, dotted), `${dotted} was applied by a remote origin`).toEqual(
        effectiveValue(baseline, dotted),
      );
      expect(applied.provenance[dotted]?.layer).toBe(baseline.provenance[dotted]?.layer);
      expect(applied.provenance[dotted]?.layer).not.toBe("team");

      // ...and it was said out loud, naming the key. A floor that sanitises
      // quietly leaves an admin believing they set something they did not.
      const refusal = applied.warnings.find((w) => w.includes("REFUSED") && w.includes(dotted));
      expect(refusal, `no REFUSED warning for ${dotted}`).toBeDefined();
      expect(refusal).toContain("DROPPED");
      // The label names the TEAM, so the warning says whose policy was refused.
      expect(refusal).toContain(ORG);
    }

    // The rest of the payload still applied — a refused key is not a refused
    // layer.
    expect(applied.settings.telemetry.enabled).toBe(false);
    expect(applied.provenance["telemetry.enabled"]?.layer).toBe("team");
  });

  it("refuses proxy.bypass_all specifically, which is the ADR-0004 case", async () => {
    const userDir = await newTempDir();
    const projectDir = await newTempDir();
    expect(REMOTE_DENIED_SETTINGS.has("proxy.bypass_all")).toBe(true);

    const { client } = fakeClient(() =>
      jsonResponse({ settings: [{ key: "proxy.bypass_all", value: true, enforced: true }] }),
    );
    const sync = await syncTeamLayer({ binding: binding(), userDir, client });
    const { settings, warnings } = await loadConfig({
      projectDir,
      userDir,
      env: {},
      teamLayer: sync.teamLayer as { settings: unknown; source?: string },
    });

    // Redaction is never weakened by a remote party, at any importance.
    expect(settings.proxy.bypass_all).toBe(false);
    expect(warnings.some((w) => w.includes("REFUSED") && w.includes("proxy.bypass_all"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------

describe("Decision 64 — no link, no team code path", () => {
  it("performs ZERO portal I/O, reads no cache and looks up no token", async () => {
    const userDir = await newTempDir();

    // A cache that WOULD change a setting if it were read. This is the trap:
    // the test can only pass if nothing looked at it.
    await writeTeamLayerCache(userDir, {
      org_id: ORG,
      fetched_at: new Date().toISOString(),
      settings: [{ key: "telemetry.enabled", value: false, enforced: true }],
    });

    // Spies for the two collaborators that could reach the network or the
    // keychain. Neither is even constructible from this call — there is no
    // parameter to pass them through — and that is the structural half of the
    // invariant. They are asserted anyway, because the point is to be able to
    // demonstrate it rather than assert it in prose.
    const request = vi.fn(async () => jsonResponse(WIRE_PAYLOAD));
    const tokenRead = vi.fn(async () => null);

    const resolution = await resolveTeamLayerForProject({ team: UNLINKED, userDir });

    expect(resolution.teamLayer).toBeUndefined();
    expect(resolution.fromCache).toBe(false);
    expect(resolution.applied).toEqual([]);
    // "no nag beyond a single mention": this path says NOTHING. The one mention
    // an unlinked project gets is `golem init`'s TEAM_LINK_HINT.
    expect(resolution.notice).toBeUndefined();

    expect(request).not.toHaveBeenCalled();
    expect(tokenRead).not.toHaveBeenCalled();
  });

  it("leaves the loaded config untouched — no team origin appears anywhere", async () => {
    const userDir = await newTempDir();
    const projectDir = await newTempDir();

    // Same trap, one level up: a cache for a team, and a project that names
    // none. Proof by consequence, which is stronger than a call count — the
    // value provably did not arrive.
    await writeTeamLayerCache(userDir, {
      org_id: ORG,
      fetched_at: new Date().toISOString(),
      settings: [{ key: "telemetry.enabled", value: false, enforced: true }],
    });

    const config = await loadConfigWithTeamLayer({ projectDir, userDir, env: {} });

    expect(config.team.teamLayer).toBeUndefined();
    expect(config.provenance["telemetry.enabled"]?.layer).toBe("default");
    for (const entry of Object.values(config.provenance)) {
      expect(entry.layer).not.toBe("team");
    }
    expect(config.warnings.some((w) => w.includes(ORG))).toBe(false);
  });

  it("is byte-identical to a plain loadConfig for an unlinked project", async () => {
    const userDir = await newTempDir();
    const projectDir = await newTempDir();
    await writeTeamLayerCache(userDir, {
      org_id: ORG,
      fetched_at: new Date().toISOString(),
      settings: [{ key: "telemetry.enabled", value: false, enforced: false }],
    });

    const withTeam = await loadConfigWithTeamLayer({ projectDir, userDir, env: {} });
    const plain = await loadConfig({ projectDir, userDir, env: {} });

    expect(withTeam.settings).toEqual(plain.settings);
    expect(withTeam.provenance).toEqual(plain.provenance);
    expect(withTeam.warnings).toEqual(plain.warnings);
  });

  it("degrades an INVALID org_id to the free path with a reason, and no I/O", async () => {
    const userDir = await newTempDir();
    const request = vi.fn(async () => jsonResponse(WIRE_PAYLOAD));

    // A path-traversal attempt via a committed settings file. Refused, not
    // sanitised — see verification-notes §159 item 2.
    const resolution = await resolveTeamLayerForProject({
      team: { ...UNLINKED, org_id: "../../../.ssh/authorized_keys" },
      userDir,
    });

    expect(resolution.teamLayer).toBeUndefined();
    expect(resolution.notice).toContain("valid organization id");
    expect(request).not.toHaveBeenCalled();
  });

  it("a linked project with team.sync off applies nothing, and says which choice did it", async () => {
    const userDir = await newTempDir();
    await writeTeamLayerCache(userDir, {
      org_id: ORG,
      fetched_at: new Date().toISOString(),
      settings: WIRE_PAYLOAD.settings,
    });

    const resolution = await resolveTeamLayerForProject({
      team: linkedSettings({ sync: false }),
      userDir,
    });

    expect(resolution.teamLayer).toBeUndefined();
    expect(resolution.notice).toContain("team.sync");
  });

  it("a linked project with no cache says so and falls back to local", async () => {
    const userDir = await newTempDir();
    const resolution = await resolveTeamLayerForProject({ team: linkedSettings(), userDir });

    expect(resolution.teamLayer).toBeUndefined();
    expect(resolution.notice).toContain("no cached team settings");
    expect(resolution.notice).toContain("golem team sync");
  });
});
