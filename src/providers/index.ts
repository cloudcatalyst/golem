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
 * The credential itself is a secret and is NEVER a settings leaf — the CLI
 * resolves it from the OS credential store (`golem gateway login`) and hands it
 * to the proxy process at spawn. Setting it via an environment variable was
 * removed in Decision 47; {@link perGatewayEnvVar} names only that internal
 * handoff channel.
 */

export {
  type GatewayEntry,
  type LegacyUpstream,
  perGatewayEnvVar,
  type ResolvedUpstream,
  type ResolveResult,
  resolveActiveUpstream,
  resolveUpstreamDisplay,
  type UpstreamDisplay,
  type UpstreamDisplaySettings,
} from "./gateways.js";
export { createGeminiToAnthropicSSE, GeminiSSETranslator } from "./gemini-stream.js";
export {
  anthropicToGemini,
  type GeminiRequest,
  geminiPath,
  geminiToAnthropic,
  mapGeminiFinish,
} from "./gemini-translate.js";
export { sniffRequestModel, stripVendorPrefix } from "./model-display.js";
export { createOpenAIToAnthropicSSE, OpenAIChatSSETranslator } from "./openai-stream.js";
export {
  type AnthropicMessageResponse,
  anthropicToOpenAIChat,
  countAnthropicInputTokens,
  countTokensResponse,
  EmptyCompletionError,
  emptyAnswerNotice,
  mapStopReason,
  type OpenAIChatMessage,
  type OpenAIChatRequest,
  openAIChatToAnthropic,
  SYNTHESIZED_THINKING_LABEL,
  UpstreamErrorResponse,
} from "./openai-translate.js";
export { withDefaultTarget } from "./target-settings.js";
export {
  accountsReferencedByTargets,
  defaultTargetId,
  defaultTrustFor,
  listTargets,
  type ResolvedTarget,
  resolveDefaultTargetId,
  resolveTarget,
  TARGET_TRUST_LEVELS,
  type TargetEntry,
  type TargetLookup,
  type TargetOrigin,
  type TargetRegistrySettings,
  type TargetTrust,
  type TargetWarning,
  targetWarnings,
} from "./targets.js";

/**
 * Upstreams Golem can front.
 * - Case (a) — Anthropic wire protocol, byte-faithful: `anthropic` (default),
 *   `azure-foundry`, `custom`.
 * - Case (b) — needs request/response translation (not byte-faithful):
 *   `openai`, `openrouter`, `ollama`, `llamacpp` (OpenAI Chat Completions
 *   schema), `gemini` (Google `generateContent` schema).
 *
 * `openrouter` was case (a) until Decision 48 (2026-07-29). OpenRouter's
 * Anthropic-Messages endpoint can only serve *Claude* models, so a byte-faithful
 * classification made every non-Claude model on the gateway — including its free
 * tier, the main reason to point Golem at OpenRouter at all — unreachable by
 * construction: byte-faithful forwards the client's own `claude-*` id and never
 * applies the account's configured `model`. It is now translated over
 * OpenRouter's normalized OpenAI Chat Completions surface
 * (verification-notes §73 reached the same conclusion). To reach the
 * Anthropic-native endpoint deliberately, use `--provider custom --base-url
 * https://openrouter.ai/api` (note: no `/v1` — the proxy appends the client's
 * own `/v1/messages`).
 */
export const UPSTREAM_PROVIDERS = [
  "anthropic",
  "azure-foundry",
  "openrouter",
  "custom",
  "openai",
  "ollama",
  // R10.8: llama.cpp's `llama-server`. It speaks the OpenAI Chat Completions
  // schema, so it reached Golem before this as `openai` + a base URL — and that
  // still works. A distinct member buys three things a shared `openai` could
  // not: `defaultTrustFor` can treat a loopback llama.cpp as genuinely `local`
  // (an `openai` target on localhost is not, and must not be, believed local),
  // `isKeylessProvider` can say that a bare `llama-server` needs no credential
  // instead of nagging for one, and the probe can explain a 404 in llama.cpp's
  // terms (no GGUF loaded) rather than OpenAI's. The cost is one enum member
  // and no new branch: every switch below folds it into the OpenAI path.
  "llamacpp",
  "gemini",
  // R9.15: not an endpoint at all — a target that SPAWNS the user's own Claude
  // Code CLI, so a draft runs on their subscription without Golem ever touching
  // that credential. Valid only as a target provider; see PROXY_PROVIDERS.
  "claude-cli",
] as const;

export type UpstreamProvider = (typeof UPSTREAM_PROVIDERS)[number];

/**
 * The providers the PROXY can front. `claude-cli` is excluded deliberately: the
 * proxy forwards a request to an endpoint, and there is no endpoint to forward
 * to — naming it as `proxy.upstream_provider` would be a setting that parses and
 * then cannot work, which is the silent-no-op class this repo keeps closing.
 * Enforced at config-load time by the schema, not at first request.
 *
 * R10.8 — `llamacpp` IS included, on exactly that test: `llama-server` serves a
 * real HTTP endpoint, so `upstream_provider = "llamacpp"` both parses and works.
 * The membership rule here is "is there something to forward to", not "is this a
 * big vendor"; excluding a working local server would be the mirror-image
 * silent-no-op (a provider you may declare on a target but not serve from, for
 * no reason a user could infer).
 */
export const PROXY_PROVIDERS = UPSTREAM_PROVIDERS.filter(
  (p) => p !== "claude-cli",
) as readonly UpstreamProvider[] as readonly [UpstreamProvider, ...UpstreamProvider[]];

/** Whether reaching this provider means spawning a process rather than an HTTP call. */
export function isSpawnProvider(provider: UpstreamProvider): boolean {
  return provider === "claude-cli";
}

/**
 * Whether the provider needs request/response translation (case b) rather than a
 * byte-faithful passthrough (case a).
 */
export function isTranslatingProvider(provider: UpstreamProvider): boolean {
  return (
    provider === "openai" ||
    provider === "openrouter" ||
    provider === "ollama" ||
    provider === "llamacpp" ||
    provider === "gemini"
  );
}

/**
 * Whether this provider is normally reached with **no credential at all** — a
 * model server you run yourself, which accepts requests because you can reach
 * the port, not because you presented a key.
 *
 * This exists so "no credential stored" can be reported as the *expected* state
 * for such a gateway instead of a defect. Without it, every surface that checks
 * for a stored key (`golem target list`, `golem status`) tells a user who ran
 * `llama-server` exactly as documented to go and set a credential that their
 * server would ignore — advice that is not merely noisy but wrong.
 *
 * `gemini` is deliberately NOT here even though its default scheme is `inherit`:
 * it genuinely needs a key, carried in the `?key=` query parameter rather than a
 * header. Keying this off `inherit` instead of naming the providers would
 * therefore silence the one warning that matters most.
 *
 * A keyless provider may still be *given* a key (`llama-server --api-key`); this
 * only governs whether the ABSENCE of one is worth reporting.
 */
export function isKeylessProvider(provider: UpstreamProvider): boolean {
  return provider === "ollama" || provider === "llamacpp" || provider === "claude-cli";
}

/**
 * Whether the provider's model ids keep their `vendor/` segment on the wire.
 *
 * Most OpenAI-schema upstreams are single-vendor and name a model bare
 * (`kimi-k3`), so a registry slug like `moonshotai/kimi-k3` has its prefix
 * stripped at the translating boundary ({@link stripVendorPrefix}). OpenRouter is
 * the opposite: it is a *multi-vendor* gateway whose canonical model id IS
 * `vendor/model` (`poolside/laguna-s-2.1:free`), and the vendor segment is what
 * disambiguates models that several vendors publish under the same name
 * (`openai/gpt-oss-20b:free` vs another host's `gpt-oss-20b`). Stripping it there
 * either 400s or silently resolves to a different vendor's model, so OpenRouter
 * ids are forwarded whole.
 */
export function preservesVendorPrefix(provider: UpstreamProvider): boolean {
  return provider === "openrouter";
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
    case "llamacpp":
      // R10.8: `llama-server` serves unauthenticated unless started with
      // `--api-key`. Inject nothing by default; a user who did pass `--api-key`
      // sets `auth_scheme = "bearer"` on the gateway and stores the key.
      return "inherit";
    case "gemini":
      // Gemini authenticates with a `?key=` query param carried in the path, not
      // a header — so no header mapping (inherit = none injected).
      return "inherit";
    case "claude-cli":
      // R9.15: there is no request for Golem to sign. The spawned Claude Code
      // authenticates as itself, which is the entire point of the route — Golem
      // never holds, reads or forwards that credential.
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

/**
 * R13.11 — the header scheme to use when Golem **originates** a request to this
 * provider, rather than proxying one.
 *
 * `inherit` means two incompatible things depending on who is asking, and
 * conflating them is what made `coder` 401 on the commonest configuration there
 * is:
 *
 * - **To the proxy** it means "forward the client's own credential unchanged" —
 *   correct, and the reason Anthropic defaults to it: Golem is a transparent
 *   passthrough and injects nothing.
 * - **To the dispatcher** it can only mean "present nothing", because there is
 *   no client request whose headers could be forwarded. For a keyless local
 *   server that is right. For `api.anthropic.com` it is a guaranteed 401.
 *
 * So origination asks a different question — *which header would Golem have to
 * set to authenticate itself here?* — and `undefined` is the honest answer only
 * where no header would do it: a keyless local server (`ollama`, `llamacpp`),
 * Gemini's `?key=` query parameter, and a spawned Claude Code that authenticates
 * as itself.
 *
 * Note this is NOT {@link defaultAuthScheme}: that function answers the proxy's
 * question and returns `inherit` for four providers. Deriving one from the other
 * would collapse the distinction this exists to draw.
 */
export function originationAuthScheme(
  provider: UpstreamProvider,
): Exclude<UpstreamAuthScheme, "inherit"> | undefined {
  switch (provider) {
    case "anthropic":
      return "x-api-key";
    case "custom":
      // Matches `defaultAuthScheme`'s note: a self-hosted Anthropic-compatible
      // gateway commonly reuses `x-api-key`.
      return "x-api-key";
    case "azure-foundry":
      return "api-key";
    case "openrouter":
    case "openai":
      return "bearer";
    case "ollama":
    case "llamacpp":
      // Keyless by default. A user who did start one with a key sets an explicit
      // non-`inherit` scheme on the gateway, which never reaches this function.
      return undefined;
    case "gemini":
      // The credential rides in the path, not a header — unreachable by a mapper.
      return undefined;
    case "claude-cli":
      // There is no request for Golem to sign; the spawned client authenticates
      // as itself (R9.15).
      return undefined;
  }
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
  // OpenRouter is a multi-vendor gateway: it fronts both prompt-cache-capable
  // models (Anthropic/OpenAI upstreams) and non-caching ones, and which is which
  // is a per-request property of the configured model, not of the gateway. Golem
  // cannot know, so it stays fail-safe — treated as caching, semantic stage off,
  // history never rewritten (Decision 31). Reclassifying it as a *translating*
  // provider (Decision 48) deliberately did NOT change this: the case below keys
  // off translation as a proxy for "genuinely non-caching", which OpenRouter is
  // not.
  if (provider === "openrouter") return true;
  // OpenAI/Ollama are genuinely non-caching — resent history is re-billed at
  // full price, so the lossy semantic stage may pay there (Decision 23/31).
  if (isTranslatingProvider(provider)) return false;
  return true; // Anthropic-protocol Claude gateways: prompt-cache-capable, fail-safe
}

/**
 * The upstream path prefix a base URL carries — its pathname with any trailing
 * slash removed (`https://openrouter.ai/api/v1` → `/api/v1`, a bare host → `""`).
 * This is exactly what {@link GolemProxy} prepends to the client's request
 * target, so every surface that needs to predict the proxy's real request URL
 * derives it from here rather than re-implementing the rule.
 */
export function upstreamBasePath(baseUrl: string): string {
  return new URL(baseUrl).pathname.replace(/\/+$/, "");
}

/**
 * The OpenAI Chat Completions path for a translating provider's base URL, e.g.
 * `http://gpubox.lan:11434/v1` → `/v1/chat/completions`. Preserves any path
 * prefix the base URL carries; the proxy POSTs the translated body here.
 *
 * Tolerates a base URL that already names the endpoint — users copy
 * `https://openrouter.ai/api/v1/chat/completions` straight out of a provider's
 * curl example, and appending to that produced a doubled
 * `/chat/completions/chat/completions` that 404s.
 */
export function upstreamChatCompletionsPath(baseUrl: string): string {
  const prefix = upstreamBasePath(baseUrl).replace(/\/chat\/completions$/, "");
  return `${prefix}/chat/completions`;
}

/**
 * The absolute URL the proxy will actually POST to for this provider — the
 * translated Chat Completions endpoint for case (b), or `<base>/v1/messages` for
 * a byte-faithful case (a) upstream (where the proxy appends the client's own
 * `/v1/messages` request target to the base path).
 *
 * Exists so a *pre-flight* surface (the credential probe) can report the same URL
 * the request path will use instead of composing its own. Gemini is excluded: its
 * path is per-request (model + `?key=`) and is built by `geminiPath`.
 */
export function upstreamRequestUrl(provider: UpstreamProvider, baseUrl: string): string {
  const { origin } = new URL(baseUrl);
  if (isGeminiProvider(provider)) return `${origin}${upstreamBasePath(baseUrl)}`;
  if (isTranslatingProvider(provider)) return `${origin}${upstreamChatCompletionsPath(baseUrl)}`;
  return `${origin}${upstreamBasePath(baseUrl)}/v1/messages`;
}

/**
 * A base URL whose composed request path repeats the API-version segment, e.g.
 * `https://openrouter.ai/api/v1` on a byte-faithful provider → the proxy appends
 * the client's `/v1/messages` and POSTs `/api/v1/v1/messages`, which 404s (with
 * an HTML error page, so it does not even surface as a clean API error).
 *
 * Returns the offending composed URL, or `undefined` when the composition looks
 * sane. Callers use it to warn at *configuration* time — the failure is otherwise
 * invisible until the first real request, and a credential probe against a
 * separately-composed `/models` URL will happily report the key as good.
 */
export function doubledVersionSegment(
  provider: UpstreamProvider,
  baseUrl: string,
): string | undefined {
  const url = upstreamRequestUrl(provider, baseUrl);
  return /\/v\d+\/v\d+\//.test(new URL(url).pathname) ? url : undefined;
}
