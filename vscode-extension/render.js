// Decision 21c — VS Code renderer: pure model + HTML/status-bar builders.
// No `vscode` imports here so this is unit-testable with `node --test`.
"use strict";

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

/** Build the view model from `golem stats --json` and `golem status --json`. */
function buildModel(stats, status) {
  const s = stats && typeof stats === "object" ? stats : {};
  const st = status && typeof status === "object" ? status : {};
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

  const upstream =
    (st.config &&
      st.config["proxy.upstream_base_url"] &&
      st.config["proxy.upstream_base_url"].value) ||
    "https://api.anthropic.com";

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
    upstreamLabel: upstreamLabel(upstream),
    proxyReachable: !!(st.proxy && st.proxy.reachable),
    source: typeof s.source === "string" ? s.source : "live",
  };
}

/**
 * The VS Code status-bar line. Intentionally distinct from `golem statusline`
 * (the terminal line): the status bar is a compact, at-a-glance presence
 * indicator — brand + slider level + which upstream the traffic fronts, in the
 * form `→ <provider>`. It deliberately OMITS cumulative savings, which live in
 * the hover tooltip (see extension.js) and the panel instead.
 *
 * When the proxy is off, the upstream is not shown — nothing is going there, so
 * `→ foundry` would mislead (mirrors the terminal statusline's rule).
 *
 * (Model name is not yet displayed: no source is available to the extension —
 * it would slot in as `→ <provider> (<model>)` once one exists.)
 */
function statusBarText(model) {
  const glyph = model.proxyReachable ? "⬢" : "⬡";
  if (!model.proxyReachable) return `${glyph} Golem · proxy off`;
  return `${glyph} Golem · L${model.slider} · → ${model.upstreamLabel}`;
}

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/** Full webview HTML. `nonce` gates inline script under the CSP. */
function renderHtml(model, nonce) {
  const sliderButtons = [0, 1, 2, 3, 4, 5]
    .map(
      (n) =>
        `<button class="lvl ${n === model.slider ? "on" : ""}" data-level="${n}">${n}</button>`,
    )
    .join("");
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
  } req</div>

  <h2>Status</h2>
  <div class="row"><span>Proxy</span><span>
    <span class="${model.proxyReachable ? "ok" : "warn"}">${
      model.proxyReachable ? "running" : "stopped"
    }</span>
    <button class="toggle" id="proxyToggle" data-running="${model.proxyReachable ? "1" : "0"}">${
      model.proxyReachable ? "Stop" : "Start"
    }</button>
  </span></div>
  <div class="row"><span>Upstream</span><span class="pill">${esc(model.upstreamLabel)}</span></div>
  <div class="row"><span>Stats source</span><span class="sub">${esc(model.source)}</span></div>

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
  </script>
</body></html>`;
}

module.exports = { fmtTokens, upstreamLabel, buildModel, statusBarText, renderHtml };
