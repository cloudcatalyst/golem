/**
 * The authorized portal client, and the retry rule the contract fixes exactly.
 *
 * > *"Refresh with `grant_type=refresh_token` on a `401 unauthenticated`, once,
 * > then re-run the full flow if that also fails."* — the portal's
 * > `docs/api-contract.md` §1.
 *
 * "Once" is load-bearing and easy to get wrong in a way that only shows up in
 * production: a refresh loop against an authorization server that keeps
 * answering 401 is an unbounded retry against someone else's rate limiter, from
 * a CLI the user believes is idle. So the ladder is counted, not just written
 * down, and {@link PortalClient.stats} reports what actually happened so a test
 * can assert the count rather than the intent:
 *
 *   attempt 1 → 401 → ONE refresh → attempt 2 → 401 → ONE full re-link →
 *   attempt 3 → 401 → give up and say so.
 *
 * The re-link leg is opt-in (`reauthorize`), because it opens a browser. A
 * non-interactive caller passes nothing and gets a clean `not_linked` failure
 * instead of a surprise browser window.
 */

import { z } from "zod";
import type { AuthorizationServerMetadata, FetchLike } from "./discovery.js";
import { PortalAuthError } from "./errors.js";
import { refreshTokens } from "./exchange.js";
import { isExpired, type PortalTokenSet, type PortalTokenStore } from "./tokens.js";

/**
 * Accept `null` from the wire wherever an absent field is acceptable, and
 * normalize it to `undefined` so nothing downstream has to know the difference.
 *
 * `.optional()` alone does NOT do this: in zod it admits `undefined` and
 * rejects `null`. A JSON API that serialises "no value" as an explicit `null`
 * therefore fails a schema that looks permissive — which is exactly what
 * happened on the first live `golem team link`. The portal answered `200` with
 * every field correct except `auth.scopes: null`, and the whole response was
 * refused as "an unexpected shape" (verification-notes §164).
 *
 * This is the boundary being liberal in what it accepts while the inside stays
 * strict: `PortalIdentity` keeps its `T | undefined` fields, so no consumer
 * changes and no `null` leaks past this line.
 */
export const wireOptional = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined);

/** `GET /api/v1/me` — the first call any client makes. */
const identitySchema = z.object({
  user: z.object({ id: z.string(), email: wireOptional(z.string()) }),
  auth: wireOptional(
    z.object({ via: wireOptional(z.string()), scopes: wireOptional(z.array(z.string())) }),
  ),
  // Absent, null, or a list — all mean "no organizations to choose from", and
  // the caller gets an array either way rather than three cases to handle.
  organizations: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        slug: wireOptional(z.string()),
        role: wireOptional(z.string()),
        entitled: wireOptional(z.boolean()),
        subscriptionStatus: wireOptional(z.string()),
        seatCount: wireOptional(z.number()),
      }),
    )
    .nullish()
    .transform((value) => value ?? []),
});

export type PortalIdentity = z.infer<typeof identitySchema>;

/** What the retry ladder actually did, for tests and `--json` diagnostics. */
export interface PortalClientStats {
  readonly requests: number;
  readonly refreshAttempts: number;
  readonly reauthorizations: number;
}

export interface PortalClient {
  /** An authorized request against `/api/v1/...`, with the retry ladder. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** `GET /api/v1/me`, validated. */
  me(): Promise<PortalIdentity>;
  readonly stats: PortalClientStats;
}

export interface PortalClientOptions {
  /** Portal API base, e.g. `https://golem.run`. `/api/v1/...` hangs off it. */
  readonly apiBaseUrl: string;
  readonly clientId: string;
  /** Lazily discovered, so an unauthenticated caller never pays for it. */
  readonly metadata: () => Promise<AuthorizationServerMetadata>;
  readonly tokens: PortalTokenStore;
  /**
   * Re-run the whole browser flow. Omit in non-interactive contexts: a CLI that
   * opens a browser without being asked is worse than one that fails.
   */
  readonly reauthorize?: () => Promise<PortalTokenSet>;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function createPortalClient(options: PortalClientOptions): PortalClient {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const now = options.now ?? Date.now;
  const stats = { requests: 0, refreshAttempts: 0, reauthorizations: 0 };

  async function binding(): Promise<{ issuer: string; clientId: string }> {
    const metadata = await options.metadata();
    return { issuer: metadata.issuer, clientId: options.clientId };
  }

  async function current(): Promise<PortalTokenSet> {
    const tokens = await options.tokens.read(await binding());
    if (tokens === null) {
      throw new PortalAuthError(
        "not_linked",
        "this machine is not linked to the portal. Run `golem team link` first.",
      );
    }
    return tokens;
  }

  /** One refresh. Returns null when it could not be done at all. */
  async function tryRefresh(tokens: PortalTokenSet): Promise<PortalTokenSet | null> {
    if (tokens.refresh_token === undefined) return null;
    stats.refreshAttempts += 1;
    const metadata = await options.metadata();
    let renewed: PortalTokenSet;
    try {
      renewed = await refreshTokens({
        metadata,
        clientId: options.clientId,
        tokens,
        now,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
    } catch {
      // A failed refresh is not fatal on its own — the full flow is the next
      // rung. The reason is not surfaced here because it would be the second
      // error a user sees for one problem.
      return null;
    }
    await options.tokens.write(renewed);
    return renewed;
  }

  async function tryReauthorize(): Promise<PortalTokenSet | null> {
    if (options.reauthorize === undefined) return null;
    stats.reauthorizations += 1;
    return await options.reauthorize();
  }

  async function send(path: string, init: RequestInit, tokens: PortalTokenSet): Promise<Response> {
    stats.requests += 1;
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${tokens.access_token}`);
    headers.set("accept", "application/json");
    return await fetchImpl(joinUrl(options.apiBaseUrl, path), { ...init, headers });
  }

  // Declared as a function rather than a method so `me()` can call it without
  // depending on `this` — a destructured `const { me } = client` would otherwise
  // throw, and that is exactly how a client gets passed to a helper.
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    let tokens = await current();

    // A token we already know is expired should not be spent on a doomed
    // request first — that would burn the one refresh on a 401 we could have
    // predicted. This pre-emptive renewal is the SAME single refresh: if it
    // fails, the ladder below still has exactly its full-flow rung left.
    if (isExpired(tokens, now())) {
      const renewed = await tryRefresh(tokens);
      if (renewed !== null) tokens = renewed;
    }

    let response = await send(path, init, tokens);
    if (response.status !== 401) return response;

    // Rung 1: exactly one refresh — unless the pre-emptive renewal above
    // already spent it.
    if (stats.refreshAttempts === 0) {
      const renewed = await tryRefresh(tokens);
      if (renewed !== null) {
        tokens = renewed;
        response = await send(path, init, tokens);
        if (response.status !== 401) return response;
      }
    }

    // Rung 2: the full flow, once.
    const relinked = await tryReauthorize();
    if (relinked === null) {
      throw new PortalAuthError(
        "not_linked",
        "the portal rejected the stored token and it could not be refreshed. " +
          "Run `golem team link` to sign in again.",
        401,
      );
    }
    response = await send(path, init, relinked);
    if (response.status === 401) {
      throw new PortalAuthError(
        "not_linked",
        "the portal rejected a freshly issued token. That is a portal-side problem, " +
          "not a stale credential — nothing further will help from here.",
        401,
      );
    }
    return response;
  }

  return {
    stats,
    request,

    me: async (): Promise<PortalIdentity> => {
      const response = await request("/api/v1/me");
      if (!response.ok) {
        throw new PortalAuthError(
          "api_error",
          `GET /api/v1/me answered ${response.status}`,
          response.status,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new PortalAuthError("api_error", "GET /api/v1/me did not return JSON");
      }
      const parsed = identitySchema.safeParse(payload);
      if (!parsed.success) {
        throw new PortalAuthError("api_error", "GET /api/v1/me returned an unexpected shape");
      }
      return parsed.data;
    },
  };
}
