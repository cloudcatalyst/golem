/**
 * Pre-flight credential probe (spec Decision 46).
 *
 * Before Golem stores a key — and before `account use` switches traffic onto it
 * — send one cheap, read-only request to the upstream and see whether the
 * credential is actually accepted. This is what turns "the env var is set" (a
 * claim about a string's existence) into "the upstream accepts this key" (the
 * thing the user actually cares about).
 *
 * **Honest verdicts.** The probe reports three outcomes, not two:
 *
 * - `accepted` — the upstream answered 2xx. The key works.
 * - `rejected` — the upstream answered 401/403. The key is wrong or revoked.
 *   This is the only verdict that blocks a store/switch.
 * - `inconclusive` — anything else: no `/models` endpoint (404), a network
 *   failure, a rate limit, an unexpected status. We genuinely cannot tell, so we
 *   say so and let the operation proceed with a warning. Claiming a key is good
 *   because a probe timed out would be exactly the kind of dishonest signal this
 *   project exists to avoid.
 *
 * The probe is a GET against the provider's model-list endpoint: no tokens are
 * spent and nothing is mutated.
 */

import { request } from "undici";
import {
  defaultAuthScheme,
  type UpstreamAuthScheme,
  type UpstreamProvider,
} from "../providers/index.js";

export type ProbeVerdict = "accepted" | "rejected" | "inconclusive";

export interface ProbeResult {
  readonly verdict: ProbeVerdict;
  /** HTTP status, when a response was received at all. */
  readonly status?: number;
  /** Human-readable explanation, safe to print (never contains the secret). */
  readonly detail: string;
}

export interface ProbeInput {
  readonly provider: UpstreamProvider;
  readonly baseUrl: string;
  readonly authScheme: UpstreamAuthScheme;
  readonly secret: string;
  readonly timeoutMs?: number;
}

/**
 * The model-list URL for a base URL, tolerating both spellings users configure:
 * an OpenAI-style base that already ends in `/v1` (→ `/v1/models`) and an
 * Anthropic-style base that does not (→ `/v1/models` appended).
 */
export function modelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
}

/**
 * Headers that present `secret` under the effective scheme. When the configured
 * scheme resolves to `inherit` (Anthropic's passthrough default, where the proxy
 * normally injects nothing) the probe still has to authenticate *somehow* to
 * test the stored key, so it falls back to that provider's native header.
 */
function probeHeaders(
  provider: UpstreamProvider,
  authScheme: UpstreamAuthScheme,
  secret: string,
): Record<string, string> {
  const resolved = authScheme === "inherit" ? defaultAuthScheme(provider) : authScheme;
  switch (resolved) {
    case "x-api-key":
      return { "x-api-key": secret, "anthropic-version": "2023-06-01" };
    case "api-key":
      return { "api-key": secret };
    case "bearer":
      return { authorization: `Bearer ${secret}` };
    case "inherit":
      // No native header for this provider (ollama ignores auth; gemini keys ride
      // in the query string, handled by the caller's URL). Anthropic and custom
      // gateways take x-api-key.
      return provider === "anthropic" || provider === "custom"
        ? { "x-api-key": secret, "anthropic-version": "2023-06-01" }
        : {};
  }
}

/**
 * Probe `secret` against the upstream. Never throws — a transport failure is an
 * `inconclusive` verdict, because "could not reach the provider" is not evidence
 * about the key.
 */
export async function probeCredential(input: ProbeInput): Promise<ProbeResult> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  const isGemini = input.provider === "gemini";
  // Gemini authenticates with ?key=, not a header.
  const url = isGemini
    ? `${modelsUrl(input.baseUrl)}?key=${encodeURIComponent(input.secret)}`
    : modelsUrl(input.baseUrl);
  const headers = isGemini ? {} : probeHeaders(input.provider, input.authScheme, input.secret);
  // NEVER interpolate `url` into a message: the Gemini form carries the key in
  // its query string. Only this stripped form is safe to print.
  const shownUrl = modelsUrl(input.baseUrl);

  try {
    const res = await request(url, {
      method: "GET",
      headers,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    // Drain so the socket is released back to the pool.
    await res.body.dump();
    const status = res.statusCode;

    if (status >= 200 && status < 300) {
      return {
        verdict: "accepted",
        status,
        detail: `upstream accepted the credential (${status})`,
      };
    }
    if (status === 401 || status === 403) {
      return {
        verdict: "rejected",
        status,
        detail: `upstream rejected the credential (HTTP ${status}) — the key is wrong, revoked, or lacks access`,
      };
    }
    if (status === 404) {
      return {
        verdict: "inconclusive",
        status,
        detail: `no model-list endpoint at ${shownUrl} (HTTP 404) — cannot verify the key this way`,
      };
    }
    if (status === 429) {
      return {
        verdict: "inconclusive",
        status,
        detail: "upstream rate-limited the probe (HTTP 429) — the key may still be valid",
      };
    }
    return {
      verdict: "inconclusive",
      status,
      detail: `unexpected probe response (HTTP ${status}) — cannot confirm or deny the key`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      verdict: "inconclusive",
      detail: `could not reach ${new URL(shownUrl).host}: ${message}`,
    };
  }
}
