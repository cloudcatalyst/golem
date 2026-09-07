/**
 * One error type for the whole portal auth flow.
 *
 * Every failure a user can hit while running `golem team link` is one of these,
 * with a `kind` a caller can branch on and a message that says what is actually
 * true. The headless case in particular must NOT read like a timeout: Clerk
 * advertises `authorization_code` and `refresh_token` only, so there is no
 * device authorization grant (RFC 8628) and a machine with no browser cannot
 * complete this flow at all. That is a portal v1 decision, not an oversight, and
 * the error says so.
 *
 * **No token ever appears in one of these.** Error construction never
 * interpolates a response body: the token endpoint's failure shape is
 * `{error, error_description}` (RFC 6749 §5.2) and only those two fields are
 * quoted back. A raw body could carry a credential into a log, and logs are the
 * one place ADR-0003 is most easily undone by accident.
 */

export type PortalAuthErrorKind =
  /** No `portal.client_id` / `portal.url` configured yet. */
  | "not_configured"
  /** The authorization-server metadata could not be fetched or did not parse. */
  | "discovery_failed"
  /** The server does not advertise something this flow requires (e.g. S256). */
  | "unsupported_server"
  /** No system browser could be opened — including the genuinely headless case. */
  | "no_browser"
  /** The user did not finish in the browser before the deadline. */
  | "timed_out"
  /** The authorization server redirected back with an `error` parameter. */
  | "authorization_denied"
  /** The `state` that came back is not the one that went out. */
  | "state_mismatch"
  /** The token endpoint refused the exchange or the refresh. */
  | "token_exchange_failed"
  /** No stored token — `golem team link` has not been run on this machine. */
  | "not_linked"
  /** The portal API answered with something other than success. */
  | "api_error"
  /** There is nowhere OS-backed to put the token on this machine. */
  | "no_secure_store";

export class PortalAuthError extends Error {
  readonly kind: PortalAuthErrorKind;
  /** HTTP status, when the failure came from a response. */
  readonly status?: number;

  constructor(kind: PortalAuthErrorKind, message: string, status?: number) {
    super(message);
    this.name = "PortalAuthError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Render an OAuth error response without echoing the body.
 *
 * RFC 6749 §5.2 gives `error` and `error_description`; anything else in the
 * payload is not ours to quote. A 4xx from a token endpoint has been observed in
 * the wild to include the request that caused it — which is the request that
 * carried the `code_verifier`.
 */
export function describeOAuthError(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "no error detail was returned";
  const record = payload as Record<string, unknown>;
  const code = typeof record.error === "string" ? record.error : undefined;
  const detail =
    typeof record.error_description === "string" ? record.error_description : undefined;
  if (code === undefined && detail === undefined) return "no error detail was returned";
  if (detail === undefined) return code as string;
  if (code === undefined) return detail;
  return `${code}: ${detail}`;
}
