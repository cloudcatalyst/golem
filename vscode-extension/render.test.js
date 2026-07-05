// Pure-logic tests for the VS Code renderer. Run: `node --test` in this dir.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fmtTokens, upstreamLabel, buildModel, statusBarText, renderHtml } = require("./render.js");

test("fmtTokens", () => {
  assert.equal(fmtTokens(1_520_615), "1.5M");
  assert.equal(fmtTokens(139_560), "139.6k");
  assert.equal(fmtTokens(42), "42");
  assert.equal(fmtTokens(undefined), "0");
});

test("upstreamLabel", () => {
  assert.equal(upstreamLabel("https://golem-x.services.ai.azure.com"), "foundry");
  assert.equal(upstreamLabel("https://api.anthropic.com"), "anthropic");
  assert.equal(upstreamLabel("bad"), "upstream");
});

test("buildModel from real CLI json shapes", () => {
  const stats = {
    source: "telemetry",
    requests: 6,
    tokens_before: 1_520_615,
    tokens_after: 139_560,
    per_stage: { dedup: { tokens_before: 400, tokens_after: 53, tokens_saved: 347 } },
  };
  const status = {
    slider: { level: 2, name: "conservative" },
    config: { "proxy.upstream_base_url": { value: "https://x.services.ai.azure.com" } },
    proxy: { reachable: true },
  };
  const m = buildModel(stats, status);
  assert.equal(m.savedPct, 91);
  assert.equal(m.slider, 2);
  assert.equal(m.upstreamLabel, "foundry");
  assert.equal(m.proxyReachable, true);
  assert.equal(m.perStage.length, 1);
});

test("buildModel is defensive against null/missing input", () => {
  const m = buildModel(null, null);
  assert.equal(m.savedPct, 0);
  assert.equal(m.slider, 1);
  assert.equal(m.upstreamLabel, "anthropic");
  assert.equal(m.proxyReachable, false);
});

test("statusBarText", () => {
  // Leads with the level NAME and a filled hexagon when the proxy is reachable.
  assert.match(
    statusBarText({ proxyReachable: true, savedPct: 8, slider: 3, sliderName: "balanced" }),
    /^⬢ Golem: Balanced · saved 8%$/,
  );
  // Hollow hexagon + "proxy off" when unreachable; falls back to L<n> without a name.
  const off = statusBarText({ proxyReachable: false, savedPct: 0, slider: 0, sliderName: "" });
  assert.match(off, /^⬡ Golem: L0/);
  assert.match(off, /proxy off/);
});

test("renderHtml contains CSP nonce, slider buttons, and escapes", () => {
  const html = renderHtml(buildModel({ tokens_before: 100, tokens_after: 50 }, {}), "abc123");
  assert.match(html, /nonce-abc123/);
  assert.match(html, /data-level="3"/);
  assert.match(html, /50%/); // savedPct
});
