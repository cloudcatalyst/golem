/**
 * Authorization-server discovery (RFC 8414).
 *
 * **Discover, do not hardcode.** The endpoints live at
 * `<issuer>/.well-known/oauth-authorization-server`, which is what lets one
 * `portal.url` (or `GOLEM_PORTAL_URL`) point the harness at development,
 * staging or production without a code change. Hardcoding
 * `<frontend-api>/oauth/authorize` would work today and break the first time the
 * portal operator moves an environment.
 *
 * Two assertions are made here rather than at the point of use, because both
 * produce a far worse error later than they do now:
 *
 * - **`S256` must be advertised.** The server refuses `plain`. Discovering that
 *   at the token endpoint means the user has already signed in and consented in
 *   a browser before anything fails.
 * - **`authorization_code` must be advertised.** The same server also advertises
 *   `refresh_token`; it advertises no device authorization grant (RFC 8628),
 *   which is exactly why there is no headless path (see `errors.ts`).
 *
 * **Transport.** Every URL involved must be `https:`, with a loopback exemption
 * so the flow can be exercised end to end against a local test server. A plain
 * `http:` authorization server on a real host would put the `code` and the
 * `code_verifier` on the wire in the clear.
 */

import { z } from "zod";
import { PortalAuthError } from "./errors.js";

/** The subset of RFC 8414 metadata this flow actually reads. */
const metadataSchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  grant_types_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  scopes_supported: z.array(z.string()).optional(),
});

export type AuthorizationServerMetadata = z.infer<typeof metadataSchema>;

/** The `fetch` seam. Node 22 has a global one; tests pass their own. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Loopback is the one host where `http:` is acceptable (RFC 8252 §8.3). */
export function isLoopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost";
}

function requireSecure(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PortalAuthError("discovery_failed", `the ${what} is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && !isLoopback(url)) {
    throw new PortalAuthError(
      "unsupported_server",
      `the ${what} must be https (got ${url.protocol.replace(":", "")}): ${raw}. ` +
        "Refusing to carry an authorization code over a cleartext connection.",
    );
  }
  return url;
}

/** `<issuer>/.well-known/oauth-authorization-server`, with no double slash. */
export function discoveryUrlFor(issuerBase: string): string {
  const base = requireSecure(issuerBase, "portal URL");
  const trimmed = base.href.replace(/\/+$/, "");
  return `${trimmed}/.well-known/oauth-authorization-server`;
}

export interface DiscoveryOptions {
  readonly fetchImpl?: FetchLike;
  /** Abort the metadata request after this long. Default 15s. */
  readonly timeoutMs?: number;
}

/**
 * Fetch and validate the authorization server's metadata.
 *
 * The response is validated with zod because it is an external boundary in the
 * strictest sense: it decides where this process is about to POST a credential.
 */
export async function discoverAuthorizationServer(
  issuerBase: string,
  options: DiscoveryOptions = {},
): Promise<AuthorizationServerMetadata> {
  const url = discoveryUrlFor(issuerBase);
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? 15_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new PortalAuthError(
      "discovery_failed",
      `could not reach the portal's authorization server at ${url}: ${why}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new PortalAuthError(
      "discovery_failed",
      `the portal's authorization server metadata at ${url} answered ${response.status}. ` +
        "Check `portal.url` — it must be the Clerk Frontend API URL (the issuer), " +
        "not the portal's web address.",
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PortalAuthError("discovery_failed", `${url} did not return JSON`);
  }

  const parsed = metadataSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined ? "unknown field" : first.path.join(".");
    throw new PortalAuthError(
      "discovery_failed",
      `${url} is not valid authorization server metadata (${where}: ${first?.message ?? "invalid"})`,
    );
  }

  const metadata = parsed.data;
  requireSecure(metadata.authorization_endpoint, "authorization_endpoint");
  requireSecure(metadata.token_endpoint, "token_endpoint");
  assertSupportsThisFlow(metadata);
  return metadata;
}

/**
 * Refuse a server this flow cannot actually use, while it is still cheap.
 *
 * A server that advertises neither list is taken at its word rather than
 * rejected: RFC 8414 makes both fields optional, and the failure mode of
 * proceeding is one honest error from the token endpoint.
 */
export function assertSupportsThisFlow(metadata: AuthorizationServerMetadata): void {
  const methods = metadata.code_challenge_methods_supported;
  if (methods !== undefined && !methods.includes("S256")) {
    throw new PortalAuthError(
      "unsupported_server",
      `${metadata.issuer} does not advertise the S256 PKCE challenge method ` +
        `(it advertises ${methods.join(", ") || "nothing"}). Golem will not fall back to ` +
        "`plain`: without S256 an intercepted authorization code is enough to get a token.",
    );
  }
  const grants = metadata.grant_types_supported;
  if (grants !== undefined && !grants.includes("authorization_code")) {
    throw new PortalAuthError(
      "unsupported_server",
      `${metadata.issuer} does not advertise the authorization_code grant ` +
        `(it advertises ${grants.join(", ") || "nothing"}), so there is no flow to run.`,
    );
  }
}

/** Whether the server can issue refresh tokens at all, for honest messaging. */
export function supportsRefresh(metadata: AuthorizationServerMetadata): boolean {
  const grants = metadata.grant_types_supported;
  return grants === undefined || grants.includes("refresh_token");
}
