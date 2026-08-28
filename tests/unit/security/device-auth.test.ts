/**
 * R13.4 — the two claims, as pure decisions.
 *
 * The gate this file exists to pin: "a paired device presenting a valid client
 * certificate AND a live user factor can use the write endpoints; either one
 * missing is refused, not degraded". So every test here is either "both held" or
 * "exactly one was missing, and the refusal named it".
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  type DeviceCa,
  generateDeviceCa,
  generateLoopbackPair,
  issueDeviceCert,
  verifyDeviceCert,
} from "../../../src/proxy/loopback-cert.js";
import {
  authorizeWrite,
  checkFactor,
  claimEnrolment,
  denialMessage,
  isFactorFresh,
  listDevices,
  lock,
  revokeDevice,
  setPasscode,
  startEnrolment,
  unlock,
  verifyPasscode,
} from "../../../src/security/index.js";
import { useTempDirs } from "../../helpers/tmp.js";

const newTempDir = useTempDirs("golem-devauth-");

// One CA for the whole file: generating a P-256 CA per test is the slowest thing
// here by an order of magnitude, and none of these tests care about its identity.
let ca: DeviceCa;

describe("device certificates", () => {
  beforeEach(async () => {
    await newTempDir();
    ca ??= await generateDeviceCa();
  });

  it("issues a certificate this CA accepts, naming the device", async () => {
    const cert = await issueDeviceCert({ ca, deviceId: "phone-1" });
    const verdict = verifyDeviceCert(cert.certPem, ca.caPem);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.deviceId).toBe("phone-1");
      expect(verdict.fingerprint).toBe(cert.fingerprint);
    }
  });

  it("refuses a certificate from a DIFFERENT CA", async () => {
    const other = await generateDeviceCa();
    const cert = await issueDeviceCert({ ca: other, deviceId: "phone-1" });
    expect(verifyDeviceCert(cert.certPem, ca.caPem)).toStrictEqual({
      ok: false,
      reason: "not-signed-by-device-ca",
    });
  });

  // The loopback CA signs the proxy's SERVER identity. If a certificate from it
  // could authenticate a device, the two CAs would not be separate in any way
  // that matters.
  it("refuses the loopback server leaf as a device credential", async () => {
    const loopback = await generateLoopbackPair();
    expect(verifyDeviceCert(loopback.leafPem, ca.caPem).ok).toBe(false);
  });

  it("refuses an expired certificate, and one that is not valid yet", async () => {
    const nowMs = Date.parse("2026-08-29T00:00:00.000Z");
    const cert = await issueDeviceCert({ ca, deviceId: "phone-1", days: 1, nowMs });
    expect(verifyDeviceCert(cert.certPem, ca.caPem, nowMs + 2 * 86_400_000)).toStrictEqual({
      ok: false,
      reason: "expired",
    });
    // Certificates are backdated by the CLOCK_SKEW_MS window, so "not yet valid"
    // needs a clock further back than that.
    expect(verifyDeviceCert(cert.certPem, ca.caPem, nowMs - 60 * 60_000)).toStrictEqual({
      ok: false,
      reason: "not-yet-valid",
    });
  });

  it("refuses garbage instead of throwing", () => {
    expect(verifyDeviceCert("not a certificate", ca.caPem).ok).toBe(false);
  });
});

describe("enrolment is local-only and single-use", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await newTempDir();
    ca ??= await generateDeviceCa();
  });

  it("cannot be claimed when no pairing was started locally", async () => {
    expect(await claimEnrolment(dir, "ANYCODE1", { ca })).toStrictEqual({
      ok: false,
      reason: "no-pending-enrolment",
    });
  });

  it("issues once, then burns the code", async () => {
    const pending = await startEnrolment(dir, { label: "Pixel" });
    const first = await claimEnrolment(dir, pending.code, { ca });
    expect(first.ok).toBe(true);
    // The SAME code again is not "wrong-code" — the pending record is gone
    // entirely, which is the property that makes replay impossible rather than
    // merely unlikely.
    expect(await claimEnrolment(dir, pending.code, { ca })).toStrictEqual({
      ok: false,
      reason: "no-pending-enrolment",
    });
  });

  it("records the device in the catalog on a successful claim", async () => {
    const pending = await startEnrolment(dir, { label: "work iPhone" });
    const claim = await claimEnrolment(dir, pending.code, { ca });
    expect(claim.ok).toBe(true);
    const devices = await listDevices(dir);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.label).toBe("work iPhone");
    expect(devices[0]?.revoked_at).toBeUndefined();
  });

  it("refuses a wrong code without burning the pending enrolment", async () => {
    const pending = await startEnrolment(dir, { label: "Pixel" });
    expect(await claimEnrolment(dir, "WRONGCOD", { ca })).toStrictEqual({
      ok: false,
      reason: "wrong-code",
    });
    // A typo must not cost the user their pairing window.
    expect((await claimEnrolment(dir, pending.code, { ca })).ok).toBe(true);
  });

  it("expires on its own, and clears itself when it does", async () => {
    const nowMs = Date.parse("2026-08-29T00:00:00.000Z");
    const pending = await startEnrolment(dir, { label: "Pixel", ttlMinutes: 10, nowMs });
    expect(
      await claimEnrolment(dir, pending.code, { ca, nowMs: nowMs + 11 * 60_000 }),
    ).toStrictEqual({ ok: false, reason: "expired" });
    expect(await claimEnrolment(dir, pending.code, { ca })).toStrictEqual({
      ok: false,
      reason: "no-pending-enrolment",
    });
  });

  it("accepts a code the human retyped with spacing and lower case", async () => {
    const pending = await startEnrolment(dir, { label: "Pixel" });
    const typed = `${pending.code.slice(0, 4).toLowerCase()} - ${pending.code.slice(4).toLowerCase()}`;
    expect((await claimEnrolment(dir, typed, { ca })).ok).toBe(true);
  });

  it("keeps at most one pairing open — a second enrolment replaces the first", async () => {
    const first = await startEnrolment(dir, { label: "old" });
    const second = await startEnrolment(dir, { label: "new" });
    expect(await claimEnrolment(dir, first.code, { ca })).toStrictEqual({
      ok: false,
      reason: "wrong-code",
    });
    expect((await claimEnrolment(dir, second.code, { ca })).ok).toBe(true);
  });
});

describe("the user factor", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await newTempDir();
  });

  it("is not live before a passcode is ever set", async () => {
    expect(await checkFactor(dir)).toStrictEqual({ live: false, reason: "no-passcode-set" });
  });

  // "No passcode set" must never mean "any passcode works" — the direction of
  // that failure is the difference between locked and wide open.
  it("verifies nothing when no passcode is set", async () => {
    expect(await verifyPasscode(dir, "")).toBe(false);
    expect(await verifyPasscode(dir, "anything")).toBe(false);
  });

  it("unlocks with the right passcode and refuses the wrong one", async () => {
    await setPasscode(dir, "correct-horse");
    expect(await unlock(dir, "wrong")).toBeNull();
    expect(await checkFactor(dir)).toStrictEqual({ live: false, reason: "locked" });
    expect(await unlock(dir, "correct-horse")).not.toBeNull();
    expect((await checkFactor(dir)).live).toBe(true);
  });

  it("rejects a passcode shorter than the minimum", async () => {
    await expect(setPasscode(dir, "abc")).rejects.toThrow(/at least/);
  });

  it("expires at the absolute window, however active", async () => {
    const t0 = Date.parse("2026-08-29T00:00:00.000Z");
    await setPasscode(dir, "correct-horse");
    await unlock(dir, "correct-horse", { windowMinutes: 15, nowMs: t0 });
    expect((await checkFactor(dir, { nowMs: t0 + 14 * 60_000, idleMinutes: 999 })).live).toBe(true);
    expect(await checkFactor(dir, { nowMs: t0 + 16 * 60_000, idleMinutes: 999 })).toStrictEqual({
      live: false,
      reason: "window-expired",
    });
  });

  it("relocks on idle, before the absolute window", async () => {
    const t0 = Date.parse("2026-08-29T00:00:00.000Z");
    await setPasscode(dir, "correct-horse");
    await unlock(dir, "correct-horse", { windowMinutes: 60, nowMs: t0 });
    expect(await checkFactor(dir, { nowMs: t0 + 6 * 60_000, idleMinutes: 5 })).toStrictEqual({
      live: false,
      reason: "idle-expired",
    });
  });

  it("locks immediately on `lock`", async () => {
    await setPasscode(dir, "correct-horse");
    await unlock(dir, "correct-horse");
    await lock(dir);
    expect(await checkFactor(dir)).toStrictEqual({ live: false, reason: "locked" });
  });

  // Changing the passcode because the old one leaked must not leave the leaked
  // one's window running.
  it("locks when the passcode is changed", async () => {
    await setPasscode(dir, "correct-horse");
    await unlock(dir, "correct-horse");
    expect((await checkFactor(dir)).live).toBe(true);
    await setPasscode(dir, "a-different-one");
    expect(await checkFactor(dir)).toStrictEqual({ live: false, reason: "locked" });
  });

  it("step-up freshness measures when the passcode was TYPED, not last activity", async () => {
    const t0 = Date.parse("2026-08-29T00:00:00.000Z");
    await setPasscode(dir, "correct-horse");
    await unlock(dir, "correct-horse", { windowMinutes: 60, nowMs: t0 });
    const fresh = await checkFactor(dir, { nowMs: t0 + 60_000, idleMinutes: 999 });
    expect(isFactorFresh(fresh, 2, t0 + 60_000)).toBe(true);
    const stale = await checkFactor(dir, { nowMs: t0 + 5 * 60_000, idleMinutes: 999 });
    expect(stale.live).toBe(true); // still unlocked…
    expect(isFactorFresh(stale, 2, t0 + 5 * 60_000)).toBe(false); // …but not fresh
  });
});

describe("authorizeWrite — both claims, or a named refusal", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await newTempDir();
    ca ??= await generateDeviceCa();
  });

  async function pairedAndUnlocked() {
    const pending = await startEnrolment(dir, { label: "Pixel" });
    const claim = await claimEnrolment(dir, pending.code, { ca });
    if (!claim.ok) throw new Error("fixture: claim failed");
    await setPasscode(dir, "correct-horse");
    await unlock(dir, "correct-horse");
    return claim.cert;
  }

  it("allows a paired device with a live factor", async () => {
    const cert = await pairedAndUnlocked();
    const auth = await authorizeWrite({
      projectDir: dir,
      peerCertPem: cert.certPem,
      deviceCaPem: ca.caPem,
    });
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.device.label).toBe("Pixel");
  });

  it("refuses with NO certificate even when unlocked", async () => {
    await pairedAndUnlocked();
    const auth = await authorizeWrite({
      projectDir: dir,
      peerCertPem: null,
      deviceCaPem: ca.caPem,
    });
    expect(auth).toStrictEqual({
      ok: false,
      denial: { claim: "device", reason: "no-certificate" },
    });
  });

  it("refuses a valid certificate when LOCKED — never a degraded write", async () => {
    const cert = await pairedAndUnlocked();
    await lock(dir);
    const auth = await authorizeWrite({
      projectDir: dir,
      peerCertPem: cert.certPem,
      deviceCaPem: ca.caPem,
    });
    expect(auth).toStrictEqual({ ok: false, denial: { claim: "user", reason: "locked" } });
  });

  // The gate: "revoking a device takes effect on the next request". Nothing is
  // cached, so this is the whole mechanism.
  it("refuses on the NEXT request after revocation", async () => {
    const cert = await pairedAndUnlocked();
    const before = await authorizeWrite({
      projectDir: dir,
      peerCertPem: cert.certPem,
      deviceCaPem: ca.caPem,
    });
    expect(before.ok).toBe(true);

    await revokeDevice(dir, cert.fingerprint, new Date().toISOString());

    const after = await authorizeWrite({
      projectDir: dir,
      peerCertPem: cert.certPem,
      deviceCaPem: ca.caPem,
    });
    expect(after).toStrictEqual({ ok: false, denial: { claim: "device", reason: "revoked" } });
  });

  // Signed by our CA but absent from the catalog: a restored backup, or a
  // rolled-back catalog. Denial, not a warning.
  it("refuses a certificate this CA signed that is not in the catalog", async () => {
    await setPasscode(dir, "correct-horse");
    await unlock(dir, "correct-horse");
    const orphan = await issueDeviceCert({ ca, deviceId: "never-enrolled" });
    const auth = await authorizeWrite({
      projectDir: dir,
      peerCertPem: orphan.certPem,
      deviceCaPem: ca.caPem,
    });
    expect(auth).toStrictEqual({
      ok: false,
      denial: { claim: "device", reason: "unknown-device" },
    });
  });

  // Order matters: an unknown caller learns nothing about whether a passcode
  // exists for this project.
  it("reports the DEVICE failure first when both claims are missing", async () => {
    const auth = await authorizeWrite({
      projectDir: dir,
      peerCertPem: null,
      deviceCaPem: ca.caPem,
    });
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.denial.claim).toBe("device");
  });

  it("refuses a high-risk act on a live-but-stale window", async () => {
    const t0 = Date.parse("2026-08-29T00:00:00.000Z");
    const pending = await startEnrolment(dir, { label: "Pixel", nowMs: t0 });
    const claim = await claimEnrolment(dir, pending.code, { ca, nowMs: t0 });
    if (!claim.ok) throw new Error("fixture");
    await setPasscode(dir, "correct-horse");
    await unlock(dir, "correct-horse", { windowMinutes: 60, nowMs: t0 });

    const later = t0 + 10 * 60_000;
    const ordinary = await authorizeWrite({
      projectDir: dir,
      peerCertPem: claim.cert.certPem,
      deviceCaPem: ca.caPem,
      idleMinutes: 999,
      nowMs: later,
    });
    expect(ordinary.ok).toBe(true);

    const highRisk = await authorizeWrite({
      projectDir: dir,
      peerCertPem: claim.cert.certPem,
      deviceCaPem: ca.caPem,
      requireFreshFactor: true,
      stepUpMaxAgeMinutes: 2,
      idleMinutes: 999,
      nowMs: later,
    });
    expect(highRisk).toStrictEqual({
      ok: false,
      denial: { claim: "user", reason: "step-up-required" },
    });
  });

  it("every denial produces a message that says what to do", () => {
    const denials = [
      { claim: "device", reason: "no-certificate" },
      { claim: "device", reason: "revoked" },
      { claim: "device", reason: "unknown-device" },
      { claim: "device", reason: "expired" },
      { claim: "device", reason: "not-yet-valid" },
      { claim: "device", reason: "not-client-auth" },
      { claim: "device", reason: "not-signed-by-device-ca" },
      { claim: "user", reason: "no-passcode-set" },
      { claim: "user", reason: "locked" },
      { claim: "user", reason: "window-expired" },
      { claim: "user", reason: "idle-expired" },
      { claim: "user", reason: "step-up-required" },
    ] as const;
    for (const denial of denials) {
      const message = denialMessage(denial);
      expect(message.length, `${denial.claim}:${denial.reason}`).toBeGreaterThan(20);
      // A refusal that does not distinguish "revoked" from "window lapsed" sends
      // the user to re-pair when they needed to re-unlock.
      expect(message).toMatch(/passcode|pair|enrol|clock/i);
    }
  });

  it("records last-seen on an authorised request", async () => {
    const cert = await pairedAndUnlocked();
    await authorizeWrite({
      projectDir: dir,
      peerCertPem: cert.certPem,
      deviceCaPem: ca.caPem,
    });
    const devices = await listDevices(dir);
    expect(devices[0]?.last_seen_at).toBeDefined();
  });

  it("does not resurrect a revoked device by re-enrolling under the same label", async () => {
    const cert = await pairedAndUnlocked();
    await revokeDevice(dir, cert.fingerprint, new Date().toISOString());
    const pending = await startEnrolment(dir, { label: "Pixel" });
    const claim = await claimEnrolment(dir, pending.code, { ca });
    expect(claim.ok).toBe(true);
    const devices = await listDevices(dir);
    expect(devices).toHaveLength(2);
    expect(devices[0]?.revoked_at).toBeDefined(); // the old record still says so
    expect(devices[1]?.revoked_at).toBeUndefined();
  });
});
