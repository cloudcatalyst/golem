/**
 * R6.2 v1 — account switching (spec Decision 21d; ADR-0003).
 *
 * A pure resolver that turns the proxy's account registry + the selected active
 * account into the concrete upstream a request should use. Legitimate
 * account/provider switching only — the automated quota-evasion half is OUT of
 * scope (ADR-0003 ToS decision). There is NO per-request routing here (that is
 * 21e, future); one account is active per proxy run, chosen explicitly.
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
 * Resolve the active upstream from the registry + selection. `active_account`
 * unset → the legacy top-level config. Set + found → that account (secret from
 * its per-account env var). Set + NOT found → legacy config + a warning (never a
 * different registry account — ADR-0003 fail-closed).
 */
export function resolveActiveUpstream(
  input: {
    readonly legacy: LegacyUpstream;
    readonly accounts?: readonly UpstreamAccount[];
    readonly activeAccount?: string;
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
    return {
      resolved: legacyResolved,
      warning:
        `active_account "${input.activeAccount}" is not in proxy.accounts — ` +
        "using the top-level upstream config instead (no silent switch to another account).",
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
