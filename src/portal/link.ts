/**
 * `golem team link`, end to end.
 *
 * The ordering here is not incidental. The listener is bound BEFORE the browser
 * opens, because the `redirect_uri` in the authorization URL has to name a port
 * that already exists; opening the browser first is a race that fails as a
 * connection-refused page in the user's face. And the listener is closed in a
 * `finally`, because a half-open loopback socket on a machine where sign-in was
 * abandoned is a listening port the user did not ask for.
 *
 * Nothing is stored until the token exchange succeeds, so an abandoned or
 * refused sign-in leaves the machine exactly as it was.
 */

import type { CredentialLocation } from "../credentials/index.js";
import type { BrowserOpener } from "./browser.js";
import {
  type AuthorizationServerMetadata,
  discoverAuthorizationServer,
  type FetchLike,
} from "./discovery.js";
import { PortalAuthError } from "./errors.js";
import { authorizationUrl, DEFAULT_SCOPES, exchangeCode } from "./exchange.js";
import { startLoopbackListener } from "./loopback.js";
import { createPkcePair, createState, type RandomBytes, statesMatch } from "./pkce.js";
import {
  describeTokenSet,
  type PortalTokenSet,
  type PortalTokenStore,
  type TokenSummary,
} from "./tokens.js";

export interface LinkOptions {
  /** The authorization server (Clerk Frontend API URL). */
  readonly issuerUrl: string;
  readonly clientId: string;
  readonly tokens: PortalTokenStore;
  readonly browser: BrowserOpener;
  readonly scopes?: readonly string[];
  /** How long the user has to finish in the browser. Default 5 min. */
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
  readonly random?: RandomBytes;
  /** Progress narration. Defaults to silence, so a library caller is quiet. */
  readonly write?: (text: string) => void;
}

export interface LinkResult {
  readonly location: CredentialLocation;
  readonly summary: TokenSummary;
  readonly metadata: AuthorizationServerMetadata;
  readonly tokens: PortalTokenSet;
}

export async function linkPortal(options: LinkOptions): Promise<LinkResult> {
  const write = options.write ?? (() => {});
  const scopes = options.scopes ?? DEFAULT_SCOPES;

  write(`Discovering the portal's authorization server at ${options.issuerUrl}...\n`);
  const metadata = await discoverAuthorizationServer(options.issuerUrl, {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  const pkce = createPkcePair(options.random);
  const state = createState(options.random);

  const listener = await startLoopbackListener({
    expectedState: state,
    statesMatch,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  try {
    const url = authorizationUrl({
      metadata,
      clientId: options.clientId,
      redirectUri: listener.redirectUri,
      state,
      pkce,
      scopes,
    });

    write(`Listening on ${listener.redirectUri} for the sign-in callback.\n`);
    await options.browser.open(url);

    const code = await listener.waitForCode();
    write("Sign-in received. Exchanging the authorization code...\n");

    const tokens = await exchangeCode({
      metadata,
      clientId: options.clientId,
      code,
      redirectUri: listener.redirectUri,
      verifier: pkce.verifier,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    if (tokens.refresh_token === undefined) {
      // Not fatal — the link works — but silence here becomes "why does it keep
      // asking me to sign in?" a week later, with nothing to point at.
      write(
        "Warning: the portal issued no refresh token, so you will be asked to sign in " +
          "again when this one expires. That means `offline_access` was not granted.\n",
      );
    }

    const location = await options.tokens.write(tokens);
    const summary = describeTokenSet(tokens, (options.now ?? Date.now)());
    return { location, summary, metadata, tokens };
  } finally {
    await listener.close();
  }
}

export interface UnlinkResult {
  readonly removed: readonly CredentialLocation[];
}

/**
 * Forget the stored token.
 *
 * Local only: it does not revoke anything at the authorization server, and says
 * so, because "signed out" that leaves a live token behind is the kind of claim
 * that gets believed.
 */
export async function unlinkPortal(tokens: PortalTokenStore): Promise<UnlinkResult> {
  return { removed: await tokens.clear() };
}

export interface PortalStatus {
  readonly linked: boolean;
  readonly issuer: string;
  readonly clientId: string;
  readonly apiBaseUrl: string;
  readonly token: TokenSummary | null;
}

export interface StatusOptions {
  readonly issuerUrl: string;
  readonly apiBaseUrl: string;
  readonly clientId: string;
  readonly tokens: PortalTokenStore;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
}

/**
 * Non-secret link status.
 *
 * Discovery is attempted so the issuer reported is the real one rather than the
 * configured string, but an unreachable portal degrades to "not linked" instead
 * of failing: `golem team status` must work offline. Nothing about a team link
 * may stop the harness from being usable (the portal's own failure rule).
 */
export async function portalStatus(options: StatusOptions): Promise<PortalStatus> {
  let issuer = options.issuerUrl;
  let token: TokenSummary | null = null;
  try {
    const metadata = await discoverAuthorizationServer(options.issuerUrl, {
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    issuer = metadata.issuer;
    const stored = await options.tokens.read({ issuer, clientId: options.clientId });
    if (stored !== null) token = describeTokenSet(stored, (options.now ?? Date.now)());
  } catch (err) {
    if (!(err instanceof PortalAuthError)) throw err;
  }
  return {
    linked: token !== null,
    issuer,
    clientId: options.clientId,
    apiBaseUrl: options.apiBaseUrl,
    token,
  };
}
