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
