/**
 * Where the portal credential lives: the OS keychain, and nowhere else.
 *
 * ADR-0003 put provider credentials in the platform's secret store rather than
 * in a settings file, and this is the same credential class, so it reuses the
 * same seam (`src/credentials/`) rather than growing a second one. Three rules
 * are enforced here rather than left to callers:
 *
 * 1. **The write always targets `keychain`.** The credential store's `file`
 *    backend is plaintext under `~/.golem/credentials/`, and the whole point of
 *    ADR-0003 is that a token does not land there. `golem gateway login` offers
 *    `--store file` as a documented escape hatch for headless machines; a portal
 *    token gets no such hatch, because a headless machine cannot complete this
 *    flow in the first place (see `browser.ts`).
 * 2. **A token is never rendered.** {@link describeTokenSet} exists so status
 *    output has something honest to print — issuer, scopes, expiry — that
 *    contains no secret material at all.
 * 3. **A token is bound to the issuer and client it was minted for.** Point
 *    `portal.url` somewhere else and the stored token stops being returned, so a
 *    development token can never be presented to production.
 *
 * A note on Windows, because it looks like a contradiction and is not: the
 * platform's OS-backed backend there is DPAPI, which writes a
 * `CryptProtectData` blob under `~/.golem/credentials/<account>.dpapi`. That is
 * a *file path*, but its contents are ciphertext bound to the current user and
 * machine — the plaintext token is not present in it, and a copied or roamed
 * blob cannot be decrypted elsewhere. The invariant to assert is that the
 * plaintext never appears in any file, which is what the tests check.
 */

import { z } from "zod";
import type { CredentialLocation, CredentialStore } from "../credentials/index.js";
import { PortalAuthError } from "./errors.js";

/**
 * The credential-store account the portal token occupies.
 *
 * Prefixed so it cannot collide with a user-chosen gateway id: `golem gateway
 * add` ids are free-form, and two different credentials sharing an account name
 * would silently overwrite each other.
 */
export const PORTAL_ACCOUNT = "portal-oauth";

/** Treat a token as expired this long before it really is (clock skew, latency). */
export const EXPIRY_SKEW_MS = 30_000;

const tokenSetSchema = z.object({
  /** The authorization server that minted this. */
  issuer: z.string().min(1),
  /** The OAuth client id it was minted for. */
  client_id: z.string().min(1),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().min(1),
  scope: z.string().optional(),
  /** Epoch ms. Absent when the server did not send `expires_in`. */
  expires_at: z.number().int().positive().optional(),
  obtained_at: z.number().int().positive(),
});

export type PortalTokenSet = z.infer<typeof tokenSetSchema>;

/** Non-secret summary, safe to print, log, and put in `--json` output. */
export interface TokenSummary {
  readonly issuer: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly hasRefreshToken: boolean;
  /** ISO-8601, or null when the server did not say. */
  readonly expiresAt: string | null;
  readonly expired: boolean;
}

export function describeTokenSet(tokens: PortalTokenSet, now = Date.now()): TokenSummary {
  return {
    issuer: tokens.issuer,
    clientId: tokens.client_id,
    scopes: tokens.scope === undefined ? [] : tokens.scope.split(/\s+/).filter((s) => s !== ""),
    hasRefreshToken: tokens.refresh_token !== undefined,
    expiresAt: tokens.expires_at === undefined ? null : new Date(tokens.expires_at).toISOString(),
    expired: isExpired(tokens, now),
  };
}

/** True when the access token is past its expiry, minus the skew allowance. */
export function isExpired(tokens: PortalTokenSet, now = Date.now()): boolean {
  if (tokens.expires_at === undefined) return false;
  return now >= tokens.expires_at - EXPIRY_SKEW_MS;
}

export interface PortalTokenStore {
  /**
   * The stored token set, or null when this machine is not linked — or is
   * linked to a DIFFERENT issuer/client than the one asked for.
   */
  read(binding: TokenBinding): Promise<PortalTokenSet | null>;
  /** Persist to the OS keychain. Throws when the platform has none. */
  write(tokens: PortalTokenSet): Promise<CredentialLocation>;
  /** Remove the stored token from every backend that has one. */
  clear(): Promise<readonly CredentialLocation[]>;
}

/** Which authorization server and client a read is asking about. */
export interface TokenBinding {
  readonly issuer: string;
  readonly clientId: string;
}

/**
 * Is there a portal token on this machine at all?
 *
 * Deliberately issuer-agnostic, which is the whole reason it exists.
 * {@link PortalTokenStore.read} takes a {@link TokenBinding}, and getting the
 * issuer means fetching the authorization-server metadata — a network call. The
 * one caller that cannot afford that is `golem init`, which must work offline
 * (`project-team-binding`: *a project must initialise without a network*).
 *
 * So this answers only the question init actually asks: name `golem team link`,
 * or try a sync? A token for the wrong issuer is not returned by `read` later
 * anyway, and the wrong answer here costs one attempted sync that degrades
 * loudly rather than an init that fails.
 *
 * Reads no token INTO anything: the secret is fetched by the credential store
 * and immediately discarded in favour of a boolean.
 */
export async function portalTokenPresent(credentials: CredentialStore): Promise<boolean> {
  try {
    return (await credentials.resolve(PORTAL_ACCOUNT)) !== null;
  } catch {
    // No usable keychain on this machine is "no token", not a failure — and on
    // a Linux box with no `secret-tool` it is the normal answer.
    return false;
  }
}

export function portalTokenStore(credentials: CredentialStore): PortalTokenStore {
  return {
    read: async (binding) => {
      const hit = await credentials.resolve(PORTAL_ACCOUNT);
      if (hit === null) return null;
      let raw: unknown;
      try {
        raw = JSON.parse(hit.secret);
      } catch {
        // A corrupt blob is "not linked", not a crash: `golem team link` fixes
        // it, and there is nothing here worth trying to salvage.
        return null;
      }
      const parsed = tokenSetSchema.safeParse(raw);
      if (!parsed.success) return null;
      if (parsed.data.issuer !== binding.issuer) return null;
      if (parsed.data.client_id !== binding.clientId) return null;
      return parsed.data;
    },

    write: async (tokens) => {
      // `"keychain"`, explicitly — never `"auto"`, which would be the same today
      // but would silently follow the credential store if its fallback ever
      // changed, and never `"file"`, which is plaintext on disk.
      try {
        return await credentials.store(PORTAL_ACCOUNT, JSON.stringify(tokens), "keychain");
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new PortalAuthError(
          "no_secure_store",
          `the portal token cannot be stored on this machine: ${why} ` +
            "Golem will not fall back to writing it in plaintext (ADR-0003), so sign-in " +
            "was abandoned and nothing was saved.",
        );
      }
    },

    clear: () => credentials.forget(PORTAL_ACCOUNT),
  };
}
