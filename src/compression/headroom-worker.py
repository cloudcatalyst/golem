"""Golem ↔ Headroom sidecar worker (task T-C-headroom, spec Decision 18/23).

A tiny, dependency-light HTTP server that keeps Headroom's compression pipeline
warm in a Python process and exposes one operation to the TS proxy:

    POST /compress  {messages, model?, mode?, config?}
                    ->  {messages, tokens_before, tokens_after, tokens_saved,
                         transforms_applied, config_applied, config_ignored}
    GET  /health    ->  {ok, headroom, pid, supported_config}

`config` is an **opaque passthrough** (Decision 53): whatever keys Headroom's
`CompressConfig` accepts in the installed version are forwarded, so an upstream
release that adds a knob is reachable from Golem's settings with no change to
this file. Unsupported keys are reported back in `config_ignored`, never passed —
forwarding them would raise and cost the whole request.

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


def _supported_config_fields() -> "frozenset[str]":
    """Field names `headroom.CompressConfig` accepts in THIS installed version.

    Introspected rather than hardcoded (Decision 53): the version pin is not the
    coupling point — *this script* is. A hand-written option list is what made
    every new upstream knob unreachable until someone edited this file. Reading
    the real signature means a Headroom release that adds a config field becomes
    usable from Golem's settings with no change here.

    Dataclass fields first, then `__init__`'s signature, then an empty set — which
    means "pass nothing through", never a crash.
    """
    cfg = getattr(headroom, "CompressConfig", None)
    if cfg is None:
        return frozenset()
    fields = getattr(cfg, "__dataclass_fields__", None)
    if isinstance(fields, dict) and fields:
        return frozenset(fields.keys())
    try:
        import inspect

        params = inspect.signature(cfg).parameters
        return frozenset(
            n for n, p in params.items() if n != "self" and p.kind is not p.VAR_KEYWORD
        )
    except Exception:  # pragma: no cover - introspection failing is not fatal
        return frozenset()


# Mode presets: Golem's opinion about the slider, as plain dicts so a caller's
# `config` can override an individual key instead of replacing the whole object.
#
# No `kompress_model` is set by default — the ML stage is opt-in and out of scope
# for the bare sidecar (§35) — but a caller may now set it explicitly, which was
# previously impossible without editing this file.
_MODE_PRESETS = {
    "aggressive": {"compress_user_messages": True, "protect_recent": 1},
    "low_relevance": {"compress_user_messages": True, "protect_recent": 2},
    # "stale_turns" (level 3) and anything else: safe defaults — system-side text
    # + read_lifecycle + structural; user content untouched.
    "stale_turns": {"protect_recent": 4},
}


def _preset_for(mode: str) -> dict:
    return dict(_MODE_PRESETS.get(mode, _MODE_PRESETS["stale_turns"]))


def _build_config(mode: str, overrides: dict) -> tuple:
    """Mode preset + caller overrides, filtered to what this Headroom supports.

    Returns `(config, applied, ignored)`. Unknown keys are **reported, not
    passed**: forwarding them would raise inside `CompressConfig` and take the
    whole request down, so they come back in `config_ignored` instead and the
    caller can say so out loud.
    """
    merged = _preset_for(mode)
    if isinstance(overrides, dict):
        merged.update(overrides)

    supported = _supported_config_fields()
    applied = {k: v for k, v in merged.items() if k in supported}
    ignored = sorted(k for k in merged if k not in supported)

    try:
        config = headroom.CompressConfig(**applied)
    except Exception as exc:
        # A supported *name* carrying an unsupported *value* (wrong type, bad
        # enum). Degrade to the mode preset alone so a bad override costs the
        # override, not the stage.
        safe = {k: v for k, v in _preset_for(mode).items() if k in supported}
        config = headroom.CompressConfig(**safe)
        applied = safe
        ignored = sorted(set(ignored) | {f"{type(exc).__name__}: {exc}"})
    return config, applied, ignored


def _compress(payload: dict) -> dict:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        raise ValueError("`messages` must be a list")
    model = payload.get("model") or DEFAULT_MODEL
    mode = payload.get("mode") or "stale_turns"
    config, applied, ignored = _build_config(mode, payload.get("config") or {})
    result = headroom.compress(messages, model=model, config=config)
    return {
        "messages": result.messages,
        "tokens_before": result.tokens_before,
        "tokens_after": result.tokens_after,
        "tokens_saved": result.tokens_saved,
        "transforms_applied": list(result.transforms_applied or []),
        # Honest echo of what the passthrough did with the caller's options.
        "config_applied": sorted(applied.keys()),
        "config_ignored": ignored,
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
                {
                    "ok": True,
                    "headroom": getattr(headroom, "__version__", "unknown"),
                    "pid": os.getpid(),
                    # The version gate: what THIS install can actually be told to
                    # do, so the TS side can report capability instead of guessing
                    # from a pin number (Decision 53).
                    "supported_config": sorted(_supported_config_fields()),
                },
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
