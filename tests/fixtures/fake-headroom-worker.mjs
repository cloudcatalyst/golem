/**
 * Fake Headroom worker for HeadroomSidecar tests — speaks the same protocol as
 * headroom-worker.py (GOLEM_HEADROOM_LISTENING line, GET /health, POST /compress)
 * without needing Python/uv/headroom. Cross-platform (Node only).
 *
 * Env knobs for negative tests:
 *   FAKE_MODE=badstatus  -> /compress returns 500
 *   FAKE_MODE=slowstart  -> never prints the listening line (startup timeout)
 *   FAKE_MODE=unhealthy  -> announces + listens, but /health returns 503
 *
 * Decision 53: mirrors the real worker's opaque `config` passthrough — a fixed
 * "supported" field set, with unknown keys reported in `config_ignored` rather
 * than forwarded.
 */
import { createServer } from "node:http";

/** Stand-in for the introspected `CompressConfig` fields of a real install. */
const SUPPORTED_CONFIG = ["compress_user_messages", "protect_recent", "kompress_model"];

const portArgIdx = process.argv.indexOf("--port");
const wantPort = portArgIdx >= 0 ? Number(process.argv[portArgIdx + 1]) : 0;
const mode = process.env.FAKE_MODE ?? "ok";

if (mode === "slowstart") {
  // Simulate a worker that binds but never announces — exercises startup timeout.
  setTimeout(() => {}, 60_000);
} else if (mode === "die_after_healthy") {
  // Start healthy, then exit after a brief delay — tests respawn backoff (R8.30).
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ ok: true, headroom: "fake", pid: process.pid, supported_config: [] }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/compress") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const out = messages.slice(1);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            messages: out,
            tokens_before: 1000,
            tokens_after: 900,
            tokens_saved: 100,
            transforms_applied: [],
          }),
        );
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(wantPort, "127.0.0.1", () => {
    process.stdout.write(`GOLEM_HEADROOM_LISTENING ${server.address().port}\n`);
  });
  // Die after 300ms — the worker was healthy, then crashed.
  setTimeout(() => process.exit(1), 300);
} else {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      if (mode === "unhealthy") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          headroom: "fake",
          pid: process.pid,
          supported_config: [...SUPPORTED_CONFIG].sort(),
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/compress") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (mode === "badstatus") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "ValueError: boom" }));
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const messages = Array.isArray(body.messages) ? body.messages : [];
        // Drop the first message to simulate a real elision; report fake tokens.
        const out = messages.slice(1);
        // Decision 53 passthrough, same semantics as the Python worker: split the
        // caller's opaque bag into what this "install" accepts and what it does not.
        const received = body.config && typeof body.config === "object" ? body.config : {};
        const applied = Object.keys(received).filter((k) => SUPPORTED_CONFIG.includes(k));
        const ignored = Object.keys(received).filter((k) => !SUPPORTED_CONFIG.includes(k));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            messages: out,
            tokens_before: 1000,
            tokens_after: 900,
            tokens_saved: 100,
            transforms_applied: ["read_lifecycle:stale:/x", "router:excluded:tool"],
            config_applied: applied.sort(),
            config_ignored: ignored.sort(),
          }),
        );
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(wantPort, "127.0.0.1", () => {
    process.stdout.write(`GOLEM_HEADROOM_LISTENING ${server.address().port}\n`);
  });
}
