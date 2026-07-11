/**
 * Regression coverage for the `golem mcp serve` stats bug: `stats`
 * always reported zero requests because it read a per-process in-memory
 * NativeLosslessCompression counter, while the real traffic is processed
 * (and telemetry recorded) by the separate `golem proxy` process.
 *
 * `mcpCompressionService` (src/cli/mcp-compression.ts) fixes this by routing
 * `stats()` through the same durable-telemetry-first seam `golem stats`
 * (CLI) uses. This is split out of main.ts specifically so it's testable
 * without importing that file, which runs `program.parseAsync(process.argv)`
 * unconditionally at module scope.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mcpCompressionService, statsSourceForCli } from "../../../src/cli/mcp-compression.js";
import { sliderPolicyForLevel } from "../../../src/interfaces/index.js";
import { JsonlTelemetryStore, recordPipelineEvent } from "../../../src/telemetry/index.js";

const LEVEL_1 = sliderPolicyForLevel(1);

/** Poll until a predicate holds, for asserting on a fire-and-forget write. */
async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor: predicate never became true");
}

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-mcp-compression-"));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("mcpCompressionService", () => {
  it("reports durable telemetry, not this process's empty live counters", async () => {
    // Simulate the real proxy process: it recorded a request's telemetry to
    // disk, but never called compress() against this process's own
    // NativeLosslessCompression instance — the exact split that caused the
    // bug (an MCP server process is never the one processing proxy traffic).
    const store = new JsonlTelemetryStore(projectDir);
    await recordPipelineEvent(
      store,
      {
        projectId: projectDir,
        level: 5,
        requestTokens: { tokensBefore: 1000, tokensAfter: 250 },
        stageSavings: { localFirst: { tokensBefore: 1000, tokensAfter: 250 } },
        ccrRefsStored: 1,
        avoidedUpstreamInputTokens: 0,
      },
      "2026-07-09T00:00:00.000Z",
    );
    await store.close();

    const stats = await mcpCompressionService(projectDir).stats();
    expect(stats.requests).toBe(1);
    expect(stats.tokensBefore).toBe(1000);
    expect(stats.tokensAfter).toBe(250);
  });

  it("falls back to live (zero) stats when no telemetry has been recorded yet", async () => {
    const stats = await mcpCompressionService(projectDir).stats();
    expect(stats.requests).toBe(0);
  });

  it("scopes to a project when asked, matching statsSourceForCli's behavior", async () => {
    const store = new JsonlTelemetryStore(projectDir);
    await recordPipelineEvent(
      store,
      {
        projectId: "other-project",
        level: 5,
        requestTokens: { tokensBefore: 500, tokensAfter: 100 },
        stageSavings: {},
        ccrRefsStored: 0,
        avoidedUpstreamInputTokens: 0,
      },
      "2026-07-09T00:00:00.000Z",
    );
    await store.close();

    const scoped = await mcpCompressionService(projectDir).stats(projectDir);
    expect(scoped.requests).toBe(0);

    const source = await statsSourceForCli(projectDir);
    expect(source.kind).toBe("telemetry");
    const global = await mcpCompressionService(projectDir).stats();
    expect(global.requests).toBe(1);
  });

  it("retrieve() durably records ccrRefsRetrieved (T1, §25)", async () => {
    const service = mcpCompressionService(projectDir);
    const repeated = "x".repeat(300); // over DEFAULT_MIN_DEDUP_CHARS so it dedups
    const { refs } = await service.compress(
      [
        { role: "user", content: repeated },
        { role: "user", content: repeated },
      ],
      LEVEL_1,
      projectDir,
    );
    const ref = refs[0];
    if (ref === undefined) throw new Error("expected compress() to emit a CCR ref");

    await service.retrieve(ref);
    await service.retrieve(ref);

    // The write is fire-and-forget from retrieve()'s perspective, so poll a
    // FRESH store reading the same file — proves durability, not just
    // in-memory state, and doesn't rely on stats()'s telemetry-vs-live
    // fallback (which requires a "request" event to prefer telemetry, and
    // a retrieval alone deliberately isn't one).
    await waitFor(async () => {
      const agg = await new JsonlTelemetryStore(projectDir).aggregate(projectDir);
      return agg.ccrRefsRetrieved === 2;
    });
  });
});
