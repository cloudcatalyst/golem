// Pure-logic tests for the VS Code renderer. Run: `node --test` in this dir.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fmtTokens,
  upstreamLabel,
  friendlyLocalModelLabel,
  friendlyModelVersionLabel,
  localModelVersionLabel,
  levelLabel,
  buildModel,
  statusBarText,
  renderHtml,
} = require("./render.js");

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

test("buildModel surfaces local_model reachability + coder model from status --json", () => {
  const status = {
    slider: { level: 3, name: "aggressive" },
    proxy: { reachable: true },
    local_model: { reachable: true, coder_model: "qwen2.5-coder:7b" },
  };
  const m = buildModel({}, status);
  assert.equal(m.localModelReachable, true);
  assert.equal(m.localCoderModel, "qwen2.5-coder:7b");
});

test("buildModel shortens a Claude last_served_model to a family label", () => {
  const status = {
    upstream: {
      provider: "anthropic",
      account: null,
      base_url: "https://api.anthropic.com",
      last_served_model: "claude-opus-4-8[1m]",
    },
  };
  const m = buildModel({}, status);
  assert.equal(m.model, "opus");
  assert.equal(m.lastServedModel, "claude-opus-4-8[1m]"); // raw id preserved on the model
});

test("buildModel prefers the account-aware status.upstream block (R6.2)", () => {
  // Regression: with an account active, the legacy config.upstream_base_url is
  // the WRONG (top-level) URL. The `upstream` block must win, so the label reads
  // the account id and the model is surfaced.
  const status = {
    slider: { level: 1, name: "lossless" },
    proxy: { reachable: true },
    config: { "proxy.upstream_base_url": { value: "https://api.anthropic.com" } },
    upstream: {
      provider: "openai",
      account: "kimi",
      base_url: "https://api.moonshot.ai/v1",
      default_model: "kimi-k3",
    },
  };
  const m = buildModel({}, status);
  assert.equal(m.upstream, "https://api.moonshot.ai/v1");
  assert.equal(m.upstreamLabel, "kimi"); // account id, NOT "anthropic"
  assert.equal(m.provider, "openai");
  assert.equal(m.model, "kimi-k3");
  assert.equal(m.defaultModel, "kimi-k3");
});

test("buildModel prefers last_served_model over default_model for the current model", () => {
  const status = {
    upstream: {
      provider: "openai",
      account: "kimi",
      base_url: "https://api.moonshot.ai/v1",
      default_model: "kimi-k3",
      last_served_model: "kimi-k3-0724",
    },
  };
  const m = buildModel({}, status);
  assert.equal(m.model, "kimi-k3-0724");
  assert.equal(m.lastServedModel, "kimi-k3-0724");
});

test("buildModel falls back to legacy config path when no upstream block (older CLI)", () => {
  const status = {
    config: { "proxy.upstream_base_url": { value: "https://x.services.ai.azure.com" } },
  };
  const m = buildModel({}, status);
  assert.equal(m.upstreamLabel, "foundry");
  assert.equal(m.model, null);
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
  // Proxy off = not transforming traffic → "Passthrough" (hollow glyph); the
  // configured destination is still shown.
  assert.equal(
    statusBarText({ proxyReachable: false, slider: 1, upstreamLabel: "foundry" }),
    "⬡ Golem · Passthrough → foundry",
  );
  // Running at slider level 0 (full bypass) also reads "Passthrough" (filled glyph).
  assert.equal(
    statusBarText({ proxyReachable: true, slider: 0, upstreamLabel: "anthropic" }),
    "⬢ Golem · Passthrough → anthropic",
  );
});

test("statusBarText — shows the current model in parentheses when known (R6.2)", () => {
  // The configured default is shown verbatim (an explicit id like kimi-k3).
  assert.equal(
    statusBarText({
      proxyReachable: true,
      slider: 1,
      upstreamLabel: "kimi",
      defaultModel: "kimi-k3",
    }),
    "⬢ Golem · L1 → kimi (kimi-k3)",
  );
  // Last-served wins over the configured default, and a Claude id is versioned.
  assert.equal(
    statusBarText({
      proxyReachable: true,
      slider: 3,
      sliderName: "aggressive",
      upstreamLabel: "anthropic",
      defaultModel: null,
      lastServedModel: "claude-opus-4-8[1m]",
      localModelReachable: true,
    }),
    "⬢ Golem · Aggressive → local + anthropic (Opus 4.8)",
  );
  // No model known → no parenthetical (plain Anthropic passthrough).
  assert.equal(
    statusBarText({ proxyReachable: true, slider: 1, upstreamLabel: "anthropic" }),
    "⬢ Golem · L1 → anthropic",
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
  // Proxy off still folds in the local segment — `coder` works in any state.
  assert.equal(
    statusBarText({
      proxyReachable: false,
      slider: 3,
      upstreamLabel: "anthropic",
      localModelReachable: true,
    }),
    "⬡ Golem · Passthrough → local + anthropic",
  );
});

test("friendlyLocalModelLabel shortens an Ollama model id to its family", () => {
  assert.equal(friendlyLocalModelLabel("qwen2.5-coder:7b"), "qwen");
  assert.equal(friendlyLocalModelLabel("llama3.1:8b"), "llama");
  assert.equal(friendlyLocalModelLabel("deepseek-coder-v2:16b"), "deepseek");
  assert.equal(friendlyLocalModelLabel("bge-m3"), "bge");
  assert.equal(friendlyLocalModelLabel(""), "");
});

test("statusBarText names each backend with its own versioned model", () => {
  assert.equal(
    statusBarText({
      proxyReachable: true,
      slider: 1,
      upstreamLabel: "anthropic",
      lastServedModel: "claude-opus-4-8[1m]",
      localModelReachable: true,
      localCoderModel: "qwen2.5-coder:7b",
    }),
    "⬢ Golem · L1 → local (Qwen 2.5) + anthropic (Opus 4.8)",
  );
});

test("friendlyModelVersionLabel / localModelVersionLabel (mirror the CLI helpers)", () => {
  assert.equal(friendlyModelVersionLabel("claude-opus-4-8[1m]"), "Opus 4.8");
  assert.equal(friendlyModelVersionLabel("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(friendlyModelVersionLabel("claude-sonnet-5"), "Sonnet 5");
  assert.equal(friendlyModelVersionLabel("kimi-k3"), "kimi-k3");
  assert.equal(localModelVersionLabel("qwen2.5-coder:7b"), "Qwen 2.5");
  assert.equal(localModelVersionLabel("llama3.1:8b"), "Llama 3.1");
  assert.equal(localModelVersionLabel("deepseek-coder-v2:16b"), "Deepseek");
  assert.equal(localModelVersionLabel(""), "");
});

test("levelLabel is Passthrough when proxy is off or at level 0, else the title-cased name", () => {
  assert.equal(levelLabel({ proxyReachable: true, slider: 2, sliderName: "balanced" }), "Balanced");
  assert.equal(levelLabel({ proxyReachable: true, slider: 3 }), "L3");
  assert.equal(levelLabel({ proxyReachable: false, slider: 2 }), "Passthrough");
  assert.equal(levelLabel({ proxyReachable: true, slider: 0 }), "Passthrough");
});

test("buildModel surfaces the savings window and local base URL for the hover summary", () => {
  const stats = {
    tokens_before: 128_000,
    tokens_after: 84_000,
    requests: 4,
    window: "24h",
    window_applied: "7d",
  };
  const status = {
    proxy: { reachable: true },
    local_model: { reachable: true, coder_model: "qwen2.5-coder:7b", base_url: "http://localhost:11434" },
  };
  const m = buildModel(stats, status);
  assert.equal(m.savingsWindow, "7d"); // window_applied wins over requested window
  assert.equal(m.localBaseUrl, "http://localhost:11434");
});

test("buildModel reads update state from the explicit update arg", () => {
  const m = buildModel({}, {}, { updateAvailable: true, latest: "0.2.0", current: "0.1.0" });
  assert.equal(m.updateAvailable, true);
  assert.equal(m.latestVersion, "0.2.0");
  assert.equal(m.currentVersion, "0.1.0");
});

test("buildModel falls back to status.update when no explicit update arg", () => {
  // `golem status --json` embeds {available,latest,current} (note: `available`).
  const status = { update: { available: true, latest: "1.3.0", current: "1.2.0" } };
  const m = buildModel({}, status);
  assert.equal(m.updateAvailable, true);
  assert.equal(m.latestVersion, "1.3.0");
});

test("buildModel: no update info → not available", () => {
  const m = buildModel({}, {});
  assert.equal(m.updateAvailable, false);
  assert.equal(m.latestVersion, null);
});

test("statusBarText appends the update codicon only when an update is available", () => {
  assert.equal(
    statusBarText({ proxyReachable: true, slider: 1, upstreamLabel: "anthropic", updateAvailable: true }),
    "⬢ Golem · L1 → anthropic $(arrow-up)",
  );
  // Shows even when the proxy is off (it's about the install, not the traffic).
  assert.equal(
    statusBarText({ proxyReachable: false, upstreamLabel: "anthropic", updateAvailable: true }),
    "⬡ Golem · Passthrough → anthropic $(arrow-up)",
  );
  // Absent when up to date.
  assert.doesNotMatch(
    statusBarText({ proxyReachable: true, slider: 1, upstreamLabel: "anthropic" }),
    /arrow-up/,
  );
});

test("renderHtml shows an Update button when available and escapes versions", () => {
  const up = renderHtml(
    buildModel({}, {}, { updateAvailable: true, latest: "0.2.0", current: "0.1.0" }),
    "nu1",
  );
  assert.match(up, /id="updateBtn">Update</);
  assert.match(up, /0\.1\.0/);
  assert.match(up, /0\.2\.0/);

  const evil = renderHtml(
    buildModel({}, {}, { updateAvailable: true, latest: "<b>x</b>", current: "0.1.0" }),
    "nu2",
  );
  assert.doesNotMatch(evil, /<b>x<\/b>/);
  assert.match(evil, /&lt;b&gt;x&lt;\/b&gt;/);

  // No button when up to date.
  const same = renderHtml(buildModel({}, { version: "0.1.0" }), "nu3");
  assert.doesNotMatch(same, /id="updateBtn"/);
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
