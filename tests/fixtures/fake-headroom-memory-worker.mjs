/**
 * Fake Headroom memory worker for HeadroomMemorySidecar tests — speaks the same
 * protocol as headroom-memory-worker.py (GOLEM_HEADROOM_LISTENING line, GET
 * /health, POST /memory/search) without needing Python/uv/headroom[memory].
 * Cross-platform (Node only).
 *
 * Env knobs for negative tests:
 *   FAKE_MODE=badstatus  -> /memory/search returns 500
 *   FAKE_MODE=slowstart  -> never prints the listening line (startup timeout)
 *   FAKE_MODE=unhealthy  -> announces + listens, but /health returns 503
 */
import { createServer } from "node:http";

const portArgIdx = process.argv.indexOf("--port");
const wantPort = portArgIdx >= 0 ? Number(process.argv[portArgIdx + 1]) : 0;
const mode = process.env.FAKE_MODE ?? "ok";

/**
 * Mirrors headroom-memory-worker.py's parent watchdog (R10.3): exit as soon as
 * the parent's stdin pipe reaches EOF, so the worker cannot outlive the process
 * that spawned it even when that process dies without running any handler.
 */
const stdinWatch = process.env.GOLEM_HEADROOM_PARENT_PIPE === "1";
if (stdinWatch) {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
}

if (mode === "slowstart") {
  // Simulate a worker that binds but never announces — exercises startup timeout.
  setTimeout(() => {}, 60_000);
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
        JSON.stringify({ ok: true, headroom: "fake", pid: process.pid, stdin_watch: stdinWatch }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/memory/search") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (mode === "badstatus") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "ValueError: boom" }));
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            results: [
              {
                id: "fact-1",
                content: `fake memory for "${body.query}" in ${body.project_id}`,
                score: 0.87,
                metadata: { source: "fake" },
              },
            ],
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
