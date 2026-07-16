/**
 * R5.2 — `golem watch` pure renderer + byte formatting.
 */

import { describe, expect, it } from "vitest";
import type { SessionStateReport } from "../../../src/cli/session-report.js";
import { formatBytes, renderWatchFrame } from "../../../src/cli/watch.js";

function report(overrides: Partial<SessionStateReport> = {}): SessionStateReport {
  return {
    project_dir: "/proj",
    generated_at: "2026-07-16T00:00:00.000Z",
    proxy: { running: true, upstream: "anthropic" },
    slider: { level: 1, name: "lossless", redaction_off: false },
    local_model: { reachable: true },
    blocked: { waiting: false },
    savings: {
      source: "telemetry",
      project_id: null,
      requests: 10,
      tokens_before: 1000,
      tokens_after: 600,
      tokens_saved: 400,
      per_stage: { dedup: { tokens_before: 1000, tokens_after: 600, tokens_saved: 400 } },
      ccr_refs_stored: 3,
      ccr_refs_retrieved: 1,
      tool_usage: {
        coder: { calls: 2, total_duration_ms: 4000, total_result_bytes: 800, draft_chars: 400 },
      },
      note: "telemetry",
    },
    storage: {
      ccr_bytes: 2048,
      knowledge_bytes: 1_572_864,
      telemetry_bytes: 512,
      webcache_bytes: 0,
    },
    ...overrides,
  };
}

describe("formatBytes", () => {
  it("renders human-readable sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1_572_864)).toBe("1.5 MB");
  });
  it("never throws on odd input", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
  });
});

describe("renderWatchFrame", () => {
  it("shows the core state fields (no color)", () => {
    const frame = renderWatchFrame(report(), { color: false });
    expect(frame).toContain("Golem watch");
    expect(frame).toContain("proxy running");
    expect(frame).toContain("→anthropic");
    expect(frame).toContain("L1 lossless");
    expect(frame).toContain("saved 40%");
    expect(frame).toContain("dedup");
    expect(frame).toContain("CCR refs: 3 stored / 1 retrieved");
    expect(frame).toContain("1.5 MB"); // knowledge storage
    expect(frame).toContain("coder");
  });

  it("warns LOUDLY when redaction is off (level 0)", () => {
    const frame = renderWatchFrame(
      report({ slider: { level: 0, name: "passthrough", redaction_off: true } }),
      { color: false },
    );
    expect(frame).toContain("REDACTION OFF");
  });

  it("shows a waiting line with the reason", () => {
    const frame = renderWatchFrame(
      report({ blocked: { waiting: true, reason: "permission prompt" } }),
      { color: false },
    );
    expect(frame).toContain("waiting on you: permission prompt");
  });

  it("shows proxy OFF and unknown liveness distinctly", () => {
    expect(renderWatchFrame(report({ proxy: { running: false, upstream: "foundry" } }))).toContain(
      "proxy OFF",
    );
    expect(renderWatchFrame(report({ proxy: { running: null, upstream: "foundry" } }))).toContain(
      "proxy unknown",
    );
  });
});
