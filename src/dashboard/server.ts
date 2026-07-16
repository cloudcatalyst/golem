/**
 * WS-E E3 — dashboard v0: a local, single-page savings view.
 *
 * Zero new runtime deps: node:http serving one self-contained inline-styled
 * HTML page (no CDN, no build step) plus a JSON endpoint the page polls.
 * Binds LOOPBACK ONLY — this is a local developer dashboard, never exposed.
 *
 * Endpoints:
 *   GET /            -> the page, server-rendered with the current snapshot
 *   GET /api/stats   -> the snapshot as JSON (polled every REFRESH_MS)
 *   anything else    -> 404
 *
 * The data comes through an injected async `snapshot()` callback, keeping
 * this module free of CLI/config/compression imports — the caller (main.ts)
 * wires the StatsSource seam and slider lookup in.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { SessionStateReport } from "../cli/session-report.js";
import type { StatsReport } from "../cli/stats.js";

/** Everything the page shows, snake_case (it is also the JSON API shape). */
export interface DashboardSnapshot {
  readonly project_dir: string;
  readonly slider: { readonly level: number; readonly name: string };
  readonly stats: StatsReport;
  /** ISO timestamp the snapshot was taken. */
  readonly generated_at: string;
}

export interface DashboardOptions {
  /** Port to bind on 127.0.0.1; 0 picks an ephemeral port (tests). */
  readonly port: number;
  /** Fresh data for each page render / API poll. */
  readonly snapshot: () => Promise<DashboardSnapshot>;
  /**
   * R5.2 — the consolidated session-state read model, served at `/api/state`.
   * This is the one payload every renderer and the future 21b remote app share.
   * Optional so existing callers/tests keep working; when absent, `/api/state`
   * 404s like any other unknown path.
   */
  readonly sessionState?: () => Promise<SessionStateReport>;
}

export interface DashboardHandle {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/** Page poll interval (ms); embedded into the served page. */
export const REFRESH_MS = 2_000;

export async function startDashboard(options: DashboardOptions): Promise<DashboardHandle> {
  const server = http.createServer((req, res) => {
    void handle(options, req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Loopback bind only (hard requirement for the local dashboard).
    server.listen(options.port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handle(
  options: DashboardOptions,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("method not allowed\n");
      return;
    }
    if (url.pathname === "/") {
      const snapshot = await options.snapshot();
      const body = renderPage(snapshot);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    if (url.pathname === "/api/stats") {
      const snapshot = await options.snapshot();
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : `${JSON.stringify(snapshot)}\n`);
      return;
    }
    if (url.pathname === "/api/state" && options.sessionState !== undefined) {
      const state = await options.sessionState();
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : `${JSON.stringify(state)}\n`);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`dashboard error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stageRows(snapshot: DashboardSnapshot): string {
  const entries = Object.entries(snapshot.stats.per_stage);
  if (entries.length === 0) {
    return '<tr><td colspan="4" class="empty">no stage activity yet</td></tr>';
  }
  return entries
    .map(
      ([stage, d]) =>
        `<tr><td>${escapeHtml(stage)}</td><td class="num">${d.tokens_before}</td>` +
        `<td class="num">${d.tokens_after}</td><td class="num">${d.tokens_saved}</td></tr>`,
    )
    .join("\n          ");
}

/** The whole page: inline CSS + a poller that re-renders from /api/stats. */
export function renderPage(snapshot: DashboardSnapshot): string {
  const s = snapshot.stats;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Golem dashboard</title>
<style>
  :root { color-scheme: light dark;
    --fg: #1a1a1a; --bg: #fafaf7; --muted: #6b6b66; --line: #e2e2dc;
    --card: #ffffff; --accent: #2f6f4f; }
  @media (prefers-color-scheme: dark) { :root {
    --fg: #e8e8e3; --bg: #161614; --muted: #99998f; --line: #33332e;
    --card: #1f1f1c; --accent: #7fc9a2; } }
  * { box-sizing: border-box; margin: 0; }
  body { font: 15px/1.5 system-ui, sans-serif; color: var(--fg);
    background: var(--bg); padding: 2rem; max-width: 60rem; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; }
  h1 { font-size: 1.3rem; }
  .dir { color: var(--muted); font-size: 0.85rem; word-break: break-all; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap: 0.75rem; margin: 1.25rem 0; }
  .tile { background: var(--card); border: 1px solid var(--line);
    border-radius: 8px; padding: 0.75rem 1rem; }
  .tile .label { color: var(--muted); font-size: 0.78rem;
    text-transform: uppercase; letter-spacing: 0.04em; }
  .tile .value { font-size: 1.5rem; font-variant-numeric: tabular-nums; }
  .tile .value small { font-size: 0.9rem; color: var(--muted); }
  #tokens-saved { color: var(--accent); }
  h2 { font-size: 0.95rem; margin: 1.5rem 0 0.5rem; }
  table { width: 100%; border-collapse: collapse; background: var(--card);
    border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 0.45rem 0.8rem;
    border-top: 1px solid var(--line); }
  thead th { border-top: none; color: var(--muted); font-size: 0.78rem;
    text-transform: uppercase; letter-spacing: 0.04em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.empty { color: var(--muted); }
  footer { margin-top: 1.5rem; color: var(--muted); font-size: 0.82rem; }
</style>
</head>
<body>
  <header>
    <h1>Golem savings</h1>
    <span class="dir" id="project-dir">${escapeHtml(snapshot.project_dir)}</span>
  </header>

  <div class="tiles">
    <div class="tile"><div class="label">Tokens saved</div>
      <div class="value" id="tokens-saved">${s.tokens_saved}</div></div>
    <div class="tile"><div class="label">Tokens before &rarr; after</div>
      <div class="value"><span id="tokens-before">${s.tokens_before}</span>
        <small>&rarr;</small> <span id="tokens-after">${s.tokens_after}</span></div></div>
    <div class="tile"><div class="label">Requests</div>
      <div class="value" id="requests">${s.requests}</div></div>
    <div class="tile"><div class="label">Slider</div>
      <div class="value"><span id="slider-level">${snapshot.slider.level}</span>
        <small id="slider-name">${escapeHtml(snapshot.slider.name)}</small></div></div>
    <div class="tile"><div class="label">CCR refs stored / retrieved</div>
      <div class="value"><span id="ccr-stored">${s.ccr_refs_stored}</span>
        <small>/</small> <span id="ccr-retrieved">${s.ccr_refs_retrieved}</span></div></div>
  </div>

  <h2>Stage attribution</h2>
  <table>
    <thead><tr><th>Stage</th><th class="num">Tokens before</th>
      <th class="num">Tokens after</th><th class="num">Saved</th></tr></thead>
    <tbody id="stages">
          ${stageRows(snapshot)}
    </tbody>
  </table>

  <footer>
    <span id="note">${escapeHtml(s.note)}</span><br>
    Auto-refreshes every ${REFRESH_MS / 1000}s &middot;
    updated <span id="generated-at">${escapeHtml(snapshot.generated_at)}</span>
  </footer>

<script>
(function () {
  "use strict";
  var REFRESH_MS = ${REFRESH_MS};
  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = String(value);
  }
  function render(snap) {
    var s = snap.stats;
    setText("project-dir", snap.project_dir);
    setText("tokens-saved", s.tokens_saved);
    setText("tokens-before", s.tokens_before);
    setText("tokens-after", s.tokens_after);
    setText("requests", s.requests);
    setText("slider-level", snap.slider.level);
    setText("slider-name", snap.slider.name);
    setText("ccr-stored", s.ccr_refs_stored);
    setText("ccr-retrieved", s.ccr_refs_retrieved);
    setText("note", s.note);
    setText("generated-at", snap.generated_at);
    var tbody = document.getElementById("stages");
    if (!tbody) return;
    tbody.textContent = "";
    var stages = Object.keys(s.per_stage);
    if (stages.length === 0) {
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 4;
      td.className = "empty";
      td.textContent = "no stage activity yet";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    stages.forEach(function (stage) {
      var d = s.per_stage[stage];
      var tr = document.createElement("tr");
      [stage, d.tokens_before, d.tokens_after, d.tokens_saved].forEach(
        function (value, i) {
          var td = document.createElement("td");
          if (i > 0) td.className = "num";
          td.textContent = String(value);
          tr.appendChild(td);
        }
      );
      tbody.appendChild(tr);
    });
  }
  function poll() {
    fetch("/api/stats")
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (snap) { if (snap) render(snap); })
      .catch(function () { /* proxy between polls; try again next tick */ });
  }
  setInterval(poll, REFRESH_MS);
})();
</script>
</body>
</html>
`;
}
