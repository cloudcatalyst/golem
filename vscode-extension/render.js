// Decision 21c — VS Code renderer: pure model + HTML/status-bar builders.
// No `vscode` imports here so this is unit-testable with `node --test`.
"use strict";

/**
 * The current slider scale (spec Decision 30 — levels 0–3, mirrors the CLI's
 * SLIDER_LEVEL_NAMES in src/cli/slider.ts). Single source of truth for the
 * panel buttons and the status-bar quick-pick so neither drifts to a stale range.
 */
const SLIDER_LEVELS = [
  { level: 0, name: "Passthrough" },
  { level: 1, name: "Lossless" },
  { level: 2, name: "Balanced" },
  { level: 3, name: "Aggressive" },
];

/** Compact token formatting: 1_520_615 -> "1.5M", 139_560 -> "139.6k". */
function fmtTokens(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

function upstreamLabel(url) {
  try {
    const host = new URL(url).host.toLowerCase();
    if (host.includes("azure")) return "foundry";
    if (host === "api.anthropic.com") return "anthropic";
    if (host.includes("openrouter")) return "openrouter";
    return host;
  } catch {
    return "upstream";
  }
}

/**
 * Short family label for a Claude model id (`claude-opus-4-8[1m]` -> `opus`).
 * Mirrors the CLI's `friendlyModelLabel` (src/providers/model-display.ts) so the
 * extension and terminal show the same thing. Non-Claude / unknown ids pass
 * through unchanged.
 */
function friendlyModelLabel(modelId) {
  if (typeof modelId !== "string") return modelId;
  const lower = modelId.toLowerCase();
  for (const family of ["opus", "sonnet", "haiku", "fable"]) {
    if (lower.includes(family)) return family;
  }
  return modelId;
}

/**
 * Short family label for a local (Ollama) model id — the leading family name
 * before any size/variant/tag, e.g. `qwen2.5-coder:7b` -> `qwen`,
 * `llama3.1:8b` -> `llama`, `deepseek-coder-v2:16b` -> `deepseek`. Strips the
 * `:tag`, then takes the alphabetic prefix of the first `-`-segment. Falls back
 * to the original id when it can't simplify.
 */
function friendlyLocalModelLabel(modelId) {
  if (typeof modelId !== "string" || modelId === "") return modelId;
  const beforeTag = modelId.split(":")[0]; // drop ":7b"
  const firstSeg = beforeTag.split("-")[0]; // drop "-coder", "-v2"
  const family = (firstSeg.match(/^[a-zA-Z]+/) || [firstSeg])[0]; // drop trailing "2.5"
  return family || modelId;
}

/** First upper, rest lower — `opus` → `Opus`, `qwen` → `Qwen`. */
function cap(s) {
  return typeof s === "string" && s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}

/**
 * Versioned Claude model label for the one-liner — `claude-opus-4-8[1m]` →
 * `Opus 4.8`, `claude-haiku-4-5-20251001` → `Haiku 4.5` (trailing date dropped).
 * Mirrors the CLI's `friendlyModelVersionLabel` (src/providers/model-display.ts)
 * so the extension and terminal show the same thing. Unknown ids pass through.
 */
function friendlyModelVersionLabel(modelId) {
  if (typeof modelId !== "string") return modelId;
  const lower = modelId.toLowerCase();
  const family = ["opus", "sonnet", "haiku", "fable"].find((f) => lower.includes(f));
  if (!family) return modelId;
  const rest = lower
    .slice(lower.indexOf(family) + family.length)
    .replace(/\[[^\]]*\]/g, "")
    .replace(/^-/, "");
  const version = [];
  for (const seg of rest.split("-")) {
    if (/^\d+$/.test(seg) && seg.length < 8) version.push(seg);
    else break;
  }
  return version.length > 0 ? `${cap(family)} ${version.join(".")}` : cap(family);
}

/** Split a `vendor/model-name` id into its parts; `defaultVendor` is used when there is no `/`. */
function parseVendorModel(modelId, defaultVendor = "anthropic") {
  const slash = modelId.indexOf("/");
  if (slash === -1) return { vendor: defaultVendor, modelName: modelId };
  return { vendor: modelId.slice(0, slash), modelName: modelId.slice(slash + 1) };
}

/** Render a vendor/model-name id as the human-facing upstream label, e.g. `moonshotai/kimi-k3` → `moonshotai (kimi-k3)`. */
function formatVendorModelStatus(modelId, defaultVendor = "anthropic") {
  const { vendor, modelName } = parseVendorModel(modelId, defaultVendor);
  return `${vendor} (${modelName})`;
}

/**
 * Versioned local (Ollama) model label — `qwen2.5-coder:7b` → `Qwen 2.5`,
 * `llama3.1:8b` → `Llama 3.1`, `deepseek-coder-v2:16b` → `Deepseek`. Mirrors the
 * CLI's `localModelVersionLabel`. Empty in → empty out.
 */
function localModelVersionLabel(modelId) {
  if (typeof modelId !== "string" || modelId === "") return modelId;
  const beforeTag = modelId.split(":")[0];
  const familyMatch = beforeTag.match(/^[a-zA-Z]+/);
  if (!familyMatch) return modelId;
  const family = cap(familyMatch[0]);
  const versionMatch = beforeTag.slice(familyMatch[0].length).match(/^[0-9]+(?:\.[0-9]+)*/);
  return versionMatch ? `${family} ${versionMatch[0]}` : family;
}

/**
 * The slider level label, "Passthrough" whenever Golem isn't transforming
 * traffic (proxy stopped, or level 0 full bypass — Decision 30). Shared by the
 * status bar and the hover summary so they never disagree.
 */
function levelLabel(model) {
  if (!model.proxyReachable || model.slider === 0) return "Passthrough";
  return model.sliderName ? cap(model.sliderName) : `L${model.slider}`;
}

/**
 * Build the view model from `golem stats --json`, `golem status --json`, and
 * (optionally) `golem update --check --json`. The update arg wins; otherwise we
 * fall back to the `update` block `golem status` embeds from its cached check.
 */
function buildModel(stats, status, update, accounts) {
  const s = stats && typeof stats === "object" ? stats : {};
  const st = status && typeof status === "object" ? status : {};
  const accountList = Array.isArray(accounts) ? accounts : [];
  // Normalize the two shapes: `golem update --json` → {updateAvailable,latest,current};
  // `golem status --json`.update → {available,latest,current}.
  const up =
    (update && typeof update === "object" && update) ||
    (st.update && typeof st.update === "object" && st.update) ||
    null;
  const updateAvailable = !!(up && (up.updateAvailable === true || up.available === true));
  const latestVersion = up && up.latest ? String(up.latest) : null;
  const currentVersion = up && up.current ? String(up.current) : st.version ? String(st.version) : null;
  const before = Number(s.tokens_before) || 0;
  const after = Number(s.tokens_after) || 0;
  const savedPct = before > 0 && after <= before ? Math.round(((before - after) / before) * 100) : 0;

  const perStage = [];
  const ps = s.per_stage && typeof s.per_stage === "object" ? s.per_stage : {};
  for (const [stage, d] of Object.entries(ps)) {
    if (d && typeof d === "object") {
      perStage.push({
        stage,
        before: Number(d.tokens_before) || 0,
        after: Number(d.tokens_after) || 0,
        saved: Number(d.tokens_saved) || 0,
      });
    }
  }

  // R6.2: prefer the account-aware `status.upstream` block (provider/account/
  // model that the proxy actually fronts). Fall back to the legacy config path
  // only for an older CLI that predates the block — that path is account-BLIND
  // (it reads the top-level base URL), so it can misreport when an account is
  // active; the block is the fix.
  const u = st.upstream && typeof st.upstream === "object" ? st.upstream : null;
  const upstream =
    (u && u.base_url) ||
    (st.config &&
      st.config["proxy.upstream_base_url"] &&
      st.config["proxy.upstream_base_url"].value) ||
    "https://api.anthropic.com";
  const account = u && typeof u.account === "string" ? u.account : null;
  const provider = u && typeof u.provider === "string" ? u.provider : null;
  const defaultModel = u && u.default_model ? String(u.default_model) : null;
  const lastServedModel = u && u.last_served_model ? String(u.last_served_model) : null;
  // Live/current model: what was last served (shortened to a family label like
  // `opus`), else the configured default (shown verbatim — an explicit id).
  const model = lastServedModel ? friendlyModelLabel(lastServedModel) : defaultModel;
  // Label prefers the account id (that's what the user switched to), matching
  // the CLI's providerUpstreamLabel; else the URL-derived host/provider name.
  // The panel pill uses this; the status-bar destination uses upstreamDisplay.
  const label = account || upstreamLabel(upstream);
  // R6.2: mirror the CLI's vendor/model-name formatting in the status bar,
  // e.g. `moonshotai/kimi-k3` with provider `openai` → `moonshotai (kimi-k3)`.
  // When no model is known, fall back to the URL-derived/provider label.
  const primaryModel = defaultModel || lastServedModel;
  const upstreamDisplay = primaryModel
    ? formatVendorModelStatus(primaryModel, provider || "anthropic")
    : label;

  return {
    requests: Number(s.requests) || 0,
    before,
    after,
    savedPct,
    savedTokens: Math.max(0, before - after),
    perStage,
    slider: st.slider && typeof st.slider.level === "number" ? st.slider.level : 1,
    sliderName: (st.slider && st.slider.name) || "",
    upstream,
    upstreamLabel: label,
    upstreamDisplay,
    account,
    provider,
    model,
    defaultModel,
    lastServedModel,
    proxyReachable: !!(st.proxy && st.proxy.reachable),
    localModelReachable: !!(st.local_model && st.local_model.reachable),
    localCoderModel:
      st.local_model && typeof st.local_model.coder_model === "string"
        ? st.local_model.coder_model
        : null,
    // The local (Ollama) base URL for the hover summary's `Local:` line — from
    // the status `local_model` block, falling back to the config value.
    localBaseUrl:
      (st.local_model && typeof st.local_model.base_url === "string" && st.local_model.base_url) ||
      (st.config &&
        st.config["inference.ollama_base_url"] &&
        st.config["inference.ollama_base_url"].value) ||
      null,
    // The savings window actually applied by `golem stats --window` (24h/7d/all),
    // for the summary's `saved …%` label. Null for an older CLI (all-time).
    savingsWindow:
      typeof s.window_applied === "string"
        ? s.window_applied
        : typeof s.window === "string"
          ? s.window
          : null,
    source: typeof s.source === "string" ? s.source : "live",
    accounts: accountList,
    updateAvailable,
    latestVersion,
    currentVersion,
  };
}

/**
 * The VS Code status-bar line. Intentionally distinct from `golem statusline`
 * (the terminal line): the status bar is a compact, at-a-glance presence
 * indicator — brand + slider level + which upstream the traffic fronts, in the
 * form `→ <provider>`. It deliberately OMITS cumulative savings, which live in
 * the hover tooltip (see extension.js) and the panel instead.
 *
 * When Golem isn't transforming traffic — the proxy is stopped, or it's running
 * at slider level 0 (full bypass, Decision 30) — the level reads "Passthrough".
 * The destination is still shown in every state (it's the configured upstream);
 * a hollow glyph (⬡) signals a stopped proxy.
 *
 * When a local model is reachable, `local` is folded into the destination
 * ahead of the upstream provider (`→ local + <provider>`) at ANY slider level —
 * Golem is then a local+upstream hybrid (`coder` at every level; auto-draft
 * / local-first at level 3), Decision 30. The arrow always precedes the
 * destination, whether it's one provider or local-plus-provider.
 *
 * R6.2: the current model (last-served, else configured default) is shown as
 * `→ <provider> (<model>)`, e.g. `→ kimi (kimi-k3)`. Omitted when no model is
 * known (a plain Anthropic passthrough stays `→ anthropic`).
 */
function statusBarText(model) {
  const glyph = model.proxyReachable ? "⬢" : "⬡";
  // The update nudge shows regardless of proxy state — it's about the install,
  // not the traffic. `$(arrow-up)` is a VS Code codicon; harmless as text too.
  const badge = model.updateAvailable ? " $(arrow-up)" : "";
  return `${glyph} Golem · ${levelLabel(model)} → ${destinationLabel(model)}${badge}`;
}

/**
 * The one-liner destination — `local (Qwen 2.5) + anthropic (Opus 4.8)`. Each
 * backend carries its own versioned `(model)`; the `local (…)` segment is
 * present only when a local model is reachable (Decision 30 — Golem is then a
 * local+upstream hybrid at any level). Shown in every state (including
 * passthrough/off): it's the configured destination traffic goes to.
 */
function destinationLabel(model) {
  // R6.2: use the vendor/model-name display label (e.g. `moonshotai (kimi-k3)`)
  // built in buildModel; it already incorporates the last-served or configured
  // model and matches the CLI's `golem status` output.
  const upstreamSeg = model.upstreamDisplay || model.upstreamLabel || "upstream";
  if (!model.localModelReachable) return upstreamSeg;
  const localVer = model.localCoderModel ? localModelVersionLabel(model.localCoderModel) : "";
  const localSeg = localVer ? `local (${localVer})` : "local";
  return `${localSeg} + ${upstreamSeg}`;
}

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/** Full webview HTML. `nonce` gates inline script under the CSP. */
function renderHtml(model, nonce) {
  const sliderButtons = SLIDER_LEVELS.map(
    (l) =>
      `<button class="lvl ${l.level === model.slider ? "on" : ""}" data-level="${l.level}" title="${esc(
        l.name,
      )}">${l.level}</button>`,
  ).join("");
  const stageRows = model.perStage
    .map(
      (p) =>
        `<tr><td>${esc(p.stage)}</td><td>${fmtTokens(p.before)}</td><td>${fmtTokens(
          p.after,
        )}</td><td class="save">${fmtTokens(p.saved)}</td></tr>`,
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body{font:12px var(--vscode-font-family);color:var(--vscode-foreground);padding:10px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;opacity:.7;margin:14px 0 6px}
  .big{font-size:26px;font-weight:600;color:var(--vscode-charts-green,#3fb950)}
  .sub{opacity:.7}
  .row{display:flex;justify-content:space-between;margin:3px 0}
  .lvl{width:26px;height:26px;margin-right:4px;border:1px solid var(--vscode-widget-border,#444);
       background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);
       border-radius:5px;cursor:pointer}
  .lvl.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:700}
  table{width:100%;border-collapse:collapse;margin-top:4px}
  td,th{text-align:right;padding:2px 4px}td:first-child,th:first-child{text-align:left;opacity:.85}
  .save{color:var(--vscode-charts-green,#3fb950)}
  .warn{color:var(--vscode-charts-yellow,#d7ba7d)}
  .ok{color:var(--vscode-charts-green,#3fb950)}
  .pill{display:inline-block;padding:1px 7px;border-radius:9px;background:var(--vscode-badge-background);
        color:var(--vscode-badge-foreground)}
  .toggle{margin-left:8px;padding:1px 9px;border:1px solid var(--vscode-widget-border,#444);
       background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);
       border-radius:5px;cursor:pointer;font:11px var(--vscode-font-family)}
  .toggle:hover{background:var(--vscode-button-secondaryHoverBackground,var(--vscode-button-background))}
</style></head><body>
  <div class="big">${model.savedPct}%</div>
  <div class="sub">saved · ${fmtTokens(model.before)} → ${fmtTokens(model.after)} tokens · ${
    model.requests
  } req${model.savingsWindow ? ` · ${esc(model.savingsWindow)}` : ""}</div>

  <h2>Status</h2>
  <div class="row"><span>Proxy</span><span>
    <span class="${model.proxyReachable ? "ok" : "warn"}">${
      model.proxyReachable ? "running" : "stopped"
    }</span>
    <button class="toggle" id="proxyToggle" data-running="${model.proxyReachable ? "1" : "0"}">${
      model.proxyReachable ? "Stop" : "Start"
    }</button>
  </span></div>
  <div class="row"><span>Upstream</span><span class="pill">${esc(
    model.upstreamLabel,
  )}${model.provider && model.provider !== model.upstreamLabel ? ` · ${esc(model.provider)}` : ""}${
    model.model ? ` · ${esc(model.model)}` : ""
  }</span></div>
  <div class="row"><span>Inference</span><span class="sub">${
    model.localModelReachable
      ? `local + upstream${model.localCoderModel ? ` · coder ${esc(model.localCoderModel)}` : ""}`
      : "upstream only"
  }</span></div>
  <div class="row"><span>Stats source</span><span class="sub">${esc(model.source)}</span></div>
  <div class="row"><span>Version</span><span>${
    model.updateAvailable
      ? `<span class="warn">${esc(model.currentVersion || "")} → ${esc(
          model.latestVersion || "",
        )}</span><button class="toggle" id="updateBtn">Update</button>`
      : `<span class="sub">${esc(model.currentVersion || "unknown")}</span>`
  }</span></div>

  <h2>Slider (level ${model.slider}${model.sliderName ? ` · ${esc(model.sliderName)}` : ""})</h2>
  <div>${sliderButtons}</div>

  <h2>Per-stage savings</h2>
  <table><tr><th>stage</th><th>before</th><th>after</th><th>saved</th></tr>${
    stageRows || '<tr><td colspan="4" class="sub">no traffic yet</td></tr>'
  }</table>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    for (const b of document.querySelectorAll('.lvl')) {
      b.addEventListener('click', () => vscode.postMessage({ type: 'setSlider', level: Number(b.dataset.level) }));
    }
    const pt = document.getElementById('proxyToggle');
    if (pt) pt.addEventListener('click', () => vscode.postMessage({ type: pt.dataset.running === '1' ? 'proxyStop' : 'proxyStart' }));
    const ub = document.getElementById('updateBtn');
    if (ub) ub.addEventListener('click', () => vscode.postMessage({ type: 'update' }));
  </script>
</body></html>`;
}

module.exports = {
  SLIDER_LEVELS,
  fmtTokens,
  upstreamLabel,
  friendlyModelLabel,
  friendlyLocalModelLabel,
  friendlyModelVersionLabel,
  localModelVersionLabel,
  levelLabel,
  destinationLabel,
  buildModel,
  statusBarText,
  renderHtml,
};
