/**
 * `golem team status` on the DEFAULT solo install — Decision 64's free tier as
 * the command surface sees it.
 *
 * The regression this guards is an ordering one, and it shipped: `golem team
 * status` asked `resolvePortalConfig` before reporting the project, and that
 * function THROWS when no portal is configured. No portal is the default for
 * every solo user, so a plain unlinked project got exit 2 and a message about
 * registering OAuth applications — a portal-setup complaint standing in for the
 * answer to "is this repo on a team?", which is knowable with no portal at all.
 */

import { describe, expect, it } from "vitest";
import { describeProjectBinding, portalIsConfigured } from "../../../src/cli/commands/team.js";
import { DEFAULT_SETTINGS } from "../../../src/config/schema.js";

describe("portalIsConfigured", () => {
  it("is false on a default install, which is what keeps status off the throwing path", () => {
    // Not a hypothetical: this is the shipped default every solo user has.
    expect(DEFAULT_SETTINGS.portal.url).toBe("");
    expect(portalIsConfigured(DEFAULT_SETTINGS.portal)).toBe(false);
  });

  it("treats whitespace as unconfigured rather than as an address", () => {
    expect(portalIsConfigured({ url: "   " })).toBe(false);
  });

  it("is true once an address is set", () => {
    expect(portalIsConfigured({ url: "https://golem.run" })).toBe(true);
  });
});

describe("describeProjectBinding on an unlinked project", () => {
  it("answers without a portal, and says the free tier is complete", async () => {
    const view = await describeProjectBinding(DEFAULT_SETTINGS.team);

    expect(view.linked).toBe(false);
    expect(view.orgId).toBeNull();
    // The wording matters as much as the flag: a solo user reading this must not
    // be left wondering what they are missing.
    expect(view.summary).toContain("not linked to a team");
    expect(view.summary).toContain("complete without one");
  });

  it("reports no cache line at all, on the unlinked and the invalid branches alike", async () => {
    // A `cache` of null is the observable half of "reads no cache": the string
    // only exists where the code has stat'd the per-org file, so its absence is
    // the absence of that read. Proving the I/O never happens with a spy belongs
    // where the seam is injectable — `tests/unit/cli/init-team.test.ts` and
    // `tests/unit/portal/team-layer.test.ts` do exactly that, including a cache
    // that WOULD change a setting left provably unread.
    const unlinked = await describeProjectBinding(DEFAULT_SETTINGS.team);
    expect(unlinked.cache).toBeNull();

    // A malformed org id is the other early return, and it must not build a path
    // from an id it has just rejected.
    const invalid = await describeProjectBinding({
      ...DEFAULT_SETTINGS.team,
      org_id: "../escape",
    });
    expect(invalid.cache).toBeNull();
    expect(invalid.linked).toBe(false);
  });
});
