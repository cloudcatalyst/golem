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
import threading
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


# ---------------------------------------------------------------------------
# R9.8 — the ContentRouter namespace.
#
# `CompressConfig` is eight FLAT fields, and `headroom.compress()` forwards
# seven of them to `pipeline.apply()`. Everything that decides whether a
# `<<ccr:…>>` marker is emitted lives on ContentRouterConfig instead, and
# Headroom's default pipeline constructs `ContentRouter()` with NO config
# (`transforms/pipeline.py`), so none of it is reachable through `compress()`
# by any configuration — including, measured against the 0.30.0 pin,
# `HeadroomConfig(smart_crusher=SmartCrusherConfig(lossless_only=True))`,
# which changes nothing. `HEADROOM_LOSSLESS_ONLY` exists but is read only by
# Headroom's own proxy server, which Golem does not run.
#
# The reach point is therefore the transform instance, not a config object:
# swap the default pipeline's ContentRouter for a configured one. We mutate a
# real default pipeline rather than rebuilding the transform list, so a
# Headroom release that adds a transform keeps it — we only replace the one
# transform we are configuring, and report it if we cannot find it.
# ---------------------------------------------------------------------------

#: Namespace key inside `headroom_config` carrying ContentRouterConfig fields.
_ROUTER_NS = "router"

#: Golem-level alias. `lossless_only: true` is the name the option has upstream
#: (`SmartCrusherConfig.lossless_only`) and the one a user reaches for, but the
#: switch that actually works is ContentRouterConfig.lossless — which also turns
#: off CCR marker injection, so the "no markers" promise holds on every path.
_ROUTER_ALIASES = {"lossless_only": "lossless"}


def _router_config_class():
    """`ContentRouterConfig` if this Headroom has one, else None."""
    try:
        from headroom.transforms.content_router import ContentRouterConfig

        return ContentRouterConfig
    except Exception:  # pragma: no cover - older/leaner Headroom
        return None


def _supported_router_fields() -> "frozenset[str]":
    """Field names this Headroom's `ContentRouterConfig` accepts.

    Introspected for the same reason as `_supported_config_fields`: the option
    list is upstream's to grow, not ours to re-type.
    """
    cls = _router_config_class()
    fields = getattr(cls, "__dataclass_fields__", None) if cls is not None else None
    return frozenset(fields.keys()) if isinstance(fields, dict) and fields else frozenset()


def _split_router_overrides(overrides: dict) -> tuple:
    """Split the opaque bag into (compress_overrides, router_overrides).

    Router options arrive either under the `router` namespace or as one of the
    aliases above. Everything else stays on the CompressConfig path untouched,
    so this is additive: a config that worked before behaves identically.
    """
    compress_overrides = {}
    router_overrides = {}
    for key, value in overrides.items():
        if key == _ROUTER_NS:
            if isinstance(value, dict):
                router_overrides.update(value)
            continue
        if key in _ROUTER_ALIASES:
            router_overrides[_ROUTER_ALIASES[key]] = value
            continue
        compress_overrides[key] = value
    return compress_overrides, router_overrides


#: (signature -> pipeline) so a stable config builds its pipeline once, not per request.
_router_pipelines: dict = {}

def _stock_pipeline():
    """Headroom's own default pipeline, built once and reused.

    Restoring this exact instance (rather than clearing the singleton to None)
    keeps the no-router path allocation-free per request, and keeps whatever
    warm state the pipeline holds.
    """
    cached = _router_pipelines.get("")
    if cached is not None:
        return cached
    try:
        from headroom.transforms import TransformPipeline

        cached = TransformPipeline()
    except Exception:  # pragma: no cover - compress() will build its own
        return None
    _router_pipelines[""] = cached
    return cached


def _apply_router(router_applied: dict) -> "tuple[bool, list]":
    """Install a configured-router pipeline, or restore the stock one.

    Called on EVERY request, including those with no router options: the
    singleton `headroom.compress` uses is process-global, so leaving a previous
    request's `lossless` router in place would silently apply it to a later
    request that did not ask for it.
    """
    if not router_applied:
        compress_mod = sys.modules.get("headroom.compress")
        if compress_mod is not None:
            compress_mod._pipeline = _stock_pipeline()
        return False, []
    return _install_router_pipeline(router_applied)


def _install_router_pipeline(router_applied: dict) -> "tuple[bool, list]":
    """Point `headroom.compress()` at a pipeline whose ContentRouter is configured.

    Returns `(installed, problems)`. `problems` are strings for `config_ignored`
    — a router option that cannot be delivered is REPORTED, never silently
    dropped, which is the whole point of the passthrough.

    Failure is never fatal: on any problem the module singleton is left alone
    and `compress()` runs exactly as it does today.
    """
    compress_mod = sys.modules.get("headroom.compress")
    if compress_mod is None:
        return False, [f"{_ROUTER_NS}: headroom.compress module not importable"]
    cls = _router_config_class()
    if cls is None:
        return False, [f"{_ROUTER_NS}: this Headroom has no ContentRouterConfig"]

    signature = json.dumps(router_applied, sort_keys=True, default=str)
    cached = _router_pipelines.get(signature)
    if cached is not None:
        compress_mod._pipeline = cached
        return True, []

    try:
        from headroom.transforms import TransformPipeline
        from headroom.transforms.content_router import ContentRouter

        pipeline = TransformPipeline()
        transforms = getattr(pipeline, "transforms", None)
        if not isinstance(transforms, list):
            return False, [f"{_ROUTER_NS}: this Headroom's pipeline exposes no transform list"]
        replaced = 0
        for index, transform in enumerate(transforms):
            if type(transform).__name__ == "ContentRouter":
                transforms[index] = ContentRouter(cls(**router_applied))
                replaced += 1
        if replaced == 0:
            return False, [f"{_ROUTER_NS}: no ContentRouter in this Headroom's default pipeline"]
    except Exception as exc:
        return False, [f"{_ROUTER_NS}: {type(exc).__name__}: {exc}"]

    _router_pipelines[signature] = pipeline
    compress_mod._pipeline = pipeline
    return True, []


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


# R9.8 — Golem's DEFAULT for the router half: marker-free.
#
# Measured against the 0.30.0 pin on a 400-row tool result: the stock router
# saves 19,181 tokens and emits 37 `<<ccr:…>>` markers; marker-free saves
# 15,740 (82% of the saving) and emits none. Golem's flagship client is a
# coding agent doing exact-match edits, and a marker in a tool result is
# precisely what makes the model's view of a file differ from its bytes on
# disk — so 18% of one stage's saving is the right price for tool output that
# always matches what an `Edit` will be applied to.
#
# A caller's `router`/`lossless_only` override still wins, so this is a
# default, not a lock.
_ROUTER_PRESET = {"lossless": True}


def _router_preset_for(_mode: str) -> dict:
    """Golem's router defaults for a mode. Marker-free everywhere the stage runs."""
    return dict(_ROUTER_PRESET)


def _build_config(mode: str, overrides: dict) -> tuple:
    """Mode preset + caller overrides, filtered to what this Headroom supports.

    Returns `(config, applied, ignored)`. Unknown keys are **reported, not
    passed**: forwarding them would raise inside `CompressConfig` and take the
    whole request down, so they come back in `config_ignored` instead and the
    caller can say so out loud.

    R9.8: router-namespace keys are split off first and delivered by swapping the
    pipeline's ContentRouter (see `_install_router_pipeline`) — they are not
    CompressConfig fields and passing them there would just report them ignored.
    """
    compress_overrides, caller_router = _split_router_overrides(
        overrides if isinstance(overrides, dict) else {}
    )
    # Golem's router default, then the caller's overrides on top — same
    # per-key layering the CompressConfig presets use.
    router_overrides = _router_preset_for(mode)
    router_overrides.update(caller_router)

    supported_router = _supported_router_fields()
    router_applied = {k: v for k, v in router_overrides.items() if k in supported_router}
    router_ignored = [
        f"{_ROUTER_NS}.{k}" for k in sorted(router_overrides) if k not in supported_router
    ]
    # Unconditional: with no router overrides this RESTORES the stock pipeline,
    # so one request's `lossless` cannot leak into the next one's.
    _installed, problems = _apply_router(router_applied)
    router_ignored.extend(problems)
    if router_overrides and not _installed:
        router_applied = {}

    merged = _preset_for(mode)
    merged.update(compress_overrides)

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

    # Router keys are namespaced in both echoes so a reader can tell which half
    # of the config surface a name came from.
    applied = dict(applied)
    applied.update({f"{_ROUTER_NS}.{k}": v for k, v in router_applied.items()})
    ignored = sorted(set(ignored) | set(router_ignored))
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
                    # R9.8: the second half of the config surface — what the
                    # `router` namespace can carry on this install. Empty means
                    # this Headroom has no ContentRouterConfig, so marker-free
                    # mode is genuinely unavailable rather than merely unset.
                    "supported_router_config": sorted(_supported_router_fields()),
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


def _exit_when_parent_closes_stdin() -> None:
    """Exit as soon as the parent's stdin pipe reaches EOF (task R10.3).

    Golem's proxy daemon is stopped with an OS kill. On Windows that is
    `TerminateProcess`: the daemon's shutdown handler does NOT run, so nothing in
    the parent gets the chance to stop this worker, and before this existed these
    processes accumulated for days — 24 of them at one point, still serving,
    still burning CPU, with no parent left to answer to.

    So the worker does not wait to be told. The parent gives it the read end of a
    pipe it never writes to; when the parent dies — cleanly, killed, or crashed —
    the OS closes the write end and this read returns EOF. `os._exit` rather than
    `sys.exit`, because the HTTP server owns the main thread and a normal exit
    from a daemon thread would not stop it.

    Off unless the parent explicitly asks for it, so running this worker by hand
    (stdin a terminal, or /dev/null, which is EOF immediately) still works.
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
    # Unused: it exists so the project this worker belongs to is visible in the
    # process table, letting Golem's start-up sweep reap ITS strays and nobody
    # else's (R10.3).
    ap.add_argument("--golem-project", default=None)
    args = ap.parse_args()
    _exit_when_parent_closes_stdin()
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
