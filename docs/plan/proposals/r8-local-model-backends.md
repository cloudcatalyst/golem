# R8 — local model backends: user-chosen models, llama.cpp, and a real agent loop

**Status: proposal (2026-08-01).** Design source for tasks **R8.15, R8.16, R8.17,
R8.18, R8.19**, and the artifact that re-scoped **21e**. Start here.

Prompted by a user question: *should Golem adopt
[little-coder](https://github.com/itayinbarr/little-coder) as a sub-agent harness for
the local code pipeline, and is it a way to support llama.cpp and user-chosen models?*

The short answer that produced the first three tasks: **yes to borrowing its
model-selection design, yes to spawning it as an ext, no to adopting it as a plugin —
and those are separable pieces of work with very different value.**

The conversation then widened twice, and the later tasks come from those turns rather
than from the little-coder question:

1. *"I really want to get to a point where I can operate effectively without needing
   upstream tokens"* → **R8.18** (make llama.cpp present, not merely addressable).
2. *"a proxy able to fan out to any and every local or upstream interface… the coder
   harness an agent or the conversation could use… the thinker, the brain"* →
   **R8.19**, and the decision that unblocked half of **21e**.
3. *"fit for purpose, and fit for hardware… not just for me, but for any developer"* →
   the catalog stopped having a default and grew a selector.

## Where it stands (updated 2026-08-01, after R8.18 landed)

| task | state | one line |
|---|---|---|
| **R8.15** | `running` — code complete, gate unmet | provider table; llama.cpp/LM Studio addressable. §112 |
| **R8.16** | queued, blocked | little-coder as a spawned ext; **ADR-0005 must be ACCEPTED first** |
| **R8.17** | queued — **priority 1** | small-model robustness in Golem's own local path |
| **R8.18** | **shipped** | `golem llamacpp` installs, verifies, runs and wires up. §114 |
| **R8.19** | queued, blocked | the routing fabric; **ADR-0005 must be ACCEPTED first** |
| **R8.20** | **new** | local-only operation, visibly and enforceably (Decision 56 goal 7) |
| **21e** | re-scoped | 21e-a unblocked into R8.19; 21e-b stays out |

**ADR-0005 is now drafted** (`docs/decisions/ADR-0005-model-routing-and-lanes.md`,
status **PROPOSED**, 2026-08-01) and is the single gate on R8.16 and R8.19 — accepting it
is a user act. **Spec Decision 56** records the product reframe those tasks now serve: no
default model, two nameable lanes, llama.cpp first-class, and operating with no upstream a
supported end state.

---

## 1. Where the local path actually is today

| piece | file | state |
|---|---|---|
| transport | `src/inference/ollama-client.ts` | **already generic** — plain `/v1/chat/completions` + `/v1/embeddings` over `inference.ollama_base_url` |
| role→model | `src/inference/catalog.ts` | a **frozen table** of Ollama-namespaced tags (`qwen2.5-coder:7b`) keyed by hardware tier. No user override anywhere. |
| availability | `src/inference/availability.ts` | resolves "pulled?" via Ollama-**native** `/api/tags` |
| bootstrap | `src/inference/ollama-bootstrap.ts`, `ollama-native.ts` | assumes `ollama pull` |
| the `coder` tool | `src/mcp/server.ts:1640`+ | **single-shot**: one `inference.chat("drafter", …)`, optional KB grounding, optional one judge→revise pass, plus R8.7's `edit` mode (one small file, validated, diff) |

Spec §169 already decided the direction — *"Ollama-first behind an OpenAI-compatible
interface … llama.cpp server / LM Studio / vLLM is a drop-in swap via config"* — and the
transport honours it. **The rest of the stack does not.** Point `ollama_base_url` at a
llama.cpp server today and:

- the tier lookup still asks for `qwen2.5-coder:7b`; llama.cpp serves whatever GGUF you
  loaded under whatever id you gave it, so the name is simply wrong;
- `/api/tags` does not exist there (llama.cpp has `/v1/models` and `/props`), so every
  slot reports `unknown` and `availabilityWarning` shouts about an endpoint that is fine;
- every remediation string says `ollama pull <model>`, which cannot help.

So "drop-in via config" is true of the bytes on the wire and false of everything around
them. That is the gap R8.15 closes.

## 2. What little-coder actually is, and where it fits

A coding agent tuned for small local models, Apache-2.0, built on **pi**
(`@earendil-works/pi-coding-agent`) as a plain dependency: pi supplies the agent loop,
provider abstraction, TUI, session tree and compaction; little-coder adds ~30 extensions
and ~30 skill markdown files and launches pi with `--no-extensions` plus exactly its own
bundled set, so the loaded set is the shipped set.

Published results, all on one consumer laptop (i9-14900HX, 32 GB RAM, **8 GB VRAM on an
RTX 5070 Laptop**) with no cloud inference:

| release | model | benchmark | result |
|---|---|---|---|
| v0.0.2 (the paper) | Qwen3.5-9B via Ollama | Aider Polyglot (225) | 45.56% mean of two runs; matched-model vanilla Aider baseline **19.11%** |
| v0.0.5 | Qwen3.6-35B-A3B via llama.cpp | Aider Polyglot | 78.67% |
| v0.1.4 | Qwen3.6-35B-A3B via llama.cpp | Terminal-Bench-Core v0.1.1 (80) | 40.0% |
| v0.1.13 | Qwen3.6-35B-A3B via llama.cpp | Terminal-Bench 2.0 (89×5) | 24.6% ± 3.2 (leaderboard rank 120) |
| v0.1.24 | Qwen3.5-9B Q4_K_M via llama.cpp | Terminal-Bench 2.0 (89×5) | 9.2% ± 2.4 (rank 142) |
| v0.1.27 | Qwen3.6-35B-A3B via llama.cpp | GAIA validation (165) | 40.00% |

The absolute numbers are modest. **The 19% → 45% delta at a fixed model is the claim that
matters** — it is scaffold–model fit, and it is exactly the axis Golem's single-shot
`coder` has never been on.

**Its shape is `ext`, not `plugin`.** ADR-0004's seams are wrong for it: seam C (MCP tool)
is in-process, full-privilege, off by default and taxes every request with its definition
tokens; routing a whole harness through it inverts the trust model for nothing. Decision
53's **ext** — spawned or detected beside Golem, Golem ships none of its bytes — is the
concept that already exists for this, and little-coder clears the four-criterion admission
bar in `src/ext/manifest.ts`:

1. does something Golem should not reimplement — an agent loop tuned for small models; ✔
2. stable, pinnable invocation contract — an npm package plus pi's `--mode rpc`; ✔
3. absence degrades to a no-op — the mode is simply not declared; ✔
4. Golem ships none of its bytes — `npm install -g little-coder`, user-installed. ✔

## 3. The three pieces, ranked

### R8.15 — the provider table (do this first; independent of little-coder)

little-coder's `models.json` is precisely the layer Golem is missing, and it is **data**:
a small, stable shipped provider table (`{api, baseUrl, apiKey-env, models[]}`) covering
`llamacpp` / `ollama` / `lmstudio`, a **user override file** where each top-level provider
key *wholly replaces* the shipped one (deliberately **not** deep-merged, so a future
package release cannot silently inject fields into a user's entry), and `*_BASE_URL` env
beating both.

That maps onto Golem's conventions almost verbatim. `catalog.ts`'s own header already
says it is *"deliberately a plain data table so it is trivial to edit without touching
routing logic"* — it just is not user-editable. The precedent for the settings shape is
`proxy.accounts` and `plugins.entries`: an array leaf of records.

Two details worth copying outright:

- **`/props` for the live context window.** little-coder auto-detects llama.cpp's running
  `n_ctx` at startup and registers the model with it, so whatever `-c` the server was
  launched with is what the client budgets against. Golem currently has no notion of a
  local model's window at all; a hardcoded number would be the dishonest version.
- **Their v1.12.0 cache fix is Golem's §14 lesson.** They had been appending per-turn
  skill/knowledge blocks to the *system prompt*, invalidating the whole cached prefix
  every turn; the fix moves those blocks to the end of the conversation. Same rule Golem
  already enforces on the proxy path — worth stating so nobody re-introduces it locally.

Note this is also what makes the **35B-A3B MoE** setup reachable on this repo's own dev
box: `-ngl 99 --n-cpu-moe 999` puts experts in RAM and attention on the GPU, i.e. a 22 GB
model on 8 GB VRAM. That is a materially better drafter than `qwen2.5-coder:7b` on the
same hardware, and today Golem has no way to name it.

### R8.16 — little-coder as a spawned sub-agent harness

The real capability gap. Golem's `coder` cannot iterate, run a test, read a second file,
or recover from its own malformed output. little-coder can, and has been tuned to do so
with the model class Golem runs.

Shape: **a mode of `coder` (`mode: "agent"`), not a new tool** — R8.6/R8.7 discipline,
because a second tool definition is ~300 tokens on *every* request. Declared only when
enabled *and* the binary resolves, exactly like `local_editor_enabled`.

**This needs an ADR before any code**, on the R8.11 precedent. The new hazard is not
in-process code — it is **egress**. Every ext in the registry today is local-only
(Headroom is a local sidecar, Ollama is local, `typescript-language-server` is local).
little-coder speaks `anthropic/*` and `openai/*` natively; a spawned session pointed at a
cloud model leaves the machine **without ever transiting Golem's proxy or its redaction
stage**. That is the first ext with an egress capability of its own, and "we documented
it" is not the same as "it cannot happen" — the provider set must be Golem-supplied and
local-only, enforced at spawn. It also writes to the user's repo, which pulls in ADR-0002
(autonomy) rather than being a fresh question.

Secondary constraint from their own docs: **sub-coders run serially by default**, because
two of them contend for one local inference server and finish slower than one. Any Golem
fan-out onto local inference inherits that.

pi never becomes a Golem dependency — spawn only, so the ≤5-runtime-dependency ceiling
(R8.10) is untouched.

### R8.17 — small-model robustness in Golem's own local path

Worth lifting even if R8.16 never ships, because they apply to today's single-shot
`coder`:

- **`output-parser`** — repair malformed ` ```tool ` fences, `<tool_call>` blocks and bare
  JSON. Small models emit these constantly; Golem currently just returns the bad draft.
- **`quality-monitor`** — empty / hallucinated / loop detection with a correction
  follow-up. Golem's `refineDraft` is the nearest thing and it only judges *quality*, not
  *degeneracy*.
- **`thinking-budget`** — cap thinking tokens per turn, retry with thinking off. Directly
  relevant to `inference.request_timeout_ms` blowouts (§66).
- **read-before-edit** as an invariant rather than a validation. `coder-edit.ts` validates
  the *result*; the cheaper guard is refusing to edit a file the caller has not read.

## 4. What Golem should NOT take

- **`skill-inject` / `knowledge-inject`.** Keyword scoring over markdown files
  (word=1.0, bigram=2.0, threshold=2.0). Golem's `gatherGrounding` over a real vector KB,
  with exact wiki-title and one-hop-wikilink matching ahead of vector search, is strictly
  better. Adopting theirs would be a regression.
- **Their status line, compaction watchdog and CH% cache tracking.** That is the entire R8
  context-economy workstream. Running two competing context economies is the failure mode,
  not the feature.
- **The TUI.** little-coder is a peer to Claude Code, not to an MCP tool. Golem drives it
  headless or not at all.

## 4a. The two later turns, and what they settled

**Operating without upstream tokens (R8.18).** R8.15 made a llama.cpp server
*addressable*; standing one up still meant picking a release asset, matching a CUDA
runtime, choosing a quant, finding the MoE offload flags and hand-writing a provider
entry. R8.18 closes that. The upstream facts are verified in §113 — release `b10216`,
the separate-and-not-optional cudart bundle, the sha256 digest per asset, and the GGUF
sizes.

Two findings from that work generalise beyond the task:

- **Active parameters, not file size, set the speed.** With `--n-cpu-moe` the experts
  live in RAM and only attention touches VRAM, so a 19 GB MoE at 3B active beats an
  8 GB dense 14B on any machine with the RAM to hold it. Sorting a model catalog by GB
  gets this exactly backwards, which is why `gguf-catalog.ts` does not.
- **A separate coder model does not fit.** `Qwen3-Coder-Next` Q4_K_M is 45.20 GB;
  beside a 19 GB generalist that is 64 GB on a 64 GB machine. The alternatives are all
  trades (IQ2 quality loss; dense `Qwen2.5-Coder-32B` is *slower* than the MoE). The
  catalog makes it a one-line choice and the planner refuses combinations that do not
  fit measured **free** RAM.

**Fit for purpose and hardware (the catalog reframe).** There is no default model. A
64 GB workstation and a 16 GB laptop want different weights for the same request, and
a throwaway classification wants different weights from an hour-long agent run. So
`selectModel` is the entry point, `FLOOR_GGUF_MODEL_ID` is named a floor, and
`undefined` — "no local model is appropriate here" — is a required answer. Two bugs
found on the way (§113): a KV estimate ~1000× too small, and a ranking that handed
defaults to whichever entry was quantised hardest.

**The routing fabric (R8.19).** The user's framing: **the thinker** (the brain a
conversation or agent plans with) and **the coder harness** (the executor) are two
lanes, each independently pointable at any backend — local llama.cpp, LAN Ollama,
Anthropic, OpenRouter, Moonshot — named per request.

This lands on `21e`, blocked since 2026-07-30 on *"a product/ToS decision, not an
implementation"*. The decision is now made, and it splits the task: **every route the
user described is named by the user**, which is `golem account use` scoped to one
request rather than a session — ADR-0003's legitimate column. **21e-a** (explicit,
user-named routing) is unblocked into R8.19; **21e-b** (route-on-exhaustion) stays out
and must remain *absent* rather than built-and-disabled.

The threat that ADR-0005 must actually answer is not credential storage — R6.2 solved
that. It is that **a prompt is attacker-influenceable in a way a config file is not**,
so "name Kimi K3 in a sentence and spend it" needs a structured, auditable surface,
with natural language mapped onto it visibly rather than interpreted silently.

## 5. Open questions

1. Does the provider table subsume the **hardware tier** or sit beside it? Proposed:
   beside — user table first, tier catalog as fallback, so an unconfigured install behaves
   exactly as it does today.
2. Is `Role` still the right abstraction when the user names concrete models? Proposed:
   yes, and it is a frozen contract (`src/interfaces/inference.ts`) — the provider table
   changes *resolution*, not the interface. Callers still never name a model.
3. Does `golem devices` stay Ollama-shaped? No: it becomes per-provider, and the
   `ollama pull …` remediation string only appears for the Ollama provider.
