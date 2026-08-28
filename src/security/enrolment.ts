/**
 * R13.4 — local-only enrolment.
 *
 * **Invariant 8, inherited verbatim from ADR-0006 §3c-1: enrolment is
 * local-only, forever.** There is no remote enrolment path and no message type
 * for one. That is the property that makes a stolen phone — and, later, a
 * compromised relay — survivable: an attacker who owns the transport still
 * cannot cause a new device to become trusted, because nothing reachable over
 * the transport can start an enrolment.
 *
 * The shape that keeps that true while still getting a credential onto a phone:
 *
 * 1. {@link startEnrolment} runs on the developer's own machine, from the CLI.
 *    It mints a short, single-use, short-lived code and writes it to
 *    `.golem/devices/pending-enrolment.json`.
 * 2. The phone POSTs that code to `/enrol/claim` on the write server and gets
 *    its certificate and key back **once**.
 * 3. The code is burned on first use, and expires on its own if unused.
 *
 * Step 2 is reachable over the network, and that is not a contradiction: it can
 * only ever succeed because a human ran step 1 locally, seconds earlier, and it
 * can succeed at most once. With no pending enrolment on disk the route is not
 * merely unauthorised — there is nothing for it to check a code against, and it
 * refuses every request. The authority to pair never leaves the machine; only
 * the delivery of an already-authorised credential does.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { writeAtomic } from "../config/file-io.js";
import { type DeviceCa, type DeviceCert, issueDeviceCert } from "../proxy/loopback-cert.js";
import { addDevice } from "./device-store.js";
import { deviceDir, pendingEnrolmentPath } from "./paths.js";

/** How long a pending enrolment stays claimable. Minutes, not hours. */
export const DEFAULT_ENROLMENT_TTL_MINUTES = 10;

/**
 * Code alphabet: Crockford-ish base32 with `I`, `L`, `O` and `U` removed. The
 * code is read off a screen and typed on a phone, so the characters that get
 * misread as one another are the ones worth not having.
 */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Code length. 8 chars over a 32-symbol alphabet is 40 bits, for a 10-minute window. */
const CODE_LENGTH = 8;

interface PendingFile {
  readonly version: 1;
  readonly device_id: string;
  readonly label: string;
  readonly code_sha256: string;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface PendingEnrolment {
  readonly deviceId: string;
  readonly label: string;
  /** Shown to the human ONCE, here, on their own machine. Never stored in clear. */
  readonly code: string;
  readonly expiresAt: Date;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isPendingFile = (v: unknown): v is PendingFile =>
  isRecord(v) &&
  typeof v.device_id === "string" &&
  typeof v.code_sha256 === "string" &&
  typeof v.expires_at === "string";

/** Uniform over the alphabet by rejection sampling — `% 32` on 256 is exact, but be explicit. */
function generateCode(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[(bytes[i] as number) % CODE_ALPHABET.length];
  }
  return out;
}

function hashCode(code: string): string {
  return createHash("sha256").update(normaliseCode(code)).digest("hex");
}

/**
 * Normalise a typed code: upper-case, and drop the separators and whitespace a
 * human adds when copying from a screen. Does NOT map look-alike characters — a
 * code containing `O` cannot exist, so silently reading `O` as `0` would only
 * widen what counts as a match.
 */
export function normaliseCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

export interface StartEnrolmentOptions {
  readonly label: string;
  readonly ttlMinutes?: number;
  readonly nowMs?: number;
  readonly randomBytes?: (n: number) => Buffer;
  /** Injected id generator (tests); defaults to a short random hex string. */
  readonly deviceId?: string;
}

/**
 * Open a pending enrolment. Overwrites any existing one: at most one device can
 * be pairing at a time, so a forgotten pending code cannot sit around waiting to
 * be guessed alongside a fresh one.
 */
export async function startEnrolment(
  projectDir: string,
  options: StartEnrolmentOptions,
): Promise<PendingEnrolment> {
  const {
    label,
    ttlMinutes = DEFAULT_ENROLMENT_TTL_MINUTES,
    nowMs = Date.now(),
    randomBytes: random = randomBytes,
  } = options;
  const deviceId = options.deviceId ?? random(6).toString("hex");
  const code = generateCode(random);
  const expiresAt = new Date(nowMs + ttlMinutes * 60_000);

  await mkdir(deviceDir(projectDir), { recursive: true });
  await writeAtomic(
    pendingEnrolmentPath(projectDir),
    `${JSON.stringify(
      {
        version: 1,
        device_id: deviceId,
        label,
        code_sha256: hashCode(code),
        created_at: new Date(nowMs).toISOString(),
        expires_at: expiresAt.toISOString(),
      } satisfies PendingFile,
      null,
      2,
    )}\n`,
  );

  return { deviceId, label, code, expiresAt };
}

/** Cancel a pending enrolment. Idempotent. */
export async function cancelEnrolment(projectDir: string): Promise<void> {
  await rm(pendingEnrolmentPath(projectDir), { force: true });
}

/** Is a pairing window open right now? `golem status` reports this. */
export async function pendingEnrolmentInfo(
  projectDir: string,
  nowMs: number = Date.now(),
): Promise<{ readonly label: string; readonly expiresAt: Date } | null> {
  const file = await readPending(projectDir);
  if (file === null) return null;
  const expiresAt = new Date(file.expires_at);
  if (nowMs >= expiresAt.getTime()) return null;
  return { label: file.label, expiresAt };
}

async function readPending(projectDir: string): Promise<PendingFile | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(pendingEnrolmentPath(projectDir), "utf8"));
    return isPendingFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export type ClaimRejection = "no-pending-enrolment" | "expired" | "wrong-code";

export type ClaimResult =
  | {
      readonly ok: true;
      readonly deviceId: string;
      readonly label: string;
      readonly cert: DeviceCert;
    }
  | { readonly ok: false; readonly reason: ClaimRejection };

export interface ClaimOptions {
  readonly ca: Pick<DeviceCa, "caPem" | "caKeyPem">;
  readonly nowMs?: number;
  readonly certDays?: number;
}

/**
 * Claim a pending enrolment with the code, exactly once.
 *
 * The code is burned BEFORE the certificate is returned, so a crash between the
 * two costs the user a re-enrolment rather than leaving a claimable code on
 * disk. Ordering matters more than convenience here.
 */
export async function claimEnrolment(
  projectDir: string,
  code: string,
  options: ClaimOptions,
): Promise<ClaimResult> {
  const { ca, nowMs = Date.now(), certDays } = options;
  const pending = await readPending(projectDir);
  if (pending === null) return { ok: false, reason: "no-pending-enrolment" };

  if (nowMs >= Date.parse(pending.expires_at)) {
    await cancelEnrolment(projectDir);
    return { ok: false, reason: "expired" };
  }

  // Constant-time over the hashes: the codes are short, and a timing oracle on
  // an 8-character secret is worth closing even inside a 10-minute window.
  const supplied = Buffer.from(hashCode(code), "hex");
  const expected = Buffer.from(pending.code_sha256, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { ok: false, reason: "wrong-code" };
  }

  await cancelEnrolment(projectDir); // single use: burn first

  const cert = await issueDeviceCert({
    ca,
    deviceId: pending.device_id,
    ...(certDays !== undefined ? { days: certDays } : {}),
    nowMs,
  });

  await addDevice(projectDir, {
    id: pending.device_id,
    label: pending.label,
    fingerprint: cert.fingerprint,
    enrolled_at: new Date(nowMs).toISOString(),
    not_after: cert.notAfter.toISOString(),
  });

  return { ok: true, deviceId: pending.device_id, label: pending.label, cert };
}
