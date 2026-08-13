/**
 * R9.20 — batched credential resolution.
 *
 * `credentialEnvForProxy` needs N credentials, and on Windows each one was a
 * PowerShell PROCESS START: measured at 6668ms on a two-gateway project, which was
 * **98% of everything the proxy daemon did before `listen()`**. R9.18 had already
 * tried concurrency and got nothing — Windows PowerShell startups contend rather
 * than overlap — so the fix is to stop making N calls at all.
 *
 * The contract these pin: `resolveMany` is `resolve` N times, in one round trip.
 * Same precedence, same "absent is silent", same "a broken keychain never hides an
 * opted-in plaintext file".
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CredentialBackend,
  fileBackend,
  keychainBackend,
} from "../../../src/credentials/backends.js";
import { createCredentialStore } from "../../../src/credentials/store.js";
import { rmTemp } from "../../helpers/tmp.js";

let userDir: string;

beforeAll(async () => {
  userDir = await mkdtemp(join(tmpdir(), "golem-cred-batch-"));
});

afterAll(async () => {
  await rm(userDir, rmTemp);
});

/** A keychain that batches, recording how many round trips it was asked for. */
function batchingKeychain(values: Readonly<Record<string, string | Error>>): {
  backend: CredentialBackend;
  calls: { get: string[]; getMany: string[][] };
} {
  const calls: { get: string[]; getMany: string[][] } = { get: [], getMany: [] };
  const backend: CredentialBackend = {
    id: "keychain",
    available: async () => true,
    get: async (account) => {
      calls.get.push(account);
      const v = values[account];
      if (v instanceof Error) throw v;
      return v ?? null;
    },
    set: async () => {},
    remove: async () => {},
    describe: () => ({ backend: "keychain", label: "batching stub", protection: "dpapi-user" }),
    getMany: async (accounts) => {
      calls.getMany.push([...accounts]);
      const out = new Map<string, { secret?: string; fault?: Error }>();
      for (const account of accounts) {
        const v = values[account];
        out.set(account, v instanceof Error ? { fault: v } : v ? { secret: v } : {});
      }
      return out;
    },
  };
  return { backend, calls };
}

describe("resolveMany (R9.20)", () => {
  it("resolves every account in ONE backend round trip", async () => {
    const { backend, calls } = batchingKeychain({
      default: "sk-active",
      kimi: "sk-kimi",
      openrouter: "sk-or",
    });
    const store = createCredentialStore({ userDir, platform: "win32", keychain: backend });

    const got = await store.resolveMany(["default", "kimi", "openrouter"]);

    expect(got.get("default")?.secret).toBe("sk-active");
    expect(got.get("kimi")?.secret).toBe("sk-kimi");
    expect(got.get("openrouter")?.secret).toBe("sk-or");
    // The whole point: one call, not three. This is the assertion that fails if
    // anybody reintroduces a per-account loop.
    expect(calls.getMany).toEqual([["default", "kimi", "openrouter"]]);
    expect(calls.get).toEqual([]);
  });

  it("deduplicates accounts, so the active gateway is not decrypted twice", async () => {
    // `credentialEnvForProxy` passes the active store id AND every
    // target-referenced gateway, which routinely overlap.
    const { backend, calls } = batchingKeychain({ kimi: "sk-kimi" });
    const store = createCredentialStore({ userDir, platform: "win32", keychain: backend });
    await store.resolveMany(["kimi", "kimi", "kimi"]);
    expect(calls.getMany).toEqual([["kimi"]]);
  });

  it("reports an absent credential as null rather than a failure", async () => {
    const { backend } = batchingKeychain({ kimi: "sk-kimi" });
    const store = createCredentialStore({ userDir, platform: "win32", keychain: backend });
    const got = await store.resolveMany(["kimi", "never-logged-in"]);
    expect(got.get("kimi")?.secret).toBe("sk-kimi");
    expect(got.get("never-logged-in")).toBeNull();
  });

  it("one unreadable blob does not deny the others (the proxy still starts)", async () => {
    // The explicit R9.20 requirement: an unresolvable account is skipped silently
    // so the proxy still starts for the targets that ARE keyed.
    const { backend } = batchingKeychain({
      default: "sk-active",
      roamed: new Error("DPAPI decrypt failed — bound to another machine"),
      kimi: "sk-kimi",
    });
    const store = createCredentialStore({ userDir, platform: "win32", keychain: backend });
    const got = await store.resolveMany(["default", "roamed", "kimi"]);
    expect(got.get("default")?.secret).toBe("sk-active");
    expect(got.get("kimi")?.secret).toBe("sk-kimi");
    expect(got.get("roamed")).toBeNull(); // a fault reads as "no credential", not a throw
  });

  it("a batch fault still falls through to an opted-in plaintext file", async () => {
    // `consult`'s rule, preserved in the batched path: a broken keychain must not
    // hide a file the user deliberately opted into.
    const fileB = fileBackend(userDir, "win32");
    await fileB.set("batch-fallthrough", "sk-from-file");
    const { backend } = batchingKeychain({
      "batch-fallthrough": new Error("keychain exploded"),
    });
    const store = createCredentialStore({ userDir, platform: "win32", keychain: backend });
    const got = await store.resolveMany(["batch-fallthrough"]);
    expect(got.get("batch-fallthrough")?.secret).toBe("sk-from-file");
  });

  it("a wholesale getMany throw is a fault per account, never an abort", async () => {
    const backend: CredentialBackend = {
      id: "keychain",
      available: async () => true,
      get: async () => null,
      set: async () => {},
      remove: async () => {},
      describe: () => ({ backend: "keychain", label: "throwing stub", protection: "dpapi-user" }),
      getMany: async () => {
        throw new Error("no PowerShell host");
      },
    };
    const store = createCredentialStore({ userDir, platform: "win32", keychain: backend });
    const got = await store.resolveMany(["a", "b"]);
    expect(got.get("a")).toBeNull();
    expect(got.get("b")).toBeNull();
  });

  it("falls back to per-account get for a backend with no batch support", async () => {
    // macOS `security` and Linux `secret-tool` are cheap, so they never implement
    // getMany. They must still work through resolveMany unchanged.
    const { backend, calls } = batchingKeychain({ a: "sk-a", b: "sk-b" });
    const noBatch: CredentialBackend = { ...backend };
    delete (noBatch as { getMany?: unknown }).getMany;
    const store = createCredentialStore({ userDir, platform: "darwin", keychain: noBatch });
    const got = await store.resolveMany(["a", "b"]);
    expect(got.get("a")?.secret).toBe("sk-a");
    expect(got.get("b")?.secret).toBe("sk-b");
    expect(calls.get).toEqual(["a", "b"]);
  });

  it("agrees with resolve(), account for account", async () => {
    // The strongest statement of the contract: a caller must not be able to tell
    // the two apart except by timing.
    const { backend } = batchingKeychain({ one: "sk-1", three: "sk-3" });
    const store = createCredentialStore({ userDir, platform: "win32", keychain: backend });
    const accounts = ["one", "two", "three"];
    const batched = await store.resolveMany(accounts);
    for (const account of accounts) {
      const single = await store.resolve(account);
      expect(batched.get(account)?.secret ?? null).toBe(single?.secret ?? null);
    }
  });
});

/**
 * The real Windows DPAPI batch, against real PowerShell.
 *
 * The stubs above pin the chain's semantics; this pins the PROTOCOL, which is
 * where a batched decrypt can actually go wrong: results are positional, so a
 * desynchronised line would hand one gateway another gateway's key. Nothing but a
 * real round trip proves the line discipline holds.
 */
describe.runIf(process.platform === "win32")("windows DPAPI batch decrypt (R9.20)", () => {
  it("round-trips several credentials in one invocation, in order", async () => {
    const backend = keychainBackend("win32", userDir);
    if (backend === null) throw new Error("expected a win32 keychain backend");
    if (!(await backend.available())) {
      // No working PowerShell host here — the backend says so honestly, and there
      // is nothing to assert about a mechanism that cannot run.
      return;
    }
    // Values chosen to catch a positional mix-up: distinct, and one carrying the
    // punctuation a real key has (which is also why results come back base64).
    const secrets: Readonly<Record<string, string>> = {
      "batch-a": "sk-ant-aaa111",
      "batch-b": "sk-or-v1-bbb+222/zzz=",
      "batch-c": "ghp_ccc333",
    };
    for (const [account, secret] of Object.entries(secrets)) {
      await backend.set(account, secret);
    }

    const got = await backend.getMany?.(["batch-a", "batch-b", "batch-c", "batch-absent"]);
    if (got === undefined) throw new Error("expected the win32 backend to support getMany");

    for (const [account, secret] of Object.entries(secrets)) {
      expect(got.get(account)?.secret, `${account} decrypted to the wrong value`).toBe(secret);
    }
    // An account with no blob is absent, not a fault — it never reaches PowerShell.
    expect(got.get("batch-absent")).toEqual({});

    // And the batch agrees with the single-blob path it replaces.
    expect(await backend.get("batch-b")).toBe(secrets["batch-b"]);

    for (const account of Object.keys(secrets)) await backend.remove(account);
  }, 120_000);

  it("has nothing to decrypt when no blob exists, and spawns nothing", async () => {
    const backend = keychainBackend("win32", userDir);
    if (backend === null) throw new Error("expected a win32 keychain backend");
    const got = await backend.getMany?.(["absent-1", "absent-2"]);
    expect(got?.get("absent-1")).toEqual({});
    expect(got?.get("absent-2")).toEqual({});
  });
});
