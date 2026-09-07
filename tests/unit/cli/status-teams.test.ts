/**
 * `golem status` reports team-cache age PER TEAM (Decision 63(c)).
 *
 * The decision's own wording is the test: *"with several caches a single age is
 * a number that describes none of them."* So the assertion is not "an age is
 * shown" — it is that TWO cached teams produce two rows with two DIFFERENT
 * ages, which no single figure can satisfy.
 *
 * `collectStatus` is exercised as well as the renderer, because the field being
 * emitted and the field being displayed are two different regressions.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectStatus, type StatusReport } from "../../../src/cli/status.js";
import { renderTeams } from "../../../src/cli/status-render.js";
import { writeTeamLayerCache } from "../../../src/portal/index.js";
import { VERSION } from "../../../src/version.js";
import { useTempDirs } from "../../helpers/tmp.js";

const newTempDir = useTempDirs("golem-status-teams");

const RECENT = "org_recentTeam";
const ANCIENT = "org_ancientTeam";

/** Two caches on one machine, deliberately far apart in age. */
async function twoCachedTeams(userDir: string, nowMs: number): Promise<void> {
  await writeTeamLayerCache(userDir, {
    org_id: RECENT,
    fetched_at: new Date(nowMs - 5 * 60_000).toISOString(),
    settings: [{ key: "telemetry.enabled", value: false, enforced: false }],
  });
  await writeTeamLayerCache(userDir, {
    org_id: ANCIENT,
    fetched_at: new Date(nowMs - 30 * 24 * 60 * 60_000).toISOString(),
    settings: [
      { key: "telemetry.enabled", value: true, enforced: false },
      { key: "security.join_injection", value: true, enforced: true },
    ],
  });
}

describe("collectStatus emits one row per cached team", () => {
  it("reports two teams with their own ages and counts", async () => {
    const userDir = await newTempDir();
    const projectDir = await newTempDir();
    const now = Date.now();
    await twoCachedTeams(userDir, now);

    const report = await collectStatus({
      projectDir,
      userDir,
      env: {},
      version: VERSION,
      probeTimeoutMs: 1,
    });

    expect(report.teams).toBeDefined();
    expect(report.teams).toHaveLength(2);
    const byOrg = new Map((report.teams ?? []).map((t) => [t.org_id, t]));

    // Each team's OWN age. These cannot both be one number.
    expect(byOrg.get(RECENT)?.age_minutes).toBe(5);
    expect(byOrg.get(ANCIENT)?.age_minutes).toBe(30 * 24 * 60);
    expect(byOrg.get(RECENT)?.age).not.toBe(byOrg.get(ANCIENT)?.age);

    // Each team's own counts, for the same reason.
    expect(byOrg.get(RECENT)?.settings_count).toBe(1);
    expect(byOrg.get(RECENT)?.enforced_count).toBe(0);
    expect(byOrg.get(ANCIENT)?.settings_count).toBe(2);
    expect(byOrg.get(ANCIENT)?.enforced_count).toBe(1);

    // The path is named, because "which file is this?" is the next question.
    expect(byOrg.get(RECENT)?.path).toBe(path.join(userDir, "teams", `${RECENT}.json`));
  });

  it("omits the block entirely on a machine that has cached no team", async () => {
    const userDir = await newTempDir();
    const projectDir = await newTempDir();

    const report = await collectStatus({
      projectDir,
      userDir,
      env: {},
      version: VERSION,
      probeTimeoutMs: 1,
    });

    // A solo install's status says nothing about teams at all — Decision 64(a)
    // in the reporting surface.
    expect(report.teams).toBeUndefined();
  });
});

describe("renderTeams", () => {
  it("prints a line per team, each with its own age", () => {
    const teams: NonNullable<StatusReport["teams"]> = [
      {
        org_id: RECENT,
        fetched_at: "2026-09-07T11:55:00.000Z",
        age_minutes: 5,
        age: "5 minutes old",
        settings_count: 1,
        enforced_count: 0,
        path: "/u/.golem/teams/org_recentTeam.json",
      },
      {
        org_id: ANCIENT,
        fetched_at: "2026-08-08T12:00:00.000Z",
        age_minutes: 43200,
        age: "30 days old",
        settings_count: 2,
        enforced_count: 1,
        path: "/u/.golem/teams/org_ancientTeam.json",
      },
    ];

    const lines = renderTeams(teams);
    expect(lines[0]).toContain("Team caches: 2");

    const body = lines.slice(1).join("\n");
    expect(body).toContain(`${RECENT}: 5 minutes old`);
    expect(body).toContain(`${ANCIENT}: 30 days old`);
    expect(body).toContain("1 enforced");
    // One row each — never one aggregate line standing in for both.
    expect(lines).toHaveLength(3);
  });

  it("says a denied cache is NOT APPLIED instead of showing its age", () => {
    // A line reading "2 hours old" about policy that is being ignored would be
    // the exact inversion of the truth (Decision 64(d)).
    const lines = renderTeams([
      {
        org_id: RECENT,
        fetched_at: "2026-09-07T10:00:00.000Z",
        age_minutes: 120,
        age: "2 hours old",
        settings_count: 1,
        enforced_count: 1,
        path: "/u/.golem/teams/org_recentTeam.json",
        denied: {
          code: "subscription_required",
          status: 402,
          detail: "the team's subscription is not active",
          at: "2026-09-07T11:00:00.000Z",
        },
      },
    ]);

    const body = lines.join("\n");
    expect(body).toContain("NOT APPLIED");
    expect(body).toContain("subscription_required");
    expect(body).not.toContain("2 hours old");
  });
});
