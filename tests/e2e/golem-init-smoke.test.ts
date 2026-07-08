/**
 * T-C2 — E2E smoke: `golem init` -> Claude Code round-trip with savings > 0
 * at level 1.
 *
 * No real network, `claude` binary, or home directory is touched:
 * - `golemInit` runs against a temp project dir with a fake `InitProbe`
 *   (pattern from tests/integration/cli-init.test.ts) — no real claude CLI
 *   or `~/.claude` is consulted.
 * - the config layer is loaded with an explicit, never-populated `userDir`
 *   so the real `~/.golem/settings.json` is never read.
 * - the proxy round trip runs the real `GolemProxy` + request pipeline
 *   against a fake local upstream (tests/integration/helpers/test-servers.ts),
 *   wired the same way the real `golem proxy` CLI command wires them from
 *   loaded settings (src/cli/main.ts `runProxyForeground`):
 *   `NativeLosslessCompression.forProjectDir` rooted at the temp project's
 *   `.golem/ccr`, and the JSONL telemetry store recording the per-request
 *   `PipelineEvent` — the same durable signal `golem stats` reads
 *   (tests/integration/cli-stats.test.ts).
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { golemInit, type InitProbe } from "../../src/cli/init.js";
import { NativeLosslessCompression } from "../../src/compression/index.js";
import { loadConfig, policyFromSettings } from "../../src/config/index.js";
import { createGolemPipeline, type PipelineEvent } from "../../src/pipeline/index.js";
import { openTelemetryStore, recordPipelineEvent } from "../../src/telemetry/index.js";
import { NON_STREAMING_TOOL_USE_RESPONSE } from "../integration/helpers/anthropic-fixtures.js";
import {
  type FakeUpstream,
  type RunningProxy,
  rawRequest,
  startProxy,
  startUpstream,
} from "../integration/helpers/test-servers.js";

// golemInit only ever consults this probe — never shells out to a real
// `claude` binary and never reads the real home directory.
const fakeProbe: InitProbe = {
  claudeCodeInstalled: () => Promise.resolve(true),
  headroomWrapActive: () => Promise.resolve(false),
};

/** Recursive file listing + contents, for whole-tree idempotence checks. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath, entry.name);
    out.set(path.relative(dir, abs), await readFile(abs, "utf8"));
  }
  return out;
}

let projectDir: string;
/** A user-scope dir that is created but never populated — proves the user
 *  settings layer (normally `~/.golem`) is never read from the real home
 *  directory during this test. */
let fakeUserDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-e2e-project-"));
  fakeUserDir = path.join(await mkdtemp(path.join(tmpdir(), "golem-e2e-home-")), ".golem");
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
  await rm(path.dirname(fakeUserDir), { recursive: true, force: true });
});

describe("golem init -> Claude Code smoke (T-C2)", () => {
  it("golem init pins slider level 1 and is idempotent on a second run", async () => {
    const first = await golemInit({ projectDir, probe: fakeProbe });
    expect(first.dryRun).toBe(false);

    const golemSettings = JSON.parse(
      await readFile(path.join(projectDir, ".golem", "settings.json"), "utf8"),
    ) as { slider: { level: number } };
    expect(golemSettings.slider.level).toBe(1);

    // Second run against the same project: no writes, every action a skip.
    const before = await snapshot(projectDir);
    const second = await golemInit({ projectDir, probe: fakeProbe });
    expect(second.dryRun).toBe(false);
    expect(second.actions.every((a) => a.kind === "skip")).toBe(true);
    expect(await snapshot(projectDir)).toStrictEqual(before);
  });

  it("level-1 proxy round trip is byte-faithful with measurable savings", async () => {
    await golemInit({ projectDir, probe: fakeProbe });

    // Load exactly the settings golemInit wrote (project scope). userDir
    // points at a dir with no settings.json in it, so this never touches the
    // real ~/.golem/settings.json.
    const { settings } = await loadConfig({ projectDir, userDir: fakeUserDir });
    expect(settings.slider.level).toBe(1);
    const policy = policyFromSettings(settings);

    const telemetry = openTelemetryStore(projectDir);
    const events: PipelineEvent[] = [];
    const telemetryWrites: Promise<void>[] = [];
    const pipeline = createGolemPipeline({
      compression: NativeLosslessCompression.forProjectDir(projectDir),
      policy: () => policy,
      projectId: projectDir,
      onEvent: (event) => {
        events.push(event);
        telemetryWrites.push(recordPipelineEvent(telemetry, event, new Date().toISOString()));
      },
    });

    let upstream: FakeUpstream | undefined;
    let proxy: RunningProxy | undefined;
    try {
      // Fake upstream: a recorded, realistic Anthropic Messages response.
      upstream = await startUpstream((req, res) => {
        if (req.url === "/v1/messages") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(NON_STREAMING_TOOL_USE_RESPONSE);
          return;
        }
        res.writeHead(404).end();
      });

      // Wired exactly like `golem proxy` (src/cli/main.ts runProxyForeground)
      // from the settings golemInit wrote.
      proxy = await startProxy({
        upstreamBaseUrl: upstream.origin,
        connectTimeoutMs: settings.proxy.connect_timeout_ms,
        headersTimeoutMs: settings.proxy.request_timeout_ms,
        bodyTimeoutMs: settings.proxy.request_timeout_ms,
        pipeline,
      });

      // A realistic request carrying a duplicated large tool_result block
      // (well above the 256-char dedup threshold), so level 1's lossless
      // compression (dedup) stage has genuine repeated content to elide.
      const bigToolResult = `${"x".repeat(600)} repeated tool output ${"y".repeat(600)}`;
      const requestBody = JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 256,
        messages: [
          { role: "user", content: [{ type: "tool_result", content: bigToolResult }] },
          { role: "assistant", content: "Got it, let me look again." },
          { role: "user", content: [{ type: "tool_result", content: bigToolResult }] },
        ],
      });

      const response = await rawRequest(proxy.origin, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      });

      // Proxy fidelity hard rule: the response path has no pipeline seam and
      // must be byte-faithful, independent of the request-side slider level.
      expect(response.status).toBe(200);
      expect(response.body.equals(Buffer.from(NON_STREAMING_TOOL_USE_RESPONSE))).toBe(true);

      // The pipeline ran exactly once and recorded genuine whole-request
      // before/after savings — the honest headline number (pipeline.ts).
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) throw new Error("expected one pipeline event");
      expect(event.level).toBe(1);
      expect(event.requestTokens.tokensBefore).toBeGreaterThan(event.requestTokens.tokensAfter);
      expect(event.ccrRefsStored).toBeGreaterThanOrEqual(1);

      // The same savings are durably observable through the telemetry store —
      // the real signal `golem stats` / the dashboard read (see
      // tests/integration/cli-stats.test.ts) — not just the in-memory event.
      await Promise.all(telemetryWrites);
      const stats = await telemetry.aggregate(projectDir);
      expect(stats.requests).toBe(1);
      expect(stats.tokensBefore).toBeGreaterThan(stats.tokensAfter);
      expect(stats.tokensBefore - stats.tokensAfter).toBe(
        event.requestTokens.tokensBefore - event.requestTokens.tokensAfter,
      );
      expect(stats.ccrRefsStored).toBeGreaterThanOrEqual(1);
    } finally {
      await proxy?.close();
      await upstream?.close();
      await telemetry.close();
    }
  });
});
