/**
 * R13.4 — device and user authentication for Golem's write surface.
 *
 * Two independent claims, both required, neither able to stand in for the
 * other: a client certificate this project's device CA issued (the *device*),
 * and a live unlock window opened by a passcode (the *person*). Failure is
 * denial, never a degraded mode. The observe-tier dashboard (R12.5) is a
 * different server with no write route and is unaffected — an unpaired browser
 * still gets it.
 *
 * Design: ADR-0007 §7, invariants 1, 3 and 8. Enrolment is local-only, forever
 * (ADR-0006 §3c-1, inherited verbatim). The passcode rather than a passkey is a
 * MEASURED choice, not a fallback — see `user-factor.ts` and
 * `docs/plan/verification-notes.md` §146.
 */

export { ensureDeviceCa, type LoadedDeviceCa, readDeviceCa } from "./device-ca-store.js";
export {
  activeDeviceCount,
  addDevice,
  CATALOG_VERSION,
  type DeviceCatalog,
  type DeviceRecord,
  findByFingerprint,
  listDevices,
  type RevokeOutcome,
  readCatalog,
  revokeDevice,
  touchLastSeen,
} from "./device-store.js";
export {
  type ClaimOptions,
  type ClaimRejection,
  type ClaimResult,
  cancelEnrolment,
  claimEnrolment,
  DEFAULT_ENROLMENT_TTL_MINUTES,
  normaliseCode,
  type PendingEnrolment,
  pendingEnrolmentInfo,
  type StartEnrolmentOptions,
  startEnrolment,
} from "./enrolment.js";
export {
  credentialBundlePath,
  deviceCaKeyPath,
  deviceCaPath,
  deviceCatalogPath,
  deviceDir,
  pendingEnrolmentPath,
  unlockSessionPath,
  userFactorPath,
} from "./paths.js";
export {
  checkFactor,
  DEFAULT_IDLE_RELOCK_MINUTES,
  DEFAULT_STEP_UP_MAX_AGE_MINUTES,
  DEFAULT_UNLOCK_WINDOW_MINUTES,
  type FactorRejection,
  type FactorStatus,
  isFactorFresh,
  isPasscodeSet,
  lock,
  MIN_PASSCODE_LENGTH,
  PasscodeTooShortError,
  recordActivity,
  setPasscode,
  type UnlockWindow,
  unlock,
  verifyPasscode,
} from "./user-factor.js";
export {
  type AuthorizeWriteOptions,
  authorizeWrite,
  denialMessage,
  type WriteAuthorization,
  type WriteDenial,
} from "./write-guard.js";
export {
  type AuthenticatedRequest,
  ENROL_CLAIM_PATH,
  peerCertificatePem,
  startWriteServer,
  WHOAMI_PATH,
  type WriteServerHandle,
  type WriteServerOptions,
} from "./write-server.js";
