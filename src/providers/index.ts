/**
 * R6.1 case (a) — Anthropic-native upstream providers (spec Decisions 22/32,
 * verification-notes §73).
 *
 * These providers all speak the **Anthropic Messages** wire protocol, so the
 * proxy stays byte-faithful: SSE streams and tool-use blocks pass through
 * exactly as they do against `api.anthropic.com` (CLAUDE.md hard rule). The
 * only per-provider differences case (a) has to handle are (i) the upstream
 * base URL (already `proxy.upstream_base_url`) and (ii) **auth-header mapping** —
 * Claude Code authenticates with its own Anthropic credential, which is wrong
 * for a different gateway, so Golem strips it and injects the configured
 * upstream credential under that provider's expected header.
 *
 * The genuine protocol *translation* to OpenAI/Gemini/Ollama schemas is case
 * (b) — a separate, larger build with its own response-transform seam. Nothing
 * here translates bodies.
 *
 * The credential itself is a secret and is NEVER a settings leaf — it is read
 * from the `GOLEM_UPSTREAM_API_KEY` environment variable by the CLI wiring.
 */

export {
  type LegacyUpstream,
  perAccountEnvVar,
  type ResolvedUpstream,
  type ResolveResult,
  resolveActiveUpstream,
  type UpstreamAccount,
} from "./accounts.js";
export { createGeminiToAnthropicSSE, GeminiSSETranslator } from "./gemini-stream.js";
export {
  anthropicToGemini,
  type GeminiRequest,
  geminiPath,
  geminiToAnthropic,
  mapGeminiFinish,
} from "./gemini-translate.js";
export { createOpenAIToAnthropicSSE, OpenAIChatSSETranslator } from "./openai-stream.js";
export {
  type AnthropicMessageResponse,
  anthropicToOpenAIChat,
  mapStopReason,
  type OpenAIChatMessage,
  type OpenAIChatRequest,
  openAIChatToAnthropic,
} from "./openai-translate.js";

/**
 * Upstreams Golem can front.
 * - Case (a) — Anthropic wire protocol, byte-faithful: `anthropic` (default),
 *   `azure-foundry`, `openrouter`, `custom`.
 * - Case (b) — needs request/response translation (not byte-faithful):
 *   `openai`, `ollama` (OpenAI Chat Completions schema), `gemini` (Google
 *   `generateContent` schema).
 */
export const UPSTREAM_PROVIDERS = [
  "anthropic",
  "azure-foundry",
  "openrouter",
  "custom",
  "openai",
  "ollama",
  "gemini",
] as const;

export type UpstreamProvider = (typeof UPSTREAM_PROVIDERS)[number];

/**
 * Whether the provider needs request/response translation (case b) rather than a
 * byte-faithful passthrough (case a).
 */
export function isTranslatingProvider(provider: UpstreamProvider): boolean {
  return provider === "openai" || provider === "ollama" || provider === "gemini";
}

/** Whether the provider uses the Gemini `generateContent` schema (a distinct translator). */
export function isGeminiProvider(provider: UpstreamProvider): boolean {
  return provider === "gemini";
}

/**
 * How the upstream credential is presented.
 * - `inherit` — forward the client's own auth headers unchanged (the Anthropic
 *   default: Golem is a transparent passthrough and injects nothing).
 * - `x-api-key` — Anthropic's native header (`x-api-key: <key>`).
 * - `api-key` — Azure AI Foundry's key header (`api-key: <key>`).
 * - `bearer` — `Authorization: Bearer <key>` (OpenRouter; Azure Entra tokens).
 */
export const UPSTREAM_AUTH_SCHEMES = ["inherit", "x-api-key", "api-key", "bearer"] as const;

export type UpstreamAuthScheme = (typeof UPSTREAM_AUTH_SCHEMES)[number];

/** The sensible default auth scheme for a provider when the config leaves it at `inherit`. */
export function defaultAuthScheme(provider: UpstreamProvider): UpstreamAuthScheme {
  switch (provider) {
    case "anthropic":
      return "inherit";
    case "azure-foundry":
      return "api-key";
    case "openrouter":
      return "bearer";
    case "custom":
      // A self-hosted Anthropic-compatible gateway commonly reuses x-api-key;
      // forward the client's creds by default and let the user override.
      return "inherit";
    case "openai":
      return "bearer";
    case "ollama":
      // Ollama ignores auth by default (local / trusted LAN); inject none.
      return "inherit";
    case "gemini":
      // Gemini authenticates with a `?key=` query param carried in the path, not
      // a header — so no header mapping (inherit = none injected).
      return "inherit";
  }
}

/**
 * Resolve the effective auth scheme: an explicit non-`inherit` config value
 * wins; otherwise a non-Anthropic provider falls back to its provider default
 * (so a user can just set `upstream_provider` and get working auth).
 */
export function resolveAuthScheme(
  provider: UpstreamProvider,
  configured: UpstreamAuthScheme,
): UpstreamAuthScheme {
  return configured === "inherit" ? defaultAuthScheme(provider) : configured;
}

/** Header map the proxy forwards upstream (lowercased names, Node semantics). */
type UpstreamHeaders = Record<string, string | string[]>;

/**
 * Build the upstream header-rewrite for a provider, or `undefined` when none is
 * needed (scheme `inherit`, or no credential available — in which case the CLI
 * warns and the request forwards unchanged rather than being silently broken).
 * The mapper strips the client's Anthropic credentials (`x-api-key`,
 * `authorization`) and injects the configured credential under the scheme's
 * header. `anthropic-version` and every other end-to-end header are left
 * untouched (Azure Foundry still wants `anthropic-version`).
 */
export function makeAuthMapper(
  scheme: UpstreamAuthScheme,
  apiKey: string | undefined,
): ((headers: UpstreamHeaders) => UpstreamHeaders) | undefined {
  if (scheme === "inherit") return undefined;
  if (apiKey === undefined || apiKey === "") return undefined;
  return (headers: UpstreamHeaders): UpstreamHeaders => {
    const out: UpstreamHeaders = { ...headers };
    delete out["x-api-key"];
    delete out.authorization;
    switch (scheme) {
      case "x-api-key":
        out["x-api-key"] = apiKey;
        break;
      case "api-key":
        out["api-key"] = apiKey;
        break;
      case "bearer":
        out.authorization = `Bearer ${apiKey}`;
        break;
    }
    return out;
  };
}

/**
 * Whether the semantic (lossy) compression stage should treat this provider as
 * a caching upstream. Returns `undefined` for `anthropic` so the pipeline keeps
 * its existing URL heuristic (`isCachingUpstream`) for the default and any
 * custom `api.anthropic.com`-style base URL. Every other case-(a) provider
 * serves **Claude over the Anthropic protocol**, which is prompt-cache-capable,
 * so it is treated as caching (fail-safe: no history-rewriting semantic stage,
 * byte-faithful; verification-notes §73). A forced A/B there still uses the
 * existing `force_semantic_on_caching` opt-in (R2.6).
 */
export function upstreamAssumesCaching(provider: UpstreamProvider): boolean | undefined {
  if (provider === "anthropic") return undefined; // URL heuristic (default + custom anthropic URL)
  // OpenAI/Ollama are genuinely non-caching — resent history is re-billed at
  // full price, so the lossy semantic stage may pay there (Decision 23/31).
  if (isTranslatingProvider(provider)) return false;
  return true; // Anthropic-protocol Claude gateways: prompt-cache-capable, fail-safe
}

/**
 * The OpenAI Chat Completions path for a translating provider's base URL, e.g.
 * `http://gpubox.lan:11434/v1` → `/v1/chat/completions`. Preserves any path
 * prefix the base URL carries; the proxy POSTs the translated body here.
 */
export function upstreamChatCompletionsPath(baseUrl: string): string {
  const prefix = new URL(baseUrl).pathname.replace(/\/+$/, "");
  return `${prefix}/chat/completions`;
}
