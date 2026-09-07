/**
 * "Cannot reach" is not "not entitled" — the rule, in both directions.
 *
 * This is the gate item the whole team design exists to protect, so it is
 * asserted as a property of one function rather than inferred from behaviour
 * somewhere downstream: the cache is available for exactly the states where the
 * portal rendered NO VERDICT, and for no others.
 *
 * Both failure directions are named tests, because each is a real bug someone
 * would ship:
 *
 * - a 402 treated like a timeout keeps applying team policy after the
 *   subscription ended, which is a free team layer granted by a bug;
 * - a timeout treated like a 402 drops an entitled team's policy the moment a
 *   developer's train enters a tunnel.
 */

import { describe, expect, it } from "vitest";
import {
  classifyPortalError,
  classifyPortalResponse,
  describeCacheAge,
  describeTeamOutcome,
  mayUseCachedTeamLayer,
  PortalAuthError,
} from "../../../src/portal/index.js";

const ORG = "org_3IojJexample";

describe("not entitled: a verdict was rendered, and the cache is withdrawn", () => {
  it("classifies 402 subscription_required as not entitled", () => {
    const d = classifyPortalResponse(402, "subscription_required");
    expect(d).toEqual({
      kind: "not_entitled",
      code: "subscription_required",
      status: 402,
      detail: "the team's subscription is not active",
    });
  });

  it("classifies 403 not_a_member as not entitled", () => {
    const d = classifyPortalResponse(403, "not_a_member");
    expect(d.kind).toBe("not_entitled");
    if (d.kind !== "not_entitled") throw new Error("unreachable");
    expect(d.code).toBe("not_a_member");
  });

  it("REFUSES the cache for 402 — a lapsed licence drops team policy", () => {
    // The bug this prevents: stale policy beats absent policy only when the
    // question is reachability. Here the answer is "you are not entitled", and
    // the cache is not a fallback — it is the thing being withdrawn.
    expect(mayUseCachedTeamLayer(classifyPortalResponse(402, "subscription_required"))).toBe(false);
  });

  it("REFUSES the cache for 403 too", () => {
    expect(mayUseCachedTeamLayer(classifyPortalResponse(403, "not_a_member"))).toBe(false);
  });

  it("still denies on a 403 whose code it does not recognise", () => {
    // v1 may add error codes, and a 403 is an authorization verdict however it
    // is spelled. Falling through to "unreachable" here would serve the cache
    // on a denial.
    const d = classifyPortalResponse(403, "some_future_code");
    expect(d.kind).toBe("not_entitled");
    expect(mayUseCachedTeamLayer(d)).toBe(false);
  });

  it("matches on code, never on the human prose", () => {
    // The contract is explicit that `error` is for humans and will be reworded.
    expect(classifyPortalResponse(403).kind).toBe("not_entitled");
    expect(classifyPortalResponse(402).kind).toBe("not_entitled");
  });

  it("names the team and says team settings are NOT applied", () => {
    const line = describeTeamOutcome(classifyPortalResponse(402, "subscription_required"), {
      orgId: ORG,
    });
    expect(line).toContain(ORG);
    expect(line).toContain("NOT");
    expect(line).toContain("subscription_required");
    expect(line).toContain("local configuration");
    // Never the cache: mentioning it would suggest policy is still in force.
    expect(line).not.toMatch(/using the cached/);
  });
});

describe("cannot reach: no verdict, so the cache stands in", () => {
  it("treats a thrown network failure as unreachable", () => {
    const d = classifyPortalError(new TypeError("fetch failed"));
    expect(d.kind).toBe("unreachable");
    expect(mayUseCachedTeamLayer(d)).toBe(true);
  });

  it("treats a DNS failure as unreachable", () => {
    const enotfound = Object.assign(new Error("getaddrinfo ENOTFOUND golem.run"), {
      code: "ENOTFOUND",
    });
    expect(mayUseCachedTeamLayer(classifyPortalError(enotfound))).toBe(true);
  });

  it("treats a timeout as unreachable, NOT as a lapsed subscription", () => {
    // The other failure direction: an offline developer must not be punished
    // for the network by losing their team's policy.
    const d = classifyPortalError(new PortalAuthError("timed_out", "the browser never returned"));
    expect(d.kind).toBe("unreachable");
    expect(mayUseCachedTeamLayer(d)).toBe(true);
  });

  it("treats a portal 5xx as unreachable, because it is not a verdict", () => {
    const d = classifyPortalResponse(500);
    expect(d.kind).toBe("unreachable");
    expect(mayUseCachedTeamLayer(d)).toBe(true);
  });

  it("reports how old the cache is", () => {
    const line = describeTeamOutcome(classifyPortalError(new TypeError("fetch failed")), {
      orgId: ORG,
      cacheAge: "4 days old",
    });
    expect(line).toContain(ORG);
    expect(line).toContain("4 days old");
    expect(line).toContain("cached team settings");
  });

  it("says local-config-only when unreachable AND there is no cache", () => {
    const line = describeTeamOutcome(classifyPortalError(new TypeError("fetch failed")), {
      orgId: ORG,
    });
    expect(line).toContain("no cached team settings");
    expect(line).toContain("local configuration");
  });
});

describe("cannot authenticate: the cache stands in, and a sign-in is named", () => {
  it("treats a 401 as an auth failure rather than a denial", () => {
    const d = classifyPortalResponse(401);
    expect(d.kind).toBe("auth_failed");
    expect(mayUseCachedTeamLayer(d)).toBe(true);
  });

  it("treats an unlinked machine as an auth failure and names golem team link", () => {
    const d = classifyPortalError(new PortalAuthError("not_linked", "not linked"));
    expect(d.kind).toBe("auth_failed");
    const line = describeTeamOutcome(d, { orgId: ORG });
    expect(line).toContain("golem team link");
  });

  it("routes an api_error carrying a 402 back through the status rules", () => {
    // A PortalAuthError built from a real response must not lose the verdict
    // that response carried just because it arrived as an exception.
    const d = classifyPortalError(new PortalAuthError("api_error", "answered 402", 402));
    expect(d.kind).toBe("not_entitled");
    expect(mayUseCachedTeamLayer(d)).toBe(false);
  });
});

describe("an answer this version does not understand is not a yes", () => {
  it("refuses the cache for an unrecognised 4xx", () => {
    const d = classifyPortalResponse(418);
    expect(d.kind).toBe("api_error");
    expect(mayUseCachedTeamLayer(d)).toBe(false);
  });

  it("says so out loud rather than staying quiet", () => {
    const line = describeTeamOutcome(classifyPortalResponse(418), { orgId: ORG });
    expect(line).toContain(ORG);
    expect(line).toContain("418");
    expect(line).toContain("NOT");
  });
});

describe("every disposition says something out loud", () => {
  it("never returns an empty line, for any state", () => {
    // "Degrade, but never silently" — the hazard is believing team policy is in
    // force when it is not, so there is no quiet path through here.
    const dispositions = [
      classifyPortalResponse(200),
      classifyPortalResponse(401),
      classifyPortalResponse(402, "subscription_required"),
      classifyPortalResponse(403, "not_a_member"),
      classifyPortalResponse(418),
      classifyPortalResponse(503),
      classifyPortalError(new TypeError("fetch failed")),
    ];
    for (const d of dispositions) {
      const line = describeTeamOutcome(d, { orgId: ORG });
      expect(line.length, d.kind).toBeGreaterThan(20);
      expect(line, d.kind).toContain(ORG);
    }
  });
});

describe("describeCacheAge", () => {
  it("reads naturally at every scale", () => {
    const now = 1_000_000_000_000;
    expect(describeCacheAge(now, now)).toBe("less than a minute old");
    expect(describeCacheAge(now - 60_000, now)).toBe("1 minute old");
    expect(describeCacheAge(now - 5 * 60_000, now)).toBe("5 minutes old");
    expect(describeCacheAge(now - 3_600_000, now)).toBe("1 hour old");
    expect(describeCacheAge(now - 4 * 24 * 3_600_000, now)).toBe("4 days old");
  });

  it("never reports a negative age from a clock that moved", () => {
    const now = 1_000_000_000_000;
    expect(describeCacheAge(now + 60_000, now)).toBe("less than a minute old");
  });
});
