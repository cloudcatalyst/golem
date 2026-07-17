# Proposal: auto-resume on session/usage-limit reset

> **Status: PROPOSED (2026-07-17).** Phase 1 (detect + capture) approved to build
> this session; Phase 2 (wait + trigger) deferred behind Phase-1 validation +
> ADR-0002. Durable task `20a9f9ae`. Supersedes the manual half of R5.1 by adding
> the automatic capture the queue was always meant to have.

## Problem
When a Claude session hits a usage limit, the conversation stops and is lost
unless the user manually re-runs it after the limit resets. R5.1 shipped the
durable half (persist a task, `notBefore` capacity gate, `golem task resume`) but
nothing **automatically** notices the limit or the reset. This closes that gap.

## Why Golem is the right place
The proxy (`ANTHROPIC_BASE_URL=localhost:4930`) is the **only** component that
sees the upstream limit response and its reset time. All traffic already flows
through it, and it already has a fidelity-preserving observation seam
(`UsageSniffer` — observe, never alter the body). Detection extends that same
discipline at the status/header level.

## Limit types (user-confirmed 2026-07-17)
There is not one limit but several, each with its own reset window:
- **Session limit** — rolling ~5h window (subscription).
- **Weekly limit** — longer window (subscription).
- **Per-model / usage limits** — model-class caps.
- **API-tier rate/spend limits** — the only ones the public docs specify (below).

The detector must read whichever reset applies to *this* hit, and must
distinguish a real exhaustion (hours away) from a transient per-minute 429
(seconds away).

## Verified signal (live docs, 2026-07-17)
`platform.claude.com/docs/en/api/rate-limits`:
- Rate-limit exceeded → **HTTP 429** + **`retry-after`** (seconds).
- Reset timestamps: `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-reset`, **RFC 3339**.
- Spend cap → "usage pauses until next month" (distinct from per-minute).

**Open unknown:** these are **API-tier** signals. The **subscription** session /
weekly limits (Pro/Max, "resets at Xpm") may present with a different status,
body, or OAuth-specific error. Phase 1 resolves this empirically by **logging
the full status + headers of every limit-shaped response**, so the next real
hit gives us ground truth to tune detection — data, not a guess.

## Design

### Phase 1 — Detect + Capture (safe; no autonomy) — THIS BUILD
- **Detect** at `proxy/server.ts` where `upstream.statusCode`/`.headers` are in
  hand (before the byte-faithful body pipe). Pure parser `parseUsageLimit()` in
  `src/proxy/limit-detector.ts` turns (status, headers, now) into a signal with
  the resolved `resetAt` (furthest-out `*-reset` header, else `retry-after`
  seconds from now) or null when not a 429. Body pipeline untouched.
- **Log** every 429's full status + headers to `.golem/state/limit-hits.jsonl`
  (bounded), so subscription-limit shapes are captured for validation.
- **Capture** only when `resetAt` is beyond a threshold (default 120s — filters
  transient per-minute 429s): read the current `sessionId` from
  `.golem/state/` (session hooks persist it), then upsert ONE durable
  `FileTaskStore` task with `notBefore = resetAt`, the session id, and a
  continue prompt. Idempotent per (session, window).
- Fire-and-forget, fail-open: never alters or delays the proxied response
  (CLAUDE.md fidelity rule). Wired via a new observe-only `onUsageLimit` proxy
  hook, mirroring `onResponseUsage`.
- Gated by `proxy.limit_autoresume`, **ON by default** (2026-07-17, user call):
  Phase 1 does no spawning, so default-on only means "auto-capture + log", which
  is safe for every project. The auto-SPAWN half (Phase 2) is a separate flag,
  still default OFF.

### Phase 2 — Wait + Trigger (autonomy-gated; opt-in; default OFF) — DEFERRED
- The long-running proxy daemon arms a cross-platform timer for `notBefore`
  (re-armed from persisted tasks on daemon start — survives sleep/restart).
- At reset, runs the existing `golem task resume <id> --spawn` →
  `claude -p --resume <sessionId>` headless with a continue prompt.
- **Gated**: auto-spawning a Claude session is an autonomy action under
  **ADR-0002 / R5.4** — off by default, behind the autonomy level, loudly
  surfaced. Deferred until Phase 1 has captured a real subscription-limit
  response to validate detection.

## Integration points
- `src/proxy/server.ts:164` — the detect call site.
- `src/proxy/types.ts` — new `onUsageLimit` observe-only hook.
- `src/proxy/limit-detector.ts` (new, pure) + `src/tasks/limit-capture.ts`
  (new, side-effecting, injectable store/clock/logger).
- `src/hooks/session-state.ts` — source of the current `sessionId`.
- `src/tasks/` (`FileTaskStore`, `createTask`, `notBefore`, `isResumable`).
- `src/cli/proxy-runtime.ts` — wires `onUsageLimit` when the setting is on.

## Risks
- **Subscription signal unknown** → mitigated by Phase-1 logging before any
  auto-action is built.
- **False trigger on transient 429** → reset-magnitude threshold.
- **Autonomy** → Phase 2 only, ADR-0002-gated, opt-in, default off.
- **Machine sleep** → Phase 2 re-arms timers from persisted `notBefore`.
