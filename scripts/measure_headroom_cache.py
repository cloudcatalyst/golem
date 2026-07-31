"""Decision-23 NET gate (the question verification-notes §34 conclusion 3 left
open): Headroom's gross input-token saving is real, but on an Anthropic-style
CACHING upstream a rewrite that changes an EARLY message invalidates the cached
prefix from that point on, re-billing the whole suffix at 1.0x (and 1.25x to
re-write the cache) instead of 0.1x. This measures where compression first
diverges from the original history and prices both arms.

Offline: no LLM call, no cost. Usage: measure_headroom_cache.py <transcript.jsonl>
"""

import json
import sys

import headroom

# Anthropic cache multipliers relative to base input price.
CACHE_READ = 0.1
FRESH_INPUT = 1.0
CACHE_WRITE = 1.25

MODEL = "claude-sonnet-4-5-20250929"

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

if not msgs:
    print("no messages reconstructed")
    sys.exit(1)


def as_text(content):
    """Flatten a message content (str or list of blocks) to countable text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, str):
                parts.append(b)
            elif isinstance(b, dict):
                # text blocks, tool_use input, tool_result content — count them all
                for k in ("text", "thinking"):
                    if isinstance(b.get(k), str):
                        parts.append(b[k])
                for k in ("input", "content"):
                    if k in b and not isinstance(b.get(k), str):
                        parts.append(json.dumps(b[k], ensure_ascii=False))
                    elif isinstance(b.get(k), str):
                        parts.append(b[k])
        return "\n".join(parts)
    return json.dumps(content, ensure_ascii=False)


def ntok(content):
    text = as_text(content)
    try:
        return headroom.count_tokens_text(text)
    except Exception:
        return len(text) // 4


def total(seq):
    return sum(ntok(m.get("content")) for m in seq)


res = headroom.compress(list(msgs), model=MODEL)
comp = list(res.messages)

# First index at which the compressed history stops matching the original. Anything
# from here on is a changed prefix for the cache's purposes.
div = None
for i in range(min(len(msgs), len(comp))):
    if json.dumps(msgs[i], sort_keys=True, ensure_ascii=False) != json.dumps(
        comp[i], sort_keys=True, ensure_ascii=False
    ):
        div = i
        break
if div is None:
    div = min(len(msgs), len(comp)) if len(msgs) != len(comp) else len(msgs)

orig_total = total(msgs)
prefix_tok = total(msgs[:div])
orig_suffix = orig_total - prefix_tok
comp_suffix = total(comp[div:])

# Arm A: no compression, warm cache — the whole history reads from cache.
cost_a = CACHE_READ * orig_total
# Arm B: compressed — prefix still hits; the changed suffix is fresh input and must
# be written back to the cache for the next turn.
cost_b = CACHE_READ * prefix_tok + CACHE_WRITE * comp_suffix
# Arm C: the no-cache world (non-caching upstream), for contrast.
cost_c_before = FRESH_INPUT * orig_total
cost_c_after = FRESH_INPUT * (prefix_tok + comp_suffix)


def pct(n, d):
    return f"{(n / d * 100):.2f}%" if d else "n/a"


print(f"transcript          {TRANSCRIPT}")
print(f"messages            {len(msgs):,} original / {len(comp):,} compressed")
print(f"headroom tokens     before={res.tokens_before:,} after={res.tokens_after:,} "
      f"saved={res.tokens_saved:,} ({pct(res.tokens_saved, res.tokens_before)} gross)")
print(f"transforms          {len(res.transforms_applied)} applied")
print()
print(f"first divergence    message {div:,} of {len(msgs):,} "
      f"({pct(div, len(msgs))} of the way in)")
print(f"untouched prefix    {prefix_tok:,} tok ({pct(prefix_tok, orig_total)} of history) "
      f"-- still cache-readable")
print(f"changed suffix      {orig_suffix:,} tok -> {comp_suffix:,} tok "
      f"({pct(orig_suffix - comp_suffix, orig_suffix)} smaller) -- must be re-billed")
print()
print("CACHING upstream (this project bills a 98.4% hit rate, §93):")
print(f"  A no compression  {cost_a:15,.0f} cost-units  (0.1x on {orig_total:,} cached tok)")
print(f"  B compressed      {cost_b:15,.0f} cost-units  "
      f"(0.1x on {prefix_tok:,} + 1.25x on {comp_suffix:,})")
ratio = (cost_b / cost_a) if cost_a else float("inf")
verdict = "NET WIN" if cost_b < cost_a else "NET LOSS"
print(f"  => {verdict}: B costs {ratio:.2f}x A "
      f"({'saves' if cost_b < cost_a else 'costs an extra'} "
      f"{abs(cost_a - cost_b):,.0f} units)")
print()
print("NON-CACHING upstream (Decision 23's stated case):")
print(f"  before {cost_c_before:,.0f} -> after {cost_c_after:,.0f} cost-units "
      f"({pct(cost_c_before - cost_c_after, cost_c_before)} saved) => NET WIN")
