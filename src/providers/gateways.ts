/**
 * R9.23: renamed from "accounts" to "gateways" (spec Decision 21d; ADR-0003).
 *
 * A pure resolver that turns the proxy's gateway registry + the selected default
 * target into the concrete upstream a request should use. A gateway holds the
 * connection config and credential reference for reaching a provider's endpoint;
 * several targets may share one gateway (one key backing several model ids),
 * which is why the two registries are separate.
 *
 * ADR-0003 invariants honoured here:
 * - **Secrets are never a setting.** A gateway entry holds only non-secret
 *   identity (id, provider, base_url, models, auth_scheme). The credential comes
 *   from a per-gateway env var {@link perGatewayEnvVar}; the legacy single
 *   account uses `GOLEM_UPSTREAM_API_KEY`.
 * - **Fail-closed / no silent cross-account fallback.** A `default_target` that
 *   names an unknown id does NOT silently use a different gateway — it falls back
 *   to the user's own top-level (legacy) config and reports a warning. A missing
 *   credential is surfaced downstream (the request 401s), never swapped for
 *   another gateway's key.
 */

import { resolveAuthScheme, type UpstreamAuthScheme, type UpstreamProvider } from "./index.js";
// Direct import, not the barrel: the barrel re-exports this module, and
// importing ourselves through it would be a circular dependency.
import { listTargets, resolveDefaultTargetId, type TargetRegistrySettings } from "./targets.js";

/** A non-secret gateway entry (from `proxy.gateways`). */
export interface GatewayEntry {
  readonly id: string;
  readonly provider: UpstreamProvider;
  readonly base_url: string;
  /**
   * R9.23: the models this gateway serves. A target is derived from each entry
   * here. Omitted or empty means no model is reachable via this gateway without
   * an explicit proxy.targets entry.
   */
  readonly models?: readonly string[];
  readonly auth_scheme?: UpstreamAuthScheme;
}

/** The legacy single-account config (top-level `proxy.*`). */
export interface LegacyUpstream {
  readonly provider: UpstreamProvider;
  readonly base_url: string;
  readonly model?: string;
  readonly auth_scheme: UpstreamAuthScheme;
}

/** The resolved upstream a request will use. */
export interface ResolvedUpstream {
  readonly provider: UpstreamProvider;
  readonly baseUrl: string;
  readonly model: string | undefined;
  readonly authScheme: UpstreamAuthScheme;
  readonly apiKey: string | undefined;
  /** The active gateway id, or null when the legacy top-level config is in use. */
  readonly accountId: string | null;
}

/** The environment variable carrying gateway `id`'s secret, e.g. `work` -> `GOLEM_UPSTREAM_API_KEY__WORK`. */
export function perGatewayEnvVar(id: string): string {
  return `GOLEM_UPSTREAM_API_KEY__${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export interface ResolveResult {
  readonly resolved: ResolvedUpstream;
  /** A loud misconfiguration note (unknown gateway) for the caller to surface; else undefined. */
  readonly warning?: string;
}

/**
 * Resolve the active upstream from the registry + selection. The selector
 * (`inference.default_target`, renamed from `active_account` in R9.1)
 * unset -> the legacy top-level config. Set + found -> that gateway (secret from
 * its per-gateway env var). Set + NOT found -> legacy config + a warning (never a
 * different gateway — ADR-0003 fail-closed).
 */
export function resolveActiveUpstream(
  input: {
    readonly legacy: LegacyUpstream;
    readonly gateways?: readonly GatewayEntry[];
    readonly activeAccount?: string;
    /** Target ids that exist; a selector naming one of these is not a misconfiguration. */
    readonly knownTargetIds?: readonly string[];
    readonly legacyApiKey: string | undefined;
  },
  env: Readonly<Record<string, string | undefined>>,
): ResolveResult {
  const legacyResolved: ResolvedUpstream = {
    provider: input.legacy.provider,
    baseUrl: input.legacy.base_url,
    model: input.legacy.model,
    authScheme: input.legacy.auth_scheme,
    apiKey: input.legacyApiKey,
    accountId: null,
  };

  if (input.activeAccount === undefined) return { resolved: legacyResolved };

  const gateway = input.gateways?.find((g) => g.id === input.activeAccount);
  if (gateway === undefined) {
    if (input.knownTargetIds?.includes(input.activeAccount) === true) {
      return { resolved: legacyResolved };
    }
    return {
      resolved: legacyResolved,
      warning:
        `inference.default_target "${input.activeAccount}" is in neither proxy.gateways nor ` +
        "proxy.targets — using the top-level upstream config instead (no silent switch).",
    };
  }

  return {
    resolved: {
      provider: gateway.provider,
      baseUrl: gateway.base_url,
      model: gateway.models?.[0],
      authScheme: resolveAuthScheme(gateway.provider, gateway.auth_scheme ?? "inherit"),
      apiKey: env[perGatewayEnvVar(gateway.id)],
      accountId: gateway.id,
    },
  };
}

/** The non-secret upstream identity for display surfaces (status/statusline/extension). */
export interface UpstreamDisplay {
  /** Active gateway id, or null when the legacy top-level config is in use. */
  readonly accountId: string | null;
  readonly provider: UpstreamProvider;
  readonly baseUrl: string;
  /** Configured default model (undefined for a byte-faithful Anthropic upstream). */
  readonly model: string | undefined;
  /** A loud misconfiguration note (unknown gateway) to surface; else undefined. */
  readonly warning?: string;
}

/**
 * The proxy-settings shape {@link resolveUpstreamDisplay} reads — a structural
 * subset of `GolemSettings["proxy"]`, kept local so the providers module does
 * not import the config schema.
 */
export interface UpstreamDisplaySettings {
  readonly upstream_provider: UpstreamProvider;
  readonly upstream_base_url: string;
  readonly upstream_model?: string;
  readonly upstream_auth_scheme: UpstreamAuthScheme;
  /** R9.23: renamed from `accounts`. */
  readonly gateways?: readonly GatewayEntry[];
  /** R9.6: the selector, renamed from `active_account` in R9.1. */
  readonly default_target?: string;
  /**
   * R9.6: ids the target registry knows. The selector may legitimately name a
   * TARGET rather than a gateway, in which case the gateway layer must stand
   * aside silently — routing owns it. Without this the gateway layer would warn
   * about a perfectly valid target id.
   */
  readonly targets?: readonly { readonly id: string }[];
}

/**
 * Resolve the active upstream's non-secret identity for DISPLAY only — the
 * gateway id / provider / base URL / configured model that `golem status`,
 * `golem statusline`, and the VS Code extension show. Wraps
 * {@link resolveActiveUpstream} (same fail-closed semantics for an unknown
 * gateway) but drops the credential/auth-scheme, which display surfaces
 * never need. `resolveActiveUpstream` reads secrets from the environment; here
 * the env is irrelevant (no key is surfaced), so an empty env is passed.
 */
export function resolveUpstreamDisplay(settings: UpstreamDisplaySettings): UpstreamDisplay {
  // R9.23: the selector may name a compound TARGET id (e.g.
  // `openrouter:deepseek/...`), which is how `inference.default_target` is
  // normally set. Routing resolves it through the target registry
  // (`resolveDefaultTargetId`), so display must too — treating it as a gateway
  // id falls back to the legacy config and reports the wrong upstream. A bare
  // gateway id (e.g. `openrouter`) resolves via the gateway path below.
  const registrySettings: TargetRegistrySettings = {
    upstream_provider: settings.upstream_provider,
    upstream_base_url: settings.upstream_base_url,
    ...(settings.upstream_model !== undefined ? { upstream_model: settings.upstream_model } : {}),
    upstream_auth_scheme: settings.upstream_auth_scheme,
    ...(settings.gateways !== undefined ? { gateways: settings.gateways } : {}),
    ...(settings.default_target !== undefined ? { default_target: settings.default_target } : {}),
  };
  const targetId = resolveDefaultTargetId(registrySettings);
  const target = listTargets(registrySettings).find((t) => t.id === targetId);
  if (target !== undefined && target.origin !== "default") {
    return {
      accountId: target.accountId,
      provider: target.provider,
      baseUrl: target.baseUrl,
      model: target.model,
    };
  }

  const { resolved, warning } = resolveActiveUpstream(
    {
      legacy: {
        provider: settings.upstream_provider,
        base_url: settings.upstream_base_url,
        ...(settings.upstream_model !== undefined ? { model: settings.upstream_model } : {}),
        auth_scheme: resolveAuthScheme(settings.upstream_provider, settings.upstream_auth_scheme),
      },
      ...(settings.gateways !== undefined ? { gateways: settings.gateways } : {}),
      ...(settings.default_target !== undefined ? { activeAccount: settings.default_target } : {}),
      ...(settings.targets !== undefined
        ? { knownTargetIds: settings.targets.map((t) => t.id) }
        : {}),
      legacyApiKey: undefined,
    },
    {},
  );
  return {
    accountId: resolved.accountId,
    provider: resolved.provider,
    baseUrl: resolved.baseUrl,
    model: resolved.model,
    ...(warning !== undefined ? { warning } : {}),
  };
}
