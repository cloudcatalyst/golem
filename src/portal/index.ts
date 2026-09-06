/**
 * Portal sign-in: authorization code + PKCE over a loopback redirect (RFC 8252),
 * with the tokens in the OS keychain.
 *
 * `pkce.ts`      — verifier/challenge/state, and the constant-time comparison
 * `discovery.ts` — RFC 8414 metadata, so endpoints are discovered not hardcoded
 * `loopback.ts`  — the one-request `127.0.0.1` listener, where `state` is checked
 * `browser.ts`   — opening the system browser, and the honest headless refusal
 * `exchange.ts`  — the authorization URL and the token endpoint (code + refresh)
 * `tokens.ts`    — keychain storage, via the ADR-0003 credential seam
 * `client.ts`    — authorized requests, and the ONE-refresh-then-relink ladder
 * `link.ts`      — the flow, start to finish
 * `config.ts`    — `portal.*` settings to URLs and ids
 *
 * **ADR-0003 invariant 4 holds here too**: nothing under `src/mcp/` or
 * `src/tools/` may import this module. A tool call cannot sign a user in, and
 * cannot read the token it produced.
 */

export {
  type BrowserOpener,
  HEADLESS_MESSAGE,
  hasDisplay,
  openerCommand,
  type PlatformProbe,
  printingBrowser,
  systemBrowser,
} from "./browser.js";
export {
  createPortalClient,
  type PortalClient,
  type PortalClientOptions,
  type PortalClientStats,
  type PortalIdentity,
} from "./client.js";
export {
  type PortalConfig,
  type PortalSettings,
  resolvePortalConfig,
} from "./config.js";
export {
  assertSupportsThisFlow,
  type AuthorizationServerMetadata,
  discoverAuthorizationServer,
  type DiscoveryOptions,
  discoveryUrlFor,
  type FetchLike,
  isLoopback,
  supportsRefresh,
} from "./discovery.js";
export {
  describeOAuthError,
  PortalAuthError,
  type PortalAuthErrorKind,
} from "./errors.js";
export {
  assertScopesSupported,
  type AuthorizationRequest,
  authorizationUrl,
  DEFAULT_SCOPES,
  exchangeCode,
  type ExchangeOptions,
  refreshTokens,
  type RefreshOptions,
} from "./exchange.js";
export {
  type LinkOptions,
  type LinkResult,
  linkPortal,
  type PortalStatus,
  portalStatus,
  type StatusOptions,
  unlinkPortal,
  type UnlinkResult,
} from "./link.js";
export {
  CALLBACK_PATH,
  LOOPBACK_HOST,
  type LoopbackListener,
  type LoopbackOptions,
  startLoopbackListener,
} from "./loopback.js";
export {
  challengeFor,
  createPkcePair,
  createState,
  type PkcePair,
  type RandomBytes,
  statesMatch,
} from "./pkce.js";
export {
  describeTokenSet,
  EXPIRY_SKEW_MS,
  isExpired,
  PORTAL_ACCOUNT,
  type PortalTokenSet,
  type PortalTokenStore,
  portalTokenStore,
  type TokenBinding,
  type TokenSummary,
} from "./tokens.js";
