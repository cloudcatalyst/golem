# Workstream brief — agent-inference (WS-D: Inference & hardware, P1/P2)

Read `CLAUDE.md` first; it binds. Spec: `docs/edge-offload-spec.md` §1 (hardware
profiles), §2.2 (tiers), §3.3, §9 Decision 6.
Live-doc note: models per tier in the spec are **advisory** — re-verify current
best small models at build time and record in `docs/verification-notes.md`.
Work on branch `ws-d`; claim tasks by ID in PR titles (e.g. "D1: ...").

## Mission
Tiered local inference: detect what the machine can run, map model roles
(summarizer/extractor/classifier/drafter/judge) to tier-appropriate Ollama models,
and serve chat + embeddings behind the frozen `InferenceService` interface with
graceful degradation.

## Task list (in order)
- **D1 — Capability detection → tier.** GPU/VRAM/unified-memory detection on all
  3 OSes → `HardwareTier` (P_CPU/P_MIN/P_MID/P_MAX per spec §2.2 thresholds).
  **Open question you own (notes table): Windows GPU detection reliability** —
  nvidia-smi presence vs WMI/PowerShell CIM fallbacks; on macOS, unified memory via
  `sysctl`; on Linux, nvidia-smi/rocm-smi. Never require a GPU: absence = P_CPU,
  not an error. Record findings (dated) in verification-notes.md.
- **D2 — Ollama client.** OpenAI-compatible chat + embeddings over HTTP (native
  fetch; no SDK dependency needed — justify if you add one). Endpoint
  URL-configurable (`OLLAMA_HOST` / settings; lab-box ready per spec Decision 12).
  Model catalog per tier (~4B-class P_MIN, ~8B-class P_MID, ~14B-class P_MAX,
  Q4–Q5; bge-m3-class embeddings; re-verify current best at build time).
  Pull-on-demand UX: detect Ollama, offer install, pull tier-appropriate models on
  first use — never at `golem init` time.
- **D3 — Role routing.** `Role` → concrete model via catalog + detected tier;
  fallback chain: one tier down → Claude Haiku via API (only if user allows in
  settings) → `CapabilityUnavailableError`. Embeddings CPU fallback path for P_CPU
  (small model via Ollama CPU or ONNX-runtime — keep heavyweight deps out of the
  default install; anything big goes in the optional ML add-on).

## Interfaces
- **Provides:** `InferenceService` implementation (`src/interfaces/inference.ts`
  is frozen; register via `describeInferenceServiceContract("OllamaInference", ...)`
  — back the contract run with a fake OpenAI-compatible server so CI needs no GPU
  and no Ollama).
- **Consumes:** `src/config/` (WS-E) for endpoints/catalog overrides;
  `src/telemetry/` for per-role usage metrics.

## Files owned
`src/inference/`, your contract registrations + integration tests.

## Dependencies
D1/D2 can start now (interfaces frozen; no other workstream blocks you). Your
consumers: WS-C (embed/rerank), WS-B (`coder`, `golem_devices`), WS-A
(semantic compression at slider ≥3, P2).

## Definition-of-done slice (P1/P2)
1. `describeInferenceServiceContract` green on all 3 OSes in CI (fake backend) +
   documented manual verification against real Ollama on at least one machine.
2. Tier detection correct on the 3-OS matrix (CI asserts P_CPU on runners; real
   GPU detection verified manually and recorded).
3. Graceful degradation proven: missing Ollama/GPU never crashes a caller.
4. `golem_devices` data source ready for WS-B/WS-E consumption.
