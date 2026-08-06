/**
 * Decision 56 / R8.31 — the bypass shim's pipeline behaviour.
 *
 * `golem proxy stop` no longer releases the port: it replaces the pipeline with a
 * redaction-only shim, so Claude Code (whose `ANTHROPIC_BASE_URL` cannot be
 * un-set without a window reload — verification-notes §112b) never dials a dead
 * socket.
 *
 * The load-bearing test here is `redacts`. The cheap way to build a passthrough
 * is level 0 / `x-golem-bypass`, which forwards untouched — i.e. redaction OFF.
 * CLAUDE.md admits level 0 as the single redaction-off path only because it is
 * never the default and always surfaced loudly; a Stop button that quietly sent
 * unredacted prompts upstream would breach that hard rule while looking like a
 * convenience. So the shim pins level 1, and these tests are what stop that
 * decision from silently regressing.
 *
 * Settings come from the real layered loader's in-memory `overrides`, matching
 * tests/unit/cli/proxy-runtime.test.ts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProxyFromSettings } from "../../../src/cli/proxy-runtime.js";
import { loadConfig } from "../../../src/config/index.js";
import type { SliderLevel } from "../../../src/interfaces/policy.js";
import { WebCache, webCacheDir } from "../../../src/knowledge/web-cache.js";
import type { ProxyRequest } from "../../../src/proxy/types.js";
import { openTelemetryStore } from "../../../src/telemetry/index.js";
import type { TelemetryStore } from "../../../src/telemetry/types.js";
import { rmTemp } from "../../helpers/tmp.js";

// Same synthetic AWS-shaped fixture the redaction unit tests use: "AKIA" + 16
// uppercase alphanumerics. Matches the pipeline's aws-key rule.
const FAKE_AWS_KEY = "AKIAQRSTUVWXYZ012345";

let projectDir: string;
let fakeUserDir: string;
let telemetry: TelemetryStore;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-proxy-shim-project-"));
  fakeUserDir = path.join(await mkdtemp(path.join(tmpdir(), "golem-proxy-shim-home-")), ".golem");
  telemetry = openTelemetryStore(projectDir);
});

afterEach(async () => {
  await telemetry.close();
  await rm(projectDir, rmTemp);
  await rm(path.dirname(fakeUserDir), rmTemp);
});

function messagesRequest(content: unknown): ProxyRequest {
  return {
    method: "POST",
    url: "/v1/messages",
    headers: { "content-type": "application/json" },
    body: Buffer.from(
      JSON.stringify({ model: "claude-x", messages: [{ role: "user", content }] }),
      "utf8",
    ),
  };
}

async function processBody(
  build: ReturnType<typeof buildProxyFromSettings>,
  content: unknown,
): Promise<string> {
  const out = await build.proxy.config.pipeline.process(messagesRequest(content));
  return (out.body as Buffer).toString("utf8");
}

describe("bypass shim — redaction (the hard rule)", () => {
  it("STILL REDACTS, even though the pipeline is 'off'", async () => {
    const { settings } = await loadConfig({ projectDir, userDir: fakeUserDir });
    const build = buildProxyFromSettings(projectDir, settings, telemetry, { shim: true });

    const body = await processBody(build, `export AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}`);

    expect(body).not.toContain(FAKE_AWS_KEY);
    expect(body).toMatch(/\[REDACTED:aws-key:\d+\]/);
  });

  it("redacts even when the LIVE SLIDER says level 0", async () => {
    // A shim that tracked the slider store could be moved to level 0 — redaction
    // off — while every surface still called it "stopped". It must not be
    // reachable that way, so the shim ignores the store entirely.
    const { settings } = await loadConfig({ projectDir, userDir: fakeUserDir });
    const sliderStore = { get: async (): Promise<SliderLevel> => 0 as SliderLevel };
    const build = buildProxyFromSettings(projectDir, settings, telemetry, {
      shim: true,
      sliderStore: sliderStore as never,
    });

    const body = await processBody(build, `token=${FAKE_AWS_KEY}`);

    expect(body).not.toContain(FAKE_AWS_KEY);
  });

  it("a level-0 NON-shim build is the one place that does not redact", async () => {
    // Guards the contrast the decision rests on: level 0 really is redaction-off
    // (Decision 30), which is exactly why the shim must not use it.
    const { settings } = await loadConfig({
      projectDir,
      userDir: fakeUserDir,
      overrides: { slider: { level: 0 } },
    });
    const build = buildProxyFromSettings(projectDir, settings, telemetry);

    const body = await processBody(build, `token=${FAKE_AWS_KEY}`);

    expect(body).toContain(FAKE_AWS_KEY);
  });
});

describe("bypass shim — pipeline is otherwise off", () => {
  it("does NOT context-substitute a webcache-known page that level 2 would replace", async () => {
    // The level-2 context-substitution stage is the observable difference between
    // "pipeline running" and "pipeline off" on an identical request.
    const known = "known webcache content ".repeat(40);
    const webCache = new WebCache(webCacheDir(projectDir));
    await webCache.put("https://example.com/known-page", known, "2026-07-11T00:00:00.000Z");

    const overrides = {
      slider: { level: 2 as SliderLevel },
      proxy: { upstream_base_url: "https://openrouter.ai/api/v1" },
    };
    const { settings } = await loadConfig({ projectDir, userDir: fakeUserDir, overrides });

    // Control: with the pipeline running, the known page IS substituted.
    const running = buildProxyFromSettings(projectDir, settings, telemetry);
    const runningMessages = JSON.parse(await processBody(running, known)).messages as Array<{
      content: unknown;
    }>;
    expect(runningMessages[0]?.content).not.toBe(known);

    // The shim leaves it alone.
    const shim = buildProxyFromSettings(projectDir, settings, telemetry, { shim: true });
    const shimMessages = JSON.parse(await processBody(shim, known)).messages as Array<{
      content: unknown;
    }>;
    expect(shimMessages[0]?.content).toBe(known);
  });

  it("never constructs the Headroom sidecar, even when it is configured", async () => {
    const { settings } = await loadConfig({
      projectDir,
      userDir: fakeUserDir,
      overrides: { slider: { level: 3 }, compression: { headroom_sidecar: true } },
    });

    // Control: configured + non-shim => a sidecar exists.
    expect(buildProxyFromSettings(projectDir, settings, telemetry).semantic).toBeDefined();
    // Shim: no compression at all, so nothing to start.
    expect(
      buildProxyFromSettings(projectDir, settings, telemetry, { shim: true }).semantic,
    ).toBeUndefined();
  });

  it("still forwards to the resolved upstream — it is a proxy, not a black hole", async () => {
    const { settings } = await loadConfig({
      projectDir,
      userDir: fakeUserDir,
      overrides: { proxy: { upstream_base_url: "https://api.anthropic.com" } },
    });

    const build = buildProxyFromSettings(projectDir, settings, telemetry, { shim: true });

    expect(build.upstream.baseUrl).toBe("https://api.anthropic.com");
  });
});
