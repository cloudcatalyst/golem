"""Golem ↔ Headroom memory sidecar worker (R3.6, spec Decisions 13/18).

Same shape as headroom-worker.py, but exposes Headroom's conversational memory
store instead of compression:

    POST /memory/search {query, project_id, top_k?} -> {results: [{id, content,
                         score, metadata}]}
    GET  /health                                     -> {ok, headroom, pid}

Golem never writes memories here — MEMORY-scope federation is search-only per
the frozen `FederatedSearch` contract (src/interfaces/knowledge.ts) — so an
empty/never-populated store degrades to an empty result list, never an error.
Golem's `projectId` is passed through as Headroom's required `user_id` scoping
field: one memory namespace per Golem project.

The `[memory]` extra pulls sentence-transformers (and, transitively, torch) —
heavyweight (verification-notes §4) — so this worker is launched ONLY behind
its own opt-in setting (`knowledge.memory_federation_enabled`), separate from
the base compression sidecar's bare `headroom-ai` install.

Only Python stdlib + `headroom` are imported, so the sidecar stays light aside
from the (opt-in) `[memory]` extra itself.
"""

import argparse
import asyncio
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import headroom
    from headroom.memory import Memory
except Exception as exc:  # pragma: no cover - exercised via the adapter's fail-open path
    sys.stderr.write(
        "golem-headroom-memory-worker: `headroom.memory` is not importable in this "
        f"environment ({type(exc).__name__}: {exc}). Install the memory extra (e.g. "
        "`pip install headroom-ai[memory]`) or run the worker under "
        "`uv run --with headroom-ai[memory]`.\n"
    )
    sys.exit(3)


def _search(payload: dict, db_path: str | None) -> dict:
    query = payload.get("query")
    if not isinstance(query, str) or not query:
        raise ValueError("`query` must be a non-empty string")
    project_id = payload.get("project_id")
    if not isinstance(project_id, str) or not project_id:
        raise ValueError("`project_id` must be a non-empty string")
    top_k = payload.get("top_k") or 10

    # A fresh instance per request — never memoized across requests — so a
    # sqlite/HNSW connection is never reused across asyncio.run()'s separate
    # event loops.
    memory = Memory(backend="local", db_path=db_path)
    results = asyncio.run(memory.search(query, user_id=project_id, top_k=top_k))
    return {
        "results": [
            {
                "id": r.id,
                "content": r.content,
                "score": r.score,
                "metadata": {str(k): str(v) for k, v in (r.metadata or {}).items()},
            }
            for r in results
        ]
    }


class Handler(BaseHTTPRequestHandler):
    # Silence the default stderr access log (keeps the proxy's stderr clean).
    def log_message(self, *_args):  # noqa: D401
        return

    def _send(self, status: int, obj: dict) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(
                200,
                {"ok": True, "headroom": getattr(headroom, "__version__", "unknown"), "pid": os.getpid()},
            )
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/memory/search":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length > 0 else b""
            payload = json.loads(raw.decode("utf-8")) if raw else {}
            self._send(200, _search(payload, self.server.db_path))  # type: ignore[attr-defined]
        except Exception as exc:  # fail-safe: report, let the TS side skip the stage
            self._send(500, {"error": f"{type(exc).__name__}: {exc}"})


def _exit_when_parent_closes_stdin() -> None:
    """Exit as soon as the parent's stdin pipe reaches EOF (task R10.3).

    Identical contract to headroom-worker.py's watchdog — see that file for why
    a worker cannot rely on being told to stop: an OS kill of the parent (on
    Windows, `TerminateProcess`) runs no shutdown handler there, and this sidecar
    was never stopped on ANY platform, so it outlived every proxy that spawned
    it. The pipe's EOF is the one signal that survives every way a parent can
    die. Off unless the parent sets the env var, so a hand-run worker (stdin a
    terminal, or /dev/null) does not exit immediately.
    """
    if os.environ.get("GOLEM_HEADROOM_PARENT_PIPE") != "1" or sys.stdin is None:
        return

    def _watch() -> None:
        try:
            while sys.stdin.buffer.read(1):
                pass
        except Exception:  # pragma: no cover - a broken stdin means the parent is gone too
            pass
        os._exit(0)

    threading.Thread(target=_watch, name="golem-parent-watchdog", daemon=True).start()

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--db-path", default=None)
    # Unused: makes the owning project visible in the process table for the
    # start-up orphan sweep (R10.3).
    ap.add_argument("--golem-project", default=None)
    args = ap.parse_args()
    _exit_when_parent_closes_stdin()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.db_path = args.db_path  # type: ignore[attr-defined]
    # Announce the bound port on stdout so the parent (which may have passed 0)
    # can discover it, then serve.
    sys.stdout.write(f"GOLEM_HEADROOM_LISTENING {server.server_address[1]}\n")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:  # pragma: no cover
        pass


if __name__ == "__main__":
    main()
