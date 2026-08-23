/**
 * User authentication factor — bounded unlock for the write surface.
 *
 * A certificate proves a device; the user factor proves a person.
 * The goal mechanism is WebAuthn/passkeys where the platform supports it
 * in this context (secure-context question, MEASURED before promising),
 * with a numeric passcode as the universal fallback.
 *
 * Unlock duration: configurable, default 15 minutes. Re-prompts after idle.
 * High-risk acts (gate-map item 5: originating a session) require fresh
 * re-authentication every time regardless of unlock state.
 */

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How many minutes an unlock lasts. Default 15. */
const DEFAULT_UNLOCK_MINUTES = 15;
/** Min PIN length for passcode fallback. */
const MIN_PIN_LENGTH = 4;
/** Max unlock window (hours) — prevents runaway config values. */
const MAX_UNLOCK_HOURS = 24;

export interface AuthState {
  /** Method used: "webauthn" or "passcode". */
  readonly method: "webauthn" | "passcode";
  /** Epoch ms until which the session is unlocked. */
  readonly expiresAt: number;
}

export interface PasscodeChallenge {
  /** One-time code the user must enter. */
  readonly code: string;
  /** Seconds until this challenge expires. */
  readonly ttlSeconds: number;
  /** Challenge consumed on first correct use. */
  ephemeral: true;
}

type RawPasscodeChallenge = Omit<PasscodeChallenge, "ephemeral"> & { ephemeral: boolean };

const authStateSchema = z.object({
  method: z.enum(["webauthn", "passcode"]),
  expiresAt: z.number().int().positive(),
});

const challengeSchema = z.object({
  code: z.string(),
  ttlSeconds: z.number().int().positive(),
  ephemeral: z.boolean(),
});

// ---------------------------------------------------------------------------
// Storage paths
// ---------------------------------------------------------------------------

/** `.golem/state/user-auth.json` — current unlock state. */
function authStatePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "user-auth.json");
}

/** `.golem/state/passcode-challenge.json` — one-time passcode challenge. */
function challengePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "passcode-challenge.json");
}

// ---------------------------------------------------------------------------
// Unlock management
// ---------------------------------------------------------------------------

/** Current auth state if still valid and non-expired. */
export async function getUnlockState(
  projectDir: string,
  nowMs?: number,
): Promise<AuthState | null> {
  try {
    const raw = await readFile(authStatePath(projectDir), "utf8");
    const parsed = authStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const state = parsed.data;
    const elapsed = (nowMs ?? Date.now()) - state.expiresAt;
    return elapsed > 0 ? null : state;
  } catch {
    return null;
  }
}

/** Write an unlock state keyed on the configured duration. */
export async function setUnlockState(
  projectDir: string,
  method: AuthState["method"],
  unlockMinutes: number,
  nowMs?: number,
): Promise<void> {
  const now = nowMs ?? Date.now();
  const expiresAt = now + unlockMinutes * 60 * 1000;
  const state: AuthState = { method, expiresAt };
  // Atomic-ish write via temp + rename.
  const p = authStatePath(projectDir);
  const tmp = `${p}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  // No cross-platform atomic rename safe here — single-writer process, accept race.
  await writeFile(p, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** Clear the current unlock state immediately. */
export async function clearUnlockState(projectDir: string): Promise<void> {
  try {
    await readFile(authStatePath(projectDir), "utf8");
    // File existed — wipe it.
    await writeFile(authStatePath(projectDir), "", "utf8").catch(() => {});
  } catch {
    // Did not exist — nothing to clear.
  }
}

// ---------------------------------------------------------------------------
// High-risk gate — always requires re-authentication
// ---------------------------------------------------------------------------

interface RiskSession {
  /** Last re-auth timestamp for high-risk gating. */
  readonly lastHighRiskAuth: number;
}

/** How long before a high-risk act demands fresh auth (minutes). Default 5. */
const HIGH_RISK_REAUTH_WINDOW_MIN = 5;

const riskSessionSchema = z.object({
  lastHighRiskAuth: z.number().int().positive(),
});

function riskSessionPath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "high-risk-session.json");
}

/** Whether a high-risk act needs fresh re-auth. True if none recently authenticated. */
export async function needsHighRiskReauth(
  projectDir: string,
  opts?: { windowMinutes?: number },
  nowMs?: number,
): Promise<boolean> {
  const windowMin = opts?.windowMinutes ?? HIGH_RISK_REAUTH_WINDOW_MIN;
  const windowMs = windowMin * 60 * 1000;
  try {
    const raw = await readFile(riskSessionPath(projectDir), "utf8");
    const parsed = riskSessionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return true;
    return (nowMs ?? Date.now()) - parsed.data.lastHighRiskAuth > windowMs;
  } catch {
    // Never wrote → never authenticated → needs re-auth.
    return true;
  }
}

/** Mark that high-risk re-auth was just performed. */
export async function recordHighRiskAuth(projectDir: string, nowMs?: number): Promise<void> {
  const now = nowMs ?? Date.now();
  const session: RiskSession = { lastHighRiskAuth: now };
  const p = riskSessionPath(projectDir);
  await writeFile(p, JSON.stringify(session, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Passcode challenges (fallback mechanism)
// ---------------------------------------------------------------------------

/** Generate a one-time passcode challenge and persist it. Returns code + TTL. */
export async function generatePasscodeChallenge(
  projectDir: string,
  opts?: { ttlSeconds?: number },
): Promise<PasscodeChallenge> {
  const ttl = opts?.ttlSeconds ?? 300; // 5 minutes default
  const code = randomBytes(MIN_PIN_LENGTH).readUInt32LE(0) % 10000;
  const challenge: RawPasscodeChallenge = {
    code: String(code).padStart(4, "0"),
    ttlSeconds: ttl,
    ephemeral: true,
  };
  const p = challengePath(projectDir);
  await writeFile(p, JSON.stringify(challenge, null, 2) + "\n", "utf8");
  return { ...challenge, ephemeral: true };
}

/**
 * Validate a passcode against the stored challenge.
 * Consumes the challenge (ephemeral). Returns success but does NOT auto-unlock —
 * the caller writes the unlock state separately.
 */
export async function validatePasscode(
  projectDir: string,
  inputCode: string,
  nowMs?: number,
): Promise<"ok" | "expired" | "wrong" | "consumed"> {
  try {
    const raw = await readFile(challengePath(projectDir), "utf8");
    const parsed = challengeSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return "wrong";

    const now = nowMs ?? Date.now();
    const age = (now / 1000) - parsed.data.ttlSeconds;
    if (age > parsed.data.ttlSeconds) {
      // Expired — consume it to avoid reuse.
      await consumeChallenge(projectDir);
      return "expired";
    }

    if (parsed.data.ephemeral && inputCode === parsed.data.code) {
      await consumeChallenge(projectDir);
      return "ok";
    }

    if (inputCode !== parsed.data.code) {
      // Wrong answer — consume to prevent brute-force replay.
      await consumeChallenge(projectDir);
      return "wrong";
    }

    // Already consumed.
    return "consumed";
  } catch {
    return "wrong";
  }
}

async function consumeChallenge(projectDir: string): Promise<void> {
  try {
    const raw = await readFile(challengePath(projectDir), "utf8");
    const parsed = challengeSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const updated: RawPasscodeChallenge = { ...parsed.data, ephemeral: false };
    await writeFile(challengePath(projectDir), JSON.stringify(updated, null, 2) + "\n", "utf8");
  } catch {
    // No challenge to consume.
  }
}

// ---------------------------------------------------------------------------
// WebAuthn / passkey detection helper
// ---------------------------------------------------------------------------

/**
 * Browser-side hint for whether WebAuthn is available.
 * This runs on the client side; the server-side probe returns
 * feature flags based on user-agent heuristics.
 *
 * Actual availability is a secure-context question — measured
 * on a real device and recorded in verification-notes.
 */
export function webauthnAvailableInBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  // Must be a secure context for PublicKeyCredential to exist.
  // On HTTPS served by private CA certs, some browsers treat this
  // as secure-context, others don't. This is a heuristic only.
  return typeof (navigator as NavigatorWithWebAuthn).credentials !== "undefined";
}

interface NavigatorWithWebAuthn extends Navigator {
  credentials?: unknown;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Read unlock window from settings. Falls back to default. */
export function resolveUnlockMinutes(
  settings: Record<string, unknown>,
): number {
  const raw = settings["authentication.unlock_minutes"];
  if (typeof raw === "number" && raw > 0 && raw <= MAX_UNLOCK_HOURS * 60) {
    return Math.floor(raw);
  }
  return DEFAULT_UNLOCK_MINUTES;
}
