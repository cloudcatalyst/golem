/**
 * Fake Headroom worker for HeadroomSidecar tests — speaks the same protocol as
 * headroom-worker.py (GOLEM_HEADROOM_LISTENING line, GET /health, POST /compress)
 * without needing Python/uv/headroom. Cross-platform (Node only).
 *
 * Env knobs for negative tests:
 *   FAKE_MODE=badstatus  -> /compress returns 500
 *   FAKE_MODE=slowstart  -> never prints the listening line (startup timeout)
 */
import { createServer } from "node:http";

const portArgIdx = process.argv.indexOf("--port");
const wantPort = portArgIdx >= 0 ? Number(process.argv[portArgIdx + 1]) : 0;
const mode = process.env.FAKE_MODE ?? "ok";

if (mode === "slowstart") {
  // Simulate a worker that binds but never announces — exercises startup timeout.
  setTimeout(() => {}, 60_000);
} else {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, headroom: "fake", pid: process.pid }));
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
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            messages: out,
            tokens_before: 1000,
            tokens_after: 900,
            tokens_saved: 100,
            transforms_applied: ["read_lifecycle:stale:/x", "router:excluded:tool"],
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
