/**
 * R5.2 — the consolidated session-state read model: shape, zod contract,
 * defensive degradation, and the redaction-off surfacing rule.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  collectSessionStateReport,
  sessionStateReportSchema,
} from "../../../src/cli/session-report.js";
import type { GolemState } from "../../../src/cli/statusline.js";
import { markBlocked } from "../../../src/hooks/index.js";
import { useTempDirs } from "../../helpers/tmp.js";

const fakeState: GolemState = {
  compression: 1 as const,
  upstreamLabel: "anthropic",
  proxyRunning: true,
  localModelReachable: false,
};

const newTempDir = useTempDirs("golem-report-");

describe("collectSessionStateReport", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await newTempDir();
  });

  it("assembles a report that satisfies the zod contract", async () => {
    const report = await collectSessionStateReport(dir, {
      nowIso: "2026-07-16T00:00:00.000Z",
      collectState: () => Promise.resolve(fakeState),
    });
    // The documented external payload must validate against its own schema.
    expect(() => sessionStateReportSchema.parse(report)).not.toThrow();
    expect(report.project_dir).toBe(dir);
    expect(report.proxy.running).toBe(true);
    expect(report.proxy.upstream).toBe("anthropic");
    expect(report.compression.level).toBe("1");
    expect(report.compression.redaction_off).toBe(false);
    expect(report.local_model.reachable).toBe(false);
    expect(report.blocked.waiting).toBe(false);
  });

  it("degrades to safe defaults when the liveness collector fails", async () => {
    const report = await collectSessionStateReport(dir, {
      collectState: () => Promise.reject(new Error("boom")),
    });
    expect(() => sessionStateReportSchema.parse(report)).not.toThrow();
    expect(report.proxy.running).toBeNull(); // unknown, not a false "off"
    expect(report.local_model.reachable).toBeNull();
    expect(report.compression.level).toBe("1"); // config default still resolves
  });

  it("surfaces a fresh blocked flag with its reason", async () => {
    await markBlocked(dir, "permission prompt", new Date().toISOString(), "sess-1");
    const report = await collectSessionStateReport(dir, {
      collectState: () => Promise.resolve(fakeState),
    });
    expect(report.blocked.waiting).toBe(true);
    expect(report.blocked.reason).toBe("permission prompt");
  });
});
