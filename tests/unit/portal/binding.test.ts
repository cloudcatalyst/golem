/**
 * The project-to-team binding: the Decision 64 gate, and what `unlink` must and
 * must not delete.
 *
 * Two of this task's gate items live here in full — the free-tier invariant as
 * a property of the READ, and `golem team unlink` asserted with a second
 * project on the same machine that has to keep working afterwards. The rest of
 * the invariant (that nothing *calls* the portal) is in
 * `tests/unit/cli/init-team.test.ts`, where the collaborators exist to spy on.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REMOTE_DENIED_SETTINGS } from "../../../src/config/index.js";
import {
  bindTeam,
  chooseOrganization,
  isValidOrgId,
  type PortalOrganization,
  readTeamBinding,
  TEAM_CACHE_DIR_NAME,
  type TeamSettings,
  teamApiBaseUrl,
  teamCachePath,
  unbindTeam,
} from "../../../src/portal/index.js";
import { useTempDirs } from "../../helpers/tmp.js";

const newTempDir = useTempDirs("golem-team-binding");

/** The default `team` section — i.e. an unlinked, free-tier project. */
const UNLINKED: TeamSettings = { org_id: "", portal_url: "", sync: true, skills: true };

function linked(overrides: Partial<TeamSettings> = {}): TeamSettings {
  return { ...UNLINKED, org_id: "org_3IojJexample", ...overrides };
}

function org(overrides: Partial<PortalOrganization> = {}): PortalOrganization {
  return { id: "org_one", name: "Red Lava", ...overrides };
}

async function writeProjectSettings(projectDir: string, body: unknown): Promise<string> {
  const dir = path.join(projectDir, ".golem");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "settings.json");
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return file;
}

async function readProjectSettings(projectDir: string): Promise<Record<string, unknown>> {
  const text = await readFile(path.join(projectDir, ".golem", "settings.json"), "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

describe("Decision 64: an unlinked project has no team at all", () => {
  it("reads as unlinked when there is no org_id — the default and the free tier", () => {
    expect(readTeamBinding(UNLINKED)).toEqual({ kind: "unlinked" });
  });

  it("treats whitespace as no team, not as a team named ' '", () => {
    expect(readTeamBinding({ ...UNLINKED, org_id: "   " }).kind).toBe("unlinked");
  });

  it("is a pure read: sync/skills being on cannot make an unlinked project linked", () => {
    // The gate is the org id and nothing else. If `sync: true` were enough to
    // start the team path, every fresh install would be on it — the defaults
    // say true precisely because the org id is what gates them.
    expect(readTeamBinding({ org_id: "", portal_url: "", sync: true, skills: true }).kind).toBe(
      "unlinked",
    );
  });
});

describe("the binding as a settings value", () => {
  it("resolves the org id, and trims a trailing slash off the portal url", () => {
    const state = readTeamBinding(linked({ portal_url: "https://golem.run/" }));
    expect(state).toEqual({
      kind: "linked",
      binding: {
        orgId: "org_3IojJexample",
        portalUrl: "https://golem.run",
        sync: true,
        skills: true,
      },
    });
  });

  it("degrades a malformed org id to a REASON rather than an exception", () => {
    // Nothing here may break anything: a hand-edit or a bad GOLEM_TEAM_ORG_ID
    // must not throw out of `golem init`.
    const state = readTeamBinding(linked({ org_id: "../../../.ssh/authorized_keys" }));
    expect(state.kind).toBe("invalid");
    if (state.kind !== "invalid") throw new Error("unreachable");
    expect(state.reason).toMatch(/valid organization id/);
  });

  it("rejects any org id that could escape the cache directory", () => {
    expect(isValidOrgId("org_3IojJ")).toBe(true);
    for (const bad of ["../x", "a/b", "a\\b", "", "a".repeat(129), "org id"]) {
      expect(isValidOrgId(bad), bad).toBe(false);
    }
    expect(() => teamCachePath("/tmp/golem", "../escape")).toThrow(/invalid organization id/);
  });

  it("prefers the committed team.portal_url over the machine's portal.url", () => {
    // The committed value is the one that travels with the repo, which is the
    // entire reason the key exists.
    const state = readTeamBinding(linked({ portal_url: "https://team.example.test" }));
    if (state.kind !== "linked") throw new Error("expected linked");
    expect(teamApiBaseUrl(state.binding, "https://machine.example.test")).toBe(
      "https://team.example.test",
    );
  });

  it("falls back to portal.url when the project names no portal", () => {
    const state = readTeamBinding(linked());
    if (state.kind !== "linked") throw new Error("expected linked");
    expect(teamApiBaseUrl(state.binding, "https://machine.example.test/")).toBe(
      "https://machine.example.test",
    );
  });
});

describe("Decision 63: the cache is keyed per org, not one team.json", () => {
  it("names ~/.golem/teams/<org_id>.json", () => {
    expect(teamCachePath("/home/u/.golem", "org_abc")).toBe(
      path.join("/home/u/.golem", TEAM_CACHE_DIR_NAME, "org_abc.json"),
    );
  });

  it("gives two orgs on one machine two different files", () => {
    // One machine holds many projects and they may belong to different teams,
    // so a single file would be last-writer-wins between two correct repos.
    expect(teamCachePath("/home/u/.golem", "org_a")).not.toBe(
      teamCachePath("/home/u/.golem", "org_b"),
    );
  });
});

describe("choosing a team: one links silently, several prompt", () => {
  it("links a single team without asking", () => {
    expect(chooseOrganization([org({ id: "org_only" })])).toEqual({
      kind: "chosen",
      org: org({ id: "org_only" }),
    });
  });

  it("reports ambiguity rather than guessing when there are several", () => {
    const choice = chooseOrganization([org({ id: "org_a" }), org({ id: "org_b" })]);
    expect(choice.kind).toBe("ambiguous");
  });

  it("takes an explicit id or slug, by either name", () => {
    const orgs = [org({ id: "org_a", slug: "alpha" }), org({ id: "org_b", slug: "beta" })];
    expect(chooseOrganization(orgs, "org_b")).toEqual({ kind: "chosen", org: orgs[1] });
    expect(chooseOrganization(orgs, "alpha")).toEqual({ kind: "chosen", org: orgs[0] });
  });

  it("says an explicit choice was not found instead of silently picking another", () => {
    expect(chooseOrganization([org({ id: "org_a" })], "org_typo")).toEqual({
      kind: "unknown",
      requested: "org_typo",
    });
  });

  it("has nothing to choose when the account is in no teams", () => {
    expect(chooseOrganization([])).toEqual({ kind: "none" });
  });

  it("still links a team whose subscription has lapsed", () => {
    // Entitlement is the portal's question, not this task's. The 402 path
    // degrades correctly and says why; refusing to record the link would just
    // hide a team the user really is a member of.
    const lapsed = org({ id: "org_lapsed", entitled: false });
    expect(chooseOrganization([lapsed])).toEqual({ kind: "chosen", org: lapsed });
  });
});

describe("the team section is denied to a remote origin", () => {
  it("refuses every team.* key from the team layer itself", () => {
    // A layer must not be the thing that decides it is allowed to be a layer:
    // `team.org_id` from the team origin is a rebinding, and `team.sync` from
    // the team origin turns itself back on for a member who opted out.
    for (const key of ["team.org_id", "team.portal_url", "team.sync", "team.skills"]) {
      expect(REMOTE_DENIED_SETTINGS.has(key), key).toBe(true);
    }
  });
});

describe("golem team link writes the binding at project scope", () => {
  it("commits team.org_id to .golem/settings.json, not the local file", async () => {
    const projectDir = await newTempDir();
    const result = await bindTeam({ projectDir, orgId: "org_written" });

    expect(result.settingsFile).toBe(path.join(projectDir, ".golem", "settings.json"));
    expect(await readProjectSettings(projectDir)).toEqual({ team: { org_id: "org_written" } });
    // The gitignored local file is where a machine-scoped "current team" would
    // have gone, and it is exactly what this design rejects.
    expect(await exists(path.join(projectDir, ".golem", "settings.local.json"))).toBe(false);
  });

  it("commits the portal url alongside it, so a clone needs no configuration", async () => {
    const projectDir = await newTempDir();
    const result = await bindTeam({
      projectDir,
      orgId: "org_written",
      portalUrl: "https://golem.run",
    });
    expect(result.wrotePortalUrl).toBe(true);
    expect(await readProjectSettings(projectDir)).toEqual({
      team: { org_id: "org_written", portal_url: "https://golem.run" },
    });
  });

  it("preserves everything else already in the committed file", async () => {
    const projectDir = await newTempDir();
    await writeProjectSettings(projectDir, { knowledge: { wiki_dir: "docs/wiki" } });
    await bindTeam({ projectDir, orgId: "org_written" });
    expect(await readProjectSettings(projectDir)).toEqual({
      knowledge: { wiki_dir: "docs/wiki" },
      team: { org_id: "org_written" },
    });
  });

  it("refuses to write an org id that is not a legal path segment", async () => {
    const projectDir = await newTempDir();
    await expect(bindTeam({ projectDir, orgId: "../../etc/passwd" })).rejects.toThrow(
      /will not write/,
    );
  });
});

describe("golem team unlink removes the key and the skills, and KEEPS the cache", () => {
  /** Two projects on one machine, both linked to the same team, plus its cache. */
  async function twoProjectsOneTeam(): Promise<{
    userDir: string;
    projectA: string;
    projectB: string;
    cacheFile: string;
    teamSettings: TeamSettings;
  }> {
    const base = await newTempDir();
    const userDir = path.join(base, "user");
    const projectA = path.join(base, "a");
    const projectB = path.join(base, "b");
    const orgId = "org_shared";
    const teamSettings = linked({ org_id: orgId });

    for (const dir of [projectA, projectB]) {
      await writeProjectSettings(dir, { team: { org_id: orgId, portal_url: "https://p.test" } });
    }

    // The team skills, in the layout this harness actually installs: one level
    // under .claude/skills, because Claude Code discovers exactly one level.
    for (const name of ["house-style", "review-rules"]) {
      const dir = path.join(projectA, ".claude", "skills", `golem-team-${name}`);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
    }
    // One of Golem's OWN skills, which unlink must not touch.
    const ownSkill = path.join(projectA, ".claude", "skills", "golem-research");
    await mkdir(ownSkill, { recursive: true });
    await writeFile(path.join(ownSkill, "SKILL.md"), "mine\n", "utf8");

    const cacheFile = teamCachePath(userDir, orgId);
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify({ settings: [], fetched_at: 1 }), "utf8");

    return { userDir, projectA, projectB, cacheFile, teamSettings };
  }

  it("removes team.org_id from the project it was asked about", async () => {
    const { userDir, projectA } = await twoProjectsOneTeam();
    const result = await unbindTeam({ projectDir: projectA, userDir });

    expect(result.orgId).toBe("org_shared");
    expect(await readProjectSettings(projectA)).toEqual({ team: {} });
    expect(readTeamBinding({ ...UNLINKED }).kind).toBe("unlinked");
  });

  it("removes the managed team skills but not Golem's own", async () => {
    const { userDir, projectA } = await twoProjectsOneTeam();
    const result = await unbindTeam({ projectDir: projectA, userDir });

    expect(result.removedSkillDirs).toEqual([
      ".claude/skills/golem-team-house-style",
      ".claude/skills/golem-team-review-rules",
    ]);
    const skills = path.join(projectA, ".claude", "skills");
    expect(await exists(path.join(skills, "golem-team-house-style"))).toBe(false);
    expect(await exists(path.join(skills, "golem-team-review-rules"))).toBe(false);
    // A team that no longer applies must not leave its instructions behind —
    // and must not take a personal skill with it either.
    expect(await exists(path.join(skills, "golem-research", "SKILL.md"))).toBe(true);
  });

  it("also clears a nested .claude/skills/golem-team/ directory if one exists", async () => {
    // The portal's doc names this shape. Claude Code would never load it, but
    // "unlink leaves nothing behind" has to hold for a directory that is there.
    const { userDir, projectA } = await twoProjectsOneTeam();
    const nested = path.join(projectA, ".claude", "skills", "golem-team", "house-style");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "SKILL.md"), "nested\n", "utf8");

    const result = await unbindTeam({ projectDir: projectA, userDir });
    expect(result.removedSkillDirs).toContain(".claude/skills/golem-team");
    expect(await exists(path.join(projectA, ".claude", "skills", "golem-team"))).toBe(false);
  });

  it("drops the managed-file record for each skill it removed", async () => {
    const { userDir, projectA } = await twoProjectsOneTeam();
    const forgotten: string[] = [];
    await unbindTeam({
      projectDir: projectA,
      userDir,
      forget: async (rel) => {
        forgotten.push(rel);
      },
    });
    expect(forgotten.sort()).toEqual([
      ".claude/skills/golem-team-house-style/SKILL.md",
      ".claude/skills/golem-team-review-rules/SKILL.md",
    ]);
  });

  it("LEAVES ~/.golem/teams/<org_id>.json, and says that it did", async () => {
    const { userDir, projectA, cacheFile } = await twoProjectsOneTeam();
    const result = await unbindTeam({ projectDir: projectA, userDir });

    expect(await exists(cacheFile)).toBe(true);
    expect(result.cacheKept).toBe(cacheFile);
  });

  it("leaves a SECOND project on the same machine still linked and still offline-capable", async () => {
    // The point of keeping the cache. The cache is machine scope and the link
    // is project scope, so deleting it while unlinking one repo would take the
    // other's offline policy away — a silent downgrade to user defaults.
    const { userDir, projectA, projectB, cacheFile, teamSettings } = await twoProjectsOneTeam();
    await unbindTeam({ projectDir: projectA, userDir });

    // B's committed binding is untouched...
    expect(await readProjectSettings(projectB)).toEqual({
      team: { org_id: "org_shared", portal_url: "https://p.test" },
    });
    const state = readTeamBinding(teamSettings);
    expect(state.kind).toBe("linked");
    if (state.kind !== "linked") throw new Error("unreachable");

    // ...and the file its offline policy comes from is still readable, with no
    // network involved in reading it.
    expect(teamCachePath(userDir, state.binding.orgId)).toBe(cacheFile);
    expect(JSON.parse(await readFile(cacheFile, "utf8"))).toEqual({
      settings: [],
      fetched_at: 1,
    });
  });

  it("is a no-op that says so when the project named no team", async () => {
    const projectDir = await newTempDir();
    const result = await unbindTeam({ projectDir });
    expect(result.orgId).toBeNull();
    expect(result.removedSkillDirs).toEqual([]);
    expect(result.cacheKept).toBeNull();
  });
});
