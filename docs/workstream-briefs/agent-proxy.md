# Workstream brief — agent-proxy (WS-A: Proxy, pipeline & compression, P0 core)

Read `CLAUDE.md` first; it binds. Spec: `docs/edge-offload-spec.md` §2.1, §3.2, §4, Decisions 16–18.
Live-doc facts you must honor: `docs/verification-notes.md` §12, §14, §15, §16.
Work on branch `ws-a` (own worktree); claim tasks by ID in PR titles (e.g. "A1: ...").

## Mission
The EOL proxy (TypeScript, Node ≥22): Claude Code sets `ANTHROPIC_BASE_URL` at us; we run
`redaction → compress (EOL-native lossless stage) → forward to api.anthropic.com`
and stream the response back untouched. This is the only component that sees every
request — byte fidelity is the product.

**Architecture note (Decision 18):** there is no embeddable Headroom library in TS.
You BUILD the lossless compression stage natively (it's the non-ML subset: dedup,
structural/JSON compaction, cache-prefix alignment, CCR store). The optional Headroom
Python sidecar for ML-heavy stages is P2 — not your P0 scope.

## Task list (in order)
- **A1 — Anthropic-compatible proxy (start here).** HTTP server (Fastify or
  node:http — your call, justify in the PR): `POST /v1/messages` (+ token-counting
  endpoint), transparent passthrough including **SSE streaming and tool-use blocks
  byte-faithful**. Build the recorded-shape integration suite in `tests/integration/`
  first (replace `placeholder.test.ts`): fixtures covering every event in
  verification-notes §15 (`message_start`, `content_block_delta` subtypes incl.
  `input_json_delta`, `thinking_delta`, `signature_delta`, `server_tool_use`,
  `web_search_tool_result`, `tool_reference`, `ping`, `error`). Rules: never
  buffer/merge/reorder events; never parse `partial_json`; pass `cache_control`
  markers through untouched and never inject them; forward `tool_reference` blocks
  correctly (tool search behind a gateway depends on it — notes §12).
- **A2 — Native lossless CompressionService.** Implement
  `src/interfaces/compression.ts` in `src/compression/`: exact-duplicate dedup,
  structural/JSON compaction, tool-result condensation → CCR store (SQLite index +
  content-addressed blobs via the `BlobStore` interface), inline retrieval markers
  (follow Headroom's marker convention, notes §2, for future sidecar interop).
  Register the harness: `describeCompressionServiceContract("NativeLossless", ...)`
  in a `tests/contract/*.test.ts` file. If you later add the pinned `headroom-ai`
  npm client for sidecar transport, ALL its imports go in
  `src/compression/headroom-adapter.ts` only; pins live in `src/compression/index.ts`
  and are enforced by `tests/contract/pins.contract.test.ts`.
- **A3 — Pipeline.** `src/pipeline/`: redaction stage (secret/PII regex corpus +
  entropy heuristics) → compression → forward. Redaction runs FIRST at every slider
  level and is never reordered/weakened (CLAUDE.md hard rule; T-C3 security review
  before release). Honor `x-eol-bypass: true`. Implement slider levels 0–2 via
  `sliderPolicyForLevel` (level 0 = redaction-only passthrough). Keep CPU-heavy
  compression off the request path's critical latency (worker_threads if profiling
  says so).
- **A4 — Telemetry events.** Per-stage `TokenDelta` events into `src/telemetry/`
  (SQLite, append-only). Coordinate schema with the integrator; WS-E reads it.

## Binding constraint: prompt-cache stability (notes §14)
Anthropic cache hits need a byte-identical prefix (tools → system → messages).
Re-compressing a previously-sent turn MUST reproduce byte-identical output: store
and replay each turn's compressed form; compress only new content. The contract
test `re-compression is deterministic` enforces this.

## Interfaces
- **Provides:** `CompressionService` implementation (frozen contract —
  `src/interfaces/compression.ts`; changes need integrator sign-off).
- **Consumes:** `SliderPolicy` (`interfaces/policy.ts`); `BlobStore`
  (`interfaces/storage.ts` — you may also ship the default local-dir BlobStore
  implementation, registered against `describeBlobStoreContract`); `src/telemetry/`;
  later `InferenceService` (WS-D) for slider ≥3 semantic compression — not P0.

## Files owned
`src/proxy/`, `src/pipeline/`, `src/compression/`, `tests/integration/`, your
contract-test registrations in `tests/contract/*.test.ts`. Do not touch other
workstreams' directories or `src/interfaces/`.

## Dependencies
T0.2/T0.3 are done (scaffold, frozen interfaces, harnesses). A1 has no blockers.
WS-B's hook work consumes your CCR store via `CompressionService.retrieve` — keep
`refs` stable and documented.

## P0 definition-of-done slice
1. Proxy passes recorded-shape tests incl. streaming + tool use; zero semantic
   change at level ≤1 (DoD #2).
2. Level 1 shows measurable savings via telemetry (DoD #3, with WS-E surfacing).
3. Redaction verified against a secrets corpus (DoD #5, with T-C3).
4. CI matrix green on ubuntu/macos/windows for every PR.
