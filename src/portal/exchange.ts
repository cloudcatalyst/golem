/**
 * The two calls that talk to the authorization server: build the authorization
 * URL, and POST the token endpoint (code exchange and refresh).
 *
 * **No client secret appears anywhere in this file, by construction.** The
 * harness is a public client — it ships as source — so the OAuth application is
 * registered `public: true` and PKCE stands in for the secret. If a future
 * change ever wants to add one, it belongs in the credential store, not here.
 *
 * **`offline_access` is required, not optional.** Without it the server issues
 * no refresh token and the user is sent back through the browser every time the
 * access token expires. It is in {@link DEFAULT_SCOPES} for that reason and the
 * scope list is validated against the server's advertised `scopes_supported`
 * before the browser opens, so a misconfigured OAuth application fails before it
 * costs the user a sign-in.
 */

import { z } from "zod";
import type { AuthorizationServerMetadata, FetchLike } from "./discovery.js";
import { describeOAuthError, PortalAuthError } from "./errors.js";
import type { PkcePair } from "./pkce.js";
import type { PortalTokenSet } from "./tokens.js";

/**
 * What `golem team link` asks for.
 *
 * `openid profile email` identify the user for `GET /api/v1/me`;
 * `offline_access` is what yields the refresh token. Nothing org-scoped is
 * requested here — choosing a team is `project-team-binding`'s job.
 */
export const DEFAULT_SCOPES: readonly string[] = ["openid", "profile", "email", "offline_access"];

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

export interface AuthorizationRequest {
  readonly metadata: AuthorizationServerMetadata;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly pkce: PkcePair;
  readonly scopes?: readonly string[];
}

/**
 * Reject a scope the server does not advertise, while the failure is still free.
 *
 * Silently dropping it is worse than failing: losing `offline_access` produces a
 * link that works once and then re-prompts forever, which reads as a bug in the
 * harness rather than as a misregistered OAuth application.
 */
export function assertScopesSupported(
  metadata: AuthorizationServerMetadata,
  scopes: readonly string[],
): void {
  const supported = metadata.scopes_supported;
  if (supported === undefined) return;
  const missing = scopes.filter((s) => !supported.includes(s));
  if (missing.length === 0) return;
  throw new PortalAuthError(
    "unsupported_server",
    `${metadata.issuer} does not advertise the scope(s) ${missing.join(", ")}. ` +
      (missing.includes("offline_access")
        ? "Without `offline_access` the portal issues no refresh token and you would be sent " +
          "back through the browser every time the access token expires, so Golem refuses " +
          "to link rather than ship that. "
        : "") +
      "The OAuth application needs re-registering by the portal operator.",
  );
}

/** The URL the browser is sent to. Carries the challenge, never the verifier. */
export function authorizationUrl(request: AuthorizationRequest): string {
  const scopes = request.scopes ?? DEFAULT_SCOPES;
  assertScopesSupported(request.metadata, scopes);
  const url = new URL(request.metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.pkce.challenge);
  url.searchParams.set("code_challenge_method", request.pkce.method);
  return url.href;
}

interface TokenPostOptions {
  readonly metadata: AuthorizationServerMetadata;
  readonly body: URLSearchParams;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /** Which failure this is, so the error `kind` stays accurate. */
  readonly what: string;
}

/**
 * POST the token endpoint and validate the answer.
 *
 * The failure path deliberately does NOT include the response body — see
 * `errors.ts`. The request body is never logged either: it carries the
 * `code_verifier` on exchange and the refresh token on refresh.
 */
async function postToken(options: TokenPostOptions): Promise<z.infer<typeof tokenResponseSchema>> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await fetchImpl(options.metadata.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: options.body.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new PortalAuthError(
      "token_exchange_failed",
      `could not reach the token endpoint for the ${options.what}: ${why}`,
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new PortalAuthError(
      "token_exchange_failed",
      `the ${options.what} was refused (HTTP ${response.status}): ${describeOAuthError(payload)}`,
      response.status,
    );
  }

  const parsed = tokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new PortalAuthError(
      "token_exchange_failed",
      `the token endpoint's answer to the ${options.what} was not a valid token response`,
      response.status,
    );
  }
  return parsed.data;
}

function toTokenSet(
  response: z.infer<typeof tokenResponseSchema>,
  binding: { issuer: string; clientId: string },
  previous: PortalTokenSet | null,
  now: number,
): PortalTokenSet {
  // RFC 6749 §6: a refresh response MAY omit `refresh_token`, in which case the
  // one already held stays valid. Dropping it would turn every silent refresh
  // into "you must sign in again" one expiry later.
  const refresh = response.refresh_token ?? previous?.refresh_token;
  return {
    issuer: binding.issuer,
    client_id: binding.clientId,
    access_token: response.access_token,
    ...(refresh === undefined ? {} : { refresh_token: refresh }),
    token_type: response.token_type,
    ...(response.scope === undefined ? {} : { scope: response.scope }),
    ...(response.expires_in === undefined ? {} : { expires_at: now + response.expires_in * 1000 }),
    obtained_at: now,
  };
}

export interface ExchangeOptions {
  readonly metadata: AuthorizationServerMetadata;
  readonly clientId: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly verifier: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/** Step 6 of the flow: authorization code + verifier in, token set out. */
export async function exchangeCode(options: ExchangeOptions): Promise<PortalTokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    code_verifier: options.verifier,
  });
  const response = await postToken({
    metadata: options.metadata,
    body,
    what: "authorization code exchange",
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const now = (options.now ?? Date.now)();
  return toTokenSet(
    response,
    { issuer: options.metadata.issuer, clientId: options.clientId },
    null,
    now,
  );
}

export interface RefreshOptions {
  readonly metadata: AuthorizationServerMetadata;
  readonly clientId: string;
  readonly tokens: PortalTokenSet;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/** `grant_type=refresh_token`. Throws when there is no refresh token to use. */
export async function refreshTokens(options: RefreshOptions): Promise<PortalTokenSet> {
  const refreshToken = options.tokens.refresh_token;
  if (refreshToken === undefined) {
    throw new PortalAuthError(
      "token_exchange_failed",
      "the stored portal token has no refresh token, so it cannot be renewed. " +
        "That usually means `offline_access` was not granted when it was minted.",
    );
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: options.clientId,
  });
  const response = await postToken({
    metadata: options.metadata,
    body,
    what: "token refresh",
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const now = (options.now ?? Date.now)();
  return toTokenSet(
    response,
    { issuer: options.metadata.issuer, clientId: options.clientId },
    options.tokens,
    now,
  );
}
