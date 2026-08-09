/**
 * R9.2 — build a live {@link RouteResolver} over the R9.1 target registry.
 *
 * Two things live here:
 *
 * 1. {@link buildUpstreamTransport} — the auth mapper and protocol translator for
 *    ONE upstream. Extracted from `proxy-runtime.ts` so the single-upstream path
 *    and every routed target run the **same** construction. Two copies of this
 *    would drift, and the drift would be silent: a translator that is subtly
 *    wrong on one path produces a mangled response, not an error.
 * 2. {@link createRouteResolver} — the precedence chain (pure, in
 *    `providers/routing.ts`) joined to the registry lookup, credential
 *    resolution, and a conversation binding cache.
 *
 * **Fail-closed throughout.** An unknown target id, or a virtual id naming a
 * target that cannot say which model to send, is a clean 4xx naming what is
 * configured — never a fallback to the default target. Claude Code will not
 * catch an unknown `golem/*` id (verification-notes §114 caveat 4), so the error
 * has to be good here or it is nowhere.
 *
 * Secrets: resolved from the process environment, which the CLI populated at
 * spawn from the OS credential store (Decision 47). Nothing here reads settings
 * for a key, and no key is ever logged or placed on a `ProxyRoute`.
 */

import {
  anthropicToGemini,
  anthropicToOpenAIChat,
  createGeminiToAnthropicSSE,
  createOpenAIToAnthropicSSE,
  geminiPath,
  geminiToAnthropic,
  isGeminiProvider,
  isTranslatingProvider,
  listTargets,
  makeAuthMapper,
  openAIChatToAnthropic,
  perAccountEnvVar,
  preservesVendorPrefix,
  type ResolvedTarget,
  resolveDefaultTargetId,
  type TargetRegistrySettings,
  type UpstreamAuthScheme,
  type UpstreamProvider,
  upstreamAssumesCaching,
  upstreamChatCompletionsPath,
} from "../providers/index.js";
import { resolveRoute, TARGET_HEADER, targetIdFromVirtualModel } from "../providers/routing.js";
import type {
  ProxyRequest,
  ProxyRoute,
  RouteResolver,
  UpstreamTranslator,
} from "../proxy/index.js";

/** Everything one upstream needs to be spoken to, independent of routing. */
export interface UpstreamTransportInput {
  readonly provider: UpstreamProvider;
  readonly baseUrl: string;
  readonly model: string | undefined;
  readonly authScheme: UpstreamAuthScheme;
  readonly apiKey: string | undefined;
  /** OpenAI-schema only: forwarded as `reasoning_effort`. */
  readonly reasoningEffort?: "low" | "high" | "max" | undefined;
  /** OpenAI-schema only: map `reasoning_content` to Anthropic thinking blocks. */
  readonly mapReasoning: boolean;
}

export interface UpstreamTransport {
  readonly mapUpstreamHeaders?: (
    headers: Record<string, string | string[]>,
  ) => Record<string, string | string[]>;
  /** Absent for a byte-faithful Anthropic-protocol upstream, which is a raw byte pipe. */
  readonly translateUpstream?: UpstreamTranslator;
}

/**
 * The auth mapper + protocol translator for one upstream.
 *
 * `inherit` (the Anthropic default) yields no mapper at all, so the passthrough
 * forwards the client's own auth verbatim and stays byte-faithful. A translating
 * provider (OpenAI / OpenRouter / Ollama / Gemini) gets a translator; an
 * Anthropic-protocol provider never does.
 */
export function buildUpstreamTransport(input: UpstreamTransportInput): UpstreamTransport {
  const { provider, baseUrl, model, authScheme, apiKey } = input;
  const mapUpstreamHeaders = makeAuthMapper(authScheme, apiKey);
  const translateFallback = { id: "msg_golem_translated", model: model ?? provider };
  const modelOpt = model !== undefined ? { model } : {};

  let translateUpstream: UpstreamTranslator | undefined;
  if (isGeminiProvider(provider)) {
    // Gemini: distinct schema; auth is a `?key=` query param carried in the
    // per-request path, so the base `path` is a placeholder that translateRequest
    // always overrides.
    translateUpstream = {
      path: geminiPath(baseUrl, model ?? "", false, apiKey),
      translateRequest: (body: Buffer | null) => {
        const { body: g, stream, model: m } = anthropicToGemini(body, modelOpt);
        return {
          body: Buffer.from(JSON.stringify(g), "utf8"),
          stream,
          path: geminiPath(baseUrl, m, stream, apiKey),
        };
      },
      translateResponse: (body: Buffer): Buffer =>
        Buffer.from(JSON.stringify(geminiToAnthropic(body, translateFallback)), "utf8"),
      createStreamTranslator: () => createGeminiToAnthropicSSE(translateFallback),
    };
  } else if (isTranslatingProvider(provider)) {
    // OpenAI / Ollama: OpenAI Chat Completions schema. b4-kimi: pass through
    // reasoning_effort and map the reasoning trace ↔ Anthropic thinking blocks.
    // A multi-vendor gateway's ids keep their `vendor/` segment (Decision 48) —
    // stripping it on OpenRouter resolves to a different vendor's model or 400s.
    const keepVendorPrefix = preservesVendorPrefix(provider);
    const reqOpts = {
      ...modelOpt,
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(keepVendorPrefix ? { keepVendorPrefix } : {}),
    };
    const respOpts = { mapReasoning: input.mapReasoning };
    translateUpstream = {
      path: upstreamChatCompletionsPath(baseUrl),
      translateRequest: (body: Buffer | null) => {
        const req = anthropicToOpenAIChat(body, reqOpts);
        return { body: Buffer.from(JSON.stringify(req), "utf8"), stream: req.stream };
      },
      translateResponse: (body: Buffer): Buffer =>
        Buffer.from(
          JSON.stringify(openAIChatToAnthropic(body, translateFallback, respOpts)),
          "utf8",
        ),
      createStreamTranslator: () =>
        createOpenAIToAnthropicSSE({ ...translateFallback, mapReasoning: input.mapReasoning }),
    };
  }

  return {
    ...(mapUpstreamHeaders !== undefined ? { mapUpstreamHeaders } : {}),
    ...(translateUpstream !== undefined ? { translateUpstream } : {}),
  };
}

/**
 * The credential for a target, from the environment the CLI populated at spawn.
 * A target with no account inherits the client's own auth and uses the legacy
 * single-upstream variable, exactly as the pre-R9.2 default upstream did.
 */
function apiKeyForTarget(
  target: ResolvedTarget,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return target.accountId === null
    ? env.GOLEM_UPSTREAM_API_KEY
    : env[perAccountEnvVar(target.accountId)];
}

export interface RouteResolverOptions {
  readonly settings: TargetRegistrySettings & {
    readonly upstream_reasoning_effort?: "low" | "high" | "max";
    readonly map_reasoning_to_thinking: boolean;
  };
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Called with every routing decision — this is the ADR-0003 audit trail
   * ("which request went to which target, and why"). Observability only; it must
   * not throw.
   */
  readonly onRoute?: (event: {
    readonly targetId: string;
    readonly reason: string;
    readonly sticky: boolean;
  }) => void;
  /** Conversation → target bindings. Injectable so tests need no global state. */
  readonly bindings?: Map<string, string>;
  /** Derive a stable conversation key from a request body, for binding. */
  readonly conversationKeyOf?: (body: Buffer | null) => string | undefined;
}

/** Read the `model` field from a JSON request body, if there is one. */
function bodyModelOf(body: Buffer | null): string | undefined {
  if (body === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const model = (parsed as Record<string, unknown>).model;
    return typeof model === "string" ? model : undefined;
  } catch {
    return undefined;
  }
}

function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const raw = headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * Build the resolver the proxy calls once per request.
 *
 * Everything expensive — the registry listing and each target's transport — is
 * computed ONCE here, not per request: a translator closure rebuilt on every
 * request would allocate on the hot path for no benefit, and the registry cannot
 * change without a proxy restart anyway (`restart: "proxy"` on the settings).
 */
export function createRouteResolver(options: RouteResolverOptions): RouteResolver {
  const { settings } = options;
  const env = options.env ?? process.env;
  const bindings = options.bindings ?? new Map<string, string>();
  const targets = listTargets(settings);
  const defaultTarget = resolveDefaultTargetId(settings);

  const byId = new Map<string, { target: ResolvedTarget; transport: UpstreamTransport }>();
  for (const target of targets) {
    byId.set(target.id, {
      target,
      transport: buildUpstreamTransport({
        provider: target.provider,
        baseUrl: target.baseUrl,
        model: target.model,
        authScheme: target.authScheme,
        apiKey: apiKeyForTarget(target, env),
        reasoningEffort: settings.upstream_reasoning_effort,
        mapReasoning: settings.map_reasoning_to_thinking,
      }),
    });
  }
  const knownIds = [...byId.keys()].join(", ") || "(none configured)";

  return (request: ProxyRequest) => {
    const bodyModel = bodyModelOf(request.body);
    const conversationKey = options.conversationKeyOf?.(request.body);
    const decision = resolveRoute({
      bodyModel,
      headerTarget: headerValue(request.headers, TARGET_HEADER),
      boundTarget: conversationKey !== undefined ? bindings.get(conversationKey) : undefined,
      defaultTarget,
    });

    const entry = byId.get(decision.targetId);
    if (entry === undefined) {
      // Fail closed, loudly, naming what exists. A proxy that quietly served the
      // default here would send the caller's context to a model they did not
      // name — and they would have no way to notice.
      const named =
        targetIdFromVirtualModel(bodyModel) !== undefined
          ? `virtual model id "${bodyModel}"`
          : `target "${decision.targetId}"`;
      return {
        ok: false,
        status: 400,
        message:
          `golem proxy: ${named} does not match any configured target. ` +
          `Configured targets: ${knownIds}. No substitute was used — add it with ` +
          "`golem target add`, or see `golem target list`.",
      };
    }

    // A virtual id selected this target, so the body's model must be replaced
    // with the target's own. A target reached that way MUST declare a model:
    // there is nothing else to send, and forwarding `golem/<id>` upstream would
    // 404 at best.
    if (decision.virtualModel !== undefined && entry.target.model === undefined) {
      return {
        ok: false,
        status: 400,
        message:
          `golem proxy: target "${decision.targetId}" was selected by model id ` +
          `"${decision.virtualModel}" but declares no model of its own, so there is nothing ` +
          "to send upstream. Give it one with `golem target add --model <id>`.",
      };
    }

    if (conversationKey !== undefined && !decision.sticky) {
      bindings.set(conversationKey, decision.targetId);
    }
    options.onRoute?.({
      targetId: decision.targetId,
      reason: decision.reason,
      sticky: decision.sticky,
    });

    const assumeCaching = upstreamAssumesCaching(entry.target.provider);
    const route: ProxyRoute = {
      targetId: entry.target.id,
      reason: decision.reason,
      baseUrl: entry.target.baseUrl,
      trust: entry.target.trust,
      ...(decision.virtualModel !== undefined && entry.target.model !== undefined
        ? { rewriteModel: entry.target.model }
        : {}),
      ...(assumeCaching !== undefined ? { assumeCachingUpstream: assumeCaching } : {}),
      ...entry.transport,
    };
    return { ok: true, route };
  };
}
