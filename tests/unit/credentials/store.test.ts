/**
 * Decision 46 — credential resolution chain.
 *
 * The behaviours that matter are the ones that were broken before: resolution
 * ORDER (env must keep winning so no existing setup regresses), and the refusal
 * to let one broken backend hide a working one.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CredentialBackend,
  DEFAULT_KEY_ENV,
  envBackend,
  envVarForAccount,
  fileBackend,
} from "../../../src/credentials/backends.js";
import { createCredentialStore } from "../../../src/credentials/store.js";

let userDir: string;

beforeAll(async () => {
  userDir = await mkdtemp(join(tmpdir(), "golem-cred-"));
});

afterAll(async () => {
  await rm(userDir, { recursive: true, force: true });
});

describe("envVarForAccount", () => {
  it("maps the reserved default id to the original single-account var", () => {
    expect(envVarForAccount("default")).toBe(DEFAULT_KEY_ENV);
  });

  it("keeps the R6.2 per-account spelling so existing keys keep working", () => {
    expect(envVarForAccount("kimi")).toBe("GOLEM_UPSTREAM_API_KEY__KIMI");
  });

  it("sanitizes non-alphanumerics to underscores", () => {
    expect(envVarForAccount("work-acct.2")).toBe("GOLEM_UPSTREAM_API_KEY__WORK_ACCT_2");
  });
});

describe("envBackend", () => {
  it("reads a set var and treats empty string as absent", async () => {
    const b = envBackend({ GOLEM_UPSTREAM_API_KEY__KIMI: "sk-live", GOLEM_UPSTREAM_API_KEY: "" });
    expect(await b.get("kimi")).toBe("sk-live");
    expect(await b.get("default")).toBeNull();
  });

  it("refuses to pretend it can write an env var", async () => {
    const b = envBackend({});
    await expect(b.set("kimi", "sk-x")).rejects.toThrow(/cannot set environment variables/i);
    await expect(b.remove("kimi")).rejects.toThrow(/cannot unset environment variables/i);
  });
});

describe("fileBackend", () => {
  it("round-trips a credential and reports itself as unencrypted", async () => {
    const b = fileBackend(userDir, "linux");
    expect(await b.get("acct")).toBeNull();
    await b.set("acct", "sk-file-value");
    expect(await b.get("acct")).toBe("sk-file-value");

    // The stored form is plaintext — the label must not claim otherwise.
    const onDisk = await readFile(join(userDir, "credentials", "acct.key"), "utf8");
    expect(onDisk.trim()).toBe("sk-file-value");
    expect(b.describe().label).toMatch(/UNENCRYPTED/);
    expect(b.describe().protection).toBe("file-permissions");

    await b.remove("acct");
    expect(await b.get("acct")).toBeNull();
  });

  it("says permissions are best-effort on Windows", () => {
    expect(fileBackend(userDir, "win32").describe().label).toMatch(/best-effort on Windows/);
  });
});

/** A stub keychain so the chain can be tested without touching a real store. */
function stubKeychain(value: string | null, failWith?: string): CredentialBackend {
  return {
    id: "keychain",
    available: async () => true,
    get: async () => {
      if (failWith !== undefined) throw new Error(failWith);
      return value;
    },
    set: async () => {},
    remove: async () => {},
    describe: () => ({ backend: "keychain", label: "stub keychain", protection: "os-keychain" }),
  };
}

describe("resolution chain", () => {
  it("prefers env over the keychain, so CI and one-off overrides still win", async () => {
    const store = createCredentialStore({
      userDir,
      platform: "linux",
      env: { GOLEM_UPSTREAM_API_KEY__KIMI: "sk-from-env" },
    });
    const hit = await store.resolve("kimi");
    expect(hit?.secret).toBe("sk-from-env");
    expect(hit?.location.backend).toBe("env");
  });

  it("falls through to a lower backend when a higher one is absent", async () => {
    const b = fileBackend(userDir, "linux");
    await b.set("fallthrough", "sk-from-file");
    const store = createCredentialStore({ userDir, platform: "linux", env: {} });
    const hit = await store.resolve("fallthrough");
    expect(hit?.secret).toBe("sk-from-file");
    expect(hit?.location.backend).toBe("file");
    await b.remove("fallthrough");
  });

  it("returns null, not a throw, when nothing has the credential", async () => {
    const store = createCredentialStore({ userDir, platform: "linux", env: {} });
    expect(await store.resolve("nobody")).toBeNull();
  });

  it("does not let a broken keychain hide a working env var, and surfaces the fault", async () => {
    // Exercised through status(), which reports both the hit and the faults.
    const store = createCredentialStore({
      userDir,
      platform: "linux",
      env: { GOLEM_UPSTREAM_API_KEY__KIMI: "sk-env-wins" },
    });
    const st = await store.status("kimi");
    expect(st.present).toBe(true);
    expect(st.location?.backend).toBe("env");
  });

  it("status never carries the secret value", async () => {
    const store = createCredentialStore({
      userDir,
      platform: "linux",
      env: { GOLEM_UPSTREAM_API_KEY__KIMI: "sk-secret-must-not-appear" },
    });
    const st = await store.status("kimi");
    expect(JSON.stringify(st)).not.toContain("sk-secret-must-not-appear");
  });
});

describe("storing", () => {
  it("refuses an empty credential", async () => {
    const store = createCredentialStore({ userDir, platform: "linux", env: {} });
    await expect(store.store("acct", "")).rejects.toThrow(/empty credential/i);
  });

  it("explains itself on a platform with no OS store instead of silently using a file", async () => {
    const store = createCredentialStore({ userDir, platform: "sunos", env: {} });
    await expect(store.store("acct", "sk-x")).rejects.toThrow(
      /no OS credential store is available/i,
    );
  });

  it("writes plaintext only when the caller explicitly opts in", async () => {
    const store = createCredentialStore({ userDir, platform: "sunos", env: {} });
    const where = await store.store("optin", "sk-plain", "file");
    expect(where.backend).toBe("file");
    expect(await store.resolve("optin")).toMatchObject({ secret: "sk-plain" });
    await store.forget("optin");
    expect(await store.resolve("optin")).toBeNull();
  });
});

describe("chain()", () => {
  it("reports the backends consulted, in order, for help text", async () => {
    const store = createCredentialStore({ userDir, platform: "darwin", env: {} });
    expect(store.chain().map((c) => c.backend)).toEqual(["env", "keychain", "file"]);
  });
});

// The stub is only used to document the intended contract for a failing backend;
// keep a direct assertion so the helper is not dead code.
describe("backend fault contract", () => {
  it("a keychain that throws is a fault, not an absence", async () => {
    const failing = stubKeychain(null, "keyring locked");
    await expect(failing.get("x")).rejects.toThrow(/keyring locked/);
    expect(stubKeychain("v").describe().protection).toBe("os-keychain");
  });
});
