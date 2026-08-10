/**
 * R9.1 — `golem target` CLI: reporting the registry without leaking a secret,
 * fail-closed registration and lookup, and the generalized N-credential
 * spawn-time preflight.
 *
 * Credentials come from an INJECTED plaintext-file store under a temp dir (same
 * discipline as the account tests) — never the machine's real keychain.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialEnvForProxy } from "../../../src/cli/accounts.js";
import {
  addTarget,
  collectTargets,
  renderTargets,
  showTarget,
  testTarget,
} from "../../../src/cli/targets.js";
import { loadConfig, writeSetting } from "../../../src/config/index.js";
import { createCredentialStore } from "../../../src/credentials/index.js";
import { rmTemp } from "../../helpers/tmp.js";

let dir: string;
let credDir: string;
let store: ReturnType<typeof createCredentialStore>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-target-"));
  credDir = await mkdtemp(path.join(tmpdir(), "golem-target-cred-"));
  store = createCredentialStore({ userDir: credDir, platform: "sunos" });
  // Two accounts sharing nothing, one of which will back two targets — the
  // many-targets-one-account case the split exists for.
  await writeSetting(
    "project",
    "proxy.accounts",
    [
      {
        id: "openrouter",
        provider: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
        model: "openai/gpt-oss-20b:free",
      },
      {
        id: "work",
        provider: "openai",
        base_url: "https://api.openai.com/v1",
        model: "gpt-5.2",
      },
    ],
    { projectDir: dir },
  );
});
afterEach(async () => {
  await rm(dir, rmTemp);
  await rm(credDir, rmTemp);
});

describe("collectTargets", () => {
  it("reports accounts as targets with no config edit, and never a secret value", async () => {
    await store.store("openrouter", "sk-or-secret", "file");
    const report = await collectTargets(dir, {}, { store_backend: store });

    expect(report.default_target).toBe("anthropic");
    expect(report.default_unknown).toBe(false);
    expect(report.targets.map((t) => t.id)).toEqual(["anthropic", "openrouter", "work"]);

    const openrouter = report.targets.find((t) => t.id === "openrouter");
    expect(openrouter).toMatchObject({
      provider: "openrouter",
      account: "openrouter",
      key_set: true,
      trust: "third-party",
      origin: "account",
    });
    expect(JSON.stringify(report)).not.toContain("sk-or-secret");
    expect(renderTargets(report)).not.toContain("sk-or-secret");
  });

  it("warns about a target whose account has no stored credential", async () => {
    const report = await collectTargets(dir, {}, { store_backend: store });
    const work = report.targets.find((t) => t.id === "work");
    expect(work?.key_set).toBe(false);
    expect(work?.warnings.join(" ")).toContain("golem account login work");
  });

  it("does NOT warn about the synthetic default, which inherits the client's auth", async () => {
    const report = await collectTargets(dir, {}, { store_backend: store });
    const dflt = report.targets.find((t) => t.id === "anthropic");
    expect(dflt?.account).toBeNull();
    expect(dflt?.warnings).toEqual([]);
  });

  it("flags a default_target that names an id in neither registry", async () => {
    await writeSetting("project", "proxy.default_target", "ghost", { projectDir: dir });
    const report = await collectTargets(dir, {}, { store_backend: store });
    expect(report.default_unknown).toBe(true);
    expect(renderTargets(report)).toContain("WARNING");
  });

  it("reads a settings file that still names the retired active_account (R9.6 migration)", async () => {
    // Written as raw JSON on purpose: writeSetting resolves retired keys, so it
    // can no longer produce this file. What is being tested is an EXISTING file
    // from before the rename, which is exactly what the migration exists for.
    await writeSetting("project", "proxy.default_target", "work", { projectDir: dir });
    const settingsPath = path.join(dir, ".golem", "settings.json");
    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as {
      proxy: Record<string, unknown>;
    };
    delete raw.proxy.default_target;
    raw.proxy.active_account = "work";
    await writeFile(
      settingsPath,
      `${JSON.stringify(raw, null, 2)}
`,
      "utf8",
    );
    const report = await collectTargets(dir, {}, { store_backend: store });
    expect(report.default_target).toBe("work");
    expect(report.default_unknown).toBe(false);
    expect(report.targets.find((t) => t.id === "work")?.is_default).toBe(true);
  });
});

describe("showTarget", () => {
  it("fails closed on an unknown id and names the ids that do exist", async () => {
    await expect(showTarget(dir, "nope", {}, { store_backend: store })).rejects.toThrow(
      /unknown target "nope".*openrouter/s,
    );
  });
});

describe("addTarget", () => {
  it("writes NON-SECRET identity only, and never a key field", async () => {
    await addTarget(
      dir,
      {
        id: "cheap",
        provider: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
        model: "poolside/laguna-s-2.1:free",
        account: "openrouter",
        trust: "third-party",
      },
      "2026-08-09T00:00:00.000Z",
    );
    const { settings } = await loadConfig({ projectDir: dir });
    const entry = settings.proxy.targets?.find((t) => t.id === "cheap");
    expect(entry).toMatchObject({ provider: "openrouter", account: "openrouter" });
    // The whole design rests on this: a target is not a place a secret can live.
    const serialized = JSON.stringify(entry ?? {}).toLowerCase();
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("secret");
  });

  it("refuses a target pointing at an account that does not exist", async () => {
    await expect(
      addTarget(
        dir,
        {
          id: "orphan",
          provider: "openrouter",
          base_url: "https://openrouter.ai/api/v1",
          model: "x/y",
          account: "missing",
        },
        "2026-08-09T00:00:00.000Z",
      ),
    ).rejects.toThrow(/references account "missing".*not in\s+proxy\.accounts/s);
  });

  it("refuses a duplicate explicit id", async () => {
    const now = "2026-08-09T00:00:00.000Z";
    const entry = {
      id: "cheap",
      provider: "openrouter" as const,
      base_url: "https://openrouter.ai/api/v1",
      model: "x/y",
    };
    await addTarget(dir, entry, now);
    await expect(addTarget(dir, entry, now)).rejects.toThrow(/already exists/);
  });

  it("allows overriding an account-derived target of the same id, and says so", async () => {
    const result = await addTarget(
      dir,
      {
        id: "work",
        provider: "openai",
        base_url: "https://api.openai.com/v1",
        model: "gpt-5.2-mini",
        trust: "third-party",
      },
      "2026-08-09T00:00:00.000Z",
    );
    expect(result.overrides_account).toBe(true);
    const report = await collectTargets(dir, {}, { store_backend: store });
    // Overriding must not duplicate the row, and the account still backs it.
    expect(report.targets.filter((t) => t.id === "work")).toHaveLength(1);
    expect(report.targets.find((t) => t.id === "work")).toMatchObject({
      model: "gpt-5.2-mini",
      account: "work",
      origin: "target",
    });
  });

  it("appends a non-secret line to the shared audit log", async () => {
    await addTarget(
      dir,
      {
        id: "cheap",
        provider: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
        model: "x/y",
      },
      "2026-08-09T00:00:00.000Z",
    );
    const log = await readFile(path.join(dir, ".golem", "state", "account-log.jsonl"), "utf8");
    expect(log).toContain('"action":"target-add"');
    expect(log).toContain('"target":"cheap"');
  });
});

describe("testTarget", () => {
  it("fails closed on an unknown id rather than probing something else", async () => {
    await expect(testTarget(dir, "ghost", {}, { store_backend: store })).rejects.toThrow(
      /unknown target "ghost"/,
    );
  });

  it("reports no-credential instead of probing an unauthenticated request", async () => {
    // A 401 from an unauthenticated probe says nothing about the STORED key.
    const result = await testTarget(dir, "work", {}, { store_backend: store });
    expect(result.verdict).toBe("no-credential");
    expect(result.detail).toContain("golem account login work");
  });
});

describe("credentialEnvForProxy — N credentials, not 1 (R9.1)", () => {
  it("injects a key for every account a target references", async () => {
    await store.store("openrouter", "sk-or", "file");
    await store.store("work", "sk-work", "file");
    const env = await credentialEnvForProxy(dir, {}, { store_backend: store });
    expect(env.GOLEM_UPSTREAM_API_KEY__OPENROUTER).toBe("sk-or");
    expect(env.GOLEM_UPSTREAM_API_KEY__WORK).toBe("sk-work");
  });

  it("skips an unkeyed target rather than refusing to start the proxy", async () => {
    await store.store("openrouter", "sk-or", "file");
    const env = await credentialEnvForProxy(dir, {}, { store_backend: store });
    expect(env.GOLEM_UPSTREAM_API_KEY__OPENROUTER).toBe("sk-or");
    expect(env.GOLEM_UPSTREAM_API_KEY__WORK).toBeUndefined();
  });

  it("still resolves the active account exactly as before this task", async () => {
    await writeSetting("project", "proxy.active_account", "work", { projectDir: dir });
    await store.store("work", "sk-work", "file");
    const env = await credentialEnvForProxy(dir, {}, { store_backend: store });
    expect(env.GOLEM_UPSTREAM_API_KEY__WORK).toBe("sk-work");
  });
});
