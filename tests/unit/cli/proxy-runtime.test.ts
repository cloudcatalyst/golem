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

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProxyFromSettings } from "../../../src/cli/proxy-runtime.js";
import { HeadroomSidecar } from "../../../src/compression/headroom-adapter.js";
import { loadConfig } from "../../../src/config/index.js";
import { openKnowledgeBase } from "../../../src/knowledge/index.js";
import { WebCache, webCacheDir } from "../../../src/knowledge/web-cache.js";
import type { ProxyRequest } from "../../../src/proxy/types.js";
import { openTelemetryStore } from "../../../src/telemetry/index.js";
import type { TelemetryStore } from "../../../src/telemetry/types.js";
import { rmTemp } from "../../helpers/tmp.js";

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
  await rm(projectDir, rmTemp);
  await rm(path.dirname(fakeUserDir), rmTemp);
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

describe("buildProxyFromSettings — resolved-upstream reporting", () => {
  it("reports the ACTIVE ACCOUNT, not the top-level upstream config", async () => {
    // Regression: the startup banner printed settings.proxy.upstream_base_url, so a
    // proxy genuinely serving an active account still announced
    // `-> https://api.anthropic.com` — making a working `golem account use` look
    // like it had not taken effect.
    const { settings } = await loadConfig({
      projectDir,
      userDir: fakeUserDir,
      overrides: {
        proxy: {
          upstream_base_url: "https://api.anthropic.com",
          upstream_provider: "anthropic",
          accounts: [
            {
              id: "openrouter-laguna",
              provider: "openrouter",
              base_url: "https://openrouter.ai/api/v1",
              model: "poolside/laguna-s-2.1:free",
              auth_scheme: "bearer",
            },
          ],
          default_target: "openrouter-laguna",
        },
      },
    });

    const build = buildProxyFromSettings(projectDir, settings, telemetry);
    expect(build.upstream).toMatchObject({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      accountId: "openrouter-laguna",
      model: "poolside/laguna-s-2.1:free",
    });
  });

  it("reports the top-level config when no account is active", async () => {
    const { settings } = await loadConfig({
      projectDir,
      userDir: fakeUserDir,
      overrides: {
        proxy: { upstream_base_url: "https://api.anthropic.com", upstream_provider: "anthropic" },
      },
    });
    const build = buildProxyFromSettings(projectDir, settings, telemetry);
    expect(build.upstream).toMatchObject({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      accountId: null,
    });
    expect(build.upstream.model).toBeUndefined();
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

describe("buildProxyFromSettings — R2.3 knowledge.local_answer_enabled wiring", () => {
  const SEED_TEXT =
    "Golem's proxy avoids upstream calls for confidently answered single-turn questions.";

  async function seedKnowledgeBase(): Promise<void> {
    // Same embedded KnowledgeBase location + embedder buildProxyFromSettings
    // opens (FileVectorDriver under `.golem/knowledge`, hashingEmbedFn) — a
    // second openKnowledgeBase() over the same projectDir reads what this
    // one wrote, exactly like `golem index` then `golem proxy` across
    // process boundaries.
    const seedDir = await mkdtemp(path.join(tmpdir(), "golem-proxy-runtime-seed-"));
    try {
      await writeFile(path.join(seedDir, "note.md"), SEED_TEXT);
      const kb = openKnowledgeBase({ projectDir });
      await kb.ingest(seedDir, projectDir);
    } finally {
      await rm(seedDir, rmTemp);
    }
  }

  it("serves a KB-composed answer directly (respondDirectly) when enabled and confident", async () => {
    await seedKnowledgeBase();
    const { settings } = await loadConfig({
      projectDir,
      userDir: fakeUserDir,
      overrides: { knowledge: { local_answer_enabled: true } },
    });

    const build = buildProxyFromSettings(projectDir, settings, telemetry);
    const out = await build.proxy.config.pipeline.process(
      messagesRequest([{ role: "user", content: SEED_TEXT }]),
    );

    expect(out.respondDirectly).toBeDefined();
    const text = out.respondDirectly?.body.toString("utf8") ?? "";
    expect(text).toContain("Golem");

    await waitFor(async () => {
      const stats = await telemetry.aggregateAvoidedUpstream(projectDir);
      return stats.events === 1;
    });
    const stats = await telemetry.aggregateAvoidedUpstream(projectDir);
    expect(stats.outputTokensAvoided).toBeGreaterThan(0);
  });

  it("never wires localAnswer when local_answer_enabled is false — no respondDirectly even for a matching query", async () => {
    await seedKnowledgeBase();
    const { settings } = await loadConfig({
      projectDir,
      userDir: fakeUserDir,
      overrides: { knowledge: { local_answer_enabled: false } },
    });
    expect(settings.knowledge.local_answer_enabled).toBe(false);

    const build = buildProxyFromSettings(projectDir, settings, telemetry);
    const out = await build.proxy.config.pipeline.process(
      messagesRequest([{ role: "user", content: SEED_TEXT }]),
    );

    expect(out.respondDirectly).toBeUndefined();
  });

  it("falls through to the normal upstream path for an ineligible (multi-turn) request even when enabled", async () => {
    await seedKnowledgeBase();
    const { settings } = await loadConfig({
      projectDir,
      userDir: fakeUserDir,
      overrides: { knowledge: { local_answer_enabled: true } },
    });

    const build = buildProxyFromSettings(projectDir, settings, telemetry);
    const out = await build.proxy.config.pipeline.process(
      messagesRequest([
        { role: "user", content: SEED_TEXT },
        { role: "assistant", content: "ok" },
        { role: "user", content: SEED_TEXT },
      ]),
    );

    expect(out.respondDirectly).toBeUndefined();
  });
});
