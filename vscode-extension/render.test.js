// Pure-logic tests for the VS Code renderer. Run: `node --test` in this dir.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fmtTokens,
  upstreamLabel,
  levelLabel,
  buildModel,
  statusBarText,
  renderHtml,
  settingsHtml,
  controlValueText,
  dialsSummary,
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
  assert.equal(m.upstreamDisplay, "foundry");
  assert.equal(m.proxyReachable, true);
  assert.equal(m.perStage.length, 1);
});

test("buildModel is defensive against null/missing input", () => {
  const m = buildModel(null, null);
  assert.equal(m.savedPct, 0);
  assert.equal(m.slider, 1);
  assert.equal(m.upstreamLabel, "anthropic");
  assert.equal(m.upstreamDisplay, "anthropic");
  assert.equal(m.proxyReachable, false);
  assert.equal(m.localModelReachable, false);
  assert.deepStrictEqual(m.accounts, []);
});

test("buildModel exposes the cached account list for the quick-pick", () => {
  const accounts = [
    { id: "anthropic", provider: "anthropic", base_url: "https://api.anthropic.com", active: true, is_default: true, key_set: true },
    { id: "kimi", provider: "openai", base_url: "https://api.moonshot.ai/v1", model: "moonshotai/kimi-k3", active: false, key_set: true },
  ];
  const m = buildModel({}, {}, null, accounts);
  assert.deepStrictEqual(m.accounts, accounts);
});

test("buildModel normalizes an unusable accounts payload to an empty list", () => {
  assert.deepStrictEqual(buildModel({}, {}, null, null).accounts, []);
  assert.deepStrictEqual(buildModel({}, {}, null, undefined).accounts, []);
  assert.deepStrictEqual(buildModel({}, {}, null, { accounts: [] }).accounts, []);
  assert.deepStrictEqual(buildModel({}, {}, null, { accounts: "nope" }).accounts, []);
});

test("buildModel unwraps the AccountsReport object golem account list --json returns", () => {
  // The bug this pins: `golem account list --json` emits the report OBJECT
  // (`{active, active_unknown, accounts:[…]}`), not a bare array. Testing only for
  // an array left the cache permanently empty, so "Switch upstream…" re-ran the
  // ~2.8s CLI call (it probes every account's credential store) on every open.
  const accounts = [
    { id: "anthropic", provider: "anthropic", base_url: "https://api.anthropic.com", active: false, is_default: true, key_set: false },
    { id: "openrouter-laguna", provider: "openrouter", base_url: "https://openrouter.ai/api/v1", model: "poolside/laguna-s-2.1:free", active: true, key_set: true },
  ];
  const m = buildModel({}, {}, null, { active: "openrouter-laguna", active_unknown: false, accounts });
  assert.deepStrictEqual(m.accounts, accounts);
});

test("buildModel surfaces local_model reachability + coder model from status --json", () => {
  const status = {
    slider: { level: 3, name: "aggressive" },
    proxy: { reachable: true },
    local_model: { reachable: true, coder_enabled: true, coder_model: "qwen2.5-coder:7b" },
  };
  const m = buildModel({}, status);
  assert.equal(m.localModelReachable, true);
  assert.equal(m.localCoderEnabled, true);
  assert.equal(m.localModelActive, true);
  assert.equal(m.localCoderModel, "qwen2.5-coder:7b");
});

test("buildModel reports the local model inactive when the coder tool is disabled", () => {
  const status = {
    proxy: { reachable: true },
    local_model: { reachable: true, coder_enabled: false, coder_model: "qwen2.5-coder:7b" },
  };
  const m = buildModel({}, status);
  assert.equal(m.localModelReachable, true); // Ollama IS up — that stays honest
  assert.equal(m.localCoderEnabled, false);
  assert.equal(m.localModelActive, false); // but nothing local is on offer
});

test("buildModel assumes the coder tool is enabled when an older CLI omits the flag", () => {
  const m = buildModel({}, { local_model: { reachable: true } });
  assert.equal(m.localCoderEnabled, true);
  assert.equal(m.localModelActive, true);
});

test("buildModel surfaces a Claude last_served_model verbatim", () => {
  const status = {
    upstream: {
      provider: "anthropic",
      account: null,
      base_url: "https://api.anthropic.com",
      last_served_model: "claude-opus-5[1m]",
    },
  };
  const m = buildModel({}, status);
  assert.equal(m.model, "claude-opus-5[1m]"); // the id as served, not a family label
  assert.equal(m.lastServedModel, "claude-opus-5[1m]");
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
      default_model: "moonshotai/kimi-k3",
    },
  };
  const m = buildModel({}, status);
  assert.equal(m.upstream, "https://api.moonshot.ai/v1");
  assert.equal(m.upstreamLabel, "kimi"); // account id, NOT "anthropic"
  assert.equal(m.upstreamDisplay, "moonshotai (kimi-k3)");
  assert.equal(m.provider, "openai");
  assert.equal(m.model, "moonshotai/kimi-k3");
  assert.equal(m.defaultModel, "moonshotai/kimi-k3");
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
  assert.equal(m.upstreamDisplay, "foundry");
  assert.equal(m.model, null);
});

test("statusBarText — compact, provider-focused, no savings", () => {
  // Running: brand + slider level + `→ <provider>`. No savings in the bar.
  assert.equal(
    statusBarText({ proxyReachable: true, slider: 1, upstreamDisplay: "foundry", savedPct: 34 }),
    "⬢ Golem · L1 → foundry",
  );
  // Slider name, title-cased, is preferred over the bare "L<n>" form.
  assert.equal(
    statusBarText({
      proxyReachable: true,
      slider: 3,
      sliderName: "aggressive",
      upstreamDisplay: "anthropic",
    }),
    "⬢ Golem · Aggressive → anthropic",
  );
  // Savings never leak into the bar text (they live in the hover tooltip).
  assert.doesNotMatch(
    statusBarText({ proxyReachable: true, slider: 2, upstreamDisplay: "anthropic", savedPct: 91 }),
    /saved|%|91/,
  );
  // Proxy off = not transforming traffic → "Passthrough" (hollow glyph); the
  // configured destination is still shown.
  assert.equal(
    statusBarText({ proxyReachable: false, slider: 1, upstreamDisplay: "foundry" }),
    "⬡ Golem · Passthrough → foundry",
  );
  // Running at slider level 0 (full bypass) also reads "Passthrough" (filled glyph).
  assert.equal(
    statusBarText({ proxyReachable: true, slider: 0, upstreamDisplay: "anthropic" }),
    "⬢ Golem · Passthrough → anthropic",
  );
});

test("statusBarText — shows the vendor/model destination built by buildModel (R6.2)", () => {
  // The configured default is shown verbatim (an explicit id like kimi-k3).
  assert.equal(
    statusBarText({
      proxyReachable: true,
      slider: 1,
      upstreamDisplay: "moonshotai (kimi-k3)",
    }),
    "⬢ Golem · L1 → moonshotai (kimi-k3)",
  );
  // Last-served wins over the configured default; the Claude id is verbatim.
  assert.equal(
    statusBarText({
      proxyReachable: true,
      slider: 3,
      sliderName: "aggressive",
      upstreamDisplay: "anthropic (claude-opus-5[1m])",
      localModelActive: true,
    }),
    "⬢ Golem · Aggressive → local + anthropic (claude-opus-5[1m])",
  );
  // No model known → no parenthetical (plain Anthropic passthrough).
  assert.equal(
    statusBarText({ proxyReachable: true, slider: 1, upstreamDisplay: "anthropic" }),
    "⬢ Golem · L1 → anthropic",
  );
});

test("statusBarText — local segment appears whenever the local model is active, at any level", () => {
  // No local model reachable: no local segment.
  assert.equal(
    statusBarText({ proxyReachable: true, slider: 1, upstreamDisplay: "foundry" }),
    "⬢ Golem · L1 → foundry",
  );
  // Local model active at ANY level (Decision 30): "local" is folded into the
  // destination with "+", the arrow before the destination always present.
  assert.equal(
    statusBarText({
      proxyReachable: true,
      slider: 1,
      upstreamDisplay: "anthropic",
      localModelActive: true,
    }),
    "⬢ Golem · L1 → local + anthropic",
  );
  // Proxy off still folds in the local segment — `coder` works in any state.
  assert.equal(
    statusBarText({
      proxyReachable: false,
      slider: 3,
      upstreamDisplay: "anthropic",
      localModelActive: true,
    }),
    "⬡ Golem · Passthrough → local + anthropic",
  );
});

test("statusBarText names each backend with its own model id, verbatim", () => {
  assert.equal(
    statusBarText({
      proxyReachable: true,
      slider: 1,
      upstreamDisplay: "anthropic (claude-opus-5[1m])",
      localModelActive: true,
      localCoderModel: "qwen2.5-coder:7b",
    }),
    "⬢ Golem · L1 → local (qwen2.5-coder:7b) + anthropic (claude-opus-5[1m])",
  );
});

test("statusBarText omits the local segment when the coder tool is disabled", () => {
  // Regression: a reachable Ollama with `inference.local_coder_enabled` false was
  // still shown as `local + …`, advertising a hybrid Golem wasn't offering. The
  // CLI statusline already gated on both conditions; the status bar did not.
  assert.equal(
    statusBarText({
      proxyReachable: true,
      slider: 1,
      upstreamDisplay: "anthropic (claude-opus-5[1m])",
      localModelReachable: true,
      localCoderEnabled: false,
      localModelActive: false,
      localCoderModel: "qwen2.5-coder:7b",
    }),
    "⬢ Golem · L1 → anthropic (claude-opus-5[1m])",
  );
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

// --- Settings section (rendered from `golem config schema --json`) -----------

/** A minimal control surface, shaped like `golem config schema --json`. */
function surfaceFixture(controls) {
  return {
    groups: [{ id: "settings:knowledge", title: "Knowledge", summary: "Search", tab: "settings", controls }],
  };
}

const toggleControl = {
  id: "setting:knowledge.enabled",
  family: "setting",
  label: "Vector knowledge base",
  summary: "Master switch",
  kind: "toggle",
  value: true,
  layer: "project",
  writableScopes: ["project", "local", "user"],
  advanced: false,
};

test("settingsHtml renders a checkbox, its provenance, and a scope select", () => {
  const html = settingsHtml(surfaceFixture([toggleControl]));
  assert.match(html, /<summary>Knowledge<\/summary>/);
  assert.match(html, /Vector knowledge base/);
  assert.match(html, /type="checkbox"[^>]*data-id="setting:knowledge\.enabled"/);
  assert.match(html, / checked>/);
  assert.match(html, /<span class="lay">project<\/span>/);
  // Three writable scopes → a select with all three.
  assert.match(html, /<select class="scope"/);
  for (const scope of ["project", "local", "user"]) {
    assert.match(html, new RegExp(`<option value="${scope}"( selected)?>`));
  }
  // This control's value is owned by `project`, so that option is pre-selected.
  assert.match(html, /<option value="project" selected>/);
});

test("settingsHtml pre-selects the scope that owns the value, not the first one", () => {
  // The bug this pins: config precedence is default < user < project < local < env,
  // so a control owned by `local` that defaulted its write to `project` was written
  // to a layer `local` immediately masked — the row snapped back and the toggle
  // looked dead (this is what made the local-coder toggle un-disablable).
  const html = settingsHtml(surfaceFixture([{ ...toggleControl, layer: "local" }]));
  assert.match(html, /<option value="local" selected>/);
  assert.match(html, /<option value="project">/);
});

test("settingsHtml falls back to the first scope when the owning layer is not writable", () => {
  // `default` and `env` are real provenance layers but not writable scopes; there is
  // nothing to pre-select, so the browser's first-option default stands.
  const html = settingsHtml(surfaceFixture([{ ...toggleControl, layer: "default" }]));
  assert.doesNotMatch(html, / selected>/);
});

test("settingsHtml omits the scope select when there is only one scope", () => {
  const html = settingsHtml(surfaceFixture([{ ...toggleControl, writableScopes: ["local"] }]));
  assert.doesNotMatch(html, /<select class="scope"/);
});

test("settingsHtml renders an enum as a select with the current value selected", () => {
  const html = settingsHtml(
    surfaceFixture([
      {
        ...toggleControl,
        id: "setting:ui.color",
        label: "Panel colour",
        kind: "enum",
        value: "auto",
        options: [
          { value: "auto", label: "auto" },
          { value: "never", label: "never" },
        ],
      },
    ]),
  );
  assert.match(html, /data-kind="enum"/);
  assert.match(html, /<option value="auto" selected>/);
  assert.match(html, /<option value="never">/);
});

test("settingsHtml renders a locked control as read-only text with a lock", () => {
  const html = settingsHtml(
    surfaceFixture([{ ...toggleControl, locked: "set by GOLEM_KNOWLEDGE_ENABLED", writableScopes: [] }]),
  );
  assert.match(html, /🔒/);
  // No input at all: the value can't be changed from here.
  assert.doesNotMatch(html, /type="checkbox"/);
  assert.doesNotMatch(html, /<select class="scope"/);
  assert.match(html, /GOLEM_KNOWLEDGE_ENABLED/);
});

test("settingsHtml marks advanced rows so the checkbox can hide them", () => {
  const html = settingsHtml(surfaceFixture([{ ...toggleControl, advanced: true }]));
  assert.match(html, /class="crow adv"/);
});

test("settingsHtml carries a danger warning onto the row for a confirm", () => {
  const html = settingsHtml(
    surfaceFixture([{ ...toggleControl, danger: "redaction would be OFF" }]),
  );
  assert.match(html, /data-danger="redaction would be OFF"/);
});

test("settingsHtml degrades to a hint when the CLI gave nothing", () => {
  for (const empty of [null, undefined, {}, { groups: [] }]) {
    const html = settingsHtml(empty);
    assert.match(html, /<h2>Settings<\/h2>/);
    assert.match(html, /golem init/);
  }
});

test("settingsHtml escapes every field a settings file could poison", () => {
  // Labels come from Golem's own table, but VALUES come from the user's settings
  // file, and an id/scope could too — all of them reach the HTML.
  const html = settingsHtml(
    surfaceFixture([
      {
        ...toggleControl,
        id: `setting:x"><script>alert(1)</script>`,
        label: `<img src=x onerror=alert(1)>`,
        kind: "text",
        value: `"><script>alert(2)</script>`,
        layer: `<b>project</b>`,
        writableScopes: [`"><script>alert(3)</script>`, "local"],
        summary: `<script>alert(4)</script>`,
      },
    ]),
  );
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
});

test("controlValueText formats the shapes a settings value can take", () => {
  const base = { kind: "text", value: null };
  assert.equal(controlValueText(base), "(unset)");
  assert.equal(controlValueText({ ...base, value: undefined }), "(unset)");
  // The text-input path wants an empty string, not the "(unset)" placeholder.
  assert.equal(controlValueText({ ...base, value: null }, ""), "");
  assert.equal(controlValueText({ ...base, value: "docs/wiki" }), "docs/wiki");
  assert.equal(controlValueText({ ...base, value: 4653 }), "4653");
  assert.equal(controlValueText({ ...base, value: ["a", "b"] }), "a, b");
  assert.equal(controlValueText({ ...base, value: [] }), "(none)");
  // A structured array must never render as "[object Object]".
  assert.equal(controlValueText({ ...base, value: [{ id: "x" }, { id: "y" }] }), "2 entries");
  assert.equal(controlValueText({ ...base, value: [{ id: "x" }] }), "1 entry");
});

test("renderHtml includes the settings section and its apply script", () => {
  const model = buildModel({}, {}, null, [], surfaceFixture([toggleControl]));
  const html = renderHtml(model, "n8");
  assert.match(html, /<h2>Settings<\/h2>/);
  assert.match(html, /Vector knowledge base/);
  // The webview posts a generic apply message; it knows nothing about the key.
  assert.match(html, /type: 'apply'/);
  assert.match(html, /id="advToggle"/);
});

test("buildModel tolerates a missing control surface", () => {
  // An older `golem` without `config schema` returns null; the panel must still
  // render everything else.
  for (const bad of [undefined, null, "nope", 7]) {
    const model = buildModel({}, {}, null, [], bad);
    assert.equal(model.surface, null);
    assert.doesNotThrow(() => renderHtml(model, "n9"));
  }
});

// --- Decision 52: the two dials ------------------------------------------

test("buildModel reads the dials block, defaulting to off on an older CLI", () => {
  const withDials = buildModel(
    {},
    {
      slider: { level: 2, name: "balanced" },
      dials: {
        brevity: { setting: "ultra", effective: "ultra", pinned: true, layer: "local" },
        compression: { setting: "auto", effective: "2", pinned: false, layer: "default" },
      },
    },
    null,
    [],
    null,
  );
  assert.equal(withDials.brevity, "ultra");
  assert.equal(withDials.brevityPinned, true);
  assert.equal(withDials.compressionLevel, "2");
  assert.equal(withDials.compressionPinned, false);

  // A CLI that predates Decision 52 emits no `dials` block at all.
  const legacy = buildModel({}, { slider: { level: 2, name: "balanced" } }, null, [], null);
  assert.equal(legacy.brevity, "off");
  assert.equal(legacy.brevityPinned, false);
});

test("statusBarText shows brevity only while it is on", () => {
  const base = {
    proxyReachable: true,
    slider: 2,
    sliderName: "balanced",
    upstreamLabel: "anthropic",
  };
  assert.ok(!statusBarText({ ...base, brevity: "off" }).includes("✂"));
  assert.ok(statusBarText({ ...base, brevity: "full" }).includes("✂ full"));
});

test("dialsSummary always spells out pinned vs auto", () => {
  assert.equal(
    dialsSummary({ brevity: "ultra", brevityPinned: true, compressionLevel: "1", compressionPinned: true }),
    "brevity ultra (pinned) · compression 1 (pinned)",
  );
  assert.equal(
    dialsSummary({ brevity: "off", brevityPinned: false, compressionLevel: "3", compressionPinned: false }),
    "brevity off (auto) · compression 3 (auto)",
  );
});

test("renderHtml warns in the panel when brevity is active", () => {
  const model = buildModel(
    {},
    {
      slider: { level: 3, name: "aggressive" },
      dials: {
        brevity: { setting: "full", effective: "full", pinned: true, layer: "local" },
        compression: { setting: "auto", effective: "3", pinned: false, layer: "default" },
      },
    },
    null,
    [],
    null,
  );
  const html = renderHtml(model, "nonce");
  assert.ok(html.includes("Brevity active"));
  assert.ok(html.includes("brevity full (pinned)"));
});
