/**
 * R13.4 — the user factor: a passcode, and a bounded unlock window.
 *
 * A certificate proves a *device*. Devices are lost, borrowed and stolen, so the
 * person is a separate claim and this file is where it is made.
 *
 * ## Why a passcode and not a passkey — MEASURED, not assumed
 *
 * R13.4's gate says "what the user factor can actually be on this platform is
 * MEASURED, not assumed", so: WebAuthn cannot work on this surface, and the
 * blocking reason is not the one you would guess.
 *
 * The obvious suspect is the secure-context rule — WebAuthn is
 * "available only in secure contexts (HTTPS)" (MDN, `PublicKeyCredentialCreationOptions`,
 * fetched 2026-08-29). That one is solvable: Golem already runs its own CA, and
 * an `https://` origin whose chain the device trusts *is* a secure context.
 *
 * The blocker is the Relying Party ID. Per the same page: *"The `id` cannot
 * include a port or scheme like a standard origin... The `id` needs to equal the
 * origin's effective domain, or a domain suffix thereof"*, and *"If omitted,
 * `id` defaults to the document origin"*. A LAN origin is `https://192.168.0.20:4655`
 * — its effective domain is an IP literal, which is not a domain and therefore
 * has no valid RP ID and no valid domain suffix. **No amount of CA trust fixes
 * that**, because it is a naming rule, not a transport-security rule. A passkey
 * would need a real registrable domain, which a LAN-only design does not have
 * and (per ADR-0007 §7) is not going to acquire before R13.10.
 *
 * So the passcode is the mechanism, not the fallback, for as long as the
 * companion app is reached by IP. Recorded in `docs/plan/verification-notes.md`
 * §146 with the quotes and the date.
 *
 * ## The shape of the window
 *
 * Unlocking is bounded twice: an absolute expiry (you re-enter the passcode
 * eventually no matter how active you are) and an idle timeout (walking away
 * relocks sooner than the absolute window). Both are configurable, and both
 * default short. High-risk acts re-require the factor regardless of the window —
 * see {@link isFactorFresh}.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { writeAtomic } from "../config/file-io.js";
import { deviceDir, unlockSessionPath, userFactorPath } from "./paths.js";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/** scrypt output length. 32 bytes — the comparison is constant-time either way. */
const KEY_LENGTH = 32;

/** Absolute window: re-enter the passcode after this long, however active you were. */
export const DEFAULT_UNLOCK_WINDOW_MINUTES = 15;

/** Idle window: no authorised request for this long relocks, before the absolute one. */
export const DEFAULT_IDLE_RELOCK_MINUTES = 5;

/**
 * How recently the factor must have been entered for a HIGH-RISK act (gate-map
 * item 5 — originating a session). Deliberately much shorter than the unlock
 * window: "I unlocked twelve minutes ago" is enough to keep reading a stream and
 * is not enough to start a new agent session in a repository.
 */
export const DEFAULT_STEP_UP_MAX_AGE_MINUTES = 2;

/** The minimum passcode length Golem will accept. */
export const MIN_PASSCODE_LENGTH = 6;

interface FactorFile {
  readonly version: 1;
  readonly salt_b64: string;
  readonly hash_b64: string;
  readonly set_at: string;
}

interface UnlockFile {
  readonly version: 1;
  readonly unlocked_at: string;
  readonly expires_at: string;
  readonly last_activity_at: string;
}

export interface UnlockWindow {
  readonly unlockedAt: Date;
  readonly expiresAt: Date;
  readonly lastActivityAt: Date;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readJson<T>(file: string, ok: (v: unknown) => v is T): Promise<T | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return ok(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const isFactorFile = (v: unknown): v is FactorFile =>
  isRecord(v) && typeof v.salt_b64 === "string" && typeof v.hash_b64 === "string";

const isUnlockFile = (v: unknown): v is UnlockFile =>
  isRecord(v) && typeof v.expires_at === "string" && typeof v.last_activity_at === "string";

/** Has a passcode ever been set for this project? */
export async function isPasscodeSet(projectDir: string): Promise<boolean> {
  return (await readJson(userFactorPath(projectDir), isFactorFile)) !== null;
}

export class PasscodeTooShortError extends Error {
  override name = "PasscodeTooShortError";
  constructor() {
    super(`passcode must be at least ${MIN_PASSCODE_LENGTH} characters`);
  }
}

/**
 * Set (or replace) the passcode. Stores a scrypt verifier and a random salt —
 * never the passcode, and never anything reversible.
 *
 * Replacing the passcode LOCKS: an unlock window opened under the old secret
 * must not outlive it, or "change the passcode because the old one leaked" would
 * leave the leaked one's window running.
 */
export async function setPasscode(projectDir: string, passcode: string): Promise<void> {
  if (passcode.length < MIN_PASSCODE_LENGTH) throw new PasscodeTooShortError();
  const salt = randomBytes(16);
  const hash = await scrypt(passcode, salt, KEY_LENGTH);
  await mkdir(deviceDir(projectDir), { recursive: true });
  await writeAtomic(
    userFactorPath(projectDir),
    `${JSON.stringify(
      {
        version: 1,
        salt_b64: salt.toString("base64"),
        hash_b64: hash.toString("base64"),
        set_at: new Date().toISOString(),
      } satisfies FactorFile,
      null,
      2,
    )}\n`,
  );
  await lock(projectDir);
}

/**
 * Is this the passcode? Constant-time, and false when none is set — "no
 * passcode" must never mean "any passcode".
 */
export async function verifyPasscode(projectDir: string, passcode: string): Promise<boolean> {
  const file = await readJson(userFactorPath(projectDir), isFactorFile);
  if (file === null) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(file.hash_b64, "base64");
  } catch {
    return false;
  }
  const actual = await scrypt(passcode, Buffer.from(file.salt_b64, "base64"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface UnlockOptions {
  readonly windowMinutes?: number;
  readonly nowMs?: number;
}

/**
 * Open an unlock window. Returns `null` when the passcode is wrong — the caller
 * decides how to report that, and nothing is written on a failed attempt.
 */
export async function unlock(
  projectDir: string,
  passcode: string,
  options: UnlockOptions = {},
): Promise<UnlockWindow | null> {
  const { windowMinutes = DEFAULT_UNLOCK_WINDOW_MINUTES, nowMs = Date.now() } = options;
  if (!(await verifyPasscode(projectDir, passcode))) return null;
  const now = new Date(nowMs);
  const expires = new Date(nowMs + windowMinutes * 60_000);
  await mkdir(deviceDir(projectDir), { recursive: true });
  await writeAtomic(
    unlockSessionPath(projectDir),
    `${JSON.stringify(
      {
        version: 1,
        unlocked_at: now.toISOString(),
        expires_at: expires.toISOString(),
        last_activity_at: now.toISOString(),
      } satisfies UnlockFile,
      null,
      2,
    )}\n`,
  );
  return { unlockedAt: now, expiresAt: expires, lastActivityAt: now };
}

/** Close the window now. Deleting the file IS the lock — there is no flag to disagree with. */
export async function lock(projectDir: string): Promise<void> {
  await rm(unlockSessionPath(projectDir), { force: true });
}

/** Why the factor is not live. */
export type FactorRejection = "no-passcode-set" | "locked" | "window-expired" | "idle-expired";

export type FactorStatus =
  | { readonly live: true; readonly window: UnlockWindow }
  | { readonly live: false; readonly reason: FactorRejection };

export interface FactorCheckOptions {
  readonly idleMinutes?: number;
  readonly nowMs?: number;
}

/**
 * Is the factor live right now? Pure read — checking does NOT extend the window,
 * because a poll that refreshes an idle timer means the timer measures the
 * poller rather than the person. {@link recordActivity} is the explicit,
 * separate way to say "the human did something".
 */
export async function checkFactor(
  projectDir: string,
  options: FactorCheckOptions = {},
): Promise<FactorStatus> {
  const { idleMinutes = DEFAULT_IDLE_RELOCK_MINUTES, nowMs = Date.now() } = options;
  if (!(await isPasscodeSet(projectDir))) return { live: false, reason: "no-passcode-set" };

  const file = await readJson(unlockSessionPath(projectDir), isUnlockFile);
  if (file === null) return { live: false, reason: "locked" };

  const expiresAt = new Date(file.expires_at);
  const lastActivityAt = new Date(file.last_activity_at);
  const unlockedAt = new Date(file.unlocked_at);
  if (Number.isNaN(expiresAt.getTime()) || Number.isNaN(lastActivityAt.getTime())) {
    return { live: false, reason: "locked" };
  }
  if (nowMs >= expiresAt.getTime()) return { live: false, reason: "window-expired" };
  if (nowMs - lastActivityAt.getTime() >= idleMinutes * 60_000) {
    return { live: false, reason: "idle-expired" };
  }
  return { live: true, window: { unlockedAt, expiresAt, lastActivityAt } };
}

/**
 * Push the idle timer out, because an authorised request happened. Never extends
 * the ABSOLUTE expiry — activity should delay an idle relock, not make a window
 * immortal.
 */
export async function recordActivity(
  projectDir: string,
  nowMs: number = Date.now(),
): Promise<void> {
  const file = await readJson(unlockSessionPath(projectDir), isUnlockFile);
  if (file === null) return;
  try {
    await writeAtomic(
      unlockSessionPath(projectDir),
      `${JSON.stringify(
        { ...file, last_activity_at: new Date(nowMs).toISOString() } satisfies UnlockFile,
        null,
        2,
      )}\n`,
    );
  } catch {
    // Best-effort: failing to extend an idle timer relocks early, which is the
    // safe direction. Failing loudly here would turn a disk hiccup into a denial.
  }
}

/**
 * Was the factor entered recently enough for a HIGH-RISK act?
 *
 * Distinct from {@link checkFactor} on purpose: a live window says the person
 * authenticated at some point in the last quarter hour, which is the right bar
 * for continuing to read a stream and the wrong bar for originating a session.
 * This measures against `unlockedAt` — when the passcode was actually typed —
 * not `lastActivityAt`, which any request can push forward.
 */
export function isFactorFresh(
  status: FactorStatus,
  maxAgeMinutes: number = DEFAULT_STEP_UP_MAX_AGE_MINUTES,
  nowMs: number = Date.now(),
): boolean {
  if (!status.live) return false;
  return nowMs - status.window.unlockedAt.getTime() < maxAgeMinutes * 60_000;
}
