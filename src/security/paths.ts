/**
 * R13.4 — where the device-authentication state lives.
 *
 * Everything sits under `<project>/.golem/devices/`, i.e. **per project**, not
 * per machine. That is a deliberate choice and it costs something: unlocking is
 * per project, so a developer working in three repos enters the passcode three
 * times.
 *
 * It buys the property that matters more. A device is enrolled to authorise
 * writes against *one project's* session host, and the blast radius of a stolen
 * phone or a leaked catalog should be that project rather than every project on
 * the machine. A machine-wide credential would silently widen every future
 * enrolment, and R13.10's internet relay would then be relaying a machine-wide
 * authority rather than a project-scoped one.
 */

import path from "node:path";

/** `<project>/.golem/devices` — the whole device subsystem's state. */
export function deviceDir(projectDir: string): string {
  return path.join(projectDir, ".golem", "devices");
}

/** The device-issuing CA certificate. Installed in no trust store, ever. */
export function deviceCaPath(projectDir: string): string {
  return path.join(deviceDir(projectDir), "ca.pem");
}

/**
 * The device CA's private key. This is the most dangerous file in the
 * subsystem: whoever holds it can mint a credential for any device id.
 */
export function deviceCaKeyPath(projectDir: string): string {
  return path.join(deviceDir(projectDir), "ca.key.pem");
}

/** The enrolled-device catalog — labels, fingerprints, last-seen, revocations. */
export function deviceCatalogPath(projectDir: string): string {
  return path.join(deviceDir(projectDir), "catalog.json");
}

/** The passcode verifier (scrypt hash + salt). Never the passcode. */
export function userFactorPath(projectDir: string): string {
  return path.join(deviceDir(projectDir), "factor.json");
}

/** The current unlock window, if any. Deleting this file locks immediately. */
export function unlockSessionPath(projectDir: string): string {
  return path.join(deviceDir(projectDir), "unlock.json");
}

/** The pending local enrolment, if one is open. Absent means no pairing is possible. */
export function pendingEnrolmentPath(projectDir: string): string {
  return path.join(deviceDir(projectDir), "pending-enrolment.json");
}

/** Where an issued credential bundle is written for the user to carry to the device. */
export function credentialBundlePath(projectDir: string, deviceId: string): string {
  return path.join(deviceDir(projectDir), `${deviceId}.bundle.pem`);
}
