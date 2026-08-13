// Decision 21c — Golem VS Code extension.
// A sidebar webview panel + status-bar item that render Golem's savings/state
// by shelling out to the `golem` CLI (`golem stats/status --json`). Thin glue;
// all rendering lives in the unit-tested render.js.
"use strict";

const vscode = require("vscode");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const nodePath = require("node:path");
const {
  buildModel,
  statusBarText,
  renderHtml,
  levelLabel,
  fmtTokens,
  gatewayRows,
  SLIDER_LEVELS,
} = require("./render.js");

const cwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

/**
 * Is the current workspace a Golem project? `golem init` writes
 * `.golem/settings.json`; that file is the opt-in marker. The extension is
 * installed globally (into VS Code's extensions dir), so it activates in EVERY
 * window — we must stay invisible in projects that never opted into Golem
 * rather than show a status bar / spawn the CLI everywhere.
 */
function isGolemProject() {
  try {
    return fs.existsSync(nodePath.join(cwd(), ".golem", "settings.json"));
  } catch {
    return false;
  }
}

/**
 * Run `golem <args>` in the workspace folder; resolve raw stdout or null.
 * `shell: true` so Windows resolves the `golem.cmd` npm shim via PATHEXT (plain
 * execFile ENOENTs on it). Args are controlled (flags + a numeric slider
 * level), so there is no shell-injection surface. `stdin` is closed immediately
 * so any command that reads it returns without waiting.
 */
function golemText(args) {
  return new Promise((resolve) => {
    const cp = execFile(
      "golem",
      args,
      { cwd: cwd(), timeout: 8000, windowsHide: true, shell: true },
      (err, stdout) => resolve(err ? null : String(stdout)),
    );
    try {
      cp.stdin?.end();
    } catch {
      // no stdin pipe — fine
    }
  });
}

/** As {@link golemText} but parse JSON (null on error / non-JSON). */
async function golemJson(args) {
  const out = await golemText(args);
  if (out === null) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * The last `golem update --check --json` result. Polled on a slow cadence (not
 * every refresh) — the CLI caches the registry answer for 24h, so this only ever
 * hits the network about once a day; we just avoid spawning it every few seconds.
 */
let lastUpdate = null;

async function fetchUpdate() {
  // Don't spawn the CLI in non-Golem windows — `golem update --check` would
  // otherwise create `.golem/state/update-check.json` in repos that never
  // opted into Golem (the extension installs globally and polls this).
  if (!isGolemProject()) {
    lastUpdate = null;
    return;
  }
  lastUpdate = await golemJson(["update", "--check", "--json"]);
}

async function fetchModel() {
  const [stats, status, accounts, surface] = await Promise.all([
    // Rolling 24h savings window (Decision 23 — savings is situational); the CLI
    // widens to 7d/all when the last day recorded nothing, and reports which
    // window it used via `window_applied`.
    golemJson(["stats", "--json", "--window", "24h"]),
    golemJson(["status", "--json"]),
    // Cache the account list so the "Switch upstream" quick-pick can render
    // instantly instead of waiting for a CLI round-trip each time it opens.
    golemJson(["gateway", "list", "--json", "--dir", cwd()]),
    // The control surface: labels, widget kinds, values, provenance, and writable
    // scopes for settings + guidance rules + runtime state. The CLI is the single
    // source of truth, so a new settings key needs no extension change.
    golemJson(["config", "schema", "--json", "--dir", cwd()]),
  ]);
  return buildModel(stats, status, lastUpdate, accounts, surface);
}

/**
 * Apply one control change through the CLI, then refresh.
 *
 * Routed by the control's id prefix, mirroring `applyControl` in
 * src/config/control-surface.ts — settings go through `golem config set/unset`
 * (which validates against the schema), guidance rules through `golem guidance`,
 * and runtime state through the command that owns its side effects. A rejected
 * write surfaces the CLI's own message; the refresh then puts the row back to
 * whatever is actually on disk.
 */
async function applyControlChange(id, value, scope) {
  if (typeof id !== "string" || id.length === 0) return;
  const sep = id.indexOf(":");
  const family = sep === -1 ? "" : id.slice(0, sep);
  const name = sep === -1 ? "" : id.slice(sep + 1);
  const dir = ["--dir", cwd()];
  let out = null;

  if (family === "setting") {
    // null / empty means "remove it from this scope" so lower layers apply again.
    out =
      value === null || value === undefined || value === ""
        ? await golemText(["config", "unset", name, "--scope", scope || "project", ...dir])
        : await golemText([
            "config",
            "set",
            name,
            String(value),
            "--scope",
            scope || "project",
            ...dir,
          ]);
  } else if (family === "guidance") {
    const verb = value === true || value === "true" ? "enable" : "disable";
    const personal = scope === "user" ? ["--user"] : [];
    out = await golemText(["guidance", verb, name, ...personal, ...dir]);
  } else if (family === "runtime" && name === "slider") {
    await applySlider(Number(value));
    return;
  } else if (family === "runtime" && name === "account") {
    out = await golemText(["gateway", "use", String(value), ...dir]);
  } else if (family === "runtime" && name === "proxy") {
    await setProxy(value === true || value === "true");
    return;
  }

  if (out === null) {
    vscode.window.showWarningMessage(
      `Golem: could not change ${id}. Run \`golem config set ${name} <value>\` in a terminal to see why.`,
    );
  }
  await refresh();
}

/** Run `golem update` in an integrated terminal so the user sees the upgrade. */
function runUpdate() {
  const term = vscode.window.createTerminal({ name: "Golem Update", cwd: cwd() });
  term.show();
  term.sendText("golem update");
  // Re-check a little later so the badge clears once the upgrade lands.
  setTimeout(() => {
    fetchUpdate().then(refresh);
  }, 15000);
}

let nonceCounter = 0;
function nonce() {
  // Extension host: deterministic per-render nonce is fine (no untrusted input).
  nonceCounter += 1;
  return `n${Date.now().toString(36)}${nonceCounter}`;
}

class GolemViewProvider {
  constructor() {
    this.view = undefined;
  }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage(async (msg) => {
      if (!msg) return;
      if (msg.type === "setSlider" && typeof msg.level === "number") {
        await applySlider(msg.level);
      } else if (msg.type === "proxyStart") {
        await setProxy(true);
      } else if (msg.type === "proxyStop") {
        await setProxy(false);
      } else if (msg.type === "update") {
        runUpdate();
      } else if (msg.type === "apply") {
        await applyControlChange(msg.id, msg.value, msg.scope);
      } else if (msg.type === "refresh") {
        await refresh();
      }
    });
    refresh();
  }
  render(model) {
    if (this.view) this.view.webview.html = renderHtml(model, nonce());
  }
}

let statusBar;
let provider;
let timer;
let updateTimer;
let refreshDebounce;
/** The most recent model, so the status-bar menu knows whether the proxy is running. */
let lastModel = null;

/** Coalesce bursts of refresh triggers — a single file write fires several watch events. */
function scheduleRefresh() {
  if (refreshDebounce) clearTimeout(refreshDebounce);
  refreshDebounce = setTimeout(() => {
    refreshDebounce = undefined;
    refresh();
  }, 150);
}

/** Slider level → its lowercase display name, from the shared SLIDER_LEVELS table. */
function sliderNameFor(level) {
  const found = SLIDER_LEVELS.find((l) => l.level === level);
  return found ? found.name.toLowerCase() : "";
}

/**
 * Apply a slider change with instant feedback: repaint the status bar + panel
 * from the chosen level immediately (no CLI round-trip), then persist via the
 * CLI and refresh to reconcile — a higher-precedence config layer could still
 * override the level, and the refresh also updates savings and the tooltip.
 */
async function applySlider(level) {
  if (lastModel) {
    lastModel = { ...lastModel, slider: level, sliderName: sliderNameFor(level) };
    if (statusBar) statusBar.text = statusBarText(lastModel);
    if (provider) provider.render(lastModel);
  }
  await golemJson(["slider", String(level), "--json"]);
  await refresh();
}

/**
 * Start (detached) or stop the proxy in the workspace, then refresh.
 *
 * Decision 56: "stop" means *pipeline off* — the CLI leaves a redaction-only
 * shim bound to the port, because Claude Code's `ANTHROPIC_BASE_URL` cannot be
 * un-set without a window reload, so releasing the port would break every
 * request until the user reloaded. Taking Golem out of the path entirely is
 * `unwireProxy` below, which is a separate, explicit action.
 */
async function setProxy(running) {
  const verb = running ? ["proxy", "start", "--detach"] : ["proxy", "stop"];
  await golemText([...verb, "--dir", cwd()]);
  await refresh();
}

/**
 * Remove Golem from `.claude/settings.json` so Claude Code talks straight to the
 * API. Confirmed first (it edits a git-tracked file), and followed by the reload
 * offer that actually makes it take effect — `env` is not hot-reloaded, so
 * reporting success without the reload would leave the user proxied and puzzled.
 */
async function unwireProxy() {
  const choice = await vscode.window.showWarningMessage(
    "Take Golem out of Claude Code's path? This edits .claude/settings.json and needs a window reload to take effect.",
    { modal: true },
    "Unwire",
  );
  if (choice !== "Unwire") return;
  const out = await golemText(["proxy", "unwire", "--dir", cwd()]);
  await refresh();
  if (typeof out === "string" && /left ANTHROPIC_BASE_URL/.test(out)) {
    vscode.window.showInformationMessage(
      "Golem: another gateway owns ANTHROPIC_BASE_URL — left it alone.",
    );
    return;
  }
  const reload = await vscode.window.showInformationMessage(
    "Golem: unwired. Reload the window for Claude Code to talk direct.",
    "Reload window",
  );
  if (reload === "Reload window") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

/** Point Claude Code back at the local proxy, then offer the reload it needs. */
async function wireProxy() {
  await golemText(["proxy", "wire", "--dir", cwd()]);
  await refresh();
  const reload = await vscode.window.showInformationMessage(
    "Golem: wired to the local proxy. Reload the window for it to take effect.",
    "Reload window",
  );
  if (reload === "Reload window") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

/**
 * Show a quick-pick of configured upstream accounts and switch to the chosen
 * one. `golem gateway use` auto-restarts a running proxy, so the switch applies
 * immediately; we just refresh afterwards. The synthetic default (e.g.
 * `anthropic`) is a first-class entry — selecting it reverts to the top-level
 * config.
 */
async function pickAccount() {
  // Use the cached account list from the last refresh so the quick-pick appears
  // instantly; only block on a CLI round-trip the first time it is opened.
  let accounts = lastModel && Array.isArray(lastModel.accounts) ? lastModel.accounts : [];
  if (accounts.length === 0) {
    // R10.11: this read was `report.accounts`, a key R9.23 renamed to `gateways`.
    // buildModel had been taught both spellings; this cold path never was, so the
    // FIRST open of the picker on a fresh window found nothing and reported "no
    // upstream accounts configured" on a project that had several. One helper
    // knows the shape now (render.gatewayRows) and both call sites use it.
    accounts = gatewayRows(await golemJson(["gateway", "list", "--json", "--dir", cwd()]));
  }
  if (accounts.length === 0) {
    vscode.window.showInformationMessage("Golem: no upstream accounts configured.");
    return;
  }
  const items = accounts.map((a) => {
    const model = a.model ? ` · ${a.model}` : "";
    const dflt = a.is_default ? " (default)" : "";
    const key = a.key_set ? "" : " · key missing";
    return {
      label: `${a.active ? "$(check) " : ""}${a.id}${dflt}`,
      description: `${a.provider}${model}${key}`,
      detail: a.base_url,
      id: a.id,
      active: !!a.active,
    };
  });
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Golem — switch upstream account",
  });
  if (!pick || pick.active) return; // cancelled, or already active
  await golemText(["gateway", "use", pick.id, "--dir", cwd()]);
  await refresh();
}

async function refresh() {
  // Non-Golem project: the extension installs globally, so stay invisible here —
  // hide the status bar and don't spawn the CLI in every unrelated window.
  if (!isGolemProject()) {
    lastModel = null;
    if (statusBar) statusBar.hide();
    return;
  }
  // The status bar renders its own compact line from `model` (see
  // render.statusBarText) — intentionally distinct from `golem statusline` (the
  // terminal line): provider-focused (`→ <provider>`), no savings. Cumulative
  // savings live in the hover tooltip below and the panel.
  const model = await fetchModel();
  lastModel = model;
  if (statusBar) {
    statusBar.text = statusBarText(model);
    // Hover summary — the fuller three-line view the compact status bar omits:
    //   Mode: <level> · saved <pct>% (<in> → <sent>) <window>
    //   Local: <ollama url> (<full model>)        (only when a local model is up)
    //   Upstream: <base url> (<full model>)
    // Cost is intentionally absent (deferred until per-backend cost tracking).
    // Full model ids here — same as the status bar, which also shows them raw.
    const modeLine = `Mode: ${levelLabel(model)} · saved ${model.savedPct}% (${fmtTokens(
      model.before,
    )} → ${fmtTokens(model.after)})${model.savingsWindow ? ` ${model.savingsWindow}` : ""}`;
    // Only when the local model is ACTIVE (reachable AND the coder tool enabled).
    // A reachable-but-disabled Ollama is called out explicitly instead, so the
    // hover explains why the status bar shows no `local` segment.
    const localLine = model.localModelActive
      ? `\nLocal: ${model.localBaseUrl || "local"}${
          model.coderModel ? ` (${model.coderModel})` : ""
        }`
      : model.coderEnabled === false
        ? "\nLocal: disabled (golem local enable)"
        : "";
    const upstreamFull = model.lastServedModel || model.defaultModel;
    const upstreamLine = `\nUpstream: ${model.upstream || model.upstreamLabel}${
      upstreamFull ? ` (${upstreamFull})` : ""
    }`;
    const updateLine = model.updateAvailable
      ? `\nUpdate available: ${model.currentVersion || "?"} → ${model.latestVersion || "?"}`
      : "";
    statusBar.tooltip = `${modeLine}${localLine}${upstreamLine}${updateLine}`;
    statusBar.show();
  }
  if (provider) provider.render(model);
}

function activate(context) {
  provider = new GolemViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("golem.panel", provider),
  );

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = "⬢ Golem";
  statusBar.command = "golem.menu"; // click → actions menu (toggle proxy, slider, panel)
  // Visibility is driven by refresh(): shown only in a Golem project, hidden
  // elsewhere (the extension is installed globally). Don't show() unconditionally.
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("golem.refresh", refresh),
    vscode.commands.registerCommand("golem.showPanel", () =>
      vscode.commands.executeCommand("golem.panel.focus"),
    ),
    // In bypass the port IS reachable but the pipeline is off, so the toggle's
    // job there is to restore it, not to "stop" an already-stopped pipeline.
    vscode.commands.registerCommand("golem.toggleProxy", () =>
      setProxy(lastModel?.proxyBypass === true ? true : !lastModel?.proxyReachable),
    ),
    vscode.commands.registerCommand("golem.unwireProxy", unwireProxy),
    vscode.commands.registerCommand("golem.wireProxy", wireProxy),
    vscode.commands.registerCommand("golem.update", runUpdate),
    vscode.commands.registerCommand("golem.setAccount", pickAccount),
    // The Settings section lives in the panel, so "Configure" just focuses it.
    vscode.commands.registerCommand("golem.configure", () =>
      vscode.commands.executeCommand("golem.panel.focus"),
    ),
    vscode.commands.registerCommand("golem.setSlider", async () => {
      const pick = await vscode.window.showQuickPick(
        SLIDER_LEVELS.map((l) => ({
          label: `${l.level === lastModel?.slider ? "$(check) " : ""}Level ${l.level} · ${l.name}`,
          // Level 0 is a full bypass with redaction OFF (Decision 30) — flag it.
          description: l.level === 0 ? "full bypass — redaction OFF" : "",
          level: l.level,
        })),
        { placeHolder: "Golem savings slider" },
      );
      if (pick) await applySlider(pick.level);
    }),
    vscode.commands.registerCommand("golem.menu", async () => {
      const running = lastModel?.proxyReachable ?? false;
      // Decision 56: three states, not two. `bypass` is serving-but-inert, so the
      // menu must offer "restore pipeline" rather than a Start/Stop toggle that
      // reads as already-stopped.
      const bypass = lastModel?.proxyBypass === true;
      const items = [
        { label: "$(arrow-both) Set slider level…", action: "slider" },
        { label: "$(account) Switch upstream…", action: "account" },
        {
          label: bypass
            ? "$(play) Restore pipeline"
            : running
              ? "$(primitive-square) Stop pipeline (keep port served)"
              : "$(play) Start proxy",
          action: "proxy",
        },
        {
          label: "$(debug-disconnect) Go direct (unwire Golem)…",
          description: "edits .claude/settings.json · needs a window reload",
          action: "unwire",
        },
        { label: "$(window) Open panel", action: "panel" },
      ];
      if (lastModel?.updateAvailable) {
        items.unshift({
          label: `$(arrow-up) Update Golem (${lastModel.currentVersion || "?"} → ${lastModel.latestVersion || "?"})`,
          action: "update",
        });
      }
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `Golem — proxy ${bypass ? "bypass (pipeline off)" : running ? "running" : "stopped"}`,
      });
      if (!pick) return;
      // In bypass the proxy IS reachable, so `!running` would stop it again;
      // restoring the pipeline is a start.
      if (pick.action === "proxy") await setProxy(bypass ? true : !running);
      else if (pick.action === "unwire") await unwireProxy();
      else if (pick.action === "slider") await vscode.commands.executeCommand("golem.setSlider");
      else if (pick.action === "account") await vscode.commands.executeCommand("golem.setAccount");
      else if (pick.action === "panel") await vscode.commands.executeCommand("golem.showPanel");
      else if (pick.action === "update") runUpdate();
      else await refresh();
    }),
  );

  // Event-driven refresh: watch the on-disk settings/served-model so a change made
  // OUTSIDE the extension (terminal `golem slider`, `golem local enable`, an
  // account switch, the MCP `level` tool, a new served model) reflects
  // near-instantly rather than waiting for the poll. `settings.local.json` is
  // watched too — the gitignored local scope holds the slider level, the account
  // selection, and anything written with `--scope local` (Decision 43).
  // Changes made IN the extension already repaint optimistically via applySlider.
  // The periodic timer below is now just a safety net (proxy up/down, telemetry
  // savings, update checks), so it can run less often.
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        folder,
        ".golem/{settings.json,settings.local.json,state/served-model.json}",
      ),
    );
    watcher.onDidChange(scheduleRefresh);
    watcher.onDidCreate(scheduleRefresh);
    watcher.onDidDelete(scheduleRefresh);
    context.subscriptions.push(watcher);
  }

  const pollSeconds = vscode.workspace.getConfiguration("golem").get("pollSeconds", 15);
  timer = setInterval(refresh, Math.max(5, pollSeconds) * 1000);
  // Update check: once at startup, then every 6h (the CLI caches for 24h anyway).
  updateTimer = setInterval(() => {
    fetchUpdate().then(refresh);
  }, 6 * 60 * 60 * 1000);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(timer);
      clearInterval(updateTimer);
    },
  });

  // Prime the update state, then render.
  fetchUpdate().finally(refresh);
}

function deactivate() {
  if (timer) clearInterval(timer);
  if (updateTimer) clearInterval(updateTimer);
}

module.exports = { activate, deactivate };
