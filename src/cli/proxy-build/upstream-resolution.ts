/**
 * "Who are we talking to, and is that sane?" — everything `buildProxyFromSettings`
 * does to pick ONE upstream and to say out loud when the configuration that
 * picked it is broken.
 *
 * Extracted verbatim from `proxy-runtime.ts` (R10.1), where the two halves had
 * drifted apart by accident of writing order. They stay two exported functions
 * rather than one because the caller invokes them at two different points in the
 * build — {@link resolveProxyUpstream} before the pipeline is constructed (which
 * needs its `baseUrl`), {@link buildUpstreamWiring} after — and merging them
 * would move the stderr warnings relative to pipeline construction. Same module,
 * same concern; the split call sites are what keeps the observable behaviour
 * identical.
 *
 * **Byte-fidelity:** `mapUpstreamHeaders` and `translateUpstream` are genuinely
 * `undefined` — not a no-op function — on the plain-Anthropic path, so the
 * caller's spread-only-if-defined leaves the byte-faithful pipe untouched.
 * Returning a do-nothing function here would silently break the ≤ level 1
 * guarantee. See the assertion in tests/unit/cli/proxy-runtime.test.ts.
 */

import type { GolemSettings } from "../../config/index.js";
import {
  isGeminiProvider,
  isTranslatingProvider,
  listTargets,
  makeAuthMapper,
  perGatewayEnvVar,
  type ResolvedUpstream,
  resolveActiveUpstream,
  resolveAuthScheme,
  resolveDefaultTargetId,
  type TargetRegistrySettings,
  targetWarnings,
  type UpstreamProvider,
  upstreamAssumesCaching,
  withDefaultTarget,
} from "../../providers/index.js";
import type { UpstreamTranslator } from "../../proxy/index.js";
import { proxyLog } from "../../shared/proxy-log.js";
import { buildUpstreamTransport, type VisionLookup } from "../route-resolver.js";

export interface ResolvedProxyUpstream {
  readonly upstream: ResolvedUpstream;
  /** `settings.proxy` with the live `inference.model` merged in (R9.23). */
  readonly proxyWithDefault: GolemSettings["proxy"];
  /** undefined for `anthropic` → the pipeline falls back to its URL heuristic. */
  readonly assumeCachingUpstream: boolean | undefined;
}

/**
 * Resolve the ACTIVE upstream and warn about every misconfiguration visible at
 * startup. Writes to stderr; returns what the pipeline and proxy need.
 */
export function resolveProxyUpstream(settings: GolemSettings): ResolvedProxyUpstream {
  // Build the target registry settings for resolving the default target
  const targetRegistrySettings: TargetRegistrySettings = {
    upstream_provider: settings.proxy.upstream_provider,
    upstream_base_url: settings.proxy.upstream_base_url,
    ...(settings.proxy.upstream_model !== undefined
      ? { upstream_model: settings.proxy.upstream_model }
      : {}),
    upstream_auth_scheme: settings.proxy.upstream_auth_scheme,
    ...(settings.proxy.gateways !== undefined ? { gateways: settings.proxy.gateways } : {}),
    ...(settings.proxy.targets !== undefined ? { targets: settings.proxy.targets } : {}),
    ...(settings.inference.model !== undefined ? { model: settings.inference.model } : {}),
  };

  const defaultTargetId = resolveDefaultTargetId(targetRegistrySettings);
  const target = listTargets(targetRegistrySettings).find((t) => t.id === defaultTargetId);

  let upstream: ResolvedUpstream;
  let accountWarning: string | undefined;

  if (target !== undefined && target.origin !== "default") {
    // We have a target that is not the legacy upstream
    const apiKey =
      target.accountId === null
        ? process.env.GOLEM_UPSTREAM_API_KEY
        : process.env[perGatewayEnvVar(target.accountId)];
    upstream = {
      provider: target.provider,
      baseUrl: target.baseUrl,
      model: target.model,
      authScheme: resolveAuthScheme(target.provider, target.authScheme ?? "inherit"),
      accountId: target.accountId,
      apiKey,
    };
  } else {
    // Fall back to the existing method for gateway and legacy account
    const { resolved, warning } = resolveActiveUpstream(
      {
        legacy: {
          provider: settings.proxy.upstream_provider,
          base_url: settings.proxy.upstream_base_url,
          ...(settings.proxy.upstream_model !== undefined
            ? { model: settings.proxy.upstream_model }
            : {}),
          auth_scheme: resolveAuthScheme(
            settings.proxy.upstream_provider,
            settings.proxy.upstream_auth_scheme,
          ),
        },
        ...(settings.proxy.gateways !== undefined ? { gateways: settings.proxy.gateways } : {}),
        ...(settings.inference.model !== undefined
          ? { activeAccount: settings.inference.model }
          : {}),
        knownTargetIds: listTargets(settings.proxy).map((t) => t.id),
        legacyApiKey: process.env.GOLEM_UPSTREAM_API_KEY,
      },
      process.env,
    );
    upstream = resolved;
    accountWarning = warning;
  }

  if (accountWarning !== undefined) {
    proxyLog(accountWarning);
  }
  // R9.1: warn for EVERY misconfigured target, not just the one being served.
  // A broken target that is not yet routed to is still broken, and the point of
  // a registry is finding that out before a request depends on it. The registry
  // is inert here — this changes what is printed, never what is served.
  for (const w of targetWarnings(settings.proxy)) {
    proxyLog(`target "${w.targetId}": ${w.message}`);
  }
  // A model naming an id in neither registry fails closed downstream
  // (R9.2); say so at startup rather than on the first request that needs it.
  // R9.23: model moved to inference, so we use it here for resolution.
  if (!listTargets(targetRegistrySettings).some((t) => t.id === defaultTargetId)) {
    process.stderr.write(
      `golem proxy: default target "${defaultTargetId}" is in neither proxy.targets nor proxy.gateways — no substitute will be used.\n`,
    );
  }
  // R6.1 case (a): the selected provider governs the semantic stage's caching
  // assumption (verification-notes §73). undefined for `anthropic` → URL heuristic.
  const assumeCachingUpstream = upstreamAssumesCaching(upstream.provider);
  // R9.23: proxyWithDefault is settings.proxy with the live inference.model merged in.
  const proxyWithDefault = withDefaultTarget(settings);
  return { upstream, proxyWithDefault, assumeCachingUpstream };
}

export interface UpstreamWiring {
  readonly upstreamProvider: UpstreamProvider;
  readonly upstreamModel: string | undefined;
  /**
   * **undefined on the plain-Anthropic path** (`inherit` auth), so the caller's
   * conditional spread never adds the key and the passthrough forwards the
   * client's own auth verbatim. Never a no-op function.
   */
  readonly mapUpstreamHeaders: ReturnType<typeof makeAuthMapper>;
  /** Absent for a byte-faithful Anthropic-protocol upstream, which is a raw byte pipe. */
  readonly translateUpstream: UpstreamTranslator | undefined;
}

/**
 * The auth mapper + protocol translator for the resolved upstream, plus the
 * credential/translation warnings that go with them. Writes to stderr.
 */
export function buildUpstreamWiring(
  settings: GolemSettings,
  upstream: ResolvedUpstream,
  /** R10.14: image-input capability for the resolved model; absent → pass images through. */
  visionOf?: VisionLookup,
): UpstreamWiring {
  // R6.1 case (a): auth-header mapping for a non-Anthropic Anthropic-protocol
  // upstream. The credential is a secret the CLI resolved from the OS credential
  // store and handed to this process at spawn (Decision 47 — an environment
  // variable is the internal transport, never a user-facing setting), and never
  // comes from settings.json. `inherit` (the Anthropic default) yields no mapper,
  // so the passthrough forwards the client's own auth verbatim.
  const upstreamProvider = upstream.provider;
  const authScheme = upstream.authScheme;
  const upstreamApiKey = upstream.apiKey;
  const mapUpstreamHeaders = makeAuthMapper(authScheme, upstreamApiKey);
  const accountLabel = upstream.accountId === null ? "" : ` (account "${upstream.accountId}")`;
  if (
    upstreamProvider !== "anthropic" &&
    authScheme !== "inherit" &&
    (upstreamApiKey === undefined || upstreamApiKey === "")
  ) {
    process.stderr.write(
      `golem proxy: upstream_provider "${upstreamProvider}"${accountLabel} needs a credential — ` +
        `set it with \`golem gateway login ${upstream.accountId ?? upstreamProvider}\`; ` +
        "forwarding the client's own auth for now.\n",
    );
  }
  // R6.1 case (b): translate request+response bodies for a non-Anthropic schema.
  // Non-streaming uses translateResponse; streaming uses createStreamTranslator.
  // The pipeline still runs in Anthropic terms before this; translation is last.
  const upstreamModel = upstream.model;
  // R9.2: the SAME builder every routed target uses, so the single-upstream path
  // and the multi-target path cannot drift. A drifting translator does not throw
  // — it mangles a response — so sharing one construction is the only way to
  // keep them honest.
  const { translateUpstream } = buildUpstreamTransport({
    provider: upstreamProvider,
    baseUrl: upstream.baseUrl,
    model: upstreamModel,
    authScheme,
    apiKey: upstreamApiKey,
    reasoningEffort: settings.proxy.upstream_reasoning_effort,
    mapReasoning: settings.proxy.map_reasoning_to_thinking,
    vision: visionOf?.(upstreamProvider, upstreamModel),
  });
  if (isTranslatingProvider(upstreamProvider) && upstreamModel === undefined) {
    process.stderr.write(
      `golem proxy: upstream_provider "${upstreamProvider}" needs proxy.upstream_model ` +
        "(the backend model id, e.g. qwen2.5-coder:7b); requests will fail until it is set.\n",
    );
  }
  if (
    isGeminiProvider(upstreamProvider) &&
    (upstreamApiKey === undefined || upstreamApiKey === "")
  ) {
    process.stderr.write(
      'golem proxy: upstream_provider "gemini" needs a credential (sent as the ?key= query ' +
        `param) — set it with \`golem gateway login ${upstream.accountId ?? "gemini"}\`; ` +
        "requests will 401 until it is set.\n",
    );
  }
  return { upstreamProvider, upstreamModel, mapUpstreamHeaders, translateUpstream };
}
