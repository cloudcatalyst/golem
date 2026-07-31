/**
 * R8.8 — `golem models` rendering.
 *
 * The assertions that matter: an absent number renders as `—` and never as `0`
 * (a false price is worse than no price), ids appear verbatim (Decision 49), and
 * a stale catalog is LABELLED rather than suppressed.
 */

import { describe, expect, it } from "vitest";
import { renderModelCatalog, renderRefreshResult } from "../../../src/cli/models.js";
import type { ModelCatalog } from "../../../src/telemetry/index.js";

const NOW = Date.parse("2026-08-01T00:00:00.000Z");

const catalog: ModelCatalog = {
  source: "https://platform.claude.com/docs/en/pricing",
  asOf: "2026-07-31",
  entries: [
    {
      id: "claude-opus-5",
      provider: "anthropic",
      inputUsdPerMTok: 5,
      outputUsdPerMTok: 25,
      cacheReadUsdPerMTok: 0.5,
      cacheWriteUsdPerMTok: 6.25,
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
    },
    {
      id: "claude-sonnet-5",
      provider: "anthropic",
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
      contextTokens: 1_000_000,
      note: "introductory pricing through 2026-08-31",
    },
    { id: "qwen2.5-coder:7b", provider: "ollama", contextTokens: 32_768 },
  ],
};

describe("renderModelCatalog", () => {
  it("cites the source and its date", () => {
    const out = renderModelCatalog(catalog, { nowMs: NOW, maxAgeDays: 45 });
    expect(out).toContain("https://platform.claude.com/docs/en/pricing");
    expect(out).toContain("as of 2026-07-31");
    expect(out).toContain("3 entry(ies)");
  });

  it("prints ids verbatim, including a colon-tagged local tag", () => {
    const out = renderModelCatalog(catalog, { nowMs: NOW, maxAgeDays: 45 });
    expect(out).toContain("claude-opus-5");
    expect(out).toContain("qwen2.5-coder:7b");
    // No prettified names anywhere (Decision 49).
    expect(out).not.toContain("Claude Opus");
    expect(out).not.toContain("Qwen");
  });

  it("renders an unknown price as an em dash, never as 0", () => {
    const out = renderModelCatalog(catalog, { nowMs: NOW, maxAgeDays: 45, filter: "ollama" });
    expect(out).toContain("qwen2.5-coder:7b");
    expect(out).toContain("—");
    expect(out).not.toMatch(/\$0(\.0+)?\b/);
  });

  it("shows a note under its entry", () => {
    const out = renderModelCatalog(catalog, { nowMs: NOW, maxAgeDays: 45, filter: "sonnet" });
    expect(out).toContain("note: introductory pricing through 2026-08-31");
  });

  it("labels a stale catalog without hiding the numbers", () => {
    const out = renderModelCatalog(catalog, {
      nowMs: Date.parse("2026-10-01T00:00:00.000Z"),
      maxAgeDays: 45,
    });
    expect(out).toContain("STALE");
    expect(out).toContain("golem models refresh");
    expect(out).toContain("$5");
  });

  it("matches the filter across provider and id, case-insensitively", () => {
    const out = renderModelCatalog(catalog, { nowMs: NOW, maxAgeDays: 45, filter: "OPUS" });
    expect(out).toContain("1 matching");
    expect(out).toContain("claude-opus-5");
    expect(out).not.toContain("claude-sonnet-5");
  });

  it("says a filter matched nothing, and that ids are not normalised", () => {
    const out = renderModelCatalog(catalog, { nowMs: NOW, maxAgeDays: 45, filter: "gpt" });
    expect(out).toContain('No entry matches "gpt"');
    expect(out).toContain("verbatim");
  });
});

describe("renderRefreshResult", () => {
  it("says what it fetched and that the built-in prices still win", () => {
    const out = renderRefreshResult({
      url: "https://models.dev/api.json",
      fetched: 5900,
      added: 5893,
      builtin: 7,
      fetchedAt: "2026-07-31T12:00:00.000Z",
    });
    expect(out).toContain("5,900");
    expect(out).toContain("https://models.dev/api.json");
    expect(out).toContain("always win on a collision");
  });
});
