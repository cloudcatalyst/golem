/**
 * Decision 46 — DPAPI backend, live round-trip (Windows only).
 *
 * The rest of the chain is unit-tested with stubs; this one runs the real
 * PowerShell round-trip because DPAPI behaviour is exactly the thing that cannot
 * be mocked faithfully. Skipped everywhere but Windows.
 *
 * It also encodes the honest-degradation contract: DPAPI depends on a working
 * PowerShell host, which is machine-dependent (verification-notes §82). So the
 * live round-trip runs when a host exists, and when none does the test asserts
 * the *remediable* error rather than pretending the machine is broken.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keychainBackend } from "../../src/credentials/backends.js";

const itOnWindows = process.platform === "win32" ? it : it.skip;

describe("DPAPI keychain backend (win32)", () => {
  let userDir: string;

  beforeAll(async () => {
    userDir = await mkdtemp(join(tmpdir(), "golem-dpapi-"));
  });

  afterAll(async () => {
    await rm(userDir, { recursive: true, force: true });
  });

  itOnWindows("reports itself as a DPAPI file, never as Windows Credential Manager", () => {
    const b = keychainBackend("win32", userDir);
    expect(b).not.toBeNull();
    expect(b?.describe().protection).toBe("dpapi-user");
    expect(b?.describe().label).toMatch(/DPAPI/i);
    expect(b?.describe().label).not.toMatch(/Credential Manager/i);
  });

  itOnWindows(
    "round-trips a credential when a DPAPI host is available",
    async () => {
      const b = keychainBackend("win32", userDir);
      expect(b).not.toBeNull();
      if (b === null) return;

      if (!(await b.available())) {
        // No working PowerShell host on this machine: that is a supported state,
        // and set() must fail with a remediable message, not a raw PS diagnostic.
        await expect(b.set("livetest", "sk-x")).rejects.toThrow(/PowerShell/i);
        return;
      }

      expect(await b.get("livetest")).toBeNull();
      await b.set("livetest", "sk-live-roundtrip-value");
      expect(await b.get("livetest")).toBe("sk-live-roundtrip-value");

      // The blob on disk is ciphertext, not the secret.
      const blob = await readFile(join(userDir, "credentials", "livetest.dpapi"), "utf8");
      expect(blob).not.toContain("sk-live-roundtrip-value");
      expect(blob.trim().length).toBeGreaterThan(0);

      await b.remove("livetest");
      expect(await b.get("livetest")).toBeNull();
    },
    30_000,
  );

  itOnWindows(
    "a corrupt blob is a thrown fault, not a silent absence",
    async () => {
      const b = keychainBackend("win32", userDir);
      expect(b).not.toBeNull();
      if (b === null || !(await b.available())) return; // needs a host to write the blob

      await b.set("corrupt", "sk-then-corrupted");
      await writeFile(join(userDir, "credentials", "corrupt.dpapi"), "not-a-valid-dpapi-blob\n");

      // ConvertFrom-SecureString must fail loudly, and the error must explain the
      // user/machine binding without ever claiming the key is simply "not set".
      await expect(b.get("corrupt")).rejects.toThrow(/bound to the user and machine/i);
      await b.remove("corrupt");
    },
    30_000,
  );
});
