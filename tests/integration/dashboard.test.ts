/**
 * WS-E task E3 — dashboard v0 HTTP tests.
 *
 * Starts the server on port 0 (ephemeral), then checks the page and JSON
 * endpoints return 200 and carry the savings numbers, and that unknown paths
 * 404. Loopback-only binding is exercised implicitly (the server listens on
 * 127.0.0.1 and we connect to 127.0.0.1).
 */

import { afterEach, describe, expect, it } from "vitest";
import type { StatsReport } from "../../src/cli/stats.js";
import {
  type DashboardHandle,
  type DashboardSnapshot,
  startDashboard,
} from "../../src/dashboard/index.js";

const STATS: StatsReport = {
  source: "live",
  project_id: null,
  requests: 12,
  tokens_before: 5000,
  tokens_after: 3200,
  tokens_saved: 1800,
  per_stage: { dedup: { tokens_before: 4000, tokens_after: 2400, tokens_saved: 1600 } },
  ccr_refs_stored: 4,
  ccr_refs_retrieved: 2,
  note: "test note",
};

function snapshot(): Promise<DashboardSnapshot> {
  return Promise.resolve({
    project_dir: "/tmp/example-project",
    slider: { level: 2, name: "balanced" },
    stats: STATS,
    generated_at: "2026-07-04T00:00:00.000Z",
  });
}

describe("dashboard server", () => {
  let handle: DashboardHandle | undefined;

  afterEach(async () => {
    if (handle !== undefined) {
      await handle.close();
      handle = undefined;
    }
  });

  it("serves the HTML page with the savings numbers", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    const res = await fetch(handle.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Golem savings");
    expect(body).toContain("1800"); // tokens saved
    expect(body).toContain("balanced"); // slider name
    expect(body).toContain("dedup"); // stage attribution row
  });

  it("serves the JSON stats endpoint", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    const res = await fetch(`${handle.url}api/stats`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const json = (await res.json()) as DashboardSnapshot;
    expect(json.stats.tokens_saved).toBe(1800);
    expect(json.slider.level).toBe(2);
    expect(json.stats.per_stage.dedup?.tokens_saved).toBe(1600);
  });

  it("404s unknown paths", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    const res = await fetch(`${handle.url}nope`);
    expect(res.status).toBe(404);
  });

  it("binds loopback only", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    expect(handle.url).toContain("127.0.0.1");
  });

  it("405s non-GET/HEAD methods", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    const res = await fetch(handle.url, { method: "POST" });
    expect(res.status).toBe(405);
    const body = await res.text();
    expect(body).toBe("method not allowed\n");
  });

  it("HEADs the HTML page with an empty body", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    const res = await fetch(handle.url, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toBe("");
  });

  it("HEADs the JSON stats endpoint with an empty body", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    const res = await fetch(`${handle.url}api/stats`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.text();
    expect(body).toBe("");
  });

  it("500s with the error message when the snapshot callback rejects", async () => {
    handle = await startDashboard({
      port: 0,
      snapshot: () => Promise.reject(new Error("boom")),
    });
    const res = await fetch(handle.url);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toBe("dashboard error: boom\n");
  });
});
