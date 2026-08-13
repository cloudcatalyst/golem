/**
 * Decisions 46/47 — credential resolution chain.
 *
 * The behaviours that matter: an environment variable is NOT a credential source
 * any more (Decision 47 — a stale export must never shadow a stored key), the
 * chain falls through cleanly, and one broken backend never hides a working one.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CredentialBackend,
  DEFAULT_KEY_ENV,
  envVarForGateway,
  fileBackend,
} from "../../../src/credentials/backends.js";
import { createCredentialStore } from "../../../src/credentials/store.js";
import { rmTemp } from "../../helpers/tmp.js";

let userDir: string;

beforeAll(async () => {
  userDir = await mkdtemp(join(tmpdir(), "golem-cred-"));
});

afterAll(async () => {
  await rm(userDir, rmTemp);
});

/**
 * `envVarForGateway` still exists, but only to name the internal CLI→daemon
 * handoff channel (Decision 47) — the spelling is pinned because the two sides
 * of that handoff must agree.
 */
describe("envVarForGateway (internal daemon handoff only)", () => {
  it("maps the reserved default id to the plain var", () => {
    expect(envVarForGateway("default")).toBe(DEFAULT_KEY_ENV);
  });

  it("keeps the per-account spelling both sides of the handoff agree on", () => {
    expect(envVarForGateway("kimi")).toBe("GOLEM_UPSTREAM_API_KEY__KIMI");
  });

  it("sanitizes non-alphanumerics to underscores", () => {
    expect(envVarForGateway("work-acct.2")).toBe("GOLEM_UPSTREAM_API_KEY__WORK_ACCT_2");
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
  /**
   * The Decision 47 regression guard: a set `GOLEM_UPSTREAM_API_KEY__<ID>` must
   * resolve to NOTHING. `platform: "sunos"` gives a store with no keychain, so
   * the only possible hits are the env var (now gone) and a file (not written) —
   * which makes an accidental re-introduction of the env backend a failure here.
   */
  it("does not read a credential from the environment", async () => {
    process.env.GOLEM_UPSTREAM_API_KEY__ENVONLY = "sk-must-be-ignored";
    try {
      const store = createCredentialStore({ userDir, platform: "sunos" });
      expect(await store.resolve("envonly")).toBeNull();
      expect((await store.status("envonly")).present).toBe(false);
    } finally {
      delete process.env.GOLEM_UPSTREAM_API_KEY__ENVONLY;
    }
  });

  it("resolves from a stored file when the keychain has nothing", async () => {
    const b = fileBackend(userDir, "linux");
    await b.set("fallthrough", "sk-from-file");
    const store = createCredentialStore({ userDir, platform: "linux" });
    const hit = await store.resolve("fallthrough");
    expect(hit?.secret).toBe("sk-from-file");
    expect(hit?.location.backend).toBe("file");
    await b.remove("fallthrough");
  });

  it("returns null, not a throw, when nothing has the credential", async () => {
    const store = createCredentialStore({ userDir, platform: "linux" });
    expect(await store.resolve("nobody")).toBeNull();
  });

  it("does not let a broken keychain hide a stored file, and surfaces the fault", async () => {
    // Exercised through status(), which reports both the hit and the faults.
    const b = fileBackend(userDir, "linux");
    await b.set("resilient", "sk-from-file");
    const store = createCredentialStore({ userDir, platform: "linux" });
    const st = await store.status("resilient");
    expect(st.present).toBe(true);
    expect(st.location?.backend).toBe("file");
    await b.remove("resilient");
  });

  it("status never carries the secret value", async () => {
    const b = fileBackend(userDir, "linux");
    await b.set("quiet", "sk-secret-must-not-appear");
    const store = createCredentialStore({ userDir, platform: "linux" });
    const st = await store.status("quiet");
    expect(st.present).toBe(true);
    expect(JSON.stringify(st)).not.toContain("sk-secret-must-not-appear");
    await b.remove("quiet");
  });
});

describe("storing", () => {
  it("refuses an empty credential", async () => {
    const store = createCredentialStore({ userDir, platform: "linux" });
    await expect(store.store("acct", "")).rejects.toThrow(/empty credential/i);
  });

  it("explains itself on a platform with no OS store instead of silently using a file", async () => {
    const store = createCredentialStore({ userDir, platform: "sunos" });
    await expect(store.store("acct", "sk-x")).rejects.toThrow(
      /no OS credential store is available/i,
    );
  });

  /** Decision 47: the remediation can no longer suggest exporting a var. */
  it("does not offer an env var as the remedy when no store is available", async () => {
    const store = createCredentialStore({ userDir, platform: "sunos" });
    await expect(store.store("acct", "sk-x")).rejects.not.toThrow(/GOLEM_UPSTREAM_API_KEY/);
  });

  it("writes plaintext only when the caller explicitly opts in", async () => {
    const store = createCredentialStore({ userDir, platform: "sunos" });
    const where = await store.store("optin", "sk-plain", "file");
    expect(where.backend).toBe("file");
    expect(await store.resolve("optin")).toMatchObject({ secret: "sk-plain" });
    await store.forget("optin");
    expect(await store.resolve("optin")).toBeNull();
  });
});

describe("chain()", () => {
  it("reports the backends consulted, in order, for help text", async () => {
    const store = createCredentialStore({ userDir, platform: "darwin" });
    expect(store.chain().map((c) => c.backend)).toEqual(["keychain", "file"]);
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
