---
title: Local Model Fabric
type: concept
tags: [inference, llamacpp, models, moe, r8, decision-56, adr-0005]
sources: ["docs/golem-spec.md (Decision 56)", "docs/decisions/ADR-0005-model-routing-and-lanes.md", "docs/plan/tasks/R8.18.md", "docs/plan/verification-notes.md (§113, §114)", "src/inference/gguf-catalog.ts", "src/inference/llamacpp-plan.ts", "src/inference/llamacpp-bootstrap.ts", "src/cli/llamacpp.ts"]
created: 2026-08-01
updated: 2026-08-01
---

# Local Model Fabric

How Golem chooses and runs local models after **spec Decision 56** — which retired
"one `coder` tool on one model a hardware tier picked for you".

Three ideas, in the order they matter:

1. **There is no default model.** A 64 GB workstation and a 16 GB laptop want different
   weights for the same request, so selection is a ranking against *this* machine, and
   *"no local model is appropriate here"* is a valid answer.
2. **Active parameters, not file size, set the speed.** This is what makes local work
   competitive at all, and it is counter-intuitive enough to be the most useful fact on
   this page.
3. **Two lanes, not one tool.** The *thinker* a conversation plans with and the *coder
   harness* that executes are separate roles, each pointable at any backend — up to and
   including a machine with no upstream at all. Governed by
   [ADR-0005](../../decisions/ADR-0005-model-routing-and-lanes.md).

## Why a 20 GB model beats an 8 GB one on 8 GB of VRAM

A mixture-of-experts model activates a fraction of its parameters per token. With
`-ngl 99 --n-cpu-moe 999`, llama.cpp offloads every layer to the GPU and then pushes the
**expert tensors back to RAM** — so what actually lives in VRAM is attention plus the KV
cache, which is small.

Qwen3.6-35B-A3B is 35B total and **3B active**. On an 8 GB card with ~24 GB of free RAM
it runs at roughly the cost per token of a 3B model while knowing what a 35B model knows.
A dense 14B — smaller on disk — must stream all 14B per token and is *slower*.

Consequences that fall out of this, and that the code encodes:

- A model catalog **sorted by GB is sorted wrong**. `rankModels` scores on
  quant-discounted capability per active parameter (`src/inference/gguf-catalog.ts`).
- `--n-cpu-moe` on a **dense** model is actively wrong, so `planServer` gates the MoE
  flags on `moe`.
- The KV cache is per *token*, in the tens of KiB — a 128K window is gigabytes. An
  estimate ~1000× too small was a real bug found in §113.

## The commands

```
golem llamacpp models        # the ladder, ranked against THIS machine's free RAM
golem llamacpp setup --model <id> --models-dir <path>
golem llamacpp status        # installed? running? what /props actually reports
golem llamacpp start|stop
```

`setup` fetches the **pinned** upstream llama.cpp release and the weights, verifies the
sha256 that **the publishers themselves report** (GitHub's per-asset `digest`, Hugging
Face's `lfs.oid`), extracts, starts the server detached, reads `/props` back, and writes
the `inference.providers` entry — so what the local coder resolves to is what is actually
loaded, with the window the server actually has. See [[Managed Tools]]: Golem ships none
of those bytes.

## Design rules worth keeping

- **Refuse before downloading.** Fit is checked against **free** RAM (not total) and free
  space on the *target volume*, with the arithmetic shown either way. Loading something
  that swaps is slower than not loading it.
- **Resumable or it does not work.** A 20 GB fetch survives interruption: `.part` file,
  `Range` resume, a **progress sidecar another process can read**, digest verified over
  the assembled file, and a mismatch **deletes** the partial rather than letting the next
  resume inherit corruption.
- **Unproven entries are listed, never recommended.** `proven: false` means reachable by
  name but never returned as a default — the §89/§100 discipline applied to model choice.
- **Believe the server, not the config.** The context window comes from `/props`, and is
  reported as unknown rather than guessed.
- **Absence stays a no-op.** With nothing configured, roles resolve from the Ollama tier
  catalog exactly as before R8.15; if the llama.cpp server is down, `chat()` falls back to
  the tier ladder and `ChatResult.model` reports what actually ran.

## Platform facts that are data, not patterns (§114)

Learned by running it, and cheap to get wrong again:

- Upstream publishes **no Linux CUDA build**. On Linux the GPU path is Vulkan whatever the
  vendor; AMD gets the versioned ROCm tarball; the Linux CPU asset has **no `-cpu-` infix**.
- The Windows CUDA runtime bundle is **separate and not optional**, and must extract into
  the same directory as `llama-server.exe`.
- **`tar` is not one program.** Windows' `System32\tar.exe` is bsdtar (reads zip); plain
  `tar` on a shell with Git on PATH is GNU tar (cannot). And bsdtar reads `-f C:\…` as
  `host:path`, so extraction runs from the archive's own directory with a bare filename.
- A **3-second probe budget is for probes.** Extraction and installs belong on the
  install runner; the wrong runner is invisible until the input is big enough.

## Related

- [[Managed Tools]] — the ships-no-third-party-bytes rule these downloads obey
- [[Configuration Surfaces]] — `inference.providers` and the three `llamacpp_*` keys
- [[Dogfooding Golem]] — how this repo runs the thing it builds
- [[Slider Levels]] — the compression dial, which never engages a model (Decision 31)
