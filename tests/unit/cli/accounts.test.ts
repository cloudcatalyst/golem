/**
 * R6.2 v1 — `golem account` CLI: registry listing (never leaking secrets),
 * fail-closed switching, and the ADR-0003 audit log.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addAccount,
  collectAccounts,
  credentialEnvForProxy,
  defaultAccountId,
  removeAccount,
  renderAccounts,
  useAccount,
} from "../../../src/cli/accounts.js";
import { loadConfig, writeSetting } from "../../../src/config/index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-acct-"));
  await writeSetting(
    "project",
    "proxy.accounts",
    [
      { id: "work", provider: "openai", base_url: "https://api.openai.com/v1", model: "gpt-5.2" },
      {
        id: "local",
        provider: "ollama",
        base_url: "http://gpubox.lan:11434/v1",
        model: "qwen2.5-coder:7b",
      },
    ],
    { projectDir: dir },
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("collectAccounts", () => {
  it("lists accounts with key-set flags (never the key); the default is active by default", async () => {
    const report = await collectAccounts(dir, { GOLEM_UPSTREAM_API_KEY__WORK: "sk-x" });
    // No named account selected → the synthetic default (top-level anthropic) is active.
    expect(report.active).toBe("anthropic");
    expect(report.active_unknown).toBe(false);
    // Default row is first, plus the two named accounts.
    expect(report.accounts).toHaveLength(3);
    const dflt = report.accounts[0];
    expect(dflt).toMatchObject({
      id: "anthropic",
      provider: "anthropic",
      is_default: true,
      active: true,
      key_env: "GOLEM_UPSTREAM_API_KEY",
    });
    const work = report.accounts.find((a) => a.id === "work");
    expect(work).toMatchObject({
      provider: "openai",
      key_env: "GOLEM_UPSTREAM_API_KEY__WORK",
      key_set: true,
      active: false,
    });
    const local = report.accounts.find((a) => a.id === "local");
    expect(local?.key_set).toBe(false);
    // The report carries no secret values anywhere.
    expect(JSON.stringify(report)).not.toContain("sk-x");
  });

  it("exposes the default id as the top-level provider name", () => {
    expect(defaultAccountId("anthropic")).toBe("anthropic");
    expect(defaultAccountId("openrouter")).toBe("openrouter");
  });
});

describe("useAccount", () => {
  it("switches the active account, marks it, and appends an audit line", async () => {
    await useAccount(dir, "work", "2026-07-23T00:00:00.000Z", { assumeYes: true });
    const report = await collectAccounts(dir, {});
    expect(report.active).toBe("work");
    expect(report.accounts.find((a) => a.id === "work")?.active).toBe(true);

    const log = await readFile(path.join(dir, ".golem", "state", "account-log.jsonl"), "utf8");
    expect(JSON.parse(log.trim())).toEqual({
      ts: "2026-07-23T00:00:00.000Z",
      action: "use",
      account: "work",
    });
  });

  it("rejects an unknown account id (fail-closed, no silent creation)", async () => {
    await expect(useAccount(dir, "ghost", "2026-07-23T00:00:00.000Z")).rejects.toThrow(
      /unknown account/,
    );
    expect((await collectAccounts(dir, {})).active).toBe("anthropic");
  });

  it("refuses to switch onto an account whose credential does not resolve (fail-closed preflight)", async () => {
    await expect(useAccount(dir, "local", "2026-07-23T00:00:00.000Z", { env: {} })).rejects.toThrow(
      /no credential resolves for "local"/,
    );
    // No switch happened.
    expect((await collectAccounts(dir, {})).active).toBe("anthropic");
  });

  it("switches when the credential resolves from the env var", async () => {
    await useAccount(dir, "work", "2026-07-23T00:00:00.000Z", {
      env: { GOLEM_UPSTREAM_API_KEY__WORK: "sk-live" },
    });
    expect((await collectAccounts(dir, {})).active).toBe("work");
  });
});

describe("addAccount", () => {
  it("registers a new account (preserving existing entries) and audit-logs it", async () => {
    await addAccount(
      dir,
      {
        id: "gemini",
        provider: "gemini",
        base_url: "https://generativelanguage.googleapis.com",
        model: "gemini-2.5-pro",
      },
      "2026-07-26T00:00:00.000Z",
    );
    const { settings } = await loadConfig({ projectDir: dir });
    const ids = (settings.proxy.accounts ?? []).map((a) => a.id);
    expect(ids).toEqual(["work", "local", "gemini"]); // existing preserved, new appended
    const added = (settings.proxy.accounts ?? []).find((a) => a.id === "gemini");
    expect(added).toMatchObject({ provider: "gemini", model: "gemini-2.5-pro" });

    const log = await readFile(path.join(dir, ".golem", "state", "account-log.jsonl"), "utf8");
    expect(log).toContain('"action":"add"');
    expect(log).toContain('"account":"gemini"');
  });

  it("is fail-closed on a duplicate id (no silent overwrite)", async () => {
    await expect(
      addAccount(
        dir,
        { id: "work", provider: "openai", base_url: "https://x.example/v1" },
        "2026-07-26T00:00:00.000Z",
      ),
    ).rejects.toThrow(/already exists/);
    // The original entry is untouched (the beforeEach seeds work → api.openai.com/v1).
    const { settings } = await loadConfig({ projectDir: dir });
    expect((settings.proxy.accounts ?? []).find((a) => a.id === "work")?.base_url).toBe(
      "https://api.openai.com/v1",
    );
  });

  it("refuses to register the default account's id", async () => {
    await expect(
      addAccount(
        dir,
        { id: "anthropic", provider: "anthropic", base_url: "https://x.example" },
        "2026-07-26T00:00:00.000Z",
      ),
    ).rejects.toThrow(/default account/);
  });

  it("rejects an invalid entry via the schema (missing base_url shape)", async () => {
    await expect(
      addAccount(
        dir,
        { id: "bad", provider: "openai", base_url: "not-a-url" },
        "2026-07-26T00:00:00.000Z",
      ),
    ).rejects.toThrow();
  });

  it("writes to the LOCAL scope so a pre-existing local-layer accounts array cannot mask it", async () => {
    // Regression: a `proxy.accounts` array in a higher-precedence layer
    // wholesale-replaces lower layers, so writing to project settings.json left
    // the new account invisible to the very merge the proxy reads.
    await addAccount(
      dir,
      { id: "gemini", provider: "gemini", base_url: "https://generativelanguage.googleapis.com" },
      "2026-07-26T00:00:00.000Z",
    );
    const localRaw = JSON.parse(
      await readFile(path.join(dir, ".golem", "settings.local.json"), "utf8"),
    ) as {
      proxy?: { accounts?: { id: string }[] };
    };
    // The beforeEach seeded accounts into settings.local.json; the add must
    // merge into THAT layer (preserving work+local), not the project file.
    expect((localRaw.proxy?.accounts ?? []).map((a) => a.id)).toEqual(["work", "local", "gemini"]);
    // And the merged view the proxy reads sees it too.
    const { settings } = await loadConfig({ projectDir: dir });
    expect((settings.proxy.accounts ?? []).map((a) => a.id)).toContain("gemini");
  });
});

describe("removeAccount", () => {
  it("removes the account and leaves its stored credential alone", async () => {
    const { account, was_active } = await removeAccount(dir, "local", "2026-07-26T00:00:00.000Z");
    expect(account).toBe("local");
    expect(was_active).toBe(false);
    const { settings } = await loadConfig({ projectDir: dir });
    expect((settings.proxy.accounts ?? []).map((a) => a.id)).toEqual(["work"]);
  });

  it("reverts active_account to the default when the active account is removed", async () => {
    await useAccount(dir, "work", "2026-07-26T00:00:00.000Z", { assumeYes: true });
    const { was_active } = await removeAccount(dir, "work", "2026-07-26T00:01:00.000Z");
    expect(was_active).toBe(true);
    const { settings } = await loadConfig({ projectDir: dir });
    expect(settings.proxy.active_account).toBeUndefined();
    expect((await collectAccounts(dir, {})).active).toBe("anthropic");
  });

  it("is fail-closed on an unknown id", async () => {
    await expect(removeAccount(dir, "ghost", "2026-07-26T00:00:00.000Z")).rejects.toThrow(
      /unknown account/,
    );
  });
});

describe("credentialEnvForProxy (Decision 46 — the daemon injection)", () => {
  it("maps the active named account's env credential to its per-account var", async () => {
    await useAccount(dir, "work", "2026-07-23T00:00:00.000Z", {
      env: { GOLEM_UPSTREAM_API_KEY__WORK: "sk-live-work" },
    });
    const env = await credentialEnvForProxy(dir, { GOLEM_UPSTREAM_API_KEY__WORK: "sk-live-work" });
    expect(env).toEqual({ GOLEM_UPSTREAM_API_KEY__WORK: "sk-live-work" });
  });

  it("maps the default account's credential to the plain GOLEM_UPSTREAM_API_KEY", async () => {
    // No active account → the top-level config → the legacy var.
    const env = await credentialEnvForProxy(dir, { GOLEM_UPSTREAM_API_KEY: "sk-default" });
    expect(env).toEqual({ GOLEM_UPSTREAM_API_KEY: "sk-default" });
  });

  it("returns {} when no credential resolves, so the proxy forwards client auth", async () => {
    const env = await credentialEnvForProxy(dir, {});
    expect(env).toEqual({});
  });

  it("clears the active account with id=null (reverts to the default)", async () => {
    await useAccount(dir, "work", "2026-07-23T00:00:00.000Z", { assumeYes: true });
    await useAccount(dir, null, "2026-07-23T00:01:00.000Z");
    const report = await collectAccounts(dir, {});
    expect(report.active).toBe("anthropic");
    expect(report.accounts[0]).toMatchObject({ id: "anthropic", active: true });
  });

  it("treats selecting the default id as clearing (not an unknown-account error)", async () => {
    await useAccount(dir, "work", "2026-07-23T00:00:00.000Z", { assumeYes: true });
    const { active } = await useAccount(dir, "anthropic", "2026-07-23T00:02:00.000Z", {
      assumeYes: true,
    });
    expect(active).toBeNull(); // cleared, reverted to top-level
    expect((await collectAccounts(dir, {})).active).toBe("anthropic");
  });
});

describe("renderAccounts", () => {
  it("marks the active account and flags a missing credential", async () => {
    await useAccount(dir, "local", "2026-07-23T00:00:00.000Z", { assumeYes: true });
    const out = renderAccounts(await collectAccounts(dir, {}));
    expect(out).toContain("* local");
    expect(out).toContain("key MISSING");
    expect(out).toContain("active: local");
    // The synthetic default is listed and tagged, but not active here.
    expect(out).toContain("anthropic");
    expect(out).toContain("(default)");
  });

  it("marks the default active when no named account is selected", async () => {
    const out = renderAccounts(await collectAccounts(dir, {}));
    expect(out).toContain("* anthropic");
    expect(out).toContain("active: anthropic");
  });
});
