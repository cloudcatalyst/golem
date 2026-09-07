/**
 * `golem init` and the team binding, against a real `golemInit` in a temp
 * project — the two gate rows that are about init rather than about a helper.
 *
 * The unit tests in `tests/unit/cli/init-team.test.ts` pin the step's logic.
 * This file exists because the invariant is only worth anything at the level a
 * user meets it: the claim is that running `golem init` in an unlinked project
 * reaches no network, no cache and no keychain, and that has to be asserted
 * against the actual command, wired the way the actual command wires it.
 *
 * `team.org_id` is written into the PROJECT settings file in both directions —
 * `""` as well as a real id — so the result cannot depend on whatever the
 * developer running the suite happens to have in `~/.golem/settings.json`. The
 * env variable is stubbed empty for the same reason.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { golemInit, type InitProbe } from "../../src/cli/init.js";
import { TEAM_LINK_HINT } from "../../src/cli/init-team.js";
import { useTempDirs } from "../helpers/tmp.js";

// Same reasoning as cli-init.test.ts: a real golemInit is ~300ms on an idle
// machine, and this file runs several under full parallel load on Windows.
vi.setConfig({ testTimeout: 90_000 });

const newTempDir = useTempDirs("golem-init-team");

const okProbe: InitProbe = {
  claudeCodeInstalled: () => Promise.resolve(true),
  headroomWrapActive: () => Promise.resolve(false),
};

let projectDir: string;

beforeEach(async () => {
  projectDir = await newTempDir();
  // A machine-scoped GOLEM_TEAM_ORG_ID would outrank the project file, so it is
  // cleared: an empty value is "unset" to the env layer.
  vi.stubEnv("GOLEM_TEAM_ORG_ID", "");
  vi.stubEnv("GOLEM_TEAM_PORTAL_URL", "");
});

async function writeTeamSection(team: Record<string, unknown>): Promise<void> {
  const dir = path.join(projectDir, ".golem");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "settings.json"),
    `${JSON.stringify({ team }, null, 2)}\n`,
    "utf8",
  );
}

describe("golem init in a project with no team", () => {
  it("looks up NO token — the Decision 64 invariant, at the command level", async () => {
    await writeTeamSection({ org_id: "" });
    const teamTokenPresent = vi.fn(async () => true);
    const teamSyncLayer = vi.fn(async () => ["should-never-happen"]);

    const report = await golemInit({
      projectDir,
      probe: okProbe,
      teamTokenPresent,
      teamSyncLayer,
    });

    expect(teamTokenPresent).not.toHaveBeenCalled();
    expect(teamSyncLayer).not.toHaveBeenCalled();
    expect(report.notices).toEqual([TEAM_LINK_HINT]);
  });

  it("succeeds, and mentions golem team link exactly once", async () => {
    await writeTeamSection({ org_id: "" });
    const report = await golemInit({ projectDir, probe: okProbe });

    expect(report.notices).toHaveLength(1);
    const mentions = (report.notices ?? []).filter((line) => line.includes("golem team link"));
    expect(mentions).toHaveLength(1);
  });

  it("leaves the committed settings file with no team binding in it", async () => {
    await writeTeamSection({ org_id: "" });
    await golemInit({ projectDir, probe: okProbe });

    const settings = JSON.parse(
      await readFile(path.join(projectDir, ".golem", "settings.json"), "utf8"),
    ) as { team?: { org_id?: string } };
    // init records a port and a compression level, but never invents a team.
    expect(settings.team?.org_id ?? "").toBe("");
  });
});

describe("golem init in a project that names a team but has no token", () => {
  it("SUCCEEDS, names the team, and names golem team link", async () => {
    await writeTeamSection({ org_id: "org_3IojJexample" });
    const teamSyncLayer = vi.fn(async () => ["should-never-happen"]);

    // No throw, and a report — that is the assertion. A missing subscription, a
    // missing token or a missing network may never fail an init.
    const report = await golemInit({
      projectDir,
      probe: okProbe,
      teamTokenPresent: async () => false,
      teamSyncLayer,
    });

    expect(report.notices?.[0]).toContain("org_3IojJexample");
    expect(report.notices?.[0]).toContain("golem team link");
    // No token, so nothing was fetched: the network is never reached.
    expect(teamSyncLayer).not.toHaveBeenCalled();
  });

  it("still writes everything else it normally writes", async () => {
    // The team step is last and additive; a project that names an unreachable
    // team must be initialised exactly as completely as one that names none.
    await writeTeamSection({ org_id: "org_3IojJexample" });
    const report = await golemInit({
      projectDir,
      probe: okProbe,
      teamTokenPresent: async () => false,
    });
    expect(report.actions.length).toBeGreaterThan(5);
    expect(report.actions.some((a) => a.path.includes("settings.local.json"))).toBe(true);
  });

  it("keeps the binding the user committed, untouched", async () => {
    await writeTeamSection({ org_id: "org_3IojJexample", portal_url: "https://golem.run" });
    await golemInit({ projectDir, probe: okProbe, teamTokenPresent: async () => false });

    const settings = JSON.parse(
      await readFile(path.join(projectDir, ".golem", "settings.json"), "utf8"),
    ) as { team?: { org_id?: string; portal_url?: string } };
    expect(settings.team).toMatchObject({
      org_id: "org_3IojJexample",
      portal_url: "https://golem.run",
    });
  });
});

describe("golem init when the team layer refuses", () => {
  it("does not fail on 402 subscription_required, and says team policy is NOT applied", async () => {
    await writeTeamSection({ org_id: "org_lapsed" });
    const { PortalAuthError } = await import("../../src/portal/index.js");

    const report = await golemInit({
      projectDir,
      probe: okProbe,
      teamTokenPresent: async () => true,
      teamSyncLayer: async () => {
        throw new PortalAuthError("api_error", "answered 402", 402);
      },
    });

    expect(report.notices?.[0]).toContain("org_lapsed");
    expect(report.notices?.[0]).toContain("NOT");
  });

  it("does not fail when the portal is unreachable", async () => {
    await writeTeamSection({ org_id: "org_offline" });
    const report = await golemInit({
      projectDir,
      probe: okProbe,
      teamTokenPresent: async () => true,
      teamSyncLayer: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(report.notices?.[0]).toContain("org_offline");
    expect(report.notices?.[0]).toContain("cached");
  });
});
