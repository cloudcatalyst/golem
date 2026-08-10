/**
 * R6.2 v1 — account switching (spec Decision 21d; ADR-0003).
 *
 * A pure resolver that turns the proxy's account registry + the selected active
 * account into the concrete upstream a request should use. Legitimate
 * account/provider switching only — the automated quota-evasion half is OUT of
 * scope (ADR-0003 ToS decision). There is NO per-request routing **in this
 * module** — it resolves the single active account, and stays the degenerate
 * one-target case. Per-request routing across many targets shipped in R9.2 and
 * lives in `providers/routing.ts` (the pure precedence chain) plus
 * `cli/route-resolver.ts` (registry lookup + transport), keyed off the R9.1
 * target registry rather than this account registry.
 *
 * ADR-0003 invariants honoured here:
 * - **Secrets are never a setting.** An account entry holds only non-secret
 *   identity (id, provider, base_url, model, auth_scheme). The credential comes
 *   from a per-account env var {@link perAccountEnvVar}; the legacy single
 *   account uses `GOLEM_UPSTREAM_API_KEY`.
 * - **Fail-closed / no silent cross-account fallback.** An `active_account` that
 *   names an unknown id does NOT silently use a different registry account — it
 *   falls back to the user's own top-level (legacy) config and reports a
 *   warning. A missing credential is surfaced downstream (the request 401s),
 *   never swapped for another account's key.
 */

import { resolveAuthScheme, type UpstreamAuthScheme, type UpstreamProvider } from "./index.js";

/** A non-secret account entry (from `proxy.accounts`). */
export interface UpstreamAccount {
  readonly id: string;
  readonly provider: UpstreamProvider;
  readonly base_url: string;
  readonly model?: string;
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
  /** The active account id, or null when the legacy top-level config is in use. */
  readonly accountId: string | null;
}

/** The environment variable carrying account `id`'s secret, e.g. `work` → `GOLEM_UPSTREAM_API_KEY__WORK`. */
export function perAccountEnvVar(id: string): string {
  return `GOLEM_UPSTREAM_API_KEY__${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export interface ResolveResult {
  readonly resolved: ResolvedUpstream;
  /** A loud misconfiguration note (unknown active account) for the caller to surface; else undefined. */
  readonly warning?: string;
}

/**
 * Resolve the active upstream from the registry + selection. The selector
 * (`proxy.default_target`, renamed from `active_account` in R9.1)
 * unset → the legacy top-level config. Set + found → that account (secret from
 * its per-account env var). Set + NOT found → legacy config + a warning (never a
 * different registry account — ADR-0003 fail-closed).
 */
export function resolveActiveUpstream(
  input: {
    readonly legacy: LegacyUpstream;
    readonly accounts?: readonly UpstreamAccount[];
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

  const account = input.accounts?.find((a) => a.id === input.activeAccount);
  if (account === undefined) {
    // R9.6: since R9.1 the selector is `proxy.default_target`, which may name a
    // target rather than an account. That is not a misconfiguration — the target
    // registry serves it — so the account layer stands aside without comment.
    // A genuinely unknown id still warns here, and the proxy separately
    // fail-closes on it against BOTH registries at startup.
    if (input.knownTargetIds?.includes(input.activeAccount) === true) {
      return { resolved: legacyResolved };
    }
    return {
      resolved: legacyResolved,
      warning:
        `proxy.default_target "${input.activeAccount}" is in neither proxy.accounts nor ` +
        "proxy.targets — using the top-level upstream config instead (no silent switch).",
    };
  }

  return {
    resolved: {
      provider: account.provider,
      baseUrl: account.base_url,
      model: account.model,
      authScheme: resolveAuthScheme(account.provider, account.auth_scheme ?? "inherit"),
      apiKey: env[perAccountEnvVar(account.id)],
      accountId: account.id,
    },
  };
}

/** The non-secret upstream identity for display surfaces (status/statusline/extension). */
export interface UpstreamDisplay {
  /** Active account id, or null when the legacy top-level config is in use. */
  readonly accountId: string | null;
  readonly provider: UpstreamProvider;
  readonly baseUrl: string;
  /** Configured default model (undefined for a byte-faithful Anthropic upstream). */
  readonly model: string | undefined;
  /** A loud misconfiguration note (unknown active account) to surface; else undefined. */
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
  readonly accounts?: readonly UpstreamAccount[];
  /** R9.6: the selector, renamed from `active_account` in R9.1. */
  readonly default_target?: string;
  /**
   * R9.6: ids the target registry knows. The selector may legitimately name a
   * TARGET rather than an account, in which case the account layer must stand
   * aside silently — routing owns it. Without this the account layer would warn
   * about a perfectly valid target id.
   */
  readonly targets?: readonly { readonly id: string }[];
}

/**
 * Resolve the active upstream's non-secret identity for DISPLAY only — the
 * account id / provider / base URL / configured model that `golem status`,
 * `golem statusline`, and the VS Code extension show. Wraps
 * {@link resolveActiveUpstream} (same fail-closed semantics for an unknown
 * active account) but drops the credential/auth-scheme, which display surfaces
 * never need. `resolveActiveUpstream` reads secrets from the environment; here
 * the env is irrelevant (no key is surfaced), so an empty env is passed.
 */
export function resolveUpstreamDisplay(settings: UpstreamDisplaySettings): UpstreamDisplay {
  const { resolved, warning } = resolveActiveUpstream(
    {
      legacy: {
        provider: settings.upstream_provider,
        base_url: settings.upstream_base_url,
        ...(settings.upstream_model !== undefined ? { model: settings.upstream_model } : {}),
        auth_scheme: resolveAuthScheme(settings.upstream_provider, settings.upstream_auth_scheme),
      },
      ...(settings.accounts !== undefined ? { accounts: settings.accounts } : {}),
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
