"""Exercise headroom-worker.py's config passthrough against a STUB headroom.

Decision 53. The worker's whole job is to forward config it does not know about,
which means the interesting logic is Python and would otherwise be untested — the
TS suite deliberately uses a Node fake worker so CI needs no Python at all.

This script injects a fake `headroom` module (a validating `CompressConfig`),
imports the real worker by path, drives `_supported_config_fields` and
`_build_config`, and prints the results as JSON for the vitest wrapper to assert.
Run: python headroom-worker-selftest.py <path-to-headroom-worker.py>
"""

import dataclasses
import importlib.util
import json
import pathlib
import sys
import types


@dataclasses.dataclass
class CompressConfig:
    """Stand-in for Headroom's real config, including a validating field.

    `protect_recent` rejects non-ints so the worker's "supported name, bad value"
    fallback is exercised — a plain dataclass would accept anything.
    """

    protect_recent: int = 4
    compress_user_messages: bool = False
    kompress_model: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.protect_recent, int) or isinstance(self.protect_recent, bool):
            raise TypeError("protect_recent must be an int")


def _install_stub() -> None:
    stub = types.ModuleType("headroom")
    stub.CompressConfig = CompressConfig
    stub.__version__ = "0.0.0-stub"
    stub.compress = lambda messages, model=None, config=None: None
    sys.modules["headroom"] = stub


def _load_worker(path: pathlib.Path):
    spec = importlib.util.spec_from_file_location("golem_headroom_worker_under_test", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> None:
    _install_stub()
    worker = _load_worker(pathlib.Path(sys.argv[1]))

    out: dict = {}
    out["supported"] = sorted(worker._supported_config_fields())

    # An unknown-to-Golem key that the install DOES accept is forwarded; a key it
    # does not accept is reported, not passed.
    cfg, applied, ignored = worker._build_config(
        "stale_turns", {"kompress_model": "m", "not_a_real_option": 1}
    )
    out["applied"] = sorted(applied)
    out["ignored"] = ignored
    out["kompress_model"] = cfg.kompress_model
    out["preset_protect_recent"] = cfg.protect_recent

    # An override beats the mode preset for that one key.
    cfg2, _, _ = worker._build_config("stale_turns", {"protect_recent": 1})
    out["override_protect_recent"] = cfg2.protect_recent

    # Mode presets still apply when no override is given.
    cfg3, _, _ = worker._build_config("aggressive", {})
    out["aggressive_protect_recent"] = cfg3.protect_recent
    out["aggressive_compress_user_messages"] = cfg3.compress_user_messages

    # An unknown mode falls back to the safe preset rather than raising.
    cfg4, _, _ = worker._build_config("no-such-mode", {})
    out["unknown_mode_protect_recent"] = cfg4.protect_recent

    # A supported NAME with an unusable VALUE degrades to the preset and reports.
    cfg5, applied5, ignored5 = worker._build_config("stale_turns", {"protect_recent": "nope"})
    out["bad_value_protect_recent"] = cfg5.protect_recent
    out["bad_value_reported"] = len(ignored5) > 0
    out["bad_value_applied"] = sorted(applied5)

    # A non-dict `config` is tolerated (the HTTP surface is untrusted input).
    cfg6, _, ignored6 = worker._build_config("stale_turns", "not-a-dict")
    out["non_dict_protect_recent"] = cfg6.protect_recent
    out["non_dict_ignored"] = ignored6

    print(json.dumps(out))


if __name__ == "__main__":
    main()
