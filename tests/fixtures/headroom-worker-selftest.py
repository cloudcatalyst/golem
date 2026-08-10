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


@dataclasses.dataclass
class ContentRouterConfig:
    """Stand-in for the ContentRouter's config (R9.8).

    `lossless` is the field that actually suppresses `<<ccr:…>>` markers in the
    real package; `smart_crusher_lossless_only` is here so the test can tell the
    two apart, and `ccr_enabled` stands in for the rest of the surface.
    """

    lossless: bool = False
    smart_crusher_lossless_only: "bool | None" = None
    ccr_enabled: bool = True


class ContentRouter:
    """Stand-in transform. Records the config it was built with."""

    def __init__(self, config=None):
        self.config = config or ContentRouterConfig()


class TransformPipeline:
    """Stand-in pipeline exposing a mutable `transforms` list, like the real one."""

    def __init__(self, config=None, transforms=None, provider=None):
        self.config = config
        self.transforms = list(transforms) if transforms is not None else [ContentRouter()]


def _install_stub() -> None:
    stub = types.ModuleType("headroom")
    stub.CompressConfig = CompressConfig
    stub.__version__ = "0.0.0-stub"
    stub.compress = lambda messages, model=None, config=None: None
    sys.modules["headroom"] = stub

    # R9.8: the router half of the config surface. The real reach point is the
    # ContentRouter TRANSFORM INSTANCE (Headroom's default pipeline builds it
    # with no config), so the stub mirrors that shape: a pipeline holding a
    # replaceable transform, and a `headroom.compress` module with the
    # `_pipeline` singleton the worker swaps.
    transforms_mod = types.ModuleType("headroom.transforms")
    transforms_mod.TransformPipeline = TransformPipeline
    router_mod = types.ModuleType("headroom.transforms.content_router")
    router_mod.ContentRouter = ContentRouter
    router_mod.ContentRouterConfig = ContentRouterConfig
    compress_mod = types.ModuleType("headroom.compress")
    compress_mod._pipeline = None
    sys.modules["headroom.transforms"] = transforms_mod
    sys.modules["headroom.transforms.content_router"] = router_mod
    sys.modules["headroom.compress"] = compress_mod


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

    # --- R9.8: the router namespace ---------------------------------------
    compress_mod = sys.modules["headroom.compress"]

    def installed_router_config():
        """The config on the ContentRouter `headroom.compress()` would actually use."""
        pipeline = compress_mod._pipeline
        if pipeline is None:
            return None
        for transform in pipeline.transforms:
            if type(transform).__name__ == "ContentRouter":
                return transform.config
        return None

    out["router_supported"] = sorted(worker._supported_router_fields())

    # The `lossless_only` alias must land on the field that actually works.
    _, applied7, ignored7 = worker._build_config("stale_turns", {"lossless_only": True})
    out["alias_applied"] = sorted(applied7)
    out["alias_ignored"] = ignored7
    out["alias_router_lossless"] = getattr(installed_router_config(), "lossless", None)

    # The explicit namespace reaches an arbitrary router field, not just the alias.
    worker._build_config("stale_turns", {"router": {"ccr_enabled": False}})
    out["namespace_ccr_enabled"] = getattr(installed_router_config(), "ccr_enabled", None)

    # Golem's DEFAULT is marker-free: a request with no router options at all
    # still gets `lossless`.
    worker._build_config("stale_turns", {})
    out["default_lossless"] = getattr(installed_router_config(), "lossless", None)
    worker._build_config("aggressive", {})
    out["default_lossless_aggressive"] = getattr(installed_router_config(), "lossless", None)

    # ...and it is a default, not a lock: an explicit false wins.
    worker._build_config("stale_turns", {"lossless_only": False})
    out["opt_out_lossless"] = getattr(installed_router_config(), "lossless", None)

    # LEAK GUARD: a later request must NOT inherit the previous one's router —
    # the singleton is process-global.
    worker._build_config("stale_turns", {"router": {"ccr_enabled": False}})
    out["leak_before"] = getattr(installed_router_config(), "ccr_enabled", None)
    worker._build_config("stale_turns", {})
    out["leak_after"] = getattr(installed_router_config(), "ccr_enabled", None)

    # An unknown ROUTER key is reported under its namespace, never forwarded.
    _, applied8, ignored8 = worker._build_config(
        "stale_turns", {"router": {"not_a_router_option": 1}}
    )
    out["router_unknown_ignored"] = ignored8
    out["router_unknown_applied"] = sorted(applied8)

    # A router key and a CompressConfig key in the same bag both land.
    _, applied9, ignored9 = worker._build_config(
        "stale_turns", {"lossless_only": True, "protect_recent": 6, "plugins": ["x"]}
    )
    out["mixed_applied"] = sorted(applied9)
    out["mixed_ignored"] = ignored9

    print(json.dumps(out))


if __name__ == "__main__":
    main()
