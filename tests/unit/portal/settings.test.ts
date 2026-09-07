/**
 * The `portal` settings section, and the floor that keeps a remote origin from
 * moving it.
 *
 * The second half is the interesting one. ADR-0008 gave the settings cascade a
 * `team` origin whose values are fetched FROM the portal, and `portal.url` /
 * `portal.issuer` / `portal.client_id` are the keys that say which portal that
 * is. A remote origin able to set them could point the next sign-in at a server
 * of its choosing — so they join `proxy.bypass_all` on the compiled-in denied
 * list. `portal.link_timeout_ms` deliberately does not: a team with slow SSO has
 * a real reason to raise it, and it carries no security weight.
 */

import { describe, expect, it } from "vitest";
import {
  allLeafPaths,
  DEFAULT_SETTINGS,
  leafSchema,
  REMOTE_DENIED_SETTINGS,
  SECTION_NAMES,
} from "../../../src/config/index.js";

describe("the portal settings section", () => {
  it("is part of the schema", () => {
    expect(SECTION_NAMES).toContain("portal");
    expect(allLeafPaths()).toEqual(
      expect.arrayContaining([
        "portal.url",
        "portal.issuer",
        "portal.client_id",
        "portal.link_timeout_ms",
      ]),
    );
  });

  it("defaults to no portal at all, so a fresh install is unchanged", () => {
    // Golem is local-first: a team link is an enhancement, never a prerequisite,
    // and nothing here may make an unconfigured harness behave differently.
    expect(DEFAULT_SETTINGS.portal.url).toBe("");
    expect(DEFAULT_SETTINGS.portal.issuer).toBe("");
    expect(DEFAULT_SETTINGS.portal.client_id).toBe("");
    expect(DEFAULT_SETTINGS.portal.link_timeout_ms).toBeGreaterThan(0);
  });

  it("holds no credential-shaped key", () => {
    // The tokens live in the OS keychain (ADR-0003). A settings file is read by
    // the control panel, copied between machines, and pasted into bug reports.
    const keys = Object.keys(DEFAULT_SETTINGS.portal);
    for (const forbidden of ["token", "secret", "access_token", "refresh_token", "client_secret"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("validates each leaf through zod", () => {
    expect(leafSchema("portal", "url")?.safeParse("https://golem.run").success).toBe(true);
    expect(leafSchema("portal", "link_timeout_ms")?.safeParse(300_000).success).toBe(true);
    expect(leafSchema("portal", "link_timeout_ms")?.safeParse(-1).success).toBe(false);
    expect(leafSchema("portal", "link_timeout_ms")?.safeParse("soon").success).toBe(false);
  });
});

describe("REMOTE_DENIED_SETTINGS", () => {
  it("still denies the redaction bypass", () => {
    expect(REMOTE_DENIED_SETTINGS.has("proxy.bypass_all")).toBe(true);
  });

  it("denies every key that decides WHICH portal is trusted", () => {
    expect(REMOTE_DENIED_SETTINGS.has("portal.url")).toBe(true);
    expect(REMOTE_DENIED_SETTINGS.has("portal.issuer")).toBe(true);
    expect(REMOTE_DENIED_SETTINGS.has("portal.client_id")).toBe(true);
  });

  it("does not deny the sign-in timeout", () => {
    expect(REMOTE_DENIED_SETTINGS.has("portal.link_timeout_ms")).toBe(false);
  });

  it("names only keys that actually exist", () => {
    // A denied key that is not a real leaf is a floor with a hole in it.
    const leaves = new Set(allLeafPaths());
    for (const denied of REMOTE_DENIED_SETTINGS) {
      expect(leaves.has(denied), denied).toBe(true);
    }
  });
});
