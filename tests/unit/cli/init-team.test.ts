/**
 * `golem init`'s team step: the three states, and the invariant.
 *
 * The Decision 64 invariant gets its own named test here rather than being
 * implied by another assertion, because it is the claim "Golem is free and
 * complete for a solo user" made checkable. It is asserted the only way that
 * means anything — with spies on every collaborator that could reach a network,
 * a cache or a keychain, and a demand that none of them was called.
 */

import { describe, expect, it, vi } from "vitest";
import { TEAM_LINK_HINT, teamInitStep } from "../../../src/cli/init-team.js";
import { PortalAuthError, type TeamSettings } from "../../../src/portal/index.js";

const UNLINKED: TeamSettings = { org_id: "", portal_url: "", sync: true, skills: true };
const ORG = "org_3IojJexample";

function linked(overrides: Partial<TeamSettings> = {}): TeamSettings {
  return { ...UNLINKED, org_id: ORG, ...overrides };
}

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

describe("Decision 64 invariant: no link, no team code path", () => {
  it("performs ZERO portal I/O, reads no cache and looks up no token when there is no org_id", async () => {
    // Every way out to the world, spied. An unlinked project must touch none of
    // them: an account-less, offline developer's tool quietly reaching for a
    // network is not a small regression.
    const tokenPresent = vi.fn(async () => true);
    const syncTeamLayer = vi.fn(async () => ["nope"]);

    const result = await teamInitStep({
      dryRun: false,
      team: UNLINKED,
      tokenPresent,
      syncTeamLayer,
    });

    expect(result.outcome).toEqual({ kind: "unlinked" });
    expect(tokenPresent).not.toHaveBeenCalled();
    expect(syncTeamLayer).not.toHaveBeenCalled();
  });

  it("nags AT MOST ONCE — exactly one line, naming the command once", async () => {
    const result = await teamInitStep({ dryRun: false, team: UNLINKED });
    expect(result.notices).toEqual([TEAM_LINK_HINT]);
    expect(result.notices).toHaveLength(1);
    // One mention of the command, not a sales pitch repeated per surface.
    expect(TEAM_LINK_HINT.match(/golem team link/g)).toHaveLength(1);
  });

  it("says the free tier is complete rather than framing it as missing something", async () => {
    const result = await teamInitStep({ dryRun: false, team: UNLINKED });
    expect(result.notices[0]).toMatch(/complete without one/);
  });

  it("holds the invariant even when a sync is wired up and a token exists", async () => {
    // The gate is the org id and nothing else. A machine that IS signed in must
    // still leave an unlinked project alone.
    const tokenPresent = vi.fn(async () => true);
    const syncTeamLayer = vi.fn(async () => ["security.redact_secrets"]);
    const result = await teamInitStep({
      dryRun: false,
      team: { org_id: "", portal_url: "https://golem.run", sync: true, skills: true },
      tokenPresent,
      syncTeamLayer,
    });
    expect(result.outcome.kind).toBe("unlinked");
    expect(tokenPresent).not.toHaveBeenCalled();
    expect(syncTeamLayer).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// org_id present, no token
// ---------------------------------------------------------------------------

describe("org_id present with no token: init still succeeds, and needs no network", () => {
  it("reports the state, names golem team link, and does not throw", async () => {
    const result = await teamInitStep({
      dryRun: false,
      team: linked(),
      tokenPresent: async () => false,
    });
    expect(result.outcome).toEqual({ kind: "no_token", orgId: ORG });
    expect(result.notices[0]).toContain(ORG);
    expect(result.notices[0]).toContain("golem team link");
  });

  it("never attempts a sync without a token, so nothing reaches the network", async () => {
    const syncTeamLayer = vi.fn(async () => ["never"]);
    await teamInitStep({
      dryRun: false,
      team: linked(),
      tokenPresent: async () => false,
      syncTeamLayer,
    });
    expect(syncTeamLayer).not.toHaveBeenCalled();
  });

  it("treats a keychain that throws as 'no token', not as a failed init", async () => {
    // On a Linux box with no `secret-tool` this is the normal answer.
    const result = await teamInitStep({
      dryRun: false,
      team: linked(),
      tokenPresent: async () => {
        throw new Error("no secret service available");
      },
    });
    expect(result.outcome.kind).toBe("no_token");
  });

  it("degrades a malformed org_id to a notice instead of an exception", async () => {
    const tokenPresent = vi.fn(async () => true);
    const result = await teamInitStep({
      dryRun: false,
      team: linked({ org_id: "../escape" }),
      tokenPresent,
    });
    expect(result.outcome.kind).toBe("invalid");
    expect(result.notices[0]).toContain("Carrying on with local configuration");
    // An unusable binding is not a binding: nothing is looked up for it.
    expect(tokenPresent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// org_id present, token present
// ---------------------------------------------------------------------------

describe("org_id present with a token", () => {
  it("reports what landed when the sync succeeds", async () => {
    const result = await teamInitStep({
      dryRun: false,
      team: linked(),
      tokenPresent: async () => true,
      syncTeamLayer: async () => ["security.redact_secrets", "proxy.default_target"],
    });
    expect(result.outcome).toEqual({
      kind: "applied",
      orgId: ORG,
      applied: ["security.redact_secrets", "proxy.default_target"],
    });
    expect(result.notices[0]).toContain("applied 2 team settings");
  });

  it("is honest that nothing is fetched while team-layer-fetch has not shipped", async () => {
    const result = await teamInitStep({
      dryRun: false,
      team: linked(),
      tokenPresent: async () => true,
    });
    expect(result.outcome).toEqual({ kind: "not_fetched", orgId: ORG });
    expect(result.notices[0]).toContain("local configuration");
  });

  it("does not sync when team.sync is off, and says why", async () => {
    const syncTeamLayer = vi.fn(async () => ["nope"]);
    const result = await teamInitStep({
      dryRun: false,
      team: linked({ sync: false }),
      tokenPresent: async () => true,
      syncTeamLayer,
    });
    expect(syncTeamLayer).not.toHaveBeenCalled();
    expect(result.notices[0]).toContain("team.sync");
  });

  it("writes nothing on a dry run", async () => {
    const syncTeamLayer = vi.fn(async () => ["nope"]);
    const result = await teamInitStep({
      dryRun: true,
      team: linked(),
      tokenPresent: async () => true,
      syncTeamLayer,
    });
    expect(syncTeamLayer).not.toHaveBeenCalled();
    expect(result.outcome.kind).toBe("not_fetched");
  });
});

// ---------------------------------------------------------------------------
// Nothing fails
// ---------------------------------------------------------------------------

describe("403 / 402 during init: the team is named, local config is used, NOTHING fails", () => {
  async function stepFailingWith(err: unknown) {
    return teamInitStep({
      dryRun: false,
      team: linked(),
      tokenPresent: async () => true,
      syncTeamLayer: async () => {
        throw err;
      },
    });
  }

  it("survives 403 not_a_member and drops team policy rather than serving the cache", async () => {
    const result = await stepFailingWith(
      new PortalAuthError("api_error", "GET /api/v1/orgs/... answered 403", 403),
    );
    expect(result.outcome).toEqual({ kind: "degraded", orgId: ORG, usedCache: false });
    expect(result.notices[0]).toContain(ORG);
    expect(result.notices[0]).toContain("NOT");
  });

  it("survives 402 subscription_required the same way", async () => {
    const result = await stepFailingWith(new PortalAuthError("api_error", "answered 402", 402));
    expect(result.outcome).toEqual({ kind: "degraded", orgId: ORG, usedCache: false });
    expect(result.notices[0]).toContain("subscription");
  });

  it("uses the cache when the portal is merely unreachable", async () => {
    const result = await stepFailingWith(new TypeError("fetch failed"));
    expect(result.outcome).toEqual({ kind: "degraded", orgId: ORG, usedCache: true });
  });

  it("never throws, whatever the sync does", async () => {
    // The failure rule is that there is no failure. An enhancement that can
    // fail an init is not an enhancement.
    for (const err of [
      new Error("boom"),
      new PortalAuthError("api_error", "500", 500),
      new PortalAuthError("not_linked", "gone"),
      "a string, thrown by something rude",
      undefined,
    ]) {
      const result = await stepFailingWith(err);
      expect(result.outcome.kind).toBe("degraded");
      expect(result.notices).toHaveLength(1);
      expect(result.notices[0]?.length ?? 0).toBeGreaterThan(20);
    }
  });
});
