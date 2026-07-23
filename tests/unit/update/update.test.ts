import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkForUpdate,
  detectInstallMethod,
  readCachedUpdateCheck,
  semverGt,
  upgradeCommand,
} from "../../../src/update/index.js";

describe("semverGt", () => {
  it("compares by field, numerically", () => {
    expect(semverGt("1.0.1", "1.0.0")).toBe(true);
    expect(semverGt("1.2.0", "1.1.9")).toBe(true);
    expect(semverGt("2.0.0", "1.9.9")).toBe(true);
    expect(semverGt("0.10.0", "0.9.0")).toBe(true); // not lexicographic
  });
  it("is false for equal or lower", () => {
    expect(semverGt("1.0.0", "1.0.0")).toBe(false);
    expect(semverGt("1.0.0", "1.0.1")).toBe(false);
  });
  it("tolerates v-prefix and suffixes, false on garbage", () => {
    expect(semverGt("v1.2.3", "1.2.2")).toBe(true);
    expect(semverGt("1.2.3-beta.1", "1.2.2")).toBe(true);
    expect(semverGt("nope", "1.0.0")).toBe(false);
  });
});

describe("detectInstallMethod", () => {
  it("detects Bun standalone binaries", () => {
    expect(detectInstallMethod({ bun: true, argv1: "/whatever" })).toBe("binary");
  });
  it("detects npm global installs from a node_modules path", () => {
    expect(
      detectInstallMethod({
        bun: false,
        argv1: "/usr/lib/node_modules/golem-run/dist/cli/main.js",
      }),
    ).toBe("npm");
    expect(
      detectInstallMethod({
        bun: false,
        argv1: "C:\\npm\\node_modules\\golem-run\\dist\\cli\\main.js",
      }),
    ).toBe("npm");
  });
  it("falls back to unknown", () => {
    expect(detectInstallMethod({ bun: false, argv1: "/home/me/golem/dist/cli/main.js" })).toBe(
      "unknown",
    );
  });
});

describe("upgradeCommand", () => {
  it("uses npm for npm installs", () => {
    expect(upgradeCommand("npm", "linux")).toBe("npm install -g golem-run@latest");
  });
  it("uses the platform installer one-liner otherwise", () => {
    expect(upgradeCommand("binary", "win32")).toBe("irm https://golem.run | iex");
    expect(upgradeCommand("binary", "darwin")).toBe("curl -fsSL https://golem.run | sh");
    expect(upgradeCommand("unknown", "linux")).toBe("curl -fsSL https://golem.run | sh");
  });
});

describe("checkForUpdate", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-update-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports an available update and caches it", async () => {
    const result = await checkForUpdate({
      current: "0.1.0",
      method: "npm",
      platform: "linux",
      cacheDir: dir,
      fetchLatest: async () => "0.2.0",
    });
    expect(result).toMatchObject({
      current: "0.1.0",
      latest: "0.2.0",
      updateAvailable: true,
      method: "npm",
      command: "npm install -g golem-run@latest",
    });
    // Cache written and readable without a network call.
    const cached = await readCachedUpdateCheck(dir);
    expect(cached?.latest).toBe("0.2.0");
    expect(JSON.parse(await readFile(path.join(dir, "update-check.json"), "utf8")).latest).toBe(
      "0.2.0",
    );
  });

  it("writes nothing when no cacheDir is given (caller gate for non-Golem projects)", async () => {
    const result = await checkForUpdate({
      current: "0.1.0",
      method: "npm",
      fetchLatest: async () => "0.2.0",
    });
    expect(result.updateAvailable).toBe(true);
    // No cacheDir → no cache file created anywhere. `golem update` relies on this
    // to avoid bootstrapping `.golem/` in a project that isn't using Golem.
    const entries = await readdir(dir);
    expect(entries).toHaveLength(0);
  });

  it("reports up-to-date when latest == current", async () => {
    const result = await checkForUpdate({
      current: "1.0.0",
      method: "npm",
      cacheDir: dir,
      fetchLatest: async () => "1.0.0",
    });
    expect(result.updateAvailable).toBe(false);
  });

  it("tolerates a null (offline / not published) result without throwing", async () => {
    const result = await checkForUpdate({
      current: "0.1.0",
      method: "binary",
      platform: "win32",
      cacheDir: dir,
      fetchLatest: async () => null,
    });
    expect(result.latest).toBeNull();
    expect(result.updateAvailable).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.command).toBe("irm https://golem.run | iex");
  });

  it("serves a fresh cache without re-fetching, and recomputes against the live version", async () => {
    let calls = 0;
    const fetchLatest = async () => {
      calls += 1;
      return "0.2.0";
    };
    const now = () => new Date("2026-07-22T12:00:00Z");
    await checkForUpdate({ current: "0.1.0", method: "npm", cacheDir: dir, fetchLatest, now });
    expect(calls).toBe(1);

    // Second call, cache still fresh → no new fetch.
    const again = await checkForUpdate({
      current: "0.1.0",
      method: "npm",
      cacheDir: dir,
      fetchLatest,
      now,
    });
    expect(calls).toBe(1);
    expect(again.updateAvailable).toBe(true);

    // If the running version already caught up to cached latest, no update.
    const caughtUp = await checkForUpdate({
      current: "0.2.0",
      method: "npm",
      cacheDir: dir,
      fetchLatest,
      now,
    });
    expect(calls).toBe(1);
    expect(caughtUp.updateAvailable).toBe(false);
  });

  it("re-fetches when the cache is stale, and when forced", async () => {
    let calls = 0;
    const fetchLatest = async () => {
      calls += 1;
      return "0.2.0";
    };
    await checkForUpdate({
      current: "0.1.0",
      method: "npm",
      cacheDir: dir,
      fetchLatest,
      now: () => new Date("2026-07-20T00:00:00Z"),
    });
    expect(calls).toBe(1);

    // 3 days later → stale → re-fetch.
    await checkForUpdate({
      current: "0.1.0",
      method: "npm",
      cacheDir: dir,
      fetchLatest,
      now: () => new Date("2026-07-23T00:00:00Z"),
    });
    expect(calls).toBe(2);

    // force bypasses a fresh cache.
    await checkForUpdate({
      current: "0.1.0",
      method: "npm",
      cacheDir: dir,
      force: true,
      fetchLatest,
      now: () => new Date("2026-07-23T00:00:01Z"),
    });
    expect(calls).toBe(3);
  });

  it("readCachedUpdateCheck returns null when absent", async () => {
    expect(await readCachedUpdateCheck(dir)).toBeNull();
  });
});
