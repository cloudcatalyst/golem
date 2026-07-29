---
title: OpenRouter reclassified to case (b) — five stacked defects
type: debrief
tags: [r6, proxy, providers, multi-provider, openrouter, credentials, honesty]
sources: [src/providers/index.ts, src/providers/openai-translate.ts, src/cli/proxy-runtime.ts, src/cli/accounts.ts, src/cli/main.ts, src/credentials/probe.ts, docs/plan/verification-notes.md, docs/golem-spec.md]
created: 2026-07-29
updated: 2026-07-29
---

# 2026-07-29 — OpenRouter free models were unreachable

A user-reported "I've been unable to use the openrouter method for free external
models" turned out to be five defects stacked on one another, each hiding the
next. Fixed under [spec Decision 48]; the forensic detail with live HTTP evidence
is [verification-notes §84], which supersedes §73's case-(a) recommendation for
OpenRouter.

Related: [[Architecture]] (§3b byte-faithful vs translating), [[Compression]]
(the caching assumption that deliberately did *not* change).

## The reported symptom

```
golem account add openrouter-laguna --provider openrouter \
  --base-url https://openrouter.ai/api/v1 \
  --model poolside/laguna-s-2.1:free --auth-scheme bearer
golem account login openrouter-laguna     # → "probe: accepted"
```

Configuration accepted, credential verified, and not one request could succeed.

## Why it took five fixes

1. **`openrouter` was case (a) — byte-faithful.** R6.1 classified it that way
   because OpenRouter *does* expose an Anthropic Messages endpoint. But that
   endpoint serves only **Claude** models, and byte-faithful by definition never
   rewrites the body — so Claude Code's own `claude-*` id went upstream and the
   account's `model` was **silently inert**. Every non-Claude model, i.e. the
   entire free tier, was unreachable by construction. Now case (b), translated
   over the normalized OpenAI Chat Completions surface.
2. **Path composition doubled the version segment.** `https://openrouter.ai/api/v1`
   + the client's `/v1/messages` = `/api/v1/v1/messages` → **404 with an HTML
   body**, so not even a legible API error.
3. **The credential probe validated the key but not the route.** It composed its
   own model-list URL and hit the real `/api/v1/models`, returning `accepted` for
   a configuration that could not serve a request.
4. **`stripVendorPrefix` mangled the model id — the dangerous one.** The
   translating boundary strips `vendor/` so a registry slug reaches a
   single-vendor upstream bare (`moonshotai/kimi-k3` → `kimi-k3`). OpenRouter is
   *multi-vendor* and `vendor/model` IS its canonical id, so a configured
   `poolside/laguna-s-2.1:free` was sent as `laguna-s-2.1:free`. OpenRouter
   happened to resolve the bare slug during testing — which is exactly why this
   would have resurfaced later as a *wrong model served*, not as an error.
5. **The startup banner printed the top-level config.** Two test proxies
   genuinely serving OpenRouter both announced
   `-> https://api.anthropic.com`, so any `golem account use` looked inert.

## The lesson worth keeping

Every one of these was a place where Golem **had** the information and reported
something else. The `--model` flag was accepted and ignored; the probe said
"accepted" about a different URL than the one traffic uses; the banner named a
config field instead of the resolved value. For a project whose pitch is *honest
observability*, the fix pattern generalises past OpenRouter:

- Reject or warn about config that cannot take effect — never accept it silently.
- A pre-flight check must name what it did **not** verify. `ProbeResult` now
  carries `requestUrl` (printed as "requests will go to: …") and `configWarning`,
  raised even on an `accepted` verdict.
- Display the **resolved** value, not the setting it came from.
- Derive from one shared helper. `upstreamBasePath` now backs both the proxy's
  request path and the probe's URL, so they cannot silently disagree — the drift
  between two path rules is what let defect 3 mask defects 1 and 2.

## Deliberately unchanged

`upstreamAssumesCaching("openrouter")` stays `true`. The case-(b) branch returns
`false` (translating ⇒ genuinely non-caching ⇒ the lossy semantic stage may pay),
but OpenRouter fronts both cache-capable and non-caching models and Golem cannot
know which per gateway. Reclassifying a provider must not quietly switch on
history rewriting, so it keeps the fail-safe assumption.

## Live verification

Throwaway proxies on spare ports, pinned with `GOLEM_PROXY_ACTIVE_ACCOUNT` so the
working session's own routing was never touched:

| Check | Result |
| --- | --- |
| `poolside/laguna-s-2.1:free`, non-streaming | 200, vendor prefix intact |
| `openai/gpt-oss-20b:free`, non-streaming | 200 |
| `openai/gpt-oss-20b:free`, SSE streaming | 200, 28 text deltas, correct event sequence |
| Tool use (b3) through OpenRouter | 200, `tool_use` block, `stop_reason: tool_use` |
| Banner | names base URL + account + model |
| `account add` warnings | fire on both traps, silent on the clean case |
| `account login` | prints the real route and warns despite `probe: accepted` |

Gates: `tsc --noEmit`, `biome check`, `format:check`, `vitest` (1445 tests) all
exit 0.

## Caveats for whoever uses this next

- **OpenRouter's free pool 429s intermittently** —
  `limit_source: upstream_provider_shared_pool`, roughly 1 call in 4 during
  testing, and it saturated completely for a stretch. Not a Golem fault; retry.
- **`laguna-s-2.1:free` is a reasoning model.** At `max_tokens: 200` it spent the
  whole budget on reasoning and emitted **zero** content blocks. Give it generous
  `max_tokens`.
- **Open question:** `map_reasoning_to_thinking` is on, yet no thinking deltas
  arrive from OpenRouter. It likely needs an explicit `reasoning: {…}` request
  field (Golem sends only `reasoning_effort`). **Unverified** — see §84.

[spec Decision 48]: ../../golem-spec.md
[verification-notes §84]: ../../plan/verification-notes.md
