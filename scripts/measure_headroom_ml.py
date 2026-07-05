"""ML-ceiling measurement: full headroom.compress() with Kompress enabled (model
cached), deadline lifted, on the real transcript. Reports total-request savings."""
import json,sys,time,os,headroom
from collections import Counter
msgs=[]
for line in open(sys.argv[1],encoding="utf-8"):
    line=line.strip()
    if not line: continue
    try: o=json.loads(line)
    except: continue
    if o.get("type") in ("user","assistant") and isinstance(o.get("message"),dict):
        m=o["message"]
        if "role" in m and "content" in m: msgs.append({"role":m["role"],"content":m["content"]})
print(f"messages: {len(msgs)}  (deadline={os.environ.get('HEADROOM_COMPRESSION_TIMEOUT_SECONDS','default')})")
MODEL="claude-sonnet-4-5-20250929"
def run(label,**cfg):
    t=time.time()
    r=headroom.compress(list(msgs),model=MODEL,config=headroom.CompressConfig(**cfg))
    kinds=Counter(t.split(":")[0] for t in (r.transforms_applied or []))
    print(f"{label:40} {r.tokens_before}->{r.tokens_after} saved={r.tokens_saved} ({r.tokens_saved/r.tokens_before*100:5.2f}%) {time.time()-t:6.1f}s {dict(kinds)}",flush=True)
run("heuristic only")
run("kompress+user+t0.5", kompress_model="chopratejas/kompress-v2-base", compress_user_messages=True, target_ratio=0.5)
run("kompress+user+t0.2 protect1", kompress_model="chopratejas/kompress-v2-base", compress_user_messages=True, target_ratio=0.2, protect_recent=1)
