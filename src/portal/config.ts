/**
 * Turning the `portal.*` settings into the three URLs/ids the flow needs.
 *
 * **Why there are two URLs and not one.** The portal's contract says a single
 * `GOLEM_PORTAL_URL` plus discovery points the harness at any environment. That
 * is true of the *authorization server* half — the endpoints really do come from
 * `<issuer>/.well-known/oauth-authorization-server`. It is not true of the API
 * half: `/api/v1/me` lives on the portal's own domain (`golem.run`), while the
 * issuer is Clerk's Frontend API (`https://clerk.<domain>`, or
 * `https://<slug>.clerk.accounts.dev` in development). They are different
 * origins, and no endpoint in the v1 contract maps one to the other.
 *
 * So `portal.url` is the API base, and `portal.issuer` is the authorization
 * server — with `portal.url` used for BOTH when `portal.issuer` is empty, which
 * is what makes the contract's single-variable claim true for any deployment
 * that publishes the metadata document at its own origin. The day the portal
 * grows an endpoint that advertises its issuer, this is the one function that
 * has to change.
 *
 * **`portal.client_id` has no default on purpose.** Registering the OAuth
 * application is a one-off act by the portal operator (`owner: user`), so a
 * baked-in id would either be wrong or would be a real client id compiled into a
 * public repository. Empty means "not configured", and the error says which
 * setting to set.
 */

import { PortalAuthError } from "./errors.js";

/** The `portal` settings section, structurally. */
export interface PortalSettings {
  readonly url: string;
  readonly issuer: string;
  readonly client_id: string;
  readonly link_timeout_ms: number;
}

export interface PortalConfig {
  /** Portal API base — `/api/v1/...` hangs off this. */
  readonly apiBaseUrl: string;
  /** Authorization server base — discovery hangs off this. */
  readonly issuerUrl: string;
  readonly clientId: string;
  readonly linkTimeoutMs: number;
}

export function resolvePortalConfig(settings: PortalSettings): PortalConfig {
  const apiBaseUrl = settings.url.trim().replace(/\/+$/, "");
  if (apiBaseUrl === "") {
    throw new PortalAuthError(
      "not_configured",
      "no portal is configured. Set `portal.url` (or GOLEM_PORTAL_URL) to the portal's " +
        "address, e.g. `golem config set portal.url https://golem.run`.",
    );
  }
  const clientId = settings.client_id.trim();
  if (clientId === "") {
    throw new PortalAuthError(
      "not_configured",
      "no portal OAuth client id is configured. The portal operator registers one public " +
        "OAuth application per distributed client and publishes its id; set it with " +
        "`golem config set portal.client_id <id>` (or GOLEM_PORTAL_CLIENT_ID).",
    );
  }
  const issuer = settings.issuer.trim().replace(/\/+$/, "");
  return {
    apiBaseUrl,
    issuerUrl: issuer === "" ? apiBaseUrl : issuer,
    clientId,
    linkTimeoutMs: settings.link_timeout_ms,
  };
}
