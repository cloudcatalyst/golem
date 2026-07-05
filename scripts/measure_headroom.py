"""Decision-23 gate: measure Headroom's real savings on a real Claude Code
transcript, offline (no LLM call, no cost). Reconstructs the final-request
message history (same view as verification-notes §32) and runs headroom.compress
at several settings, reporting token deltas from Headroom's own tokenizer."""

import json
import sys

import headroom

TRANSCRIPT = sys.argv[1]

msgs = []
with open(TRANSCRIPT, encoding="utf-8") as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("type") in ("user", "assistant") and isinstance(o.get("message"), dict):
            m = o["message"]
            if "role" in m and "content" in m:
                msgs.append({"role": m["role"], "content": m["content"]})

print(f"reconstructed {len(msgs)} messages")
MODEL = "claude-sonnet-4-5-20250929"

# Inspect what a result actually carries (messages? transforms?).
r0 = headroom.compress(list(msgs), model=MODEL)
print("CompressResult attrs:", [a for a in dir(r0) if not a.startswith("_")])
for extra in ("messages", "transforms_applied", "compressed", "ccr_hashes", "waste_signals"):
    if hasattr(r0, extra):
        v = getattr(r0, extra)
        if extra == "messages":
            print(f"  has .messages: {len(v) if v is not None else None} items")
        else:
            print(f"  .{extra} = {str(v)[:200]}")


def run(label, use_kwargs=False, **cfg):
    try:
        if use_kwargs:
            res = headroom.compress(list(msgs), model=MODEL, **cfg)
        else:
            res = headroom.compress(list(msgs), model=MODEL, config=headroom.CompressConfig(**cfg))
        print(
            f"{label:44} before={res.tokens_before:>8} after={res.tokens_after:>8} "
            f"saved={res.tokens_saved:>8} ({res.tokens_saved / res.tokens_before * 100:5.2f}%)"
        )
    except Exception as e:
        print(f"{label:44} ERROR {type(e).__name__}: {e}")


run("default")
run("kwargs compress_user_messages=True", use_kwargs=True, compress_user_messages=True)
run("kwargs target_ratio=0.5", use_kwargs=True, compress_user_messages=True, target_ratio=0.5)
for prof in ("conservative", "balanced", "aggressive", "max"):
    run(f"savings_profile={prof}", savings_profile=prof)
