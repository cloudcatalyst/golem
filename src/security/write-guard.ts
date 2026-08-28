/**
 * R13.4 — the write guard: the one place that decides whether a request may
 * write.
 *
 * Two independent claims must BOTH hold, and the answer names which one failed:
 *
 *   1. **A device** — a client certificate this project's device CA issued, not
 *      revoked, not expired, carrying `clientAuth`.
 *   2. **A person** — a live unlock window, opened by the passcode.
 *
 * "Failure is denial." There is no degraded mode, no read-only fallback that
 * pretends a write happened, and no path where one claim substitutes for the
 * other. A phone with a perfect certificate and a locked passcode is refused; so
 * is a correct passcode presented from an unenrolled device.
 *
 * The read surface is unaffected and deliberately so: an unpaired browser still
 * gets the observe-tier dashboard (R12.5), which is a different server with no
 * write route at all.
 */

import { type DeviceCertRejection, verifyDeviceCert } from "../proxy/loopback-cert.js";
import { type DeviceRecord, findByFingerprint, touchLastSeen } from "./device-store.js";
import { checkFactor, type FactorRejection, isFactorFresh, recordActivity } from "./user-factor.js";

/** Why a write was refused. Every value names ONE missing thing. */
export type WriteDenial =
  | { readonly claim: "device"; readonly reason: "no-certificate" }
  | { readonly claim: "device"; readonly reason: DeviceCertRejection }
  | { readonly claim: "device"; readonly reason: "unknown-device" }
  | { readonly claim: "device"; readonly reason: "revoked" }
  | { readonly claim: "user"; readonly reason: FactorRejection }
  | { readonly claim: "user"; readonly reason: "step-up-required" };

export type WriteAuthorization =
  | { readonly ok: true; readonly device: DeviceRecord }
  | { readonly ok: false; readonly denial: WriteDenial };

export interface AuthorizeWriteOptions {
  readonly projectDir: string;
  /** The peer certificate, PEM. `null` when the client presented none. */
  readonly peerCertPem: string | null;
  /** The device CA to verify against. */
  readonly deviceCaPem: string;
  /**
   * High-risk act (gate-map item 5 — originating a session): require the
   * passcode to have been entered RECENTLY, not merely to be within its window.
   */
  readonly requireFreshFactor?: boolean;
  readonly stepUpMaxAgeMinutes?: number;
  readonly idleMinutes?: number;
  readonly nowMs?: number;
}

/**
 * Decide. Reads the catalog on every call and caches nothing — that is what
 * makes revocation effective on the next request (see `device-store.ts`).
 *
 * Order matters: the device claim is checked FIRST so that a locked passcode on
 * an unenrolled device reports "unknown device" rather than telling an unknown
 * caller anything about whether a passcode exists.
 */
export async function authorizeWrite(options: AuthorizeWriteOptions): Promise<WriteAuthorization> {
  const {
    projectDir,
    peerCertPem,
    deviceCaPem,
    requireFreshFactor = false,
    stepUpMaxAgeMinutes,
    idleMinutes,
    nowMs = Date.now(),
  } = options;

  // --- claim 1: the device ------------------------------------------------
  if (peerCertPem === null || peerCertPem.length === 0) {
    return { ok: false, denial: { claim: "device", reason: "no-certificate" } };
  }
  const verdict = verifyDeviceCert(peerCertPem, deviceCaPem, nowMs);
  if (!verdict.ok) {
    return { ok: false, denial: { claim: "device", reason: verdict.reason } };
  }
  const record = await findByFingerprint(projectDir, verdict.fingerprint);
  if (record === null) {
    // Signed by our CA but absent from the catalog. Should be impossible in
    // normal operation, and is exactly what a restored-from-backup certificate
    // or a catalog rollback looks like — so it is a denial, not a warning.
    return { ok: false, denial: { claim: "device", reason: "unknown-device" } };
  }
  if (record.revoked_at !== undefined) {
    return { ok: false, denial: { claim: "device", reason: "revoked" } };
  }

  // --- claim 2: the person ------------------------------------------------
  const factor = await checkFactor(projectDir, {
    ...(idleMinutes !== undefined ? { idleMinutes } : {}),
    nowMs,
  });
  if (!factor.live) {
    return { ok: false, denial: { claim: "user", reason: factor.reason } };
  }
  if (requireFreshFactor && !isFactorFresh(factor, stepUpMaxAgeMinutes ?? undefined, nowMs)) {
    return { ok: false, denial: { claim: "user", reason: "step-up-required" } };
  }

  // Both claims held. Record the activity that keeps the idle timer alive, and
  // the last-seen that makes `golem device list` useful. Both best-effort: a
  // write failure here must not turn an authorised request into a refused one.
  await Promise.all([
    recordActivity(projectDir, nowMs),
    touchLastSeen(projectDir, verdict.fingerprint, new Date(nowMs).toISOString()),
  ]);

  return { ok: true, device: record };
}

/**
 * The message a refused caller sees. Says which claim failed and what to do —
 * a 401 that does not distinguish "your device is revoked" from "your passcode
 * window lapsed" sends the user to re-pair when they needed to re-unlock.
 *
 * This is deliberately informative to a caller that already reached the write
 * port. It reveals nothing an attacker cannot determine by trying: whether a
 * certificate is accepted is observable from the response either way.
 */
export function denialMessage(denial: WriteDenial): string {
  if (denial.claim === "device") {
    switch (denial.reason) {
      case "no-certificate":
        return "No device certificate presented. Pair this device locally: run `golem device enrol` on the machine running Golem.";
      case "revoked":
        return "This device has been revoked. Re-pair it locally with `golem device enrol`, or use another device.";
      case "unknown-device":
        return "This certificate is not in the device catalog. Re-pair locally with `golem device enrol`.";
      case "expired":
        return "This device certificate has expired. Re-pair locally with `golem device enrol`.";
      case "not-yet-valid":
        return "This device certificate is not valid yet — check the clock on this device and on the host.";
      case "not-client-auth":
        return "This certificate is not a device credential (no clientAuth). Re-pair locally with `golem device enrol`.";
      default:
        return "This certificate was not issued by this project's device CA. Re-pair locally with `golem device enrol`.";
    }
  }
  switch (denial.reason) {
    case "no-passcode-set":
      return "No passcode is set for this project. Run `golem device passcode` on the machine running Golem.";
    case "locked":
      return "Locked. Unlock with your passcode to send.";
    case "window-expired":
      return "Your unlock window has expired. Enter your passcode again to send.";
    case "idle-expired":
      return "Locked after inactivity. Enter your passcode again to send.";
    default:
      return "This action needs your passcode again, just now — re-enter it to continue.";
  }
}
