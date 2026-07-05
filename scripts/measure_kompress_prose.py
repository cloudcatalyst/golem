"""Definitive prose ML ceiling: Kompress on the FULL prose corpus, deadline lifted."""
import json,sys,time,os
os.environ.setdefault("PYTHONIOENCODING","utf-8")
from headroom.transforms.kompress_compressor import KompressCompressor, KompressConfig
kc=KompressCompressor(KompressConfig(device="cpu"))
kc.preload()
prose=[]
for line in open(sys.argv[1],encoding="utf-8"):
    line=line.strip()
    if not line: continue
    try: o=json.loads(line)
    except: continue
    if o.get("type") in ("user","assistant") and isinstance(o.get("message"),dict):
        c=o["message"].get("content")
        if isinstance(c,str): prose.append(c)
        elif isinstance(c,list):
            for b in c:
                if isinstance(b,dict) and b.get("type")=="text" and isinstance(b.get("text"),str):
                    prose.append(b["text"])
big="\n\n".join(p for p in prose if len(p)>=200)
print(f"full prose chars: {len(big):,}",flush=True)
t=time.time()
r=kc.compress(big)
print(f"KOMPRESS FULL PROSE: {r.original_tokens} -> {r.compressed_tokens} tok  saved {r.savings_percentage:.1f}%  ({time.time()-t:.0f}s)",flush=True)
