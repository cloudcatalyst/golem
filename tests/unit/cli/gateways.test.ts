/**
 * R6.2 v1 + Decisions 46/47 / R9.23 — `golem gateway` CLI: registry listing
 * (never leaking secrets), fail-closed switching, logout-on-remove, and the
 * ADR-0003 audit log.
 *
 * Credentials come from an INJECTED store (a plaintext file backend under a temp
 * dir), not the machine's real keychain and — since Decision 47 removed the env
 * backend — not from environment variables either. The `env` arguments that
 * remain only drive non-secret `GOLEM_<SECTION>_<KEY>` settings overrides.
 *
 * R9.23: `proxy.accounts` renamed to `proxy.gateways`; gateway entries carry
 * `models[]` (plural) instead of a single `model`.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addGateway,
  collectGateways,
  credentialEnvForProxy,
  defaultGatewayId,
  logoutGateway,
  removeGateway,
  renderGateways,
  useGateway,
} from "../../../src/cli/gateways.js";
import { loadConfig, writeSetting } from "../../../src/config/index.js";
import { createCredentialStore } from "../../../src/credentials/index.js";
import { readServedModel, writeServedModel } from "../../../src/proxy/index.js";
import { rmTemp } from "../../helpers/tmp.js";

let dir: string;
let credDir: string;
/** A store with no keychain (`sunos`), so `--store file` is the only mechanism. */
let store: ReturnType<typeof createCredentialStore>;

/** Put a credential in the injected store for `accountId`. */
async function seedKey(accountId: string, secret: string): Promise<void> {
  await store.store(accountId, secret, "file");
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-acct-"));
  credDir = await mkdtemp(path.join(tmpdir(), "golem-acct-cred-"));
  store = createCredentialStore({ userDir: credDir, platform: "sunos" });
  await writeSetting(
    "project",
    "proxy.gateways",
    [
      {
        id: "work",
        provider: "openai",
        base_url: "https://api.openai.com/v1",
        models: ["gpt-5.2"],
      },
      {
        id: "local",
        provider: "ollama",
        base_url: "http://gpubox.lan:11434/v1",
        models: ["qwen2.5-coder:7b"],
      },
    ],
    { projectDir: dir },
  );
});
afterEach(async () => {
  await rm(dir, rmTemp);
  await rm(credDir, rmTemp);
});

describe("collectGateways", () => {
  it("lists gateways with key-set flags (never the key); the default is active by default", async () => {
    await seedKey("work", "sk-x");
    const report = await collectGateways(dir, {}, { store_backend: store });
    // No named gateway selected → the synthetic default (top-level anthropic) is active.
    expect(report.active).toBe("anthropic");
    expect(report.active_unknown).toBe(false);
    // Default row is first, plus the two named gateways.
    expect(report.gateways).toHaveLength(3);
    const dflt = report.gateways[0];
    expect(dflt).toMatchObject({
      id: "anthropic",
      provider: "anthropic",
      is_default: true,
      active: true,
    });
    const work = report.gateways.find((a) => a.id === "work");
    expect(work).toMatchObject({ provider: "openai", key_set: true, active: false });
    const local = report.gateways.find((a) => a.id === "local");
    expect(local?.key_set).toBe(false);
    // The report carries no secret values anywhere.
    expect(JSON.stringify(report)).not.toContain("sk-x");
  });

  /** Decision 47: the report must not advertise an env var as the way to set a key. */
  it("does not name an env var anywhere in the report", async () => {
    const report = await collectGateways(dir, {}, { store_backend: store });
    expect(JSON.stringify(report)).not.toContain("GOLEM_UPSTREAM_API_KEY");
  });

  it("exposes the default id as the top-level provider name", () => {
    expect(defaultGatewayId("anthropic")).toBe("anthropic");
    expect(defaultGatewayId("openrouter")).toBe("openrouter");
  });
});

describe("useGateway", () => {
  it("switches the active account, marks it, and appends an audit line", async () => {
    await useGateway(dir, "work", "2026-07-23T00:00:00.000Z", { assumeYes: true });
    const report = await collectGateways(dir, {}, { store_backend: store });
    expect(report.active).toBe("work");
    expect(report.gateways.find((a) => a.id === "work")?.active).toBe(true);

    const log = await readFile(path.join(dir, ".golem", "state", "account-log.jsonl"), "utf8");
    expect(JSON.parse(log.trim())).toEqual({
      ts: "2026-07-23T00:00:00.000Z",
      action: "use",
      account: "work",
    });
  });

  /**
   * R10.24 — `inference.default_target` is a TARGET selector, and a gateway that
   * fronts several models collapses to one target when selected by gateway id. A
   * user with two OpenRouter models configured could therefore reach only the
   * first, and the VS Code picker could only ever offer the gateway. Selecting a
   * target by id is what makes "switch model" possible at all.
   */
  it("switches to a TARGET id, not just a gateway id (R10.24)", async () => {
    await seedKey("work", "sk-x");
    await useGateway(dir, "work:gpt-5.2", "2026-08-20T00:00:00.000Z", { store_backend: store });
    const report = await collectGateways(dir, {}, { store_backend: store });
    // `active` stays the backing GATEWAY id, so every pre-R10.24 consumer keeps
    // its meaning; `active_target` is the field that names the selected MODEL.
    expect(report.active).toBe("work");
    expect(report.active_target).toBe("work:gpt-5.2");
    expect(report.active_unknown).toBe(false);
    const work = report.gateways.find((g) => g.id === "work");
    expect(work?.active).toBe(true);
    // The row names the model actually in force, not the gateway's first.
    expect(work?.model).toBe("gpt-5.2");
    expect(work?.models).toEqual(["gpt-5.2"]);
  });

  it("preflights the credential of the gateway BEHIND a target, not the target id", async () => {
    // The key is stored for `work`; the target id is `work:gpt-5.2`. Resolving the
    // target id would find nothing and refuse a switch that is perfectly valid.
    await seedKey("work", "sk-x");
    await expect(
      useGateway(dir, "work:gpt-5.2", "2026-08-20T00:00:00.000Z", { store_backend: store }),
    ).resolves.toEqual({ active: "work:gpt-5.2" });
  });

  it("still fails closed on an id that is neither a gateway nor a target", async () => {
    await expect(
      useGateway(dir, "work:no-such-model", "2026-08-20T00:00:00.000Z", { store_backend: store }),
    ).rejects.toThrow(/unknown gateway or target/);
    expect((await collectGateways(dir, {}, { store_backend: store })).active).toBe("anthropic");
  });

  it("rejects an unknown account id (fail-closed, no silent creation)", async () => {
    await expect(
      useGateway(dir, "ghost", "2026-07-23T00:00:00.000Z", { store_backend: store }),
    ).rejects.toThrow(/unknown gateway/);
    expect((await collectGateways(dir, {}, { store_backend: store })).active).toBe("anthropic");
  });

  it("refuses to switch onto an account with no stored credential (fail-closed preflight)", async () => {
    await expect(
      useGateway(dir, "local", "2026-07-23T00:00:00.000Z", { store_backend: store }),
    ).rejects.toThrow(/no credential is stored for "local"/);
    // No switch happened.
    expect((await collectGateways(dir, {}, { store_backend: store })).active).toBe("anthropic");
  });

  /**
   * Decision 47: the remediation must point at `account login`, not an export —
   * a message that tells the user to set a var Golem no longer reads is worse
   * than no message.
   */
  it("remediates a missing credential with account login, never an env var", async () => {
    await expect(
      useGateway(dir, "local", "2026-07-23T00:00:00.000Z", { store_backend: store }),
    ).rejects.toThrow(/golem gateway login local/);
    await expect(
      useGateway(dir, "local", "2026-07-23T00:00:00.000Z", { store_backend: store }),
    ).rejects.not.toThrow(/GOLEM_UPSTREAM_API_KEY/);
  });

  it("switches when the credential resolves from the store", async () => {
    await seedKey("work", "sk-live");
    await useGateway(dir, "work", "2026-07-23T00:00:00.000Z", { store_backend: store });
    expect((await collectGateways(dir, {}, { store_backend: store })).active).toBe("work");
  });

  it("clears the last-served-model snapshot so no display shows the previous model", async () => {
    await writeServedModel(dir, {
      model: "claude-opus-4-8",
      servedAtIso: "2026-07-23T00:00:00.000Z",
      accountId: null,
    });
    await useGateway(dir, "work", "2026-07-23T00:01:00.000Z", { assumeYes: true });
    expect(await readServedModel(dir)).toBeNull();
  });

  it("clears it on the revert path too (account use none)", async () => {
    await useGateway(dir, "work", "2026-07-23T00:00:00.000Z", { assumeYes: true });
    await writeServedModel(dir, {
      model: "gpt-5.2",
      servedAtIso: "2026-07-23T00:01:00.000Z",
      accountId: "work",
    });
    await useGateway(dir, null, "2026-07-23T00:02:00.000Z", { store_backend: store });
    expect(await readServedModel(dir)).toBeNull();
  });

  /** An exported var is no longer a credential — the preflight must still refuse. */
  it("ignores a set environment variable when deciding whether a key exists", async () => {
    process.env.GOLEM_UPSTREAM_API_KEY__LOCAL = "sk-must-be-ignored";
    try {
      await expect(
        useGateway(dir, "local", "2026-07-23T00:00:00.000Z", { store_backend: store }),
      ).rejects.toThrow(/no credential is stored/);
    } finally {
      delete process.env.GOLEM_UPSTREAM_API_KEY__LOCAL;
    }
  });
});

describe("addGateway", () => {
  it("registers a new account (preserving existing entries) and audit-logs it", async () => {
    await addGateway(
      dir,
      {
        id: "gemini",
        provider: "gemini",
        base_url: "https://generativelanguage.googleapis.com",
        models: ["gemini-2.5-pro"],
      },
      "2026-07-26T00:00:00.000Z",
    );
    const { settings } = await loadConfig({ projectDir: dir });
    const ids = (settings.proxy.gateways ?? []).map((g) => g.id);
    expect(ids).toEqual(["work", "local", "gemini"]); // existing preserved, new appended
    const added = (settings.proxy.gateways ?? []).find((g) => g.id === "gemini");
    expect(added).toMatchObject({ provider: "gemini", models: ["gemini-2.5-pro"] });

    const log = await readFile(path.join(dir, ".golem", "state", "account-log.jsonl"), "utf8");
    expect(log).toContain('"action":"add"');
    expect(log).toContain('"account":"gemini"');
  });

  it("is fail-closed on a duplicate id (no silent overwrite)", async () => {
    await expect(
      addGateway(
        dir,
        { id: "work", provider: "openai", base_url: "https://x.example/v1" },
        "2026-07-26T00:00:00.000Z",
      ),
    ).rejects.toThrow(/already exists/);
    // The original entry is untouched (the beforeEach seeds work → api.openai.com/v1).
    const { settings } = await loadConfig({ projectDir: dir });
    expect((settings.proxy.gateways ?? []).find((g) => g.id === "work")?.base_url).toBe(
      "https://api.openai.com/v1",
    );
  });

  it("refuses to register the default account's id", async () => {
    await expect(
      addGateway(
        dir,
        { id: "anthropic", provider: "anthropic", base_url: "https://x.example" },
        "2026-07-26T00:00:00.000Z",
      ),
    ).rejects.toThrow(/default gateway/);
  });

  it("rejects an invalid entry via the schema (missing base_url shape)", async () => {
    await expect(
      addGateway(
        dir,
        { id: "bad", provider: "openai", base_url: "not-a-url" },
        "2026-07-26T00:00:00.000Z",
      ),
    ).rejects.toThrow();
  });

  it("warns that --model is inert on a byte-faithful provider (Decision 48)", async () => {
    const warnings: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await addGateway(
        dir,
        { id: "foundry", provider: "azure-foundry", base_url: "https://x.example/anthropic" },
        "2026-07-26T00:00:00.000Z",
      );
      expect(warnings.join("")).toBe(""); // no models → nothing to warn about
      await addGateway(
        dir,
        {
          id: "foundry-pinned",
          provider: "azure-foundry",
          base_url: "https://x.example/anthropic",
          models: ["claude-opus-5"],
        },
        "2026-07-26T00:00:00.000Z",
      );
      expect(warnings.join("")).toMatch(/IGNORED on the wire/);
    } finally {
      process.stderr.write = original;
    }
    // The account is still registered — this is a warning, not a rejection.
    const { settings } = await loadConfig({ projectDir: dir });
    expect((settings.proxy.gateways ?? []).map((g) => g.id)).toContain("foundry-pinned");
  });

  it("R13.13 — does NOT claim the model is ignored on a SPAWN provider, which pins it", async () => {
    // "not translating" was standing in for "forwards the client's model id", and
    // those are different sets. A spawn provider forwards nothing — there is no
    // wire — and `claudeCliArgs` pins the model as an explicit `--model <id>`
    // argument. So this warning fired on the one provider where the model is the
    // most load-bearing field there is: it is what the dispatcher's same-model
    // guard compares against, so a user who believed the warning and omitted it
    // got a target that could not dispatch at all. It misled a real user.
    const warnings: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await addGateway(
        dir,
        {
          id: "spawned",
          provider: "claude-cli",
          base_url: "https://api.anthropic.com",
          models: ["claude-sonnet-5"],
        },
        "2026-07-26T00:00:00.000Z",
      );
    } finally {
      process.stderr.write = original;
    }
    expect(warnings.join("")).not.toMatch(/IGNORED on the wire/);
  });

  it("warns when the base URL composes into a doubled version segment", async () => {
    const warnings: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await addGateway(
        dir,
        { id: "or-native", provider: "anthropic", base_url: "https://openrouter.ai/api/v1" },
        "2026-07-26T00:00:00.000Z",
      );
    } finally {
      process.stderr.write = original;
    }
    expect(warnings.join("")).toMatch(/api\/v1\/v1\/messages/);
  });

  it("does NOT warn for a translating provider with a model — the normal case", async () => {
    const warnings: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await addGateway(
        dir,
        {
          id: "openrouter-laguna",
          provider: "openrouter",
          base_url: "https://openrouter.ai/api/v1",
          models: ["poolside/laguna-s-2.1:free"],
          auth_scheme: "bearer",
        },
        "2026-07-26T00:00:00.000Z",
      );
    } finally {
      process.stderr.write = original;
    }
    expect(warnings.join("")).toBe("");
  });

  it("writes to the LOCAL scope so a pre-existing local-layer gateways array cannot mask it", async () => {
    // Regression: a `proxy.gateways` array in a higher-precedence layer
    // wholesale-replaces lower layers, so writing to project settings.json left
    // the new gateway invisible to the very merge the proxy reads.
    await addGateway(
      dir,
      { id: "gemini", provider: "gemini", base_url: "https://generativelanguage.googleapis.com" },
      "2026-07-26T00:00:00.000Z",
    );
    const localRaw = JSON.parse(
      await readFile(path.join(dir, ".golem", "settings.local.json"), "utf8"),
    ) as {
      proxy?: { gateways?: { id: string }[] };
    };
    // The beforeEach seeded gateways into settings.local.json; the add must
    // merge into THAT layer (preserving work+local), not the project file.
    expect((localRaw.proxy?.gateways ?? []).map((g) => g.id)).toEqual(["work", "local", "gemini"]);
    // And the merged view the proxy reads sees it too.
    const { settings } = await loadConfig({ projectDir: dir });
    expect((settings.proxy.gateways ?? []).map((g) => g.id)).toContain("gemini");
  });
});

describe("removeGateway", () => {
  it("removes the account from the registry", async () => {
    const { account, was_active } = await removeGateway(dir, "local", "2026-07-26T00:00:00.000Z", {
      store_backend: store,
    });
    expect(account).toBe("local");
    expect(was_active).toBe(false);
    const { settings } = await loadConfig({ projectDir: dir });
    expect((settings.proxy.gateways ?? []).map((g) => g.id)).toEqual(["work"]);
  });

  it("logs the account out first, deleting its stored credential", async () => {
    await seedKey("local", "sk-local");
    expect(await store.resolve("local")).not.toBeNull();

    const result = await removeGateway(dir, "local", "2026-07-26T00:00:00.000Z", {
      store_backend: store,
    });
    expect(result.credential_removed.length).toBeGreaterThan(0);
    expect(await store.resolve("local")).toBeNull();
  });

  it("audit-logs the logout as well as the remove", async () => {
    await seedKey("local", "sk-local");
    await removeGateway(dir, "local", "2026-07-26T00:00:00.000Z", { store_backend: store });
    const log = await readFile(path.join(dir, ".golem", "state", "account-log.jsonl"), "utf8");
    expect(log).toContain('"action":"logout"');
    expect(log).toContain('"action":"remove"');
    expect(log).not.toContain("sk-local");
  });

  it("reports no credential to remove when the account never had one", async () => {
    const result = await removeGateway(dir, "local", "2026-07-26T00:00:00.000Z", {
      store_backend: store,
    });
    expect(result.credential_removed).toEqual([]);
  });

  it("keeps the credential when keepCredential is set (the escape hatch)", async () => {
    await seedKey("local", "sk-local");
    const result = await removeGateway(dir, "local", "2026-07-26T00:00:00.000Z", {
      keepCredential: true,
      store_backend: store,
    });
    expect(result.credential_removed).toEqual([]);
    expect(await store.resolve("local")).not.toBeNull();
  });

  it("does not delete a credential when the id is unknown (fail-closed, nothing touched)", async () => {
    await seedKey("local", "sk-local");
    await expect(
      removeGateway(dir, "ghost", "2026-07-26T00:00:00.000Z", { store_backend: store }),
    ).rejects.toThrow(/unknown gateway/);
    expect(await store.resolve("local")).not.toBeNull();
  });

  it("reverts active_account to the default when the active account is removed", async () => {
    await useGateway(dir, "work", "2026-07-26T00:00:00.000Z", { assumeYes: true });
    const { was_active } = await removeGateway(dir, "work", "2026-07-26T00:01:00.000Z", {
      store_backend: store,
    });
    expect(was_active).toBe(true);
    const { settings } = await loadConfig({ projectDir: dir });
    expect(settings.inference.default_target).toBeUndefined();
    expect((await collectGateways(dir, {}, { store_backend: store })).active).toBe("anthropic");
  });
});

describe("logoutGateway", () => {
  it("removes the stored credential and reports where from", async () => {
    await seedKey("work", "sk-work");
    const result = await logoutGateway(dir, "work", "2026-07-26T00:00:00.000Z", {
      store_backend: store,
    });
    expect(result.removed.length).toBeGreaterThan(0);
    expect(await store.resolve("work")).toBeNull();
  });

  it("is a no-op report when there was nothing stored", async () => {
    const result = await logoutGateway(dir, "work", "2026-07-26T00:00:00.000Z", {
      store_backend: store,
    });
    expect(result.removed).toEqual([]);
  });
});

describe("credentialEnvForProxy (Decisions 46/47 — the daemon handoff)", () => {
  it("hands the active named account's stored credential over on its per-account var", async () => {
    await seedKey("work", "sk-live-work");
    await useGateway(dir, "work", "2026-07-23T00:00:00.000Z", { store_backend: store });
    const env = await credentialEnvForProxy(dir, {}, { store_backend: store });
    expect(env).toEqual({ GOLEM_UPSTREAM_API_KEY__WORK: "sk-live-work" });
  });

  it("hands the default account's credential over on the plain var", async () => {
    await seedKey("default", "sk-default");
    const env = await credentialEnvForProxy(dir, {}, { store_backend: store });
    expect(env).toEqual({ GOLEM_UPSTREAM_API_KEY: "sk-default" });
  });

  it("returns {} when no credential resolves, so the proxy forwards client auth", async () => {
    const env = await credentialEnvForProxy(dir, {}, { store_backend: store });
    expect(env).toEqual({});
  });

  it("does not pass through an ambient env var that has no stored credential", async () => {
    process.env.GOLEM_UPSTREAM_API_KEY = "sk-ambient";
    try {
      expect(await credentialEnvForProxy(dir, {}, { store_backend: store })).toEqual({});
    } finally {
      delete process.env.GOLEM_UPSTREAM_API_KEY;
    }
  });

  it("clears the active account with id=null (reverts to the default)", async () => {
    await useGateway(dir, "work", "2026-07-23T00:00:00.000Z", { assumeYes: true });
    await useGateway(dir, null, "2026-07-23T00:01:00.000Z", { store_backend: store });
    const report = await collectGateways(dir, {}, { store_backend: store });
    expect(report.active).toBe("anthropic");
    expect(report.gateways[0]).toMatchObject({ id: "anthropic", active: true });
  });

  it("treats selecting the default id as clearing (not an unknown-account error)", async () => {
    await useGateway(dir, "work", "2026-07-23T00:00:00.000Z", { assumeYes: true });
    const { active } = await useGateway(dir, "anthropic", "2026-07-23T00:02:00.000Z", {
      assumeYes: true,
    });
    expect(active).toBeNull(); // cleared, reverted to top-level
    expect((await collectGateways(dir, {}, { store_backend: store })).active).toBe("anthropic");
  });
});

describe("renderGateways", () => {
  it("marks the active account and flags a missing credential", async () => {
    await useGateway(dir, "local", "2026-07-23T00:00:00.000Z", { assumeYes: true });
    const out = renderGateways(await collectGateways(dir, {}, { store_backend: store }));
    expect(out).toContain("* local");
    expect(out).toContain("key MISSING");
    expect(out).toContain("active: local");
    // The synthetic default is listed and tagged, but not active here.
    expect(out).toContain("anthropic");
    expect(out).toContain("(default)");
  });

  /** Decision 47: the fix offered for a missing key is `login`, not an export. */
  it("remediates a missing key with account login and names no env var", async () => {
    const out = renderGateways(await collectGateways(dir, {}, { store_backend: store }));
    expect(out).toContain("golem gateway login");
    expect(out).not.toContain("GOLEM_UPSTREAM_API_KEY");
    expect(out).not.toContain("export ");
  });

  it("marks the default active when no named account is selected", async () => {
    const out = renderGateways(await collectGateways(dir, {}, { store_backend: store }));
    expect(out).toContain("* anthropic");
    expect(out).toContain("active: anthropic");
  });
});
