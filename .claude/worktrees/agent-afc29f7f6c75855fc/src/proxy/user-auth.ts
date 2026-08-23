/**
 * User authentication factor — bounded unlock for the write surface.
 *
 * A certificate proves a device; the user factor proves a person.
 * The goal mechanism is WebAuthn/passkeys where the platform supports it
 * in this context (secure-context question, MEASURED before promising),
 * with a numeric passcode as the universal fallback.
 *
 * Unlock duration: configurable, default 15 minutes. Re-prompts after idle.
 * High-risk acts (gate-map item 5) require fresh re-authentication every time.
 */

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const DEFAULT_UNLOCK_MINUTES = 15;
const MAX_UNLOCK_HOURS = 24;

export interface AuthState {
  readonly method: "webauthn" | "passcode";
  readonly expiresAt: number;
}

export interface PasscodeChallenge {
  readonly code: string;
  readonly ttlSeconds: number;
  readonly ephemeral: true;
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

function authStatePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "user-auth.json");
}

function challengePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "passcode-challenge.json");
}

/** Current auth state if still valid and non-expired. */
export async function getUnlockState(
  projectDir: string,
  nowMs?: number,
): Promise<AuthState | null> {
  try {
    const raw = await readFile(authStatePath(projectDir), "utf8");
    const parsed = authStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return (nowMs ?? Date.now()) > parsed.data.expiresAt ? null : parsed.data;
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
  const p = authStatePath(projectDir);
  await writeFile(p, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** Clear the current unlock state immediately. */
export async function clearUnlockState(projectDir: string): Promise<void> {
  try {
    await readFile(authStatePath(projectDir), "utf8");
    await writeFile(authStatePath(projectDir), "", "utf8").catch(() => {});
  } catch {
    /* Did not exist — nothing to clear. */
  }
}

// ---------------------------------------------------------------------------
// High-risk gate
// ---------------------------------------------------------------------------

interface RiskSession {
  readonly lastHighRiskAuth: number;
}

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
  const windowMs = (opts?.windowMinutes ?? HIGH_RISK_REAUTH_WINDOW_MIN) * 60 * 1000;
  try {
    const raw = await readFile(riskSessionPath(projectDir), "utf8");
    const parsed = riskSessionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return true;
    return (nowMs ?? Date.now()) - parsed.data.lastHighRiskAuth > windowMs;
  } catch {
    return true;
  }
}

/** Mark that high-risk re-auth was just performed. */
export async function recordHighRiskAuth(projectDir: string, nowMs?: number): Promise<void> {
  const now = nowMs ?? Date.now();
  const session: RiskSession = { lastHighRiskAuth: now };
  await writeFile(riskSessionPath(projectDir), JSON.stringify(session, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Passcode challenges (fallback mechanism)
// ---------------------------------------------------------------------------

/** Generate a one-time passcode challenge and persist it. Returns code + TTL. */
export async function generatePasscodeChallenge(
  projectDir: string,
  opts?: { ttlSeconds?: number },
): Promise<PasscodeChallenge> {
  const ttl = opts?.ttlSeconds ?? 300;
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const challenge: RawPasscodeChallenge = { code, ttlSeconds: ttl, ephemeral: true };
  await writeFile(challengePath(projectDir), JSON.stringify(challenge, null, 2) + "\n", "utf8");
  return { ...challenge, ephemeral: true };
}

/**
 * Validate a passcode against the stored challenge.
 * Consumes the challenge (ephemeral). Does NOT auto-unlock — caller writes the state.
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
    if (now / 1000 > parsed.data.ttlSeconds) {
      await consumeChallenge(projectDir);
      return "expired";
    }
    if (parsed.data.ephemeral && inputCode === parsed.data.code) {
      await consumeChallenge(projectDir);
      return "ok";
    }
    // Wrong answer or already consumed.
    await consumeChallenge(projectDir);
    return parsed.data.ephemeral ? "wrong" : "consumed";
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
    /* No challenge to consume. */
  }
}

/** Browser-side hint for whether WebAuthn is available. Heuristic only. */
export function webauthnAvailableInBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return typeof (navigator as NavigatorWithWebAuthn).credentials !== "undefined";
}

interface NavigatorWithWebAuthn extends Navigator {
  credentials?: unknown;
}

/** Read unlock window from settings. Falls back to default. */
export function resolveUnlockMinutes(settings: Record<string, unknown>): number {
  const raw = settings["authentication.unlock_minutes"];
  if (typeof raw === "number" && raw > 0 && raw <= MAX_UNLOCK_HOURS * 60) {
    return Math.floor(raw);
  }
  return DEFAULT_UNLOCK_MINUTES;
}
