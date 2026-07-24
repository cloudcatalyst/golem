// Decision 21c — Golem VS Code extension.
// A sidebar webview panel + status-bar item that render Golem's savings/state
// by shelling out to the `golem` CLI (`golem stats/status --json`). Thin glue;
// all rendering lives in the unit-tested render.js.
"use strict";

const vscode = require("vscode");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const nodePath = require("node:path");
const { buildModel, statusBarText, renderHtml, levelLabel, fmtTokens } = require("./render.js");

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
  const [stats, status] = await Promise.all([
    // Rolling 24h savings window (Decision 23 — savings is situational); the CLI
    // widens to 7d/all when the last day recorded nothing, and reports which
    // window it used via `window_applied`.
    golemJson(["stats", "--json", "--window", "24h"]),
    golemJson(["status", "--json"]),
  ]);
  return buildModel(stats, status, lastUpdate);
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
        await golemJson(["slider", String(msg.level), "--json"]);
        refresh();
      } else if (msg.type === "proxyStart") {
        await setProxy(true);
      } else if (msg.type === "proxyStop") {
        await setProxy(false);
      } else if (msg.type === "update") {
        runUpdate();
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
/** The most recent model, so the status-bar menu knows whether the proxy is running. */
let lastModel = null;

/** Start (detached) or stop the proxy in the workspace, then refresh. */
async function setProxy(running) {
  const verb = running ? ["proxy", "start", "--detach"] : ["proxy", "stop"];
  await golemText([...verb, "--dir", cwd()]);
  await refresh();
}

/**
 * Show a quick-pick of configured upstream accounts and switch to the chosen
 * one. `golem account use` auto-restarts a running proxy, so the switch applies
 * immediately; we just refresh afterwards. The synthetic default (e.g.
 * `anthropic`) is a first-class entry — selecting it reverts to the top-level
 * config.
 */
async function pickAccount() {
  const report = await golemJson(["account", "list", "--json", "--dir", cwd()]);
  const accounts = report && Array.isArray(report.accounts) ? report.accounts : [];
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
  await golemText(["account", "use", pick.id, "--dir", cwd()]);
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
    // Full model ids here (not the compact versioned labels), since there's room.
    const modeLine = `Mode: ${levelLabel(model)} · saved ${model.savedPct}% (${fmtTokens(
      model.before,
    )} → ${fmtTokens(model.after)})${model.savingsWindow ? ` ${model.savingsWindow}` : ""}`;
    const localLine = model.localModelReachable
      ? `\nLocal: ${model.localBaseUrl || "local"}${
          model.localCoderModel ? ` (${model.localCoderModel})` : ""
        }`
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
    vscode.commands.registerCommand("golem.toggleProxy", () => setProxy(!lastModel?.proxyReachable)),
    vscode.commands.registerCommand("golem.update", runUpdate),
    vscode.commands.registerCommand("golem.setAccount", pickAccount),
    vscode.commands.registerCommand("golem.setSlider", async () => {
      const pick = await vscode.window.showQuickPick(
        ["0", "1", "2", "3", "4", "5"].map((l) => ({ label: `Level ${l}`, level: Number(l) })),
        { placeHolder: "Golem savings slider" },
      );
      if (pick) {
        await golemJson(["slider", String(pick.level), "--json"]);
        refresh();
      }
    }),
    vscode.commands.registerCommand("golem.menu", async () => {
      const running = lastModel?.proxyReachable ?? false;
      const items = [
        {
          label: running ? "$(primitive-square) Stop Golem proxy" : "$(play) Start Golem proxy",
          action: "proxy",
        },
        { label: "$(arrow-both) Set slider level…", action: "slider" },
        { label: "$(account) Switch upstream account…", action: "account" },
        { label: "$(window) Open Golem panel", action: "panel" },
        { label: "$(refresh) Refresh", action: "refresh" },
      ];
      if (lastModel?.updateAvailable) {
        items.unshift({
          label: `$(arrow-up) Update Golem (${lastModel.currentVersion || "?"} → ${lastModel.latestVersion || "?"})`,
          action: "update",
        });
      }
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `Golem — proxy ${running ? "running" : "stopped"}`,
      });
      if (!pick) return;
      if (pick.action === "proxy") await setProxy(!running);
      else if (pick.action === "slider") await vscode.commands.executeCommand("golem.setSlider");
      else if (pick.action === "account") await vscode.commands.executeCommand("golem.setAccount");
      else if (pick.action === "panel") await vscode.commands.executeCommand("golem.showPanel");
      else if (pick.action === "update") runUpdate();
      else await refresh();
    }),
  );

  const pollSeconds = vscode.workspace.getConfiguration("golem").get("pollSeconds", 5);
  timer = setInterval(refresh, Math.max(2, pollSeconds) * 1000);
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
