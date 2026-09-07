/**
 * Where the token goes, and — the gate item — everywhere it must not.
 *
 * The second half of this file is the assertion the task asks for in as literal
 * a form as it can be made: run a complete link against a fake authorization
 * server, then walk EVERY file under both the user directory and the project
 * directory and assert the access and refresh token strings appear in none of
 * them.
 *
 * That phrasing is chosen over "assert nothing was written under `~/.golem/`"
 * because the latter is not quite true on Windows and the difference matters.
 * The platform's OS-backed backend there is DPAPI, which writes a
 * `CryptProtectData` blob to `~/.golem/credentials/<account>.dpapi`. It is a
 * file path under the user directory — but its contents are ciphertext bound to
 * the current user and machine, the plaintext is not in it, and a copied blob
 * cannot be read elsewhere. The invariant with actual security content is "the
 * plaintext token is in no file", and that is what is checked, on every
 * platform, including the one where a path-based check would have passed while
 * the plaintext sat in it.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CredentialBackend, CredentialStore } from "../../../src/credentials/index.js";
import { createCredentialStore } from "../../../src/credentials/index.js";
import {
  type AuthorizationServerMetadata,
  createPkcePair,
  describeTokenSet,
  exchangeCode,
  type FetchLike,
  isExpired,
  PORTAL_ACCOUNT,
  type PortalTokenSet,
  portalTokenStore,
} from "../../../src/portal/index.js";
import { useTempDirs } from "../../helpers/tmp.js";

const ISSUER = "https://clerk.example.test";
const META: AuthorizationServerMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["openid", "profile", "email", "offline_access"],
};

const ACCESS_TOKEN = "portal-access-token-3f9a2c7e-do-not-write-me-to-disk";
const REFRESH_TOKEN = "portal-refresh-token-8b1d4e6a-do-not-write-me-to-disk";

const makeTempDir = useTempDirs("golem-portal-tokens");

/** An in-memory stand-in for a real OS keychain. */
function fakeKeychain(): CredentialBackend & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    id: "keychain",
    available: async () => true,
    describe: () => ({ backend: "keychain", label: "fake keychain", protection: "os-keychain" }),
    get: async (account) => entries.get(account) ?? null,
    set: async (account, secret) => {
      entries.set(account, secret);
    },
    remove: async (account) => {
      entries.delete(account);
    },
  };
}

function tokenSet(over: Partial<PortalTokenSet> = {}): PortalTokenSet {
  return {
    issuer: ISSUER,
    client_id: "client_abc",
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    token_type: "Bearer",
    scope: "openid profile email offline_access",
    expires_at: 2_000_000,
    obtained_at: 1_000_000,
    ...over,
  };
}

/** Every regular file under `root`, recursively. */
async function allFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push(full);
    }
  }
  await walk(root);
  return found;
}

describe("portalTokenStore", () => {
  it("round-trips a token set through the keychain", async () => {
    const userDir = await makeTempDir();
    const keychain = fakeKeychain();
    const store = portalTokenStore(createCredentialStore({ userDir, keychain }));

    const location = await store.write(tokenSet());
    expect(location.backend).toBe("keychain");
    expect(keychain.entries.has(PORTAL_ACCOUNT)).toBe(true);

    const read = await store.read({ issuer: ISSUER, clientId: "client_abc" });
    expect(read?.access_token).toBe(ACCESS_TOKEN);
    expect(read?.refresh_token).toBe(REFRESH_TOKEN);
  });

  it("refuses to store anything when the platform has no OS-backed store", async () => {
    const userDir = await makeTempDir();
    // `keychain: null` is how the credential store models "no secret service
    // here". The gateway path offers `--store file` as an escape hatch; a portal
    // token gets none, because plaintext on disk is the thing ADR-0003 rejects.
    const store = portalTokenStore(createCredentialStore({ userDir, keychain: null }));
    await expect(store.write(tokenSet())).rejects.toMatchObject({ kind: "no_secure_store" });

    const files = await allFiles(userDir);
    for (const file of files) {
      expect(await readFile(file, "utf8")).not.toContain(ACCESS_TOKEN);
    }
  });

  it("never returns a token minted for another issuer or another client", async () => {
    const userDir = await makeTempDir();
    const store = portalTokenStore(createCredentialStore({ userDir, keychain: fakeKeychain() }));
    await store.write(tokenSet());

    expect(
      await store.read({ issuer: "https://clerk.other.test", clientId: "client_abc" }),
    ).toBeNull();
    expect(await store.read({ issuer: ISSUER, clientId: "client_other" })).toBeNull();
    expect(await store.read({ issuer: ISSUER, clientId: "client_abc" })).not.toBeNull();
  });

  it("treats a corrupt blob as 'not linked' rather than crashing", async () => {
    const userDir = await makeTempDir();
    const keychain = fakeKeychain();
    const credentials = createCredentialStore({ userDir, keychain });
    await credentials.store(PORTAL_ACCOUNT, "{ this is not json", "keychain");
    const store = portalTokenStore(credentials);
    expect(await store.read({ issuer: ISSUER, clientId: "client_abc" })).toBeNull();
  });

  it("clears the stored token", async () => {
    const userDir = await makeTempDir();
    const keychain = fakeKeychain();
    const store = portalTokenStore(createCredentialStore({ userDir, keychain }));
    await store.write(tokenSet());
    await store.clear();
    expect(keychain.entries.has(PORTAL_ACCOUNT)).toBe(false);
    expect(await store.read({ issuer: ISSUER, clientId: "client_abc" })).toBeNull();
  });
});

describe("describeTokenSet", () => {
  it("carries no secret material at all", () => {
    const summary = describeTokenSet(tokenSet(), 1_500_000);
    const rendered = JSON.stringify(summary);
    // This is what `golem team status`, `--json` and the link banner print.
    expect(rendered).not.toContain(ACCESS_TOKEN);
    expect(rendered).not.toContain(REFRESH_TOKEN);
    expect(summary.scopes).toContain("offline_access");
    expect(summary.hasRefreshToken).toBe(true);
    expect(summary.expired).toBe(false);
  });

  it("counts a token inside the skew window as already expired", () => {
    // Better to renew a few seconds early than to spend the one refresh on a
    // request that was always going to 401.
    expect(isExpired(tokenSet({ expires_at: 2_000_000 }), 1_999_990)).toBe(true);
    expect(isExpired(tokenSet({ expires_at: 2_000_000 }), 1_900_000)).toBe(false);
  });

  it("never claims expiry the server did not state", () => {
    const { expires_at: _dropped, ...noExpiry } = tokenSet();
    expect(isExpired(noExpiry, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(describeTokenSet(noExpiry).expiresAt).toBeNull();
  });
});

describe("the gate: no token reaches any file", () => {
  it("leaves the plaintext token in no file under the user or project directory", async () => {
    const userDir = await makeTempDir();
    const projectDir = await makeTempDir();

    // A complete token exchange against a fake authorization server.
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid profile email offline_access",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const keychain = fakeKeychain();
    const credentials: CredentialStore = createCredentialStore({ userDir, keychain });
    const store = portalTokenStore(credentials);

    const tokens = await exchangeCode({
      metadata: META,
      clientId: "client_abc",
      code: "auth-code-1",
      redirectUri: "http://127.0.0.1:51234/callback",
      verifier: createPkcePair().verifier,
      fetchImpl,
    });
    await store.write(tokens);

    // It really was stored — otherwise this test passes for the wrong reason.
    expect((await store.read({ issuer: ISSUER, clientId: "client_abc" }))?.access_token).toBe(
      ACCESS_TOKEN,
    );

    const files = [...(await allFiles(userDir)), ...(await allFiles(projectDir))];
    for (const file of files) {
      const contents = await readFile(file, "utf8").catch(() => "");
      expect(contents, `${file} contains the access token`).not.toContain(ACCESS_TOKEN);
      expect(contents, `${file} contains the refresh token`).not.toContain(REFRESH_TOKEN);
    }

    // And specifically: no settings file was created or touched by any of this.
    for (const settings of [
      path.join(userDir, "settings.json"),
      path.join(projectDir, ".golem", "settings.json"),
    ]) {
      await expect(stat(settings)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
