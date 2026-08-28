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
import type { BlockedView } from "../cli/blocked-view.js";
import type { SessionStateReport } from "../cli/session-report.js";
import type { StatsReport } from "../cli/stats.js";
import { ICON_SIZES, iconPng, iconSizeForPath } from "./icon.js";

/** Everything the page shows, snake_case (it is also the JSON API shape). */
export interface DashboardSnapshot {
  readonly project_dir: string;
  /** R11.1: the compression dial (`off|1|2|3`) — the slider is retired (ADR-0004). */
  readonly compression: { readonly level: string; readonly name: string };
  readonly stats: StatsReport;
  /** ISO timestamp the snapshot was taken. */
  readonly generated_at: string;
  /**
   * R12.2 — the blocked read model, so the PAGE renders it and not just
   * `/api/state`. Same {@link BlockedView} the status line and the VS Code panel
   * read: one model, many renderers. Optional so a caller that predates R12.2
   * degrades to a page with no banner rather than failing to build a snapshot.
   *
   * Read-only. The banner shows the tool argument (already redacted before it was
   * written, ADR-0006 §1) and offers no way to answer it — approving is R12.3,
   * and this server gains no write route.
   */
  readonly blocked?: BlockedView;
}

/**
 * The loopback bind this server has always used, and still defaults to. Named
 * rather than inlined so the one place that widens it (R12.5's opt-in LAN bind)
 * is visibly a departure from the default rather than a different literal.
 */
export const LOOPBACK_HOST = "127.0.0.1";

/** Bind every interface — R12.5's opt-in, so a phone on the same network can reach it. */
export const LAN_HOST = "0.0.0.0";

export interface DashboardOptions {
  /** Port to bind; 0 picks an ephemeral port (tests). */
  readonly port: number;
  /**
   * R12.5 — the interface to bind. Defaults to {@link LOOPBACK_HOST}, which is
   * what every caller before the companion app wanted and what an omitted field
   * must therefore keep meaning. {@link LAN_HOST} is the companion app's opt-in.
   *
   * Widening the bind does NOT widen what the server can do: there is no write
   * route to reach, and the method guard below refuses everything but GET/HEAD.
   * That is the whole security argument for a LAN-exposed read surface, and it
   * is structural rather than a policy check that could be forgotten.
   */
  readonly host?: string;
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
  /** The interface actually bound — so a caller can report what it did, not what it asked for. */
  readonly host: string;
  close(): Promise<void>;
}

/** Page poll interval (ms); embedded into the served page. */
export const REFRESH_MS = 2_000;

/**
 * R12.5 — how long a page may go without a successful poll before it stops
 * claiming to be live. Three missed polls: long enough that one dropped request
 * on a phone's flaky Wi-Fi does not flash a scary banner, short enough that
 * walking out of range is visible before the numbers mean anything else.
 *
 * The gate this serves: "pulling the network shows a disconnected state rather
 * than stale data." Showing the last good numbers under a live-looking header IS
 * stale data, so going stale must visibly change the page, not just log.
 */
export const STALE_AFTER_MS = REFRESH_MS * 3;

/** The web-app manifest route — referenced by the page and served as a real route. */
export const MANIFEST_PATH = "/manifest.webmanifest";

/**
 * The web app manifest. `display: standalone` is what makes an installed icon
 * open without browser chrome; `start_url: "/"` keeps a home-screen launch on
 * the same origin it was installed from, whatever LAN address that was.
 */
export function manifestJson(): string {
  return `${JSON.stringify(
    {
      name: "Golem — session state",
      short_name: "Golem",
      description:
        "Read-only view of a locally-hosted Golem project: what is blocked, limits, and savings.",
      start_url: "/",
      scope: "/",
      display: "standalone",
      orientation: "portrait",
      background_color: "#161614",
      theme_color: "#161614",
      icons: ICON_SIZES.map((size) => ({
        src: `/icon-${size}.png`,
        sizes: `${size}x${size}`,
        type: "image/png",
        purpose: "any",
      })),
    },
    null,
    2,
  )}\n`;
}

export async function startDashboard(options: DashboardOptions): Promise<DashboardHandle> {
  const server = http.createServer((req, res) => {
    void handle(options, req, res);
  });

  const host = options.host ?? LOOPBACK_HOST;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Loopback unless the caller explicitly opted into the LAN bind (R12.5).
    server.listen(options.port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  return {
    port,
    host,
    // `0.0.0.0` is a bind target, not somewhere to browse — report loopback as
    // the URL and let the caller print the reachable LAN addresses separately.
    url: `http://${host === LAN_HOST ? LOOPBACK_HOST : host}:${port}/`,
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
    // R12.5 — the two static assets that make the page installable to a home
    // screen. Both are pure functions of nothing, so they are the only routes
    // here that may be cached; everything with state stays `no-store`.
    if (url.pathname === MANIFEST_PATH) {
      const body = manifestJson();
      res.writeHead(200, {
        "content-type": "application/manifest+json; charset=utf-8",
        "cache-control": "public, max-age=86400",
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    const iconSize = iconSizeForPath(url.pathname);
    if (iconSize !== null) {
      const png = iconPng(iconSize);
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(png.length),
        "cache-control": "public, max-age=86400",
      });
      res.end(req.method === "HEAD" ? undefined : png);
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

/**
 * R12.2 — the blocked banner, or "" when there is nothing waiting.
 *
 * Rendered for `abandoned` as well as `waiting`: a block nobody ever came back to
 * is exactly what the page should say out loud, rather than showing the same
 * nothing it shows for a session that is running fine.
 *
 * The argument is shown verbatim — it was redacted on the way INTO the state file
 * (ADR-0006 §1), so what arrives here is already safe to display — and escaped,
 * because a shell command is full of characters HTML cares about.
 */
export function blockedBanner(blocked: BlockedView | undefined): string {
  if (blocked === undefined) return "";
  if (blocked.status !== "waiting" && blocked.status !== "abandoned") return "";
  const head =
    blocked.status === "waiting"
      ? `Waiting on you${blocked.kind === undefined ? "" : ` · ${blocked.kind}`}`
      : "Was waiting on you — no answer recorded";
  const project = blocked.project_name === undefined ? "" : ` · ${blocked.project_name}`;
  const tool =
    blocked.tool === undefined
      ? ""
      : ` · ${blocked.tool.name}${
          blocked.tool.action_class === undefined ? "" : ` (${blocked.tool.action_class})`
        }`;
  const since = blocked.since === undefined ? "" : ` · since ${blocked.since}`;
  const detail = blocked.tool?.argument ?? blocked.reason;
  return `
  <div class="blocked ${blocked.status}">
    <div class="blocked-head">⏸ ${escapeHtml(head + project + tool + since)}</div>
    ${detail === undefined ? "" : `<code>${escapeHtml(detail)}</code>`}
  </div>
`;
}

/** The whole page: inline CSS + a poller that re-renders from /api/stats. */
export function renderPage(snapshot: DashboardSnapshot): string {
  const s = snapshot.stats;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Golem dashboard</title>
<!-- R12.5 — installable to a home screen. Android reads the manifest; iOS
     ignores it and reads these three meta/link tags, which is why both exist. -->
<link rel="manifest" href="${MANIFEST_PATH}">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Golem">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#161614">
<style>
  :root { color-scheme: light dark;
    --fg: #1a1a1a; --bg: #fafaf7; --muted: #6b6b66; --line: #e2e2dc;
    --card: #ffffff; --accent: #2f6f4f; }
  @media (prefers-color-scheme: dark) { :root {
    --fg: #e8e8e3; --bg: #161614; --muted: #99998f; --line: #33332e;
    --card: #1f1f1c; --accent: #7fc9a2; } }
  * { box-sizing: border-box; margin: 0; }
  /* R12.5 — phone-first. The desktop layout is the wide branch of this, not the
     other way round: 2rem of padding and a 60rem column is a fine dashboard and
     an unusable phone screen. env(safe-area-inset-*) keeps content clear of a
     notch when the app is launched standalone from a home screen. */
  body { font: 15px/1.5 system-ui, sans-serif; color: var(--fg);
    background: var(--bg); max-width: 60rem; margin: 0 auto;
    padding: 1rem calc(0.9rem + env(safe-area-inset-right))
             calc(1.5rem + env(safe-area-inset-bottom))
             calc(0.9rem + env(safe-area-inset-left));
    padding-top: calc(1rem + env(safe-area-inset-top)); }
  @media (min-width: 40rem) { body { padding: 2rem; } }
  header { display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; }
  h1 { font-size: 1.3rem; }
  .dir { color: var(--muted); font-size: 0.85rem; word-break: break-all; }
  /* Two tiles across on a phone, auto-fit from 40rem up. minmax(0, 1fr) (not
     auto) is what stops a long number forcing a horizontal scroll. */
  .tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.6rem; margin: 1rem 0; }
  @media (min-width: 40rem) { .tiles {
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap: 0.75rem; margin: 1.25rem 0; } }
  .tile { background: var(--card); border: 1px solid var(--line);
    border-radius: 8px; padding: 0.75rem 1rem; }
  .tile .label { color: var(--muted); font-size: 0.78rem;
    text-transform: uppercase; letter-spacing: 0.04em; }
  .tile .value { font-size: 1.5rem; font-variant-numeric: tabular-nums; }
  .tile .value small { font-size: 0.9rem; color: var(--muted); }
  #tokens-saved { color: var(--accent); }
  h2 { font-size: 0.95rem; margin: 1.5rem 0 0.5rem; }
  /* The stage table is the one genuinely wide thing on the page. It scrolls
     inside its own box rather than making the BODY scroll sideways, which on a
     phone reads as a broken layout. */
  .scroll-x { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; min-width: 22rem; border-collapse: collapse;
    background: var(--card); border: 1px solid var(--line);
    border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 0.45rem 0.8rem;
    border-top: 1px solid var(--line); }
  thead th { border-top: none; color: var(--muted); font-size: 0.78rem;
    text-transform: uppercase; letter-spacing: 0.04em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.empty { color: var(--muted); }
  footer { margin-top: 1.5rem; color: var(--muted); font-size: 0.82rem; }
  /* R12.2 — the blocked banner. */
  .blocked { margin: 1rem 0; padding: 0.7rem 0.9rem; border-radius: 8px;
    border: 1px solid #c9a227; border-left-width: 4px; background: var(--card); }
  .blocked.abandoned { border-color: var(--line); color: var(--muted); }
  .blocked-head { font-weight: 600; }
  .blocked code { display: block; margin-top: 0.4rem; font-size: 0.85rem;
    white-space: pre-wrap; word-break: break-all; }
  /* R12.5 — connection state. The .stale class greys the whole readout so nothing on a
     disconnected screen can be mistaken for a live number. */
  #link { display: none; margin: 0.75rem 0; padding: 0.7rem 0.9rem;
    border-radius: 8px; border: 1px solid #c05c4a; border-left-width: 4px;
    background: var(--card); font-weight: 600; }
  #link small { display: block; font-weight: 400; color: var(--muted);
    margin-top: 0.2rem; }
  body.stale #link { display: block; }
  body.stale .tiles, body.stale .scroll-x, body.stale #blocked-slot {
    opacity: 0.42; filter: grayscale(1); }
  /* R12.5 — the read-only notice. Sits where a control would be, on purpose. */
  .readonly { margin: 1rem 0 0; padding: 0.6rem 0.8rem; border-radius: 8px;
    border: 1px dashed var(--line); color: var(--muted); font-size: 0.85rem; }
</style>
</head>
<body>
  <header>
    <h1>Golem savings</h1>
    <span class="dir" id="project-dir">${escapeHtml(snapshot.project_dir)}</span>
  </header>
<div id="link">⚠ Not connected — this screen is not updating.
  <small>Showing nothing rather than the last numbers, which would look live and
  would not be. Reconnect to the network Golem is running on.</small></div>
<div id="blocked-slot">${blockedBanner(snapshot.blocked)}</div>

  <div class="tiles">
    <div class="tile"><div class="label">Tokens saved</div>
      <div class="value" id="tokens-saved">${s.tokens_saved}</div></div>
    <div class="tile"><div class="label">Tokens before &rarr; after</div>
      <div class="value"><span id="tokens-before">${s.tokens_before}</span>
        <small>&rarr;</small> <span id="tokens-after">${s.tokens_after}</span></div></div>
    <div class="tile"><div class="label">Requests</div>
      <div class="value" id="requests">${s.requests}</div></div>
    <div class="tile"><div class="label">Compression</div>
      <div class="value"><span id="compression-level">${escapeHtml(snapshot.compression.level)}</span>
        <small id="compression-name">${escapeHtml(snapshot.compression.name)}</small></div></div>
    <div class="tile"><div class="label">CCR refs stored / retrieved</div>
      <div class="value"><span id="ccr-stored">${s.ccr_refs_stored}</span>
        <small>/</small> <span id="ccr-retrieved">${s.ccr_refs_retrieved}</span></div></div>
  </div>

  <h2>Stage attribution</h2>
  <div class="scroll-x">
  <table>
    <thead><tr><th>Stage</th><th class="num">Tokens before</th>
      <th class="num">Tokens after</th><th class="num">Saved</th></tr></thead>
    <tbody id="stages">
          ${stageRows(snapshot)}
    </tbody>
  </table>
  </div>

  <p class="readonly">This screen is read-only. There is no prompt box and no
  approve button — nothing here can answer the agent or start a turn.</p>

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
  // R12.2 — the blocked banner, rebuilt with DOM nodes rather than innerHTML.
  // The argument is a redacted tool argument, but it is still attacker-adjacent
  // text: textContent means it can never be markup here, whatever it contains.
  function renderBlocked(b) {
    var slot = document.getElementById("blocked-slot");
    if (!slot) return;
    slot.textContent = "";
    if (!b || (b.status !== "waiting" && b.status !== "abandoned")) return;
    var box = document.createElement("div");
    box.className = "blocked " + b.status;
    var head = document.createElement("div");
    head.className = "blocked-head";
    head.textContent =
      "⏸ " +
      (b.status === "waiting"
        ? "Waiting on you" + (b.kind ? " · " + b.kind : "")
        : "Was waiting on you — no answer recorded") +
      (b.project_name ? " · " + b.project_name : "") +
      (b.tool ? " · " + b.tool.name + (b.tool.action_class ? " (" + b.tool.action_class + ")" : "") : "") +
      (b.since ? " · since " + b.since : "");
    box.appendChild(head);
    var detail = (b.tool && b.tool.argument) || b.reason;
    if (detail) {
      var code = document.createElement("code");
      code.textContent = detail;
      box.appendChild(code);
    }
    slot.appendChild(box);
  }
  function render(snap) {
    var s = snap.stats;
    setText("project-dir", snap.project_dir);
    setText("tokens-saved", s.tokens_saved);
    setText("tokens-before", s.tokens_before);
    setText("tokens-after", s.tokens_after);
    setText("requests", s.requests);
    // R11.1 retired the slider, and R12.2 found this still reading
    // \`snap.slider.level\` — which throws on every poll, so the page never
    // refreshed anything after the first server render. The dial block is what
    // the snapshot carries now.
    if (snap.compression) {
      setText("compression-level", snap.compression.level);
      setText("compression-name", snap.compression.name);
    }
    renderBlocked(snap.blocked);
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
  // R12.5 — connection state, never optimism. A failed poll does NOT leave the
  // last good numbers sitting under a live-looking header: after STALE_AFTER_MS
  // without a success the page marks itself stale, which greys the readout and
  // shows the "not connected" banner. The gate is "pulling the network shows a
  // disconnected state rather than stale data", and quietly retrying is exactly
  // the failure that phrasing is aimed at.
  var STALE_AFTER_MS = ${STALE_AFTER_MS};
  var lastOkAt = Date.now();
  function setStale(stale) {
    if (document.body.classList.contains("stale") === stale) return;
    document.body.classList.toggle("stale", stale);
  }
  function poll() {
    fetch("/api/stats", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (snap) {
        if (!snap) return;           // reachable but unhealthy: let the clock run out
        lastOkAt = Date.now();
        setStale(false);
        render(snap);
      })
      .catch(function () { /* offline or Golem stopped; the clock below decides */ });
  }
  function tick() {
    poll();
    setStale(Date.now() - lastOkAt > STALE_AFTER_MS);
  }
  setInterval(tick, REFRESH_MS);
  // An installed app resumed from the background has been asleep, not connected.
  // Without this it shows however old the last render was until the next tick.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) tick();
  });
  window.addEventListener("offline", function () { setStale(true); });
  window.addEventListener("online", tick);
})();
</script>
</body>
</html>
`;
}
