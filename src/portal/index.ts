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
 * `project-team-binding` adds the two that are about a PROJECT rather than a
 * machine, and neither touches a credential:
 *
 * `binding.ts`     — which team this project names, and the Decision 64 gate
 * `entitlement.ts` — "cannot reach" versus "not entitled", decided in one place
 *
 * **ADR-0003 invariant 4 holds here too**: nothing under `src/mcp/` or
 * `src/tools/` may import this module. A tool call cannot sign a user in, and
 * cannot read the token it produced.
 */

export {
  type BindTeamOptions,
  type BindTeamResult,
  bindTeam,
  chooseOrganization,
  isValidOrgId,
  type OrganizationChoice,
  type PortalOrganization,
  readTeamBinding,
  TEAM_CACHE_DIR_NAME,
  TEAM_SKILLS_DIR,
  TEAM_SKILLS_PREFIX,
  type TeamBinding,
  type TeamBindingState,
  type TeamSettings,
  teamApiBaseUrl,
  teamCachePath,
  type UnbindTeamOptions,
  type UnbindTeamResult,
  unbindTeam,
} from "./binding.js";
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
  type AuthorizationServerMetadata,
  assertSupportsThisFlow,
  type DiscoveryOptions,
  discoverAuthorizationServer,
  discoveryUrlFor,
  type FetchLike,
  isLoopback,
  supportsRefresh,
} from "./discovery.js";
export {
  classifyPortalError,
  classifyPortalResponse,
  type DescribeOutcomeOptions,
  describeCacheAge,
  describeTeamOutcome,
  mayUseCachedTeamLayer,
  type NotEntitledCode,
  type TeamLayerDisposition,
} from "./entitlement.js";
export {
  describeOAuthError,
  PortalAuthError,
  type PortalAuthErrorKind,
} from "./errors.js";
export {
  type AuthorizationRequest,
  assertScopesSupported,
  authorizationUrl,
  DEFAULT_SCOPES,
  type ExchangeOptions,
  exchangeCode,
  type RefreshOptions,
  refreshTokens,
} from "./exchange.js";
export {
  type LinkOptions,
  type LinkResult,
  linkPortal,
  type PortalStatus,
  portalStatus,
  type StatusOptions,
  type UnlinkResult,
  unlinkPortal,
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
  type ConfigWithTeam,
  type FetchTeamSettingsResult,
  fetchTeamSettings,
  type LoadConfigWithTeamOptions,
  listTeamLayerCaches,
  loadConfigWithTeamLayer,
  type ResolveForProjectOptions,
  type ResolveTeamLayerOptions,
  readTeamLayerCache,
  resolveTeamLayer,
  resolveTeamLayerForProject,
  type SyncTeamLayerOptions,
  type SyncTeamLayerResult,
  syncTeamLayer,
  type TeamCacheDenial,
  type TeamCacheStatus,
  type TeamLayerCache,
  type TeamLayerForConfig,
  type TeamLayerResolution,
  type TeamSettingRow,
  type TeamSettingsResponse,
  type TranslatedTeamLayer,
  teamLayerSource,
  teamSettingsPath,
  translateTeamRows,
  writeTeamLayerCache,
} from "./team-layer.js";
export {
  describeTokenSet,
  EXPIRY_SKEW_MS,
  isExpired,
  PORTAL_ACCOUNT,
  type PortalTokenSet,
  type PortalTokenStore,
  portalTokenPresent,
  portalTokenStore,
  type TokenBinding,
  type TokenSummary,
} from "./tokens.js";
