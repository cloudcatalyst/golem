/**
 * Bounded user-authentication factor -- passcode-based (universal fallback).
 *
 * Inherited verbatim from ADR-0006 section 3c-1: no relay-mediated pairing,
 * forever local-only. Failure is denial, never degradation. The observe tier
 * requires none of this; only write surfaces are gated. Revocation takes
 * effect on the next request.
 *
 * Passkey/WebAuthn measured on this platform (verification-notes §143):
 * browsers do not treat LAN origins behind private CA certs as secure contexts
 * under the Secure Contexts spec, so navigator.credentials is absent. We use
 * a six-character alphanumeric passcode instead. Window defaults to 15 min,
 * idle re-prompt at 10 min.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";

export interface UserFactorSession {
  readonly active: true;
  readonly unlockedAt: Date;
  readonly expiresAt: Date;
  readonly lastActivity: Date;
}

export class BoundedUnlockError extends Error {
  override name = "BoundedUnlockError";
  constructor(reason: string) {
    super(reason);
  }
}

export const WINDOW_MS = 15 * 60 * 1000;
export const IDLE_REPROMPT_MS = 10 * 60 * 1000;
export const MIN_PASSCODE_LENGTH = 6;
export const PASSCODE_DIGITS = 6;

// Alphanumeric excluding visually ambiguous characters: 0/O/1/I/l.
const _ALPHA = "[REDACTED:high-entropy:1]";

interface StoredSession {
  active: true;
  unlockedAt: string;
  expiresAt: string;
  lastActivity: string;
  salt: string;
  hash: string;
}

function sessionPath(userDir: string): string {
  return join(userDir, ".golem", "user-factor", "session.json");
}

function randomSalt(): string {
  return Buffer.from(
    globalThis.crypto.getRandomValues(new Uint8Array(16)),
  ).toString("hex");
}

function generatePasscode(length: number): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length));
  let result = "";
  for (let i = 0; i < length; i++) {
    const idx = bytes[i]! % _ALPHA.length;
    result += _ALPHA[idx];
  }
  return result;
}

function hashPasscode(passcode: string, salt: string): string {
  return createHash("sha256")
    .update(Buffer.from(salt + passcode, "utf8"))
    .digest("base64");
}

async function loadStored(userDir: string): Promise<StoredSession | null> {
  try {
    const raw = await readFile(sessionPath(userDir), "utf8");
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

async function saveStored(
  userDir: string,
  session: StoredSession,
): Promise<void> {
  await mkdir(join(userDir, ".golem", "user-factor"), { recursive: true });
  await writeFile(
    sessionPath(userDir),
    JSON.stringify(session, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Unlock the user factor. If no session exists, registration flow (show a
 * one-time code back, verify user typed it). If a session exists, accept a
 * passcode from `prompt` callback.
 */
export async function unlock(
  userDir: string,
  prompt: (message: string) => Promise<string>,
): Promise<void> {
  let existing = await loadStored(userDir);

  if (!existing) {
    const code = generatePasscode(PASSCODE_DIGITS);
    const msg = [
      `Registration: your temporary passcode is ${code}.`,
      `Enter it to confirm:`,
    ].join("\n");
    const attempt = await prompt(msg);
    if (attempt !== code) {
      throw new BoundedUnlockError("confirmation mismatch");
    }

    const now = new Date();
    const salt = randomSalt();
    const session: StoredSession = {
      active: true,
      unlockedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + WINDOW_MS).toISOString(),
      lastActivity: now.toISOString(),
      salt,
      hash: hashPasscode(code, salt),
    };
    await saveStored(userDir, session);
    return;
  }

  const passcode = await prompt(`Enter your ${PASSCODE_DIGITS}-character passcode:`);
  const computed = hashPasscode(passcode, existing.salt);
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(existing.hash, "utf8");

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new BoundedUnlockError("invalid passcode");
  }

  const now = new Date();
  if (now >= new Date(existing.expiresAt)) {
    throw new BoundedUnlockError("session expired");
  }

  existing.unlockedAt = now.toISOString();
  existing.lastActivity = now.toISOString();
  existing.expiresAt = new Date(now.getTime() + WINDOW_MS).toISOString();
  await saveStored(userDir, existing);
}

/** Destroy current session. Forces full re-auth on next use. */
export async function lock(userDir: string): Promise<void> {
  try {
    await writeFile(sessionPath(userDir), "", "utf8");
  } catch {
    // Already absent.
  }
}

export type SessionStatus = "granted" | "expired" | "locked";

/** Check session status without prompting. Returns 'granted' | 'expired' | 'locked'. */
export async function checkStatus(userDir: string): Promise<SessionStatus> {
  const stored = await loadStored(userDir);
  if (!stored) return "locked";
  if (new Date() >= new Date(stored.expiresAt)) return "expired";
  return "granted";
}

/** Extend session by WINDOW_MS from now. Returns false if already expired. */
export async function touchSession(userDir: string): Promise<boolean> {
  const stored = await loadStored(userDir);
  if (!stored) return false;
  if (new Date() >= new Date(stored.expiresAt)) return false;
  const now = new Date();
  stored.lastActivity = now.toISOString();
  stored.expiresAt = new Date(now.getTime() + WINDOW_MS).toISOString();
  await saveStored(userDir, stored);
  return true;
}

/** Quick existence check without parsing contents. */
export async function isActive(userDir: string): Promise<boolean> {
  const stored = await loadStored(userDir);
  if (!stored) return false;
  return new Date() < new Date(stored.expiresAt);
}

/** Decide whether a re-prompt is needed based on idle time. */
export function needsReprompt(lastActivity: Date): boolean {
  return Date.now() - lastActivity.getTime() >= IDLE_REPROMPT_MS;
}
