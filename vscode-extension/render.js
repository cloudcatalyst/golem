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

/** First upper, rest lower — `lossless` → `Lossless`. */
function cap(s) {
  return typeof s === "string" && s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
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
function buildModel(stats, status, update, accounts, surface) {
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
  // Live/current model: what was last served, else the configured default. Both
  // verbatim — the id as served/configured, never a prettified family name
  // (mirrors the CLI, see src/providers/model-display.ts).
  const model = lastServedModel || defaultModel;
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
    // `golem config schema --json`: the control surface the Settings section
    // renders. Null when the CLI didn't answer (older golem, or a non-Golem
    // window) — settingsHtml degrades to a hint rather than an empty section.
    surface: surface && typeof surface === "object" ? surface : null,
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
    // `inference.local_coder_enabled`. Absent on an older CLI → assume enabled,
    // matching the CLI statusline's fail-open reading of the same setting.
    localCoderEnabled:
      st.local_model && typeof st.local_model.coder_enabled === "boolean"
        ? st.local_model.coder_enabled
        : true,
    // The local model counts as ACTIVE only when it is enabled AND reachable —
    // reachability alone is not enough. Ollama running with the coder tool turned
    // off used to still render as `local + …` here (the CLI statusline already
    // gated on both), claiming a hybrid Golem isn't actually offering.
    localModelActive:
      !!(st.local_model && st.local_model.reachable) &&
      (st.local_model && typeof st.local_model.coder_enabled === "boolean"
        ? st.local_model.coder_enabled
        : true),
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
 * When a local model is reachable AND the coder tool is enabled, `local` is
 * folded into the destination ahead of the upstream provider
 * (`→ local + <provider>`) at ANY slider level — Golem is then a local+upstream
 * hybrid (`coder` at every level; auto-draft / local-first at level 3),
 * Decision 30. A disabled coder tool means no local traffic, so the segment is
 * omitted however reachable Ollama happens to be. The arrow always precedes the
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
 * The one-liner destination — `local (qwen2.5-coder:7b) + anthropic
 * (claude-opus-5[1m])`. Each backend carries its own `(model)` id verbatim; the
 * `local (…)` segment is
 * present only when the local model is ACTIVE — reachable *and* enabled
 * (Decision 30 — Golem is then a local+upstream hybrid at any level). Shown in
 * every state (including passthrough/off): it's the configured destination
 * traffic goes to.
 */
function destinationLabel(model) {
  // R6.2: use the vendor/model-name display label (e.g. `moonshotai (kimi-k3)`)
  // built in buildModel; it already incorporates the last-served or configured
  // model and matches the CLI's `golem status` output.
  const upstreamSeg = model.upstreamDisplay || model.upstreamLabel || "upstream";
  if (!model.localModelActive) return upstreamSeg;
  const localSeg = model.localCoderModel ? `local (${model.localCoderModel})` : "local";
  return `${localSeg} + ${upstreamSeg}`;
}

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/** Full webview HTML. `nonce` gates inline script under the CSP. */
/**
 * The Settings section, rendered from `golem config schema --json` (the same
 * control surface the `golem ui` terminal panel uses).
 *
 * Nothing about the key set is hard-coded here: labels, widget kinds, current
 * values, provenance, and writable scopes all come from the CLI. A new settings
 * key therefore appears in this panel with no extension change and no version
 * skew between the two.
 *
 * `surface` is the parsed JSON, or null when the CLI didn't answer (an older
 * `golem` without `config schema`, or a non-Golem window).
 */
function settingsHtml(surface) {
  if (!surface || !Array.isArray(surface.groups) || surface.groups.length === 0) {
    return '<h2>Settings</h2><div class="sub">Run <code>golem init</code>, or upgrade the golem CLI, to manage settings here.</div>';
  }
  const groups = surface.groups
    .map((group) => {
      const rows = (group.controls || []).map((c) => controlRowHtml(c)).join("");
      if (!rows) return "";
      const summary = group.summary ? `<div class="sub gsum">${esc(group.summary)}</div>` : "";
      return `<details class="grp" open><summary>${esc(group.title || group.id)}</summary>${summary}${rows}</details>`;
    })
    .join("");
  return `<h2>Settings</h2>${groups}`;
}

/**
 * One control as a labelled row. The `data-*` attributes carry everything the
 * webview script needs to post back an apply message, so the script itself stays
 * generic — it never knows what any particular setting means.
 */
function controlRowHtml(control) {
  const id = esc(control.id);
  const label = esc(control.label || control.id);
  // Provenance is the answer to "why is it that value?", so it's always shown.
  const layer = esc(control.layer || "default");
  const title = esc(
    control.locked
      ? `${control.summary || ""}\n\nLocked: ${control.locked}`
      : control.detail || control.summary || "",
  );
  const scopes = Array.isArray(control.writableScopes) ? control.writableScopes : [];
  const scopeSelect =
    scopes.length > 1
      ? `<select class="scope" data-id="${id}" title="Which settings scope a change is written to">${scopes
          .map((s) => `<option value="${esc(s)}">${esc(s)}</option>`)
          .join("")}</select>`
      : "";

  let input;
  if (control.locked) {
    input = `<span class="sub">${esc(controlValueText(control))} 🔒</span>`;
  } else if (control.kind === "toggle") {
    input = `<input type="checkbox" class="ctl" data-id="${id}" data-kind="toggle"${
      control.value === true ? " checked" : ""
    }>`;
  } else if (control.kind === "enum" && Array.isArray(control.options)) {
    input = `<select class="ctl" data-id="${id}" data-kind="enum">${control.options
      .map(
        (o) =>
          `<option value="${esc(o.value)}"${
            String(control.value) === String(o.value) ? " selected" : ""
          }>${esc(o.label || o.value)}</option>`,
      )
      .join("")}</select>`;
  } else if (control.kind === "opaque") {
    input = `<span class="sub">${esc(controlValueText(control))}</span>`;
  } else {
    // text / number / url / list / color all edit as one line of text; the CLI
    // validates against the zod schema and rejects anything invalid.
    input = `<input type="text" class="ctl txt" data-id="${id}" data-kind="${esc(
      control.kind,
    )}" value="${esc(controlValueText(control, ""))}" placeholder="(unset)">`;
  }

  const danger = control.danger ? ` data-danger="${esc(control.danger)}"` : "";
  const advanced = control.advanced ? " adv" : "";
  return (
    `<div class="crow${advanced}"${danger} title="${title}">` +
    `<span class="clabel">${label}</span>` +
    `<span class="cval">${input}${scopeSelect}<span class="lay">${layer}</span></span>` +
    "</div>"
  );
}

/** A control's value as display text. `fallback` is used for unset values. */
function controlValueText(control, fallback = "(unset)") {
  const v = control.value;
  if (v === undefined || v === null) return fallback;
  if (Array.isArray(v)) {
    if (v.length === 0) return fallback === "" ? "" : "(none)";
    return v.every((i) => typeof i !== "object" || i === null)
      ? v.join(", ")
      : `${v.length} entr${v.length === 1 ? "y" : "ies"}`;
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

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
  /* Settings section (rendered from the golem config schema control surface). */
  .grp{margin:6px 0}
  .grp>summary{cursor:pointer;font-weight:600;opacity:.9;padding:2px 0}
  .gsum{margin:0 0 4px 2px;font-size:11px}
  .crow{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:2px 0 2px 2px}
  .crow:hover{background:var(--vscode-list-hoverBackground)}
  .clabel{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cval{flex:0 0 auto;display:flex;align-items:center;gap:6px}
  .lay{font-size:10px;opacity:.55;min-width:46px;text-align:right}
  .ctl.txt{width:110px}
  .ctl,.scope{background:var(--vscode-input-background);color:var(--vscode-input-foreground);
       border:1px solid var(--vscode-input-border,var(--vscode-widget-border,#444));border-radius:4px;
       font:11px var(--vscode-font-family);padding:1px 3px}
  .scope{opacity:.75}
  .hideadv .adv{display:none}
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
    model.localModelActive
      ? `local + upstream${model.localCoderModel ? ` · coder ${esc(model.localCoderModel)}` : ""}`
      : model.localCoderEnabled === false
        ? "upstream only · local coder disabled"
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

  ${settingsHtml(model.surface)}
  <div class="row"><span class="sub">
    <label><input type="checkbox" id="advToggle"> show advanced</label>
  </span></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    for (const b of document.querySelectorAll('.lvl')) {
      b.addEventListener('click', () => vscode.postMessage({ type: 'setSlider', level: Number(b.dataset.level) }));
    }
    const pt = document.getElementById('proxyToggle');
    if (pt) pt.addEventListener('click', () => vscode.postMessage({ type: pt.dataset.running === '1' ? 'proxyStop' : 'proxyStart' }));
    const ub = document.getElementById('updateBtn');
    if (ub) ub.addEventListener('click', () => vscode.postMessage({ type: 'update' }));

    // Advanced rows are hidden by default; the preference lives in the webview's
    // own state so it survives a repaint (the panel re-renders on every refresh).
    const advBox = document.getElementById('advToggle');
    const saved = vscode.getState && vscode.getState();
    const showAdv = !!(saved && saved.showAdvanced);
    if (advBox) advBox.checked = showAdv;
    document.body.classList.toggle('hideadv', !showAdv);
    if (advBox) advBox.addEventListener('change', () => {
      document.body.classList.toggle('hideadv', !advBox.checked);
      if (vscode.setState) vscode.setState({ showAdvanced: advBox.checked });
    });

    // The scope select is per-row and only chooses WHERE the next write goes; it
    // never applies anything on its own.
    const scopeFor = (id) => {
      const sel = document.querySelector('.scope[data-id="' + id + '"]');
      return sel ? sel.value : 'project';
    };
    const apply = (el, value) => {
      const row = el.closest('.crow');
      const danger = row && row.dataset.danger;
      // A dangerous change needs an explicit confirm, same as the terminal panel.
      if (danger && !confirm(danger + '\\n\\nApply it?')) {
        vscode.postMessage({ type: 'refresh' });
        return;
      }
      vscode.postMessage({ type: 'apply', id: el.dataset.id, value: value, scope: scopeFor(el.dataset.id) });
    };
    for (const el of document.querySelectorAll('.ctl')) {
      if (el.dataset.kind === 'toggle') {
        el.addEventListener('change', () => apply(el, el.checked));
      } else if (el.tagName === 'SELECT') {
        el.addEventListener('change', () => apply(el, el.value));
      } else {
        // Commit on blur or Enter, not per keystroke — every apply is a CLI spawn.
        el.addEventListener('change', () => apply(el, el.value === '' ? null : el.value));
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
      }
    }
  </script>
</body></html>`;
}

module.exports = {
  SLIDER_LEVELS,
  fmtTokens,
  upstreamLabel,
  levelLabel,
  destinationLabel,
  buildModel,
  statusBarText,
  renderHtml,
  settingsHtml,
  controlRowHtml,
  controlValueText,
};
