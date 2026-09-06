/**
 * The authorization URL and the token endpoint.
 *
 * The `offline_access` assertion is the one worth explaining. Losing that scope
 * does not fail — it produces a link that works, and then re-prompts forever one
 * expiry later, which reads as a harness bug rather than as a misregistered
 * OAuth application. So the code refuses at registration-check time, and this
 * pins that refusal.
 */

import { describe, expect, it } from "vitest";
import {
  type AuthorizationServerMetadata,
  authorizationUrl,
  createPkcePair,
  DEFAULT_SCOPES,
  exchangeCode,
  type FetchLike,
  type PortalTokenSet,
  refreshTokens,
} from "../../../src/portal/index.js";

const ISSUER = "https://clerk.example.test";
const META: AuthorizationServerMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["openid", "profile", "email", "offline_access"],
};

const PKCE = createPkcePair();
const REDIRECT = "http://127.0.0.1:51234/callback";

function recordingFetch(response: unknown, status = 200) {
  const bodies: string[] = [];
  const urls: string[] = [];
  const impl: FetchLike = async (url, init) => {
    urls.push(url);
    bodies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, bodies, urls };
}

describe("authorizationUrl", () => {
  const url = () =>
    new URL(
      authorizationUrl({
        metadata: META,
        clientId: "client_abc",
        redirectUri: REDIRECT,
        state: "state-xyz",
        pkce: PKCE,
      }),
    );

  it("carries every parameter the flow requires", () => {
    const q = url().searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("client_abc");
    expect(q.get("redirect_uri")).toBe(REDIRECT);
    expect(q.get("state")).toBe("state-xyz");
    expect(q.get("code_challenge")).toBe(PKCE.challenge);
    expect(q.get("code_challenge_method")).toBe("S256");
  });

  it("requests offline_access, so a refresh token is actually issued", () => {
    expect(url().searchParams.get("scope")?.split(" ")).toContain("offline_access");
    expect(DEFAULT_SCOPES).toContain("offline_access");
  });

  it("never puts the code_verifier in the browser URL", () => {
    // The verifier goes to the token endpoint and nowhere else; in the
    // authorization URL it would be visible to anything that sees the redirect.
    expect(url().href).not.toContain(PKCE.verifier);
  });

  it("points at 127.0.0.1, not localhost", () => {
    expect(url().searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it("refuses to open a browser for a scope the server does not advertise", () => {
    const noOffline = { ...META, scopes_supported: ["openid", "profile", "email"] };
    expect(() =>
      authorizationUrl({
        metadata: noOffline,
        clientId: "client_abc",
        redirectUri: REDIRECT,
        state: "s",
        pkce: PKCE,
      }),
    ).toThrow(/offline_access/);
  });
});

describe("exchangeCode", () => {
  it("POSTs the documented form body, with the verifier and no client secret", async () => {
    const { impl, bodies, urls } = recordingFetch({
      access_token: "at-1",
      refresh_token: "rt-1",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid offline_access",
    });
    const tokens = await exchangeCode({
      metadata: META,
      clientId: "client_abc",
      code: "auth-code-1",
      redirectUri: REDIRECT,
      verifier: PKCE.verifier,
      fetchImpl: impl,
      now: () => 1_000_000,
    });

    expect(urls).toEqual([`${ISSUER}/oauth/token`]);
    const form = new URLSearchParams(bodies[0]);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("auth-code-1");
    expect(form.get("redirect_uri")).toBe(REDIRECT);
    expect(form.get("client_id")).toBe("client_abc");
    expect(form.get("code_verifier")).toBe(PKCE.verifier);
    // A public client has no secret, and must not invent one.
    expect(form.get("client_secret")).toBeNull();

    expect(tokens.access_token).toBe("at-1");
    expect(tokens.refresh_token).toBe("rt-1");
    expect(tokens.expires_at).toBe(1_000_000 + 3600 * 1000);
    expect(tokens.issuer).toBe(ISSUER);
    expect(tokens.client_id).toBe("client_abc");
  });

  it("reports an OAuth error without echoing the response body", async () => {
    // The body deliberately carries something secret-shaped alongside the
    // documented fields: a token endpoint that reflects the request back must
    // not become the thing that leaks it into a terminal.
    const { impl } = recordingFetch(
      {
        error: "invalid_grant",
        error_description: "code already used",
        echoed_request: { code_verifier: "SECRET-VERIFIER-VALUE" },
      },
      400,
    );
    const attempt = exchangeCode({
      metadata: META,
      clientId: "client_abc",
      code: "c",
      redirectUri: REDIRECT,
      verifier: PKCE.verifier,
      fetchImpl: impl,
    });
    await expect(attempt).rejects.toMatchObject({ kind: "token_exchange_failed", status: 400 });
    await attempt.catch((err: Error) => {
      expect(err.message).toContain("invalid_grant");
      expect(err.message).toContain("code already used");
      expect(err.message).not.toContain("SECRET-VERIFIER-VALUE");
    });
  });

  it("rejects a 200 that is not a token response", async () => {
    const { impl } = recordingFetch({ nope: true });
    await expect(
      exchangeCode({
        metadata: META,
        clientId: "c",
        code: "c",
        redirectUri: REDIRECT,
        verifier: PKCE.verifier,
        fetchImpl: impl,
      }),
    ).rejects.toThrow(/not a valid token response/);
  });
});

describe("refreshTokens", () => {
  const stored: PortalTokenSet = {
    issuer: ISSUER,
    client_id: "client_abc",
    access_token: "at-old",
    refresh_token: "rt-old",
    token_type: "Bearer",
    obtained_at: 1,
  };

  it("sends grant_type=refresh_token with the stored refresh token", async () => {
    const { impl, bodies } = recordingFetch({ access_token: "at-new", token_type: "Bearer" });
    await refreshTokens({
      metadata: META,
      clientId: "client_abc",
      tokens: stored,
      fetchImpl: impl,
    });
    const form = new URLSearchParams(bodies[0]);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt-old");
    expect(form.get("client_id")).toBe("client_abc");
  });

  it("keeps the existing refresh token when the response omits one (RFC 6749 §6)", async () => {
    const { impl } = recordingFetch({ access_token: "at-new", token_type: "Bearer" });
    const renewed = await refreshTokens({
      metadata: META,
      clientId: "client_abc",
      tokens: stored,
      fetchImpl: impl,
    });
    // Dropping it here would turn every silent refresh into "sign in again"
    // one expiry later.
    expect(renewed.refresh_token).toBe("rt-old");
    expect(renewed.access_token).toBe("at-new");
  });

  it("takes a rotated refresh token when the server sends one", async () => {
    const { impl } = recordingFetch({
      access_token: "at-new",
      refresh_token: "rt-new",
      token_type: "Bearer",
    });
    const renewed = await refreshTokens({
      metadata: META,
      clientId: "client_abc",
      tokens: stored,
      fetchImpl: impl,
    });
    expect(renewed.refresh_token).toBe("rt-new");
  });

  it("says plainly when there is no refresh token to use", async () => {
    const { refresh_token: _dropped, ...noRefresh } = stored;
    await expect(
      refreshTokens({ metadata: META, clientId: "client_abc", tokens: noRefresh }),
    ).rejects.toThrow(/offline_access/);
  });
});
