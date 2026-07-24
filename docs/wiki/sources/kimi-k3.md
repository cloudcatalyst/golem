---
title: Kimi K3 (Moonshot AI) — API & Golem integration
type: source
tags: [source, kimi, moonshot, provider, openai-compatible, r6]
sources: [https://platform.kimi.ai/docs/guide/kimi-k3-quickstart, https://api.moonshot.ai/v1, https://apidog.com/blog/kimi-k3-api/, https://www.morphllm.com/kimi-api]
created: 2026-07-24
updated: 2026-07-24
---

# Kimi K3 (Moonshot AI)

Distilled source note (in our own words; see the cited URLs for the originals —
raw fetched text is not committed). Verified 2026-07-24; the full model weights
were slated for release 2026-07-27, so details may still move — re-check the
console before production.

## What it is

Kimi K3 is Moonshot AI's flagship open-weight model (~2.8T params, MoE, 1M-token
context), a **reasoning + native-vision** model aimed at long-horizon coding and
knowledge work. `reasoning_effort` supports `low`/`high`/`max` (default `max`);
thinking is always on.

## API shape (what Golem needs)

The API is **OpenAI Chat Completions compatible** — the whole reason it drops
into Golem's existing OpenAI-schema path with no new provider code.

| Setting | Value |
|---|---|
| Base URL | `https://api.moonshot.ai/v1` |
| Endpoint | `POST /v1/chat/completions` |
| Model id | `kimi-k3` (OpenRouter slug: `moonshotai/kimi-k3`) |
| Auth | `Authorization: Bearer $MOONSHOT_API_KEY` |
| Streaming | SSE; separate `reasoning_content` and `content` deltas |
| Tools | OpenAI function/tool-call schema |
| Structured output | `response_format` `json_schema` (`strict: true`) |
| Vision | content-array `image_url` (base64 or `ms://` file refs; not arbitrary public URLs) |
| Extra field | top-level `reasoning_effort` (`low`/`high`/`max`) |

**Access:** a key requires a **$1 minimum top-up**; cumulative top-up sets the
account tier + rate limits. Pricing (2026-07): ~\$0.30/1M cache-hit input,
\$3.00/1M cache-miss input, \$15.00/1M output (reasoning trace billed as output).
`GET /v1/models` returns the live model list (ids move fast — prefer it over
hardcoding).

## Using it with Golem

No new provider — front it via the `openai` translating provider (R6.1 case b):

```
proxy.upstream_provider  = openai
proxy.upstream_base_url  = https://api.moonshot.ai/v1
proxy.upstream_model     = kimi-k3
# secret (never a setting): GOLEM_UPSTREAM_API_KEY=<moonshot key>
# optional: proxy.upstream_reasoning_effort = low | high | max
```
Or as a switchable account (`proxy.accounts` + `golem account use kimi`, secret
in `GOLEM_UPSTREAM_API_KEY__KIMI`).

K3's reasoning trace and images are carried by the translator enhancements
shipped alongside this note: `reasoning_content` → Anthropic `thinking` blocks
(config `map_reasoning_to_thinking`), `reasoning_effort` passthrough
(`upstream_reasoning_effort`), and Anthropic `image` → OpenAI `image_url`.

## Caveats

- Synthesized `thinking` blocks carry **no Anthropic signature** (display-only);
  the reasoning trace is **not preserved across multi-turn** (Golem rebuilds each
  request from Anthropic history and drops `thinking` outbound — K3 recomputes).
- `reasoning_effort` defaults to `max` (priciest); set the config to trim cost.
- Golem's OpenAI translator does not map Moonshot `ms://` file references or the
  Files API; images pass through as base64/URL only.
- **LIVE-verified 2026-07-24** (verification-notes §81): non-streaming and
  streaming both work against real Kimi K3 — the reasoning trace maps to an
  Anthropic `thinking` block and the response honestly reports `kimi-k3`. One
  fix needed: the proxy now decompresses gzip before translating a non-streaming
  response (Moonshot gzips; undici doesn't auto-decompress).

Related: [[R6.1 b4-kimi — Kimi K3 upstream + reasoning/vision translator enhancements]]
(the implementation + verification), [[R6 — Multi-provider & remote batch retrospective]]
(where this provider fits), [[Redaction Stage]] (redaction runs before the
request is translated and forwarded to any provider).
