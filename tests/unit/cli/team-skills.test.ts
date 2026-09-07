/**
 * `team-skills-sync` — the disk.
 *
 * Four claims, and each is the kind that is easy to assert loosely and hard to
 * assert honestly:
 *
 * 1. **The Decision 64 invariant**, with spies on every way out to the world
 *    and a demand that none was called. It gets its own named describe because
 *    "Golem is free and complete for a solo user" is a promise until something
 *    checks it.
 * 2. **A deletion in the portal disappears locally** — that is what makes the
 *    namespace managed rather than a one-way copy.
 * 3. **A hand-edited skill is KEPT and reported**, and a skill Golem has no
 *    record of writing is never touched at all. Those two are the whole reason
 *    provenance exists, and they are the failure mode that costs a user work.
 * 4. **A no-op sync writes nothing** — asserted on MTIMES, not on log output,
 *    because a log line saying "up to date" is exactly what a rewrite that
 *    still produced identical bytes would print.
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashManaged, managedRecordPath, rememberManaged } from "../../../src/cli/managed-files.js";
import {
  type SyncTeamSkillsOptions,
  syncTeamSkills,
  teamSkillDirName,
  teamSkillFile,
} from "../../../src/cli/team-skills.js";
import type { TeamSettings } from "../../../src/portal/index.js";
import { useTempDirs } from "../../helpers/tmp.js";

const ORG = "org_3IojJexample";
const UNLINKED: TeamSettings = { org_id: "", portal_url: "", sync: true, skills: true };

function linked(overrides: Partial<TeamSettings> = {}): TeamSettings {
  return { ...UNLINKED, org_id: ORG, ...overrides };
}

let dir: string;
const newTempDir = useTempDirs("golem-team-skills-");

beforeEach(async () => {
  dir = await newTempDir();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** What the portal holds, as `{ name: content }`. */
type Portal = Record<string, string>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A transport that serves a manifest and bodies from an in-memory team, and
 * records which form each call took — so "bodies were fetched only for what
 * differs" is a claim about calls rather than about intentions.
 */
function portalServing(skills: Portal) {
  const calls: string[] = [];
  const transport = vi.fn(async (reqPath: string) => {
    calls.push(reqPath);
    const manifest = reqPath.includes("manifest=1");
    return jsonResponse({
      skills: Object.entries(skills).map(([name, content]) => ({
        name,
        ...(manifest ? {} : { content }),
        content_sha256: hashManaged(content),
        updated_at: "2026-09-04T02:11:00Z",
      })),
    });
  });
  return { transport, calls, bodyFetches: () => calls.filter((c) => !c.includes("manifest=1")) };
}

/** Put a file on disk and record it as Golem's, the way a real sync would. */
async function installAsOurs(name: string, content: string): Promise<string> {
  const file = teamSkillFile(dir, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  await rememberManaged(dir, file, content);
  return file;
}

/** Put a file on disk with NO provenance — the way a user's own skill exists. */
async function installUnknown(dirName: string, content: string): Promise<string> {
  const file = path.join(dir, ".claude", "skills", dirName, "SKILL.md");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return file;
}

const exists = (file: string): Promise<boolean> =>
  readFile(file, "utf8").then(
    () => true,
    () => false,
  );

function run(options: Partial<SyncTeamSkillsOptions> & { team: TeamSettings }) {
  return syncTeamSkills({ projectDir: dir, dryRun: false, ...options });
}

// ---------------------------------------------------------------------------
// 1. The invariant
// ---------------------------------------------------------------------------

describe("Decision 64 invariant: no link, no team code path", () => {
  it("performs ZERO portal I/O, reads no cache and looks up no token with no org_id", async () => {
    // Both collaborators would SUCCEED if they were called — the assertion is
    // that they are not reached, not that they fail safely.
    const { transport } = portalServing({ "house-style": "team text" });
    const readLocal = vi.fn(async () => []);

    const result = await run({ team: UNLINKED, transport, readLocal });

    expect(result.outcome).toEqual({ kind: "unlinked" });
    expect(transport).not.toHaveBeenCalled();
    expect(readLocal).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
  });

  it("nags AT MOST ONCE — and the unlinked path says nothing at all, so init's one line stands", async () => {
    const result = await run({ team: UNLINKED });
    expect(result.notices).toEqual([]);
  });

  it("holds the invariant even when team skills are already sitting on disk", async () => {
    // The gate is the org id and nothing else. A project that was once linked
    // and has been unlinked must not have its files read, let alone touched.
    const file = await installAsOurs("house-style", "team text");
    const before = (await stat(file)).mtimeMs;
    const { transport } = portalServing({});
    const readLocal = vi.fn(async () => []);

    const result = await run({ team: UNLINKED, transport, readLocal });

    expect(result.outcome.kind).toBe("unlinked");
    expect(transport).not.toHaveBeenCalled();
    expect(readLocal).not.toHaveBeenCalled();
    expect(await exists(file)).toBe(true);
    expect((await stat(file)).mtimeMs).toBe(before);
  });

  it("refuses a malformed org_id without building any path from it", async () => {
    const { transport } = portalServing({});
    const readLocal = vi.fn(async () => []);
    const result = await run({ team: linked({ org_id: "../escape" }), transport, readLocal });
    expect(result.outcome.kind).toBe("invalid");
    expect(transport).not.toHaveBeenCalled();
    expect(readLocal).not.toHaveBeenCalled();
    expect(result.notices[0]).toContain("nothing on disk was changed");
  });

  it("does nothing when team.skills is off, and does not clear the namespace either", async () => {
    const file = await installAsOurs("house-style", "team text");
    const { transport } = portalServing({});
    const result = await run({ team: linked({ skills: false }), transport });
    expect(transport).not.toHaveBeenCalled();
    expect(result.outcome.kind).toBe("disabled");
    expect(await exists(file)).toBe(true);
  });

  it("without a transport, reports honestly instead of treating it as an empty team", async () => {
    // An absent transport read as "the portal listed nothing" would delete
    // every team skill in the project.
    const file = await installAsOurs("house-style", "team text");
    const result = await run({ team: linked() });
    expect(result.outcome.kind).toBe("no_transport");
    expect(await exists(file)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Added, updated, removed
// ---------------------------------------------------------------------------

describe("the managed namespace tracks the portal", () => {
  it("a skill added in the portal appears at the FLAT path on the next sync", async () => {
    const { transport } = portalServing({ "house-style": "# House style\nBe brief.\n" });
    const result = await run({ team: linked(), transport });

    const file = path.join(dir, ".claude", "skills", "golem-team-house-style", "SKILL.md");
    expect(await readFile(file, "utf8")).toBe("# House style\nBe brief.\n");
    // Flat, not nested: `.claude/skills/golem-team/house-style/` would sync
    // perfectly and never load (§159 item 1).
    expect(
      await exists(path.join(dir, ".claude", "skills", "golem-team", "house-style", "SKILL.md")),
    ).toBe(false);
    expect(result.outcome).toMatchObject({ kind: "synced", created: ["house-style"] });
  });

  it("an updated skill is refreshed, and the refresh is reported as a modify", async () => {
    await installAsOurs("house-style", "old text");
    const { transport } = portalServing({ "house-style": "new text" });
    const result = await run({ team: linked(), transport });
    expect(await readFile(teamSkillFile(dir, "house-style"), "utf8")).toBe("new text");
    expect(result.outcome).toMatchObject({ refreshed: ["house-style"] });
    expect(result.actions.some((a) => a.kind === "modify")).toBe(true);
  });

  it("a skill REMOVED in the portal is deleted locally on the next sync", async () => {
    // The headline. A namespace that only ever adds is a one-way copy, and a
    // retired instruction file that keeps loading is worse than a missing one.
    const file = await installAsOurs("retired", "gone upstream");
    await installAsOurs("kept", "still here");

    const { transport } = portalServing({ kept: "still here" });
    const result = await run({ team: linked(), transport });

    expect(await exists(file)).toBe(false);
    expect(await exists(path.dirname(file))).toBe(false);
    expect(await exists(teamSkillFile(dir, "kept"))).toBe(true);
    expect(result.outcome).toMatchObject({ removed: ["retired"] });
  });

  it("forgets the provenance of a skill it removed", async () => {
    await installAsOurs("retired", "gone upstream");
    const { transport } = portalServing({});
    await run({ team: linked(), transport });
    const record = JSON.parse(await readFile(managedRecordPath(dir), "utf8")) as Record<
      string,
      string
    >;
    expect(Object.keys(record).some((k) => k.includes("golem-team-retired"))).toBe(false);
  });

  it("fetches bodies ONLY for what differs", async () => {
    await installAsOurs("same", "identical");
    const served = portalServing({ same: "identical", changed: "new" });

    await run({ team: linked(), transport: served.transport });

    expect(served.calls[0]).toContain("manifest=1");
    // One body call for the one skill that differs — not one per skill, and
    // not a body call at all if nothing had differed (asserted below).
    expect(served.bodyFetches()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. A no-op sync writes nothing
// ---------------------------------------------------------------------------

describe("a sync where nothing changed writes no file and touches no mtime", () => {
  it("leaves every mtime alone, including the provenance record's", async () => {
    // Asserted on mtimes rather than on log output: R11.2's session-start index
    // sync is mtime-driven, so a rewrite that happened to produce identical
    // bytes would still feed it a phantom change — and would still print
    // "up to date".
    const served = portalServing({ a: "one", b: "two" });
    await run({ team: linked(), transport: served.transport });

    const files = [teamSkillFile(dir, "a"), teamSkillFile(dir, "b"), managedRecordPath(dir)];
    const before = await Promise.all(files.map(async (f) => (await stat(f)).mtimeMs));

    const second = portalServing({ a: "one", b: "two" });
    const result = await run({ team: linked(), transport: second.transport });

    const after = await Promise.all(files.map(async (f) => (await stat(f)).mtimeMs));
    expect(after).toEqual(before);
    // And no body was downloaded at all: the manifest's hashes answered it.
    expect(second.bodyFetches()).toEqual([]);
    expect(result.outcome).toMatchObject({ unchanged: ["a", "b"], created: [], refreshed: [] });
  });

  it("adopts a skill that arrived via git, so a clone is not a permanent conflict", async () => {
    // `skill-provenance-on-clone`: bytes matching the portal's own hash are
    // provably the team's text, whoever put them there. Without adopting them
    // the first teammate to sync meets a conflict on every file.
    const file = teamSkillFile(dir, "house-style");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "team text", "utf8");
    const before = (await stat(file)).mtimeMs;

    const served = portalServing({ "house-style": "team text" });
    const result = await run({ team: linked(), transport: served.transport });

    expect(result.outcome).toMatchObject({ unchanged: ["house-style"], conflicts: [] });
    expect((await stat(file)).mtimeMs).toBe(before);
    // Now it can be refreshed rather than conflicting forever.
    const next = portalServing({ "house-style": "revised" });
    const second = await run({ team: linked(), transport: next.transport });
    expect(second.outcome).toMatchObject({ refreshed: ["house-style"] });
  });

  it("writes nothing at all on a dry run, but still says what it would do", async () => {
    const served = portalServing({ "house-style": "team text" });
    const result = await run({ team: linked(), dryRun: true, transport: served.transport });
    expect(await exists(teamSkillFile(dir, "house-style"))).toBe(false);
    expect(result.actions.some((a) => a.kind === "create")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Provenance: the user's file is the user's
// ---------------------------------------------------------------------------

describe("a hand-edited team skill is reported and KEPT, never overwritten", () => {
  it("keeps the edit, reports a conflict, and does not download over it", async () => {
    await installAsOurs("house-style", "team text");
    await writeFile(teamSkillFile(dir, "house-style"), "MY OWN EDIT", "utf8");

    const served = portalServing({ "house-style": "new team text" });
    const result = await run({ team: linked(), transport: served.transport });

    expect(await readFile(teamSkillFile(dir, "house-style"), "utf8")).toBe("MY OWN EDIT");
    expect(result.outcome).toMatchObject({ conflicts: ["house-style"] });
    expect(result.actions.some((a) => a.kind === "conflict")).toBe(true);
    // Not merely un-written — not even fetched.
    expect(served.bodyFetches()).toEqual([]);
  });

  it("keeps an edited skill that the team has DELETED, rather than destroying the edit", async () => {
    // "The team removed this" is not a reason to discard someone's work.
    await installAsOurs("house-style", "team text");
    await writeFile(teamSkillFile(dir, "house-style"), "MY OWN EDIT", "utf8");

    const served = portalServing({});
    const result = await run({ team: linked(), transport: served.transport });

    expect(await readFile(teamSkillFile(dir, "house-style"), "utf8")).toBe("MY OWN EDIT");
    expect(result.outcome).toMatchObject({ removed: [], conflicts: ["house-style"] });
  });

  it("never touches a skill Golem has no record of writing", async () => {
    // Somebody hand-authored a file in the team namespace. Golem cannot prove
    // it wrote those bytes, so they are not Golem's to refresh or delete.
    const file = await installUnknown("golem-team-mine", "hand written, never synced");
    const before = (await stat(file)).mtimeMs;

    const served = portalServing({});
    const result = await run({ team: linked(), transport: served.transport });

    expect(await readFile(file, "utf8")).toBe("hand written, never synced");
    expect((await stat(file)).mtimeMs).toBe(before);
    expect(result.outcome).toMatchObject({ removed: [], conflicts: ["mine"] });
  });

  it("leaves a team directory with no readable SKILL.md alone", async () => {
    // Whatever put it there, it is not a file Golem can account for — so it is
    // reported and survives, exactly as `init-skills.ts` treats the same shape.
    const weird = path.join(dir, ".claude", "skills", "golem-team-weird");
    await mkdir(weird, { recursive: true });
    const served = portalServing({});
    const result = await run({ team: linked(), transport: served.transport });
    expect((await stat(weird)).isDirectory()).toBe(true);
    expect(result.actions.some((a) => a.kind === "skip")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. The namespace guarantee
// ---------------------------------------------------------------------------

describe("a team skill can never collide with a Golem-shipped or user-authored skill", () => {
  it("leaves Golem's own and the user's own skills entirely alone", async () => {
    const ours = await installUnknown("golem-ship", "Golem's own shipped skill");
    const theirs = await installUnknown("my-own-skill", "the user's own");
    const oursBefore = (await stat(ours)).mtimeMs;
    const theirsBefore = (await stat(theirs)).mtimeMs;

    // A portal that is actively trying to reach them.
    const served = portalServing({ ship: "overwrite golem", "my-own-skill": "overwrite theirs" });
    await run({ team: linked(), transport: served.transport });

    expect(await readFile(ours, "utf8")).toBe("Golem's own shipped skill");
    expect(await readFile(theirs, "utf8")).toBe("the user's own");
    expect((await stat(ours)).mtimeMs).toBe(oursBefore);
    expect((await stat(theirs)).mtimeMs).toBe(theirsBefore);
    // The rows landed in the team namespace instead, which is the whole point.
    expect(await exists(teamSkillFile(dir, "ship"))).toBe(true);
    expect(await exists(teamSkillFile(dir, "my-own-skill"))).toBe(true);
  });

  it("refuses a traversal name rather than writing outside the namespace", async () => {
    const served = portalServing({ "../../rules/golem-evil": "pwned", ok: "fine" });
    const result = await run({ team: linked(), transport: served.transport });

    expect(await exists(path.join(dir, ".claude", "rules", "golem-evil"))).toBe(false);
    expect(await exists(path.join(dir, "..", "rules", "golem-evil"))).toBe(false);
    expect(await exists(teamSkillFile(dir, "ok"))).toBe(true);
    expect(result.notices.join("\n")).toContain("was not installed");
  });

  it("builds every path through one function that re-checks the result", () => {
    expect(teamSkillDirName("house-style")).toBe("golem-team-house-style");
    expect(() => teamSkillDirName("../golem-ship")).toThrow(/unusable name/);
    expect(() => teamSkillFile(dir, "..")).toThrow(/unusable name/);
    expect(teamSkillFile(dir, "x")).toBe(
      path.resolve(dir, ".claude", "skills", "golem-team-x", "SKILL.md"),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Cannot reach vs not entitled
// ---------------------------------------------------------------------------

describe("cannot reach keeps what is on disk; not entitled drops it", () => {
  async function withStatus(status: number, code?: string) {
    await installAsOurs("house-style", "team text");
    const transport = vi.fn(async () => jsonResponse(code === undefined ? {} : { code }, status));
    return { result: await run({ team: linked(), transport }), transport };
  }

  it("offline: keeps the installed skills and says how old they are", async () => {
    const file = await installAsOurs("house-style", "team text");
    const mtime = (await stat(file)).mtimeMs;
    const transport = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    const result = await run({
      team: linked(),
      transport,
      // Two hours after the file was written, so the age is a real reading.
      now: () => mtime + 2 * 60 * 60 * 1000,
    });

    expect(result.outcome).toMatchObject({ kind: "kept_cached", kept: ["house-style"] });
    expect(await readFile(file, "utf8")).toBe("team text");
    expect(result.notices.join("\n")).toMatch(/2 hours/);
    expect(result.actions).toEqual([]);
  });

  it("401: the cache is allowed, because a credential is not an entitlement verdict (e2)", async () => {
    const { result } = await withStatus(401, "unauthenticated");
    expect(result.outcome.kind).toBe("kept_cached");
    expect(await exists(teamSkillFile(dir, "house-style"))).toBe(true);
  });

  it("5xx: the portal did not judge anything, so the skills stay", async () => {
    const { result } = await withStatus(503);
    expect(result.outcome.kind).toBe("kept_cached");
    expect(await exists(teamSkillFile(dir, "house-style"))).toBe(true);
  });

  it("402 subscription_required: team skills are DROPPED, not served from the cache", async () => {
    // A lapsed subscription that left the team's skills installed and loading
    // would be the free team layer this rule exists to prevent.
    const { result } = await withStatus(402, "subscription_required");
    expect(result.outcome.kind).toBe("dropped");
    expect(await exists(teamSkillFile(dir, "house-style"))).toBe(false);
    expect(result.notices.join("\n")).toContain("NOT");
  });

  it("403 not_a_member: dropped the same way, naming the team", async () => {
    const { result } = await withStatus(403, "not_a_member");
    expect(result.outcome.kind).toBe("dropped");
    expect(await exists(teamSkillFile(dir, "house-style"))).toBe(false);
    expect(result.notices.join("\n")).toContain(ORG);
  });

  it("a drop still keeps a skill the user edited", async () => {
    await installAsOurs("house-style", "team text");
    await writeFile(teamSkillFile(dir, "house-style"), "MY OWN EDIT", "utf8");
    const transport = vi.fn(async () => jsonResponse({ code: "subscription_required" }, 402));

    const result = await run({ team: linked(), transport });

    expect(result.outcome).toMatchObject({
      kind: "dropped",
      removed: [],
      conflicts: ["house-style"],
    });
    expect(await readFile(teamSkillFile(dir, "house-style"), "utf8")).toBe("MY OWN EDIT");
  });

  it("keeps the removals the manifest authorised even when the bodies then fail", async () => {
    await installAsOurs("retired", "gone upstream");
    let call = 0;
    const transport = vi.fn(async (reqPath: string) => {
      call += 1;
      if (reqPath.includes("manifest=1")) {
        return jsonResponse({
          skills: [{ name: "new-one", content_sha256: hashManaged("body") }],
        });
      }
      throw new TypeError("fetch failed");
    });

    const result = await run({ team: linked(), transport });

    expect(call).toBe(2);
    // The manifest was a real answer from the portal, so what it said to remove
    // is removed; what could not be downloaded is simply absent.
    expect(await exists(teamSkillFile(dir, "retired"))).toBe(false);
    expect(await exists(teamSkillFile(dir, "new-one"))).toBe(false);
    expect(result.notices.join("\n")).toContain("could not be downloaded");
  });

  it("refuses a body whose hash does not match the manifest's", async () => {
    const transport = vi.fn(async (reqPath: string) =>
      jsonResponse({
        skills: [
          {
            name: "house-style",
            ...(reqPath.includes("manifest=1") ? {} : { content: "TAMPERED" }),
            content_sha256: hashManaged("the real thing"),
          },
        ],
      }),
    );

    const result = await run({ team: linked(), transport });

    expect(await exists(teamSkillFile(dir, "house-style"))).toBe(false);
    expect(result.notices.join("\n")).toContain("did not match the hash");
  });
});

// ---------------------------------------------------------------------------
// 7. Nothing may break
// ---------------------------------------------------------------------------

describe("nothing here may break anything", () => {
  it("never throws, whatever the portal does", async () => {
    for (const transport of [
      async () => {
        throw new Error("boom");
      },
      async () => {
        throw "a string, thrown by something rude";
      },
      async () => jsonResponse({ skills: [{ name: 42 }] }),
      async () => new Response("<html>", { status: 200 }),
      async () => new Response(null, { status: 204 }),
    ]) {
      const result = await run({ team: linked(), transport: transport as never });
      expect(result.notices.length).toBeGreaterThan(0);
    }
  });

  it("survives a .claude/skills that does not exist", async () => {
    await rm(path.join(dir, ".claude"), { recursive: true, force: true });
    const served = portalServing({ "house-style": "team text" });
    const result = await run({ team: linked(), transport: served.transport });
    expect(result.outcome).toMatchObject({ created: ["house-style"] });
  });

  it("points out a stray nested golem-team/ directory rather than trusting it", async () => {
    await mkdir(path.join(dir, ".claude", "skills", "golem-team", "house-style"), {
      recursive: true,
    });
    const served = portalServing({});
    const result = await run({ team: linked(), transport: served.transport });
    expect(result.notices.join("\n")).toContain("exactly one level");
  });
});
