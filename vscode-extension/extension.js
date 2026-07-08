// Decision 21c — Golem VS Code extension.
// A sidebar webview panel + status-bar item that render Golem's savings/state
// by shelling out to the `golem` CLI (`golem stats/status --json`). Thin glue;
// all rendering lives in the unit-tested render.js.
"use strict";

const vscode = require("vscode");
const { execFile } = require("node:child_process");
const { buildModel, statusBarText, renderHtml } = require("./render.js");

const cwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

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

async function fetchModel() {
  const [stats, status] = await Promise.all([
    golemJson(["stats", "--json"]),
    golemJson(["status", "--json"]),
  ]);
  return buildModel(stats, status);
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
/** The most recent model, so the status-bar menu knows whether the proxy is running. */
let lastModel = null;

/** Start (detached) or stop the proxy in the workspace, then refresh. */
async function setProxy(running) {
  const verb = running ? ["proxy", "start", "--detach"] : ["proxy", "stop"];
  await golemText([...verb, "--dir", cwd()]);
  await refresh();
}

async function refresh() {
  // The status bar renders its own compact line from `model` (see
  // render.statusBarText) — intentionally distinct from `golem statusline` (the
  // terminal line): provider-focused (`→ <provider>`), no savings. Cumulative
  // savings live in the hover tooltip below and the panel.
  const model = await fetchModel();
  lastModel = model;
  if (statusBar) {
    statusBar.text = statusBarText(model);
    statusBar.tooltip = `Golem → ${model.upstreamLabel} · ${model.savedPct}% saved · slider L${model.slider}\nClick for actions`;
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
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("golem.refresh", refresh),
    vscode.commands.registerCommand("golem.showPanel", () =>
      vscode.commands.executeCommand("golem.panel.focus"),
    ),
    vscode.commands.registerCommand("golem.toggleProxy", () => setProxy(!lastModel?.proxyReachable)),
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
        { label: "$(window) Open Golem panel", action: "panel" },
        { label: "$(refresh) Refresh", action: "refresh" },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `Golem — proxy ${running ? "running" : "stopped"}`,
      });
      if (!pick) return;
      if (pick.action === "proxy") await setProxy(!running);
      else if (pick.action === "slider") await vscode.commands.executeCommand("golem.setSlider");
      else if (pick.action === "panel") await vscode.commands.executeCommand("golem.showPanel");
      else await refresh();
    }),
  );

  const pollSeconds = vscode.workspace.getConfiguration("golem").get("pollSeconds", 5);
  timer = setInterval(refresh, Math.max(2, pollSeconds) * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  refresh();
}

function deactivate() {
  if (timer) clearInterval(timer);
}

module.exports = { activate, deactivate };
