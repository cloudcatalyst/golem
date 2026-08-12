/**
 * T-C2 — E2E smoke: `golem init` -> Claude Code round-trip with savings > 0
 * at level 1.
 *
 * No real network, `claude` binary, or home directory is touched:
 * - `golemInit` runs against a temp project dir with a fake `InitProbe`
 *   (pattern from tests/integration/cli-init.test.ts) — no real claude CLI
 *   or `~/.claude` is consulted.
 * - the config layer is loaded with an explicit, never-populated `userDir`
 *   so the real `~/.golem/settings.json` is never read; the fake upstream's
 *   origin is injected via `loadConfig`'s in-memory `overrides` layer (the
 *   same layer real per-request overrides use), not by hand-editing settings.
 * - the proxy round trip calls the REAL `buildProxyFromSettings`
 *   (src/cli/proxy-runtime.ts) — the exact function `golem proxy`'s
 *   `runProxyForeground` (src/cli/main.ts) calls to construct its
 *   `GolemProxy` + request pipeline from loaded settings. This test only
 *   adds the CLI-irrelevant bits `runProxyForeground` itself adds around it
 *   (binding an ephemeral port via `proxy.listen()`, teardown) — it does not
 *   re-implement the construction. A regression in `buildProxyFromSettings`
 *   itself (wrong compression root, dropped pipeline, mis-wired semantic
 *   sidecar flag, pinned policy) would fail this test.
 * - telemetry is read back through the same durable `TelemetryStore.aggregate`
 *   signal `golem stats` reads (tests/integration/cli-stats.test.ts).
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { golemInit, type InitProbe } from "../../src/cli/init.js";
import { buildProxyFromSettings } from "../../src/cli/proxy-runtime.js";
import { loadConfig } from "../../src/config/index.js";
import { openTelemetryStore } from "../../src/telemetry/index.js";
import { useTempDirs } from "../helpers/tmp.js";

// R10.2: one recursive delete for the file instead of two per test.
const newTempDir = useTempDirs("golem-e2e");

import { NON_STREAMING_TOOL_USE_RESPONSE } from "../integration/helpers/anthropic-fixtures.js";
import {
  type FakeUpstream,
  rawRequest,
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
  projectDir = await newTempDir();
  fakeUserDir = path.join(await newTempDir(), ".golem");
});

describe("golem init -> Claude Code smoke (T-C2)", () => {
  it("golem init pins slider level 1 and is idempotent on a second run", async () => {
    const first = await golemInit({ projectDir, probe: fakeProbe });
    expect(first.dryRun).toBe(false);

    // Slider level is machine-local/transient → gitignored settings.local.json;
    // committed settings.json is a content-free marker (spec Decision 43).
    const golemLocal = JSON.parse(
      await readFile(path.join(projectDir, ".golem", "settings.local.json"), "utf8"),
    ) as { slider: { level: number } };
    expect(golemLocal.slider.level).toBe(1);

    // Second run against the same project: no writes, every action a skip.
    const before = await snapshot(projectDir);
    const second = await golemInit({ projectDir, probe: fakeProbe });
    expect(second.dryRun).toBe(false);
    expect(second.actions.every((a) => a.kind === "skip")).toBe(true);
    expect(await snapshot(projectDir)).toStrictEqual(before);
  });

  it("level-1 proxy round trip is byte-faithful with measurable savings", async () => {
    await golemInit({ projectDir, probe: fakeProbe });

    let upstream: FakeUpstream | undefined;
    const telemetry = openTelemetryStore(projectDir);
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

      // Load exactly the settings golemInit wrote (project scope), pointing
      // the upstream at the fake server via the same in-memory `overrides`
      // layer real per-request overrides use — no hand-editing of the
      // (deeply-frozen) settings object. userDir points at a dir with no
      // settings.json in it, so this never touches the real
      // ~/.golem/settings.json.
      const { settings } = await loadConfig({
        projectDir,
        userDir: fakeUserDir,
        overrides: { proxy: { upstream_base_url: upstream.origin } },
      });
      expect(settings.slider.level).toBe(1);

      // The REAL construction path: exactly what `golem proxy`'s
      // `runProxyForeground` (src/cli/main.ts) calls to build its
      // `GolemProxy` + request pipeline from loaded settings. Only
      // `proxy.listen()` (ephemeral port, so parallel test runs never
      // collide) and teardown are added here — the CLI-only pid-file /
      // stdout / signal-handler bits stay in `runProxyForeground`.
      const { proxy } = buildProxyFromSettings(projectDir, settings, telemetry);
      try {
        const addr = await proxy.listen();
        const origin = `http://127.0.0.1:${addr.port}`;

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

        const response = await rawRequest(origin, "/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestBody,
        });

        // Proxy fidelity hard rule: the response path has no pipeline seam and
        // must be byte-faithful, independent of the request-side slider level.
        expect(response.status).toBe(200);
        expect(response.body.equals(Buffer.from(NON_STREAMING_TOOL_USE_RESPONSE))).toBe(true);

        // The pipeline ran and recorded genuine whole-request before/after
        // savings, durably, through the same `TelemetryStore.aggregate`
        // signal `golem stats` / the dashboard read (see
        // tests/integration/cli-stats.test.ts). Draining the store (safe to
        // call more than once) guarantees the fire-and-forget telemetry
        // write has landed before we read it back.
        await telemetry.close();
        const stats = await telemetry.aggregate(projectDir);
        expect(stats.requests).toBe(1);
        expect(stats.tokensBefore).toBeGreaterThan(stats.tokensAfter);
        expect(stats.ccrRefsStored).toBeGreaterThanOrEqual(1);
      } finally {
        await proxy.close();
      }
    } finally {
      await upstream?.close();
      await telemetry.close();
    }
  });
});
