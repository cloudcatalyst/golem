/**
 * Unit coverage for `buildProxyFromSettings` (src/cli/proxy-runtime.ts) —
 * specifically the opt-in `compression.headroom_sidecar` branch, which had no
 * test coverage: when the flag is set, a real `HeadroomSidecar` must be
 * constructed and returned as `semantic` on the `ProxyBuild`; when unset
 * (the default), `semantic` must be absent.
 *
 * Settings are loaded through the real layered config loader's in-memory
 * `overrides` (the same mechanism tests/e2e/golem-init-smoke.test.ts uses),
 * never by hand-editing a settings object. The sidecar is only ever
 * constructed here, never started (`.start()` / subprocess / network) — that
 * behavior is covered by tests/integration/headroom-adapter.test.ts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProxyFromSettings } from "../../../src/cli/proxy-runtime.js";
import { HeadroomSidecar } from "../../../src/compression/headroom-adapter.js";
import { loadConfig } from "../../../src/config/index.js";
import { WebCache, webCacheDir } from "../../../src/knowledge/web-cache.js";
import type { ProxyRequest } from "../../../src/proxy/types.js";
import { openTelemetryStore } from "../../../src/telemetry/index.js";
import type { TelemetryStore } from "../../../src/telemetry/types.js";

let projectDir: string;
let fakeUserDir: string;
let telemetry: TelemetryStore;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-proxy-runtime-project-"));
  fakeUserDir = path.join(
    await mkdtemp(path.join(tmpdir(), "golem-proxy-runtime-home-")),
    ".golem",
  );
  telemetry = openTelemetryStore(projectDir);
});

afterEach(async () => {
  await telemetry.close();
  await rm(projectDir, { recursive: true, force: true });
  await rm(path.dirname(fakeUserDir), { recursive: true, force: true });
});

/** Poll until a predicate holds, for asserting on a fire-and-forget telemetry write. */
async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor: predicate never became true");
}

function messagesRequest(messages: unknown): ProxyRequest {
  return {
    method: "POST",
    url: "/v1/messages",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ model: "claude-x", messages }), "utf8"),
  };
}

describe("buildProxyFromSettings — R2.2 context-substitution wiring", () => {
  it("substitutes a webcache-known page and records an avoidedUpstream telemetry event", async () => {
    const known = "known webcache content ".repeat(40);
    const webCache = new WebCache(webCacheDir(projectDir));
    await webCache.put("https://example.com/known-page", known, "2026-07-11T00:00:00.000Z");

    const { settings } = await loadConfig({
      projectDir,
      userDir: fakeUserDir,
      overrides: {
        slider: { level: 2 },
        proxy: { upstream_base_url: "https://openrouter.ai/api/v1" },
      },
    });

    const build = buildProxyFromSettings(projectDir, settings, telemetry);

    const out = await build.proxy.config.pipeline.process(
      messagesRequest([{ role: "user", content: known }]),
    );
    const outMessages = JSON.parse((out.body as Buffer).toString("utf8")).messages as Array<{
      content: unknown;
    }>;
    expect(outMessages[0]?.content).not.toBe(known);

    await waitFor(async () => {
      const stats = await telemetry.aggregateAvoidedUpstream(projectDir);
      return stats.events === 1;
    });
    const stats = await telemetry.aggregateAvoidedUpstream(projectDir);
    expect(stats.inputTokensAvoided).toBeGreaterThan(0);
  });
});

describe("buildProxyFromSettings — compression.headroom_sidecar wiring", () => {
  it("constructs and returns a HeadroomSidecar as `semantic` when headroom_sidecar is true", async () => {
    const { settings } = await loadConfig({
      projectDir,
      userDir: fakeUserDir,
      overrides: { compression: { headroom_sidecar: true } },
    });
    expect(settings.compression.headroom_sidecar).toBe(true);

    // buildProxyFromSettings never calls proxy.listen() — it only assembles
    // the objects — so there is nothing to close here (GolemProxy#close()
    // throws ERR_SERVER_NOT_RUNNING on a server that was never bound).
    const build = buildProxyFromSettings(projectDir, settings, telemetry);
    expect(build.semantic).toBeInstanceOf(HeadroomSidecar);
  });

  it("omits `semantic` entirely when headroom_sidecar is false (default)", async () => {
    const { settings } = await loadConfig({ projectDir, userDir: fakeUserDir });
    expect(settings.compression.headroom_sidecar).toBe(false);

    const build = buildProxyFromSettings(projectDir, settings, telemetry);
    expect(build.semantic).toBeUndefined();
    expect("semantic" in build).toBe(false);
  });
});
