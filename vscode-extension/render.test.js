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
    slider: { level: 2, name: "balanced" },
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
  assert.equal(m.localModelReachable, false);
});

test("buildModel surfaces local_model reachability from status --json", () => {
  const status = {
    slider: { level: 3, name: "aggressive" },
    proxy: { reachable: true },
    local_model: { reachable: true },
  };
  const m = buildModel({}, status);
  assert.equal(m.localModelReachable, true);
});

test("statusBarText — compact, provider-focused, no savings", () => {
  // Running: brand + slider level + `→ <provider>`. No savings in the bar.
  assert.equal(
    statusBarText({ proxyReachable: true, slider: 1, upstreamLabel: "foundry", savedPct: 34 }),
    "⬢ Golem · L1 → foundry",
  );
  // Slider name, title-cased, is preferred over the bare "L<n>" form.
  assert.equal(
    statusBarText({
      proxyReachable: true,
      slider: 3,
      sliderName: "aggressive",
      upstreamLabel: "anthropic",
    }),
    "⬢ Golem · Aggressive → anthropic",
  );
  // Savings never leak into the bar text (they live in the hover tooltip).
  assert.doesNotMatch(
    statusBarText({ proxyReachable: true, slider: 2, upstreamLabel: "anthropic", savedPct: 91 }),
    /saved|%|91/,
  );
  // Proxy off: brand + state only, no upstream (nothing is fronting it).
  assert.equal(
    statusBarText({ proxyReachable: false, slider: 1, upstreamLabel: "foundry" }),
    "⬡ Golem · proxy off",
  );
});

test("statusBarText — local segment appears whenever a local model is reachable, at any level", () => {
  // No local model reachable: no local segment.
  assert.equal(
    statusBarText({ proxyReachable: true, slider: 1, upstreamLabel: "foundry" }),
    "⬢ Golem · L1 → foundry",
  );
  // Local model reachable at ANY level (Decision 30): "local" is folded into the
  // destination with "+", the arrow before the destination always present.
  assert.equal(
    statusBarText({
      proxyReachable: true,
      slider: 1,
      upstreamLabel: "anthropic",
      localModelReachable: true,
    }),
    "⬢ Golem · L1 → local + anthropic",
  );
  // Proxy off short-circuits before the local segment is ever considered.
  assert.equal(
    statusBarText({
      proxyReachable: false,
      slider: 3,
      upstreamLabel: "anthropic",
      localModelReachable: true,
    }),
    "⬡ Golem · proxy off",
  );
});

test("renderHtml contains CSP nonce, slider buttons, and escapes", () => {
  const html = renderHtml(buildModel({ tokens_before: 100, tokens_after: 50 }, {}), "abc123");
  assert.match(html, /nonce-abc123/);
  assert.match(html, /data-level="3"/);
  assert.match(html, /50%/); // savedPct
});

test("renderHtml proxy toggle reflects running state (Stop when running)", () => {
  const running = renderHtml(buildModel({}, { proxy: { reachable: true } }), "n1");
  assert.match(running, /id="proxyToggle" data-running="1">Stop</);
  assert.match(running, />running</);

  const stopped = renderHtml(buildModel({}, { proxy: { reachable: false } }), "n2");
  assert.match(stopped, /id="proxyToggle" data-running="0">Start</);
  assert.match(stopped, />stopped</);
});

// --- HTML-escaping of CLI-sourced strings -----------------------------------
//
// `stats` (from `golem stats --json`) and `status` (from `golem status --json`)
// are local CLI output, but a misconfigured or compromised CLI could still
// shape them adversarially. buildModel() passes per-stage names, `source`,
// and `slider.name` through unmodified; renderHtml() must esc() every one of
// them before interpolating into the webview HTML, or this is an XSS-class
// defect (local blast radius, but still a real one in a VS Code webview).

test("renderHtml escapes attacker-controlled per-stage names from stats --json", () => {
  const stats = {
    tokens_before: 100,
    tokens_after: 50,
    per_stage: {
      "<script>alert(1)</script>": { tokens_before: 10, tokens_after: 5, tokens_saved: 5 },
    },
  };
  const html = renderHtml(buildModel(stats, {}), "n3");
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("renderHtml escapes attacker-controlled stats.source from stats --json", () => {
  const stats = { tokens_before: 10, tokens_after: 5, source: '<img src=x onerror=alert(1)>' };
  const html = renderHtml(buildModel(stats, {}), "n4");
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("renderHtml escapes attacker-controlled slider.name from status --json", () => {
  const status = { slider: { level: 2, name: `<b>evil</b>"'&quote` } };
  const html = renderHtml(buildModel({}, status), "n5");
  assert.doesNotMatch(html, /<b>evil<\/b>/);
  assert.match(html, /&lt;b&gt;evil&lt;\/b&gt;&quot;&#39;&amp;quote/);
});

test("renderHtml escapes all HTML metacharacters (& < > \" ') in one pass", () => {
  const stats = {
    tokens_before: 10,
    tokens_after: 5,
    per_stage: { [`&<>"'`]: { tokens_before: 1, tokens_after: 1, tokens_saved: 0 } },
  };
  const html = renderHtml(buildModel(stats, {}), "n6");
  assert.doesNotMatch(html, /<td>&<>"'<\/td>/);
  assert.match(html, /<td>&amp;&lt;&gt;&quot;&#39;<\/td>/);
});

test("upstreamLabel can never carry HTML metacharacters into renderHtml", () => {
  // WHATWG URL parsing rejects hostnames containing HTML metacharacters
  // (throws "Invalid URL"), so upstreamLabel()'s try/catch always falls back
  // to the fixed, safe "upstream" string for such input — unlike per-stage
  // names, `source`, and `slider.name`, a malicious upstream URL host can't
  // reach esc(model.upstreamLabel) with dangerous raw content.
  const model = buildModel(
    {},
    { config: { "proxy.upstream_base_url": { value: "https://<script>alert(1)</script>.com" } } },
  );
  assert.equal(model.upstreamLabel, "upstream");
  const html = renderHtml(model, "n7");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<span class="pill">upstream<\/span>/);
});
