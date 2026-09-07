/**
 * `linkPortal` end to end — everything except the human and the real browser.
 *
 * The "browser" here is a function that receives the authorization URL and does
 * to it what a real one would: parse it, and GET the `redirect_uri` with a
 * `code` and the `state` it was given. That exercises the actual loopback
 * server, the actual state check and the actual token exchange, so the only
 * unexercised link in the chain is the part where a person types a password into
 * a window this process cannot open.
 *
 * `resolvePortalConfig` is here too, since "which URL is which" is the thing
 * this task most easily gets wrong in a way no unit test would notice.
 */

import { describe, expect, it } from "vitest";
import type { CredentialBackend } from "../../../src/credentials/index.js";
import { createCredentialStore } from "../../../src/credentials/index.js";
import {
  type BrowserOpener,
  type FetchLike,
  linkPortal,
  PORTAL_ACCOUNT,
  portalStatus,
  portalTokenStore,
  resolvePortalConfig,
  unlinkPortal,
} from "../../../src/portal/index.js";
import { useTempDirs } from "../../helpers/tmp.js";

const ISSUER = "https://clerk.example.test";
const API = "https://portal.example.test";

const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["openid", "profile", "email", "offline_access"],
};

const makeTempDir = useTempDirs("golem-portal-link");

function fakeKeychain(): CredentialBackend & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    id: "keychain",
    available: async () => true,
    describe: () => ({ backend: "keychain", label: "fake keychain", protection: "os-keychain" }),
    get: async (a) => entries.get(a) ?? null,
    set: async (a, s) => {
      entries.set(a, s);
    },
    remove: async (a) => {
      entries.delete(a);
    },
  };
}

/** A fake authorization server: serves discovery, and exchanges one code. */
function authServer(options: { token?: Record<string, unknown> } = {}) {
  const exchanges: URLSearchParams[] = [];
  const impl: FetchLike = async (url, init) => {
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return new Response(JSON.stringify(METADATA), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === METADATA.token_endpoint) {
      exchanges.push(new URLSearchParams(String(init?.body ?? "")));
      return new Response(
        JSON.stringify(
          options.token ?? {
            access_token: "at-linked",
            refresh_token: "rt-linked",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "openid profile email offline_access",
          },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { impl, exchanges };
}

/** Acts like a browser: follows the redirect back to the loopback listener. */
function completingBrowser(overrides: { state?: string; code?: string } = {}): BrowserOpener & {
  seen: () => URL | null;
} {
  let seen: URL | null = null;
  return {
    seen: () => seen,
    open: async (raw) => {
      const url = new URL(raw);
      seen = url;
      const redirect = new URL(url.searchParams.get("redirect_uri") as string);
      redirect.searchParams.set("code", overrides.code ?? "auth-code-from-browser");
      redirect.searchParams.set(
        "state",
        overrides.state ?? (url.searchParams.get("state") as string),
      );
      // Fire and forget, exactly as a browser navigation would.
      void fetch(redirect.href).catch(() => {});
    },
  };
}

async function store() {
  const userDir = await makeTempDir();
  const keychain = fakeKeychain();
  return {
    keychain,
    tokens: portalTokenStore(createCredentialStore({ userDir, keychain })),
  };
}

describe("linkPortal", () => {
  it("runs discovery, the browser round trip and the exchange, then stores the token", async () => {
    const { impl, exchanges } = authServer();
    const { keychain, tokens } = await store();
    const browser = completingBrowser();

    const result = await linkPortal({
      issuerUrl: ISSUER,
      clientId: "client_abc",
      tokens,
      browser,
      fetchImpl: impl,
      timeoutMs: 5_000,
    });

    expect(result.location.backend).toBe("keychain");
    expect(result.tokens.access_token).toBe("at-linked");
    expect(keychain.entries.has(PORTAL_ACCOUNT)).toBe(true);

    // The verifier really did travel with the exchange, and only with it.
    const form = exchanges[0] as URLSearchParams;
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("auth-code-from-browser");
    expect(form.get("code_verifier")).toBeTruthy();
    expect(browser.seen()?.searchParams.get("code_verifier")).toBeNull();

    // The redirect the browser was sent to is the one the listener was on.
    const redirect = browser.seen()?.searchParams.get("redirect_uri") as string;
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it("stores nothing when the browser comes back with a tampered state", async () => {
    const { impl, exchanges } = authServer();
    const { keychain, tokens } = await store();

    await expect(
      linkPortal({
        issuerUrl: ISSUER,
        clientId: "client_abc",
        tokens,
        browser: completingBrowser({ state: "forged-state" }),
        fetchImpl: impl,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ kind: "state_mismatch" });

    // Nothing exchanged, nothing stored: the machine is exactly as it was.
    expect(exchanges).toHaveLength(0);
    expect(keychain.entries.size).toBe(0);
  });

  it("releases the loopback port whether it succeeds or fails", async () => {
    const { impl } = authServer();
    const { tokens } = await store();
    let redirectUri = "";
    const spy: BrowserOpener = {
      open: async (raw) => {
        redirectUri = new URL(raw).searchParams.get("redirect_uri") as string;
        // Never completes: the flow must time out and still clean up.
      },
    };
    await expect(
      linkPortal({
        issuerUrl: ISSUER,
        clientId: "client_abc",
        tokens,
        browser: spy,
        fetchImpl: impl,
        timeoutMs: 60,
      }),
    ).rejects.toMatchObject({ kind: "timed_out" });

    await expect(fetch(redirectUri)).rejects.toThrow();
  });

  it("warns, but still links, when no refresh token comes back", async () => {
    const { impl } = authServer({
      token: { access_token: "at-only", token_type: "Bearer", expires_in: 60 },
    });
    const { tokens } = await store();
    const said: string[] = [];

    const result = await linkPortal({
      issuerUrl: ISSUER,
      clientId: "client_abc",
      tokens,
      browser: completingBrowser(),
      fetchImpl: impl,
      timeoutMs: 5_000,
      write: (t) => said.push(t),
    });

    expect(result.summary.hasRefreshToken).toBe(false);
    expect(said.join("")).toContain("offline_access");
  });

  it("never narrates a token", async () => {
    const { impl } = authServer();
    const { tokens } = await store();
    const said: string[] = [];
    await linkPortal({
      issuerUrl: ISSUER,
      clientId: "client_abc",
      tokens,
      browser: completingBrowser(),
      fetchImpl: impl,
      timeoutMs: 5_000,
      write: (t) => said.push(t),
    });
    expect(said.join("")).not.toContain("at-linked");
    expect(said.join("")).not.toContain("rt-linked");
  });
});

describe("portalStatus and unlinkPortal", () => {
  it("reports not-linked before a link and linked after one", async () => {
    const { impl } = authServer();
    const { tokens } = await store();
    const options = {
      issuerUrl: ISSUER,
      apiBaseUrl: API,
      clientId: "client_abc",
      tokens,
      fetchImpl: impl,
    };

    expect((await portalStatus(options)).linked).toBe(false);

    await linkPortal({
      issuerUrl: ISSUER,
      clientId: "client_abc",
      tokens,
      browser: completingBrowser(),
      fetchImpl: impl,
      timeoutMs: 5_000,
    });

    const after = await portalStatus(options);
    expect(after.linked).toBe(true);
    expect(after.issuer).toBe(ISSUER);
    expect(JSON.stringify(after)).not.toContain("at-linked");

    await unlinkPortal(tokens);
    expect((await portalStatus(options)).linked).toBe(false);
  });

  it("degrades to not-linked rather than throwing when the portal is unreachable", async () => {
    const { tokens } = await store();
    const offline: FetchLike = async () => {
      throw new Error("ENETUNREACH");
    };
    // Nothing about a team link may stop the harness being usable offline.
    const status = await portalStatus({
      issuerUrl: ISSUER,
      apiBaseUrl: API,
      clientId: "client_abc",
      tokens,
      fetchImpl: offline,
    });
    expect(status.linked).toBe(false);
    expect(status.issuer).toBe(ISSUER);
  });
});

describe("resolvePortalConfig", () => {
  const base = { url: API, issuer: "", client_id: "client_abc", link_timeout_ms: 1000 };

  it("uses the portal URL as the issuer when no separate issuer is set", () => {
    expect(resolvePortalConfig(base)).toMatchObject({ apiBaseUrl: API, issuerUrl: API });
  });

  it("keeps the API and the authorization server apart when they differ", () => {
    // The real deployment shape: /api/v1/me on the portal's domain, OAuth on
    // Clerk's Frontend API. Collapsing these is the bug this key exists to stop.
    const resolved = resolvePortalConfig({ ...base, issuer: ISSUER });
    expect(resolved.apiBaseUrl).toBe(API);
    expect(resolved.issuerUrl).toBe(ISSUER);
  });

  it("trims trailing slashes off both", () => {
    const resolved = resolvePortalConfig({ ...base, url: `${API}/`, issuer: `${ISSUER}//` });
    expect(resolved.apiBaseUrl).toBe(API);
    expect(resolved.issuerUrl).toBe(ISSUER);
  });

  it("says which setting is missing rather than guessing a default", () => {
    // No baked-in portal: an unconfigured harness must say so, not reach for a
    // default host.
    expect(() => resolvePortalConfig({ ...base, url: "" })).toThrow(/portal\.url/);
    expect(() => resolvePortalConfig({ ...base, client_id: "" })).toThrow(/portal\.client_id/);
    expect(() => resolvePortalConfig({ ...base, url: "" })).toThrow(
      expect.objectContaining({ kind: "not_configured" }),
    );
  });

  it("treats whitespace as unset", () => {
    expect(() => resolvePortalConfig({ ...base, client_id: "   " })).toThrow(/client_id/);
    expect(() => resolvePortalConfig({ ...base, url: "   " })).toThrow(/portal\.url/);
  });
});
