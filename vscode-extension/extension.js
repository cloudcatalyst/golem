// Decision 21c — Golem VS Code extension.
// A sidebar webview panel + status-bar item that render Golem's savings/state
// by shelling out to the `golem` CLI (`golem stats/status --json`). Thin glue;
// all rendering lives in the unit-tested render.js.
"use strict";

const vscode = require("vscode");
const { execFile } = require("node:child_process");
const { buildModel, statusBarText, renderHtml } = require("./render.js");

/**
 * Run `golem <args>` in the workspace folder; resolve parsed JSON or null.
 * `shell: true` so Windows resolves the `golem.cmd` npm shim via PATHEXT (plain
 * execFile ENOENTs on it). Args are controlled (flags + a numeric slider
 * level), so there is no shell-injection surface.
 */
function golemJson(args) {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  return new Promise((resolve) => {
    execFile("golem", args, { cwd, timeout: 8000, windowsHide: true, shell: true }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
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
      if (msg && msg.type === "setSlider" && typeof msg.level === "number") {
        await golemJson(["slider", String(msg.level), "--json"]);
        refresh();
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

async function refresh() {
  const model = await fetchModel();
  if (statusBar) {
    statusBar.text = statusBarText(model);
    statusBar.tooltip = `Golem → ${model.upstreamLabel} · ${model.savedPct}% saved · slider L${model.slider}`;
  }
  if (provider) provider.render(model);
}

function activate(context) {
  provider = new GolemViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("golem.panel", provider),
  );

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = "⬢ golem";
  statusBar.command = "golem.showPanel";
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("golem.refresh", refresh),
    vscode.commands.registerCommand("golem.showPanel", () =>
      vscode.commands.executeCommand("golem.panel.focus"),
    ),
    vscode.commands.registerCommand("golem.setSlider", async () => {
      const pick = await vscode.window.showQuickPick(
        ["0", "1", "2", "3", "4", "5"].map((l) => ({ label: `Level ${l}` , level: Number(l) })),
        { placeHolder: "Golem savings slider" },
      );
      if (pick) {
        await golemJson(["slider", String(pick.level), "--json"]);
        refresh();
      }
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
