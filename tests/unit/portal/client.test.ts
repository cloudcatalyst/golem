/**
 * The retry ladder, which is a gate item stated as a count:
 *
 * > *"A `401 unauthenticated` triggers exactly ONE refresh attempt before the
 * > full flow is re-run."*
 *
 * "Exactly one" is asserted two ways on purpose. `stats.refreshAttempts` is what
 * the code believes it did; the number of POSTs the fake fetch actually saw at
 * the token endpoint is what it really did. A bug that increments the counter
 * without making the call, or makes the call without counting, fails one and
 * passes the other.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  type AuthorizationServerMetadata,
  createPortalClient,
  type FetchLike,
  type PortalTokenSet,
  type PortalTokenStore,
} from "../../../src/portal/index.js";

const ISSUER = "https://clerk.example.test";
const API = "https://portal.example.test";
const META: AuthorizationServerMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
};

function tokenSet(over: Partial<PortalTokenSet> = {}): PortalTokenSet {
  return {
    issuer: ISSUER,
    client_id: "client_abc",
    access_token: "at-1",
    refresh_token: "rt-1",
    token_type: "Bearer",
    obtained_at: 1,
    ...over,
  };
}

/** An in-memory token store with the real one's issuer/client binding rule. */
function memoryStore(
  initial: PortalTokenSet | null,
): PortalTokenStore & { held: () => PortalTokenSet | null } {
  let held = initial;
  return {
    held: () => held,
    read: async (binding) => {
      if (held === null) return null;
      if (held.issuer !== binding.issuer || held.client_id !== binding.clientId) return null;
      return held;
    },
    write: async (tokens) => {
      held = tokens;
      return { backend: "keychain", label: "test keychain", protection: "os-keychain" };
    },
    clear: async () => {
      held = null;
      return [];
    },
  };
}

interface Recorded {
  readonly url: string;
  readonly authorization: string | null;
}

/**
 * A fetch that plays a scripted sequence of API statuses and always renews at
 * the token endpoint, recording every call.
 */
function scriptedFetch(apiStatuses: number[], options: { refreshFails?: boolean } = {}) {
  const calls: Recorded[] = [];
  let apiIndex = 0;
  const impl: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get("authorization") });
    if (url === META.token_endpoint) {
      if (options.refreshFails === true) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ access_token: `at-refreshed-${apiIndex}`, token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const status = apiStatuses[apiIndex] ?? 200;
    apiIndex += 1;
    return new Response(JSON.stringify({ user: { id: "user_1" }, organizations: [] }), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  const tokenPosts = () => calls.filter((c) => c.url === META.token_endpoint).length;
  const apiCalls = () => calls.filter((c) => c.url !== META.token_endpoint);
  return { impl, calls, tokenPosts, apiCalls };
}

describe("createPortalClient", () => {
  let store: ReturnType<typeof memoryStore>;

  beforeEach(() => {
    store = memoryStore(tokenSet());
  });

  const client = (
    fetchImpl: FetchLike,
    extra: { reauthorize?: () => Promise<PortalTokenSet> } = {},
  ) =>
    createPortalClient({
      apiBaseUrl: API,
      clientId: "client_abc",
      metadata: async () => META,
      tokens: store,
      fetchImpl,
      now: () => 1_000,
      ...extra,
    });

  it("sends the stored access token as a Bearer credential", async () => {
    const { impl, apiCalls } = scriptedFetch([200]);
    const c = client(impl);
    await c.request("/api/v1/me");
    expect(apiCalls()[0]?.url).toBe(`${API}/api/v1/me`);
    expect(apiCalls()[0]?.authorization).toBe("Bearer at-1");
  });

  it("does not refresh at all when the request succeeds", async () => {
    const { impl, tokenPosts } = scriptedFetch([200]);
    const c = client(impl);
    await c.request("/api/v1/me");
    expect(c.stats.refreshAttempts).toBe(0);
    expect(tokenPosts()).toBe(0);
  });

  it("on 401 refreshes EXACTLY once and retries with the new token", async () => {
    const { impl, tokenPosts, apiCalls } = scriptedFetch([401, 200]);
    const c = client(impl);
    const response = await c.request("/api/v1/me");

    expect(response.status).toBe(200);
    expect(c.stats.refreshAttempts).toBe(1);
    expect(tokenPosts()).toBe(1);
    expect(apiCalls()).toHaveLength(2);
    expect(apiCalls()[0]?.authorization).toBe("Bearer at-1");
    expect(apiCalls()[1]?.authorization).toBe("Bearer at-refreshed-1");
    // The renewed token is persisted, so the next command does not repeat this.
    expect(store.held()?.access_token).toBe("at-refreshed-1");
  });

  it("after a second 401 runs the FULL flow once — never a second refresh", async () => {
    const { impl, tokenPosts } = scriptedFetch([401, 401, 200]);
    let relinked = 0;
    const c = client(impl, {
      reauthorize: async () => {
        relinked += 1;
        return tokenSet({ access_token: "at-relinked" });
      },
    });
    const response = await c.request("/api/v1/me");

    expect(response.status).toBe(200);
    expect(c.stats.refreshAttempts).toBe(1);
    expect(tokenPosts()).toBe(1);
    expect(relinked).toBe(1);
    expect(c.stats.reauthorizations).toBe(1);
  });

  it("gives up rather than looping when even a fresh token is rejected", async () => {
    const { impl, tokenPosts } = scriptedFetch([401, 401, 401, 401, 401]);
    let relinked = 0;
    const c = client(impl, {
      reauthorize: async () => {
        relinked += 1;
        return tokenSet({ access_token: "at-relinked" });
      },
    });
    await expect(c.request("/api/v1/me")).rejects.toMatchObject({
      kind: "not_linked",
      status: 401,
    });
    // The whole point: bounded. One refresh, one re-link, then stop.
    expect(c.stats.refreshAttempts).toBe(1);
    expect(tokenPosts()).toBe(1);
    expect(relinked).toBe(1);
  });

  it("does not open a browser when no reauthorize callback was given", async () => {
    const { impl } = scriptedFetch([401, 401]);
    const c = client(impl);
    await expect(c.request("/api/v1/me")).rejects.toMatchObject({ kind: "not_linked" });
    expect(c.stats.reauthorizations).toBe(0);
  });

  it("still spends only one refresh when the refresh itself fails", async () => {
    const { impl, tokenPosts } = scriptedFetch([401, 401], { refreshFails: true });
    const c = client(impl);
    await expect(c.request("/api/v1/me")).rejects.toMatchObject({ kind: "not_linked" });
    expect(c.stats.refreshAttempts).toBe(1);
    expect(tokenPosts()).toBe(1);
  });

  it("renews a known-expired token pre-emptively, and that IS the one refresh", async () => {
    store = memoryStore(tokenSet({ expires_at: 500 }));
    const { impl, tokenPosts, apiCalls } = scriptedFetch([401, 200]);
    let relinked = 0;
    const c = client(impl, {
      reauthorize: async () => {
        relinked += 1;
        return tokenSet({ access_token: "at-relinked" });
      },
    });
    const response = await c.request("/api/v1/me");

    expect(response.status).toBe(200);
    // One refresh total — the pre-emptive renewal did not buy a second one.
    expect(c.stats.refreshAttempts).toBe(1);
    expect(tokenPosts()).toBe(1);
    expect(apiCalls()[0]?.authorization).toBe("Bearer at-refreshed-0");
    expect(relinked).toBe(1);
  });

  it("refuses without any network call when nothing is stored", async () => {
    store = memoryStore(null);
    const { impl, calls } = scriptedFetch([200]);
    await expect(client(impl).request("/api/v1/me")).rejects.toMatchObject({ kind: "not_linked" });
    expect(calls).toHaveLength(0);
  });

  it("treats a token minted for a different issuer as not linked", async () => {
    store = memoryStore(tokenSet({ issuer: "https://clerk.other.test" }));
    const { impl } = scriptedFetch([200]);
    // A development token must never be presented to production.
    await expect(client(impl).request("/api/v1/me")).rejects.toMatchObject({ kind: "not_linked" });
  });

  describe("me()", () => {
    it("validates and returns the identity document", async () => {
      const impl: FetchLike = async () =>
        new Response(
          JSON.stringify({
            user: { id: "user_1", email: "dev@example.test" },
            auth: { via: "oauth_token", scopes: ["openid"] },
            organizations: [{ id: "org_1", name: "Red Lava", slug: "red-lava", entitled: true }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      const identity = await client(impl).me();
      expect(identity.user.id).toBe("user_1");
      expect(identity.organizations[0]?.name).toBe("Red Lava");
    });

    it("works when it is destructured off the client", async () => {
      const impl: FetchLike = async () =>
        new Response(JSON.stringify({ user: { id: "user_1" }, organizations: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      const { me } = client(impl);
      await expect(me()).resolves.toMatchObject({ user: { id: "user_1" } });
    });

    it("reports a non-401 API failure as api_error with its status", async () => {
      const impl: FetchLike = async () => new Response("{}", { status: 503 });
      await expect(client(impl).me()).rejects.toMatchObject({ kind: "api_error", status: 503 });
    });

    it("reports an unexpected shape rather than trusting it", async () => {
      const impl: FetchLike = async () =>
        new Response(JSON.stringify({ nope: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      await expect(client(impl).me()).rejects.toThrow(/unexpected shape/);
    });
  });
});
