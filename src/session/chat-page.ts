/**
 * R13.6 — the chat surface: a phone-shaped conversation view.
 *
 * Self-rendered HTML, inline CSS, no framework, no build step — R12.5's shell
 * and Decision 51's discipline, inherited rather than forked.
 *
 * ## The line ADR-0007 §2 draws, and what it means for this file
 *
 * Promised: streamed replies, visible tool calls, scrollback, interruption,
 * in-place permission answers. **Not promised, and the specific dishonesty this
 * screen must avoid: mirroring the developer's TUI.** So the header always names
 * what this actually is — a *hosted* session, Golem's own, running in a project
 * — and never dresses itself as a window onto the laptop's terminal.
 *
 * ## Two things are deliberately absent rather than disabled
 *
 * 1. **The send box, when the user factor has lapsed.** The device certificate
 *    got you the page; the passcode window is what lets you send, and it can
 *    lapse while the page is open. A greyed-out box invites you to tap it and
 *    wonder; an absent one with an unlock prompt tells you what to do.
 *
 * 2. **Approve/deny for a `destructive`/`outward` question.** Gate-map item 3 is
 *    LOCKED (Decision 59(a)): those are never answerable from a device. So the
 *    screen shows the refusal and why a local human is required — **never a
 *    button that cannot exist.** A control that would always fail is worse than
 *    no control, because it implies an authority the design does not grant.
 */

export interface ChatPageOptions {
  readonly sessionId: string;
  readonly projectDir: string;
  /**
   * `hosted` — Golem spawned and owns it (R13.3).
   * `joined` — a live harness session Golem is injecting into (R13.7).
   *
   * Two different things with two different capabilities, and the user must
   * never have to guess which they are in. R13.6 only ever renders `hosted`;
   * the parameter exists so R13.7 adds a value rather than a redesign.
   */
  readonly kind: "hosted" | "joined";
}

/**
 * JSON for embedding inside a `<script>` block.
 *
 * `JSON.stringify` alone is NOT enough, and the gap is a real XSS rather than a
 * theoretical one: the HTML parser hunts for the end-of-script tag before any
 * JavaScript is parsed, so a string containing it ends the script element early
 * and everything after it is markup. Escaping every `<` into its unicode escape
 * is inert in JS and invisible to the HTML parser.
 *
 * Caught by a test that fed the session id `"><script>alert(1)</script>` — the
 * HTML interpolation was already escaped, and this one was not.
 */
function jsonForScript(value: unknown): string {
  // The replacement must be the SIX characters backslash-u-0-0-3-c. Writing
  // that as a normal escape makes the compiler turn it back into a literal
  // `<`, so the call becomes a silent no-op — which is what happened on the
  // first two attempts here, and what the XSS test caught both times. Built
  // from a char code so there is no backslash in this file to be re-read.
  const escaped = `${String.fromCharCode(92)}u003c`;
  return JSON.stringify(value).replaceAll(`<`, escaped);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The chat page. Served only to a request that already passed the write guard. */
export function renderChatPage(options: ChatPageOptions): string {
  const { sessionId, projectDir, kind } = options;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Golem — hosted session</title>
<link rel="apple-touch-icon" href="/icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Golem">
<meta name="theme-color" content="#161614">
<style>
  :root { color-scheme: light dark;
    --fg: #1a1a1a; --bg: #fafaf7; --muted: #6b6b66; --line: #e2e2dc;
    --card: #ffffff; --accent: #2f6f4f; --warn: #c9a227; --bad: #c05c4a; }
  @media (prefers-color-scheme: dark) { :root {
    --fg: #e8e8e3; --bg: #161614; --muted: #99998f; --line: #33332e;
    --card: #1f1f1c; --accent: #7fc9a2; } }
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; }
  body { font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg);
    display: flex; flex-direction: column; }
  header { padding: calc(0.6rem + env(safe-area-inset-top)) 0.9rem 0.6rem;
    border-bottom: 1px solid var(--line); background: var(--card); }
  /* The honesty line: what this IS, never dressed as the laptop's terminal. */
  .kind { font-weight: 600; font-size: 0.95rem; }
  .kind .badge { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em;
    border: 1px solid var(--accent); color: var(--accent); border-radius: 999px;
    padding: 0.1rem 0.45rem; margin-right: 0.4rem; }
  .where { color: var(--muted); font-size: 0.78rem; word-break: break-all; }
  .not-terminal { color: var(--muted); font-size: 0.72rem; margin-top: 0.25rem; }
  main { flex: 1; overflow-y: auto; padding: 0.9rem; }
  .turn { margin-bottom: 0.9rem; }
  .turn.user { text-align: right; }
  .bubble { display: inline-block; max-width: 90%; text-align: left;
    padding: 0.5rem 0.7rem; border-radius: 10px; background: var(--card);
    border: 1px solid var(--line); white-space: pre-wrap; word-break: break-word; }
  .turn.user .bubble { background: var(--accent); color: #fff; border-color: transparent; }
  /* A Read result is not a phone screen's worth of content — collapsed. */
  details.tool { margin: 0.4rem 0; border: 1px solid var(--line); border-radius: 8px;
    background: var(--card); }
  details.tool > summary { cursor: pointer; padding: 0.4rem 0.6rem; font-size: 0.82rem;
    font-family: ui-monospace, monospace; }
  details.tool pre { margin: 0; padding: 0 0.6rem 0.5rem; font-size: 0.78rem;
    white-space: pre-wrap; word-break: break-all; }
  details.tool.err { border-color: var(--bad); }
  details.tool.err > summary { color: var(--bad); font-weight: 600; }
  .refusal { border: 1px solid var(--bad); border-left-width: 4px; border-radius: 8px;
    background: var(--card); padding: 0.55rem 0.7rem; margin: 0.5rem 0; font-size: 0.87rem; }
  .refusal b { color: var(--bad); }
  .refusal .why { color: var(--muted); font-size: 0.8rem; margin-top: 0.3rem; }
  .boundary { text-align: center; color: var(--muted); font-size: 0.72rem;
    margin: 0.8rem 0; border-top: 1px solid var(--line); padding-top: 0.4rem; }
  .gap { text-align: center; color: var(--warn); font-size: 0.78rem; margin: 0.6rem 0; }
  footer { border-top: 1px solid var(--line); background: var(--card);
    padding: 0.6rem calc(0.7rem + env(safe-area-inset-left)) calc(0.6rem + env(safe-area-inset-bottom)); }
  form { display: flex; gap: 0.5rem; }
  textarea { flex: 1; resize: none; font: inherit; padding: 0.5rem 0.6rem; border-radius: 8px;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg); min-height: 2.6rem; }
  button { font: inherit; padding: 0.5rem 0.9rem; border-radius: 8px; border: 1px solid var(--line);
    background: var(--accent); color: #fff; font-weight: 600; }
  button.ghost { background: transparent; color: var(--fg); }
  button[disabled] { opacity: 0.5; }
  /* Not connected REPLACES content — it does not sit in a corner while stale
     turns look live. Same rule as the observe view (R12.5). */
  #link { display: none; padding: 1rem; text-align: center; }
  body.offline #link { display: block; }
  body.offline main, body.offline footer { display: none; }
  #link .head { font-weight: 600; color: var(--bad); }
  #link .sub { color: var(--muted); font-size: 0.85rem; margin-top: 0.3rem; }
  /* The send box is ABSENT when it cannot work, never greyed out. */
  #locked { display: none; font-size: 0.85rem; color: var(--muted); }
  body.locked #locked { display: block; }
  body.locked form { display: none; }
</style>
</head>
<body>
<header>
  <div class="kind"><span class="badge">${escapeHtml(kind)}</span><span id="kind-text">${
    kind === "hosted" ? "A session Golem is running" : "A live session Golem has joined"
  }</span></div>
  <div class="where">${escapeHtml(projectDir)} · <span id="sid">${escapeHtml(sessionId)}</span></div>
  <div class="not-terminal">This is not a mirror of the terminal on your laptop — it is a
    separate session Golem runs and supervises.</div>
</header>

<div id="link">
  <div class="head">Not connected</div>
  <div class="sub">Showing nothing rather than the last messages, which would look current and
    would not be. Reconnect to the network Golem is running on.</div>
</div>

<main id="log"></main>

<footer>
  <div id="locked">Locked. Enter your passcode on the machine running Golem
    (<code>golem device unlock</code>) to send again.</div>
  <form id="send">
    <textarea id="text" rows="1" placeholder="Message this session…" autocomplete="off"></textarea>
    <button type="submit" id="go">Send</button>
    <button type="button" class="ghost" id="stop" title="End the current turn">Stop</button>
  </form>
</footer>

<script>
(function () {
  "use strict";
  var SESSION = ${jsonForScript(sessionId)};
  var log = document.getElementById("log");
  var body = document.body;
  var lastSeq = 0;
  var es = null;

  function atBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  }
  function append(node) {
    var stick = atBottom();
    log.appendChild(node);
    if (stick) log.scrollTop = log.scrollHeight;
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function bubble(role, text) {
    var wrap = el("div", "turn " + role);
    wrap.appendChild(el("div", "bubble", text));
    append(wrap);
  }

  var assistantEl = null;
  function assistantText(text) {
    if (assistantEl === null) {
      var wrap = el("div", "turn assistant");
      assistantEl = el("div", "bubble", "");
      wrap.appendChild(assistantEl);
      append(wrap);
    }
    assistantEl.textContent += text;
    if (atBottom()) log.scrollTop = log.scrollHeight;
  }

  function toolCall(ev) {
    var d = el("details", "tool");
    var s = el("summary", null, "→ " + ev.name);
    d.appendChild(s);
    d.appendChild(el("pre", null, JSON.stringify(ev.input, null, 2)));
    d.dataset.toolId = ev.id;
    append(d);
  }

  function toolResult(ev) {
    // A refusal arrives as an errored result. Render it as a REFUSAL rather than
    // as a failure — the user needs to know Golem said no, not that something
    // broke. And never offer a control to override it: gate-map item 3 is locked.
    if (ev.isError && /Refused by the Golem session host/.test(ev.content)) {
      var r = el("div", "refusal");
      r.appendChild(el("b", null, "Refused"));
      r.appendChild(el("div", null, ev.content));
      r.appendChild(el("div", "why",
        "Destructive and outward steps are never answerable from a device. " +
        "If this should happen, run it yourself on the machine."));
      append(r);
      return;
    }
    var d = el("details", "tool" + (ev.isError ? " err" : ""));
    d.appendChild(el("summary", null, (ev.isError ? "⚠ " : "← ") + "result"));
    d.appendChild(el("pre", null, ev.content));
    append(d);
  }

  function handle(ev) {
    if (typeof ev.seq === "number" && ev.seq > lastSeq) lastSeq = ev.seq;
    switch (ev.type) {
      case "attached":
        if (ev.gap) {
          append(el("div", "gap",
            "⚠ Some of this conversation is missing — you were away longer than the " +
            "server keeps. What follows is not continuous."));
        }
        break;
      case "text": assistantText(ev.text); break;
      case "tool_call": assistantEl = null; toolCall(ev); break;
      case "tool_result": toolResult(ev); break;
      case "refused":
        var rr = el("div", "refusal");
        rr.appendChild(el("b", null, "Blocked by Claude Code"));
        rr.appendChild(el("div", null, ev.message));
        append(rr);
        break;
      case "turn_end":
        assistantEl = null;
        append(el("div", "boundary",
          "end of turn" + (typeof ev.costUsd === "number" ? " · $" + ev.costUsd.toFixed(4) : "")));
        break;
      case "parked":
        append(el("div", "gap", "⏸ " + ev.detail));
        break;
      case "ended":
        assistantEl = null;
        append(el("div", "boundary", "session ended — " + ev.reason));
        break;
    }
  }

  function connect() {
    if (es !== null) es.close();
    // EventSource sends Last-Event-ID itself on ITS reconnects; the after= query covers
    // the case where we are reconnecting deliberately.
    es = new EventSource("/session/" + SESSION + "/stream?after=" + lastSeq);
    es.onopen = function () { body.classList.remove("offline"); };
    es.onmessage = function (m) { try { handle(JSON.parse(m.data)); } catch (e) {} };
    ["attached","text","tool_call","tool_result","refused","turn_end","parked","ended"]
      .forEach(function (name) {
        es.addEventListener(name, function (m) {
          try { handle(JSON.parse(m.data)); } catch (e) {}
        });
      });
    es.onerror = function () {
      // Not connected REPLACES the content; it does not decorate stale turns.
      body.classList.add("offline");
    };
  }

  // A client-generated id, so a retry after a dropped connection cannot make the
  // agent act twice. A duplicated instruction is not a duplicated packet.
  function messageId() {
    return (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  }

  document.getElementById("send").addEventListener("submit", function (e) {
    e.preventDefault();
    var box = document.getElementById("text");
    var text = box.value.trim();
    if (text === "") return;
    var go = document.getElementById("go");
    go.disabled = true;
    fetch("/session/" + SESSION + "/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: messageId(), text: text }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
      .then(function (res) {
        if (res.ok) {
          // Only echo the turn once the server said DELIVERED — showing it
          // optimistically is exactly the "a message the user believes they
          // sent" failure this design is built to avoid.
          bubble("user", text);
          box.value = "";
          return;
        }
        if (res.status === 401 && res.j && res.j.claim === "user") {
          // The passcode window lapsed. Remove the box rather than grey it.
          body.classList.add("locked");
          return;
        }
        append(el("div", "refusal", (res.j && res.j.message) || "That was not sent."));
      })
      .catch(function () { body.classList.add("offline"); })
      .finally(function () { go.disabled = false; });
  });

  document.getElementById("stop").addEventListener("click", function () {
    if (!window.confirm(
      "Stopping ends this hosted session, not just the current turn — interrupting a " +
      "running turn is not reliable on every platform, so Golem stops the process instead. " +
      "Continue?"
    )) return;
    fetch("/session/" + SESSION + "/interrupt", { method: "POST" }).catch(function () {});
  });

  // Scrollback from the store, then live.
  fetch("/session/" + SESSION + "/history")
    .then(function (r) { return r.ok ? r.json() : { turns: [] }; })
    .then(function (h) {
      (h.turns || []).forEach(function (t) {
        bubble(t.role === "user" ? "user" : "assistant", t.content);
      });
      if ((h.turns || []).length > 0) append(el("div", "boundary", "— earlier —"));
    })
    .catch(function () {})
    .finally(connect);

  window.addEventListener("online", connect);
  window.addEventListener("offline", function () { body.classList.add("offline"); });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && es !== null && es.readyState === 2) connect();
  });
})();
</script>
</body>
</html>
`;
}
