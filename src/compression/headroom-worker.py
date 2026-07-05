"""Golem ↔ Headroom sidecar worker (task T-C-headroom, spec Decision 18/23).

A tiny, dependency-light HTTP server that keeps Headroom's compression pipeline
warm in a Python process and exposes one operation to the TS proxy:

    POST /compress  {messages, model?, mode?}  ->  {messages, tokens_before,
                     tokens_after, tokens_saved, transforms_applied}
    GET  /health                               ->  {ok, headroom, pid}

It calls `headroom.compress()` IN-PROCESS (no proxy, no LLM, no cost) and returns
the compressed messages. Golem keeps ownership of redaction (already done before
this runs) and of the actual forward to Anthropic — Headroom is a *compression
service* here, never a competing proxy (verification-notes §34).

Heuristic-only by design (§35): the default install is bare `headroom-ai` (no
torch / no `[ml]`), so the ML/Kompress stage is absent and `read_lifecycle` +
structural compression do the work. `mode` maps the Golem slider's
`semanticCompression` setting onto Headroom's CompressConfig.

Only Python stdlib + `headroom` are imported, so the sidecar stays light.
"""

import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import headroom
except Exception as exc:  # pragma: no cover - exercised via the adapter's fail-open path
    sys.stderr.write(
        "golem-headroom-worker: `headroom` is not importable in this environment "
        f"({type(exc).__name__}: {exc}). Install it (e.g. `pip install headroom-ai`) "
        "or run the worker under `uv run --with headroom-ai`.\n"
    )
    sys.exit(3)

DEFAULT_MODEL = "claude-sonnet-4-5-20250929"


def _config_for_mode(mode: str) -> "headroom.CompressConfig":
    """Map Golem's slider `semanticCompression` onto a heuristic CompressConfig.

    No `kompress_model` is ever set — the ML stage is opt-in and out of scope for
    the default sidecar (§35). `read_lifecycle` (stale re-read elision) runs at
    every mode; higher modes also let user-message text be structurally compressed
    and protect fewer recent turns.
    """
    if mode == "aggressive":
        return headroom.CompressConfig(compress_user_messages=True, protect_recent=1)
    if mode == "low_relevance":
        return headroom.CompressConfig(compress_user_messages=True, protect_recent=2)
    # "stale_turns" (level 3) and anything else: safe defaults — system-side text
    # + read_lifecycle + structural; user content untouched.
    return headroom.CompressConfig(protect_recent=4)


def _compress(payload: dict) -> dict:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        raise ValueError("`messages` must be a list")
    model = payload.get("model") or DEFAULT_MODEL
    mode = payload.get("mode") or "stale_turns"
    result = headroom.compress(messages, model=model, config=_config_for_mode(mode))
    return {
        "messages": result.messages,
        "tokens_before": result.tokens_before,
        "tokens_after": result.tokens_after,
        "tokens_saved": result.tokens_saved,
        "transforms_applied": list(result.transforms_applied or []),
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
        if self.path != "/compress":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length > 0 else b""
            payload = json.loads(raw.decode("utf-8")) if raw else {}
            self._send(200, _compress(payload))
        except Exception as exc:  # fail-safe: report, let the TS side skip the stage
            self._send(500, {"error": f"{type(exc).__name__}: {exc}"})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
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
