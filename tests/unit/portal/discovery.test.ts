/**
 * RFC 8414 discovery, and the two servers this flow must refuse.
 *
 * Both refusals are cheap here and expensive later: a server that only offers
 * `plain` is discovered at the token endpoint AFTER the user has signed in and
 * consented, and a cleartext endpoint is discovered never.
 */

import { describe, expect, it } from "vitest";
import {
  type AuthorizationServerMetadata,
  assertSupportsThisFlow,
  discoverAuthorizationServer,
  discoveryUrlFor,
  type FetchLike,
  PortalAuthError,
  supportsRefresh,
} from "../../../src/portal/index.js";

const ISSUER = "https://clerk.example.test";

const GOOD: AuthorizationServerMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["openid", "profile", "email", "offline_access", "user:org:read"],
};

/** A fetch that answers exactly one URL, and records what it was asked for. */
function fakeFetch(body: unknown, init: { status?: number; json?: boolean } = {}) {
  const calls: string[] = [];
  const impl: FetchLike = async (url) => {
    calls.push(url);
    const text = init.json === false ? "not json at all" : JSON.stringify(body);
    return new Response(text, {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

describe("discoveryUrlFor", () => {
  it("appends the well-known path without doubling the slash", () => {
    expect(discoveryUrlFor(ISSUER)).toBe(`${ISSUER}/.well-known/oauth-authorization-server`);
    expect(discoveryUrlFor(`${ISSUER}/`)).toBe(`${ISSUER}/.well-known/oauth-authorization-server`);
    expect(discoveryUrlFor(`${ISSUER}///`)).toBe(
      `${ISSUER}/.well-known/oauth-authorization-server`,
    );
  });

  it("refuses a cleartext issuer, but allows loopback for local testing", () => {
    expect(() => discoveryUrlFor("http://portal.example.test")).toThrow(PortalAuthError);
    expect(() => discoveryUrlFor("http://127.0.0.1:9999")).not.toThrow();
  });

  it("refuses something that is not a URL at all", () => {
    expect(() => discoveryUrlFor("golem.run")).toThrow(/not a valid URL/);
  });
});

describe("discoverAuthorizationServer", () => {
  it("fetches the well-known document and returns the endpoints", async () => {
    const { impl, calls } = fakeFetch(GOOD);
    const metadata = await discoverAuthorizationServer(ISSUER, { fetchImpl: impl });
    expect(calls).toEqual([`${ISSUER}/.well-known/oauth-authorization-server`]);
    expect(metadata.token_endpoint).toBe(`${ISSUER}/oauth/token`);
  });

  it("reports a non-200 with a hint about which URL was configured", async () => {
    const { impl } = fakeFetch({}, { status: 404 });
    await expect(discoverAuthorizationServer(ISSUER, { fetchImpl: impl })).rejects.toMatchObject({
      kind: "discovery_failed",
      status: 404,
    });
  });

  it("reports a body that is not JSON", async () => {
    const { impl } = fakeFetch({}, { json: false });
    await expect(discoverAuthorizationServer(ISSUER, { fetchImpl: impl })).rejects.toThrow(
      /did not return JSON/,
    );
  });

  it("reports metadata missing a required endpoint", async () => {
    const { impl } = fakeFetch({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/a` });
    await expect(discoverAuthorizationServer(ISSUER, { fetchImpl: impl })).rejects.toMatchObject({
      kind: "discovery_failed",
    });
  });

  it("refuses a token endpoint served over cleartext", async () => {
    const { impl } = fakeFetch({ ...GOOD, token_endpoint: "http://evil.example.test/oauth/token" });
    await expect(discoverAuthorizationServer(ISSUER, { fetchImpl: impl })).rejects.toMatchObject({
      kind: "unsupported_server",
    });
  });

  it("surfaces a transport failure as discovery_failed, not as a raw throw", async () => {
    const impl: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    await expect(discoverAuthorizationServer(ISSUER, { fetchImpl: impl })).rejects.toMatchObject({
      kind: "discovery_failed",
    });
  });
});

describe("assertSupportsThisFlow", () => {
  it("accepts a server advertising S256 and authorization_code", () => {
    expect(() => assertSupportsThisFlow(GOOD)).not.toThrow();
  });

  it("refuses a server that only offers plain, and says why rather than falling back", () => {
    const plainOnly = { ...GOOD, code_challenge_methods_supported: ["plain"] };
    expect(() => assertSupportsThisFlow(plainOnly)).toThrow(/S256/);
    expect(() => assertSupportsThisFlow(plainOnly)).toThrow(/will not fall back/);
  });

  it("refuses a server with no authorization_code grant", () => {
    // This is also the shape a device-grant-only server would have; there is no
    // flow to run either way.
    expect(() =>
      assertSupportsThisFlow({ ...GOOD, grant_types_supported: ["client_credentials"] }),
    ).toThrow(/authorization_code/);
  });

  it("takes a server that advertises neither list at its word", () => {
    const silent: AuthorizationServerMetadata = {
      issuer: GOOD.issuer,
      authorization_endpoint: GOOD.authorization_endpoint,
      token_endpoint: GOOD.token_endpoint,
    };
    expect(() => assertSupportsThisFlow(silent)).not.toThrow();
    expect(supportsRefresh(silent)).toBe(true);
  });

  it("knows when refresh is not on offer", () => {
    expect(supportsRefresh({ ...GOOD, grant_types_supported: ["authorization_code"] })).toBe(false);
  });
});
