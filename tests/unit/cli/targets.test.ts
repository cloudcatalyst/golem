/**
 * R9.1 / R9.23 — `golem target` CLI: reporting the registry without leaking a
 * secret, fail-closed registration and lookup, and the generalized N-credential
 * spawn-time preflight.
 *
 * Credentials come from an INJECTED plaintext-file store under a temp dir (same
 * discipline as the account tests) — never the machine's real keychain.
 *
 * R9.23: `proxy.gateways` renamed to `proxy.gateways`; targets reference a
 * `gateway` id rather than carrying `provider`/`base_url`/`account` inline.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialEnvForProxy } from "../../../src/cli/gateways.js";
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
  // Two gateways sharing nothing, one of which will back two targets — the
  // many-targets-one-gateway case the split exists for.
  await writeSetting(
    "project",
    "proxy.gateways",
    [
      {
        id: "openrouter",
        provider: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
        models: ["openai/gpt-oss-20b:free"],
      },
      {
        id: "work",
        provider: "openai",
        base_url: "https://api.openai.com/v1",
        models: ["gpt-5.2"],
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
  it("reports gateways as targets with no config edit, and never a secret value", async () => {
    await store.store("openrouter", "sk-or-secret", "file");
    const report = await collectTargets(dir, {}, { store_backend: store });

    expect(report.default_target).toBe("anthropic");
    expect(report.default_unknown).toBe(false);
    // R9.23: gateway-derived target ids are `<gateway>/<model>`
    expect(report.targets.map((t) => t.id)).toEqual([
      "anthropic",
      "openrouter:openai/gpt-oss-20b:free",
      "work:gpt-5.2",
    ]);

    const openrouter = report.targets.find((t) => t.id === "openrouter:openai/gpt-oss-20b:free");
    expect(openrouter).toMatchObject({
      provider: "openrouter",
      account: "openrouter",
      key_set: true,
      trust: "third-party",
      origin: "gateway",
    });
    expect(JSON.stringify(report)).not.toContain("sk-or-secret");
    expect(renderTargets(report)).not.toContain("sk-or-secret");
  });

  it("warns about a target whose gateway has no stored credential", async () => {
    const report = await collectTargets(dir, {}, { store_backend: store });
    // R9.23: target id is compound `<gateway>/<model>`
    const work = report.targets.find((t) => t.id === "work:gpt-5.2");
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
    await writeSetting("project", "inference.default_target", "ghost", { projectDir: dir });
    const report = await collectTargets(dir, {}, { store_backend: store });
    expect(report.default_unknown).toBe(true);
    expect(renderTargets(report)).toContain("WARNING");
  });

  it("reads a settings file that still names the retired active_account (R9.6 migration)", async () => {
    // R9.23: default_target now references a compound target id `<gateway>/<model>`.
    // The old `active_account: "work"` would have migrated to `default_target: "work"`
    // (gateway id), but in the new schema the target id is `work:gpt-5.2`. This test
    // uses the compound id directly since the migration layer only renames the key.
    await writeSetting("project", "inference.default_target", "work:gpt-5.2", { projectDir: dir });
    const settingsPath = path.join(dir, ".golem", "settings.json");
    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    const inference = raw.inference as Record<string, unknown> | undefined;
    if (inference !== undefined) delete inference.default_target;
    const proxy = raw.proxy as Record<string, unknown>;
    proxy.active_account = "work";
    await writeFile(
      settingsPath,
      `${JSON.stringify(raw, null, 2)}
`,
      "utf8",
    );
    const report = await collectTargets(dir, {}, { store_backend: store });
    // R9.23: active_account "work" migrates to default_target "work" (gateway id),
    // and resolveDefaultTargetId resolves it to the first target from that gateway.
    expect(report.default_target).toBe("work:gpt-5.2");
    expect(report.default_unknown).toBe(false);
    const work = report.targets.find((t) => t.id === "work:gpt-5.2");
    expect(work?.is_default).toBe(true);
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
        gateway: "openrouter",
        model: "poolside/laguna-s-2.1:free",
        trust: "third-party",
      },
      "2026-08-09T00:00:00.000Z",
    );
    const { settings } = await loadConfig({ projectDir: dir });
    const entry = settings.proxy.targets?.find((t) => t.id === "cheap");
    expect(entry).toMatchObject({ gateway: "openrouter" });
    // The whole design rests on this: a target is not a place a secret can live.
    const serialized = JSON.stringify(entry ?? {}).toLowerCase();
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("secret");
  });

  it("refuses a target pointing at a gateway that does not exist", async () => {
    await expect(
      addTarget(
        dir,
        {
          id: "orphan",
          gateway: "missing",
          model: "x/y",
        },
        "2026-08-09T00:00:00.000Z",
      ),
    ).rejects.toThrow(/references gateway "missing".*not in\s+proxy\.gateways/s);
  });

  it("refuses a duplicate explicit id", async () => {
    const now = "2026-08-09T00:00:00.000Z";
    const entry: Parameters<typeof addTarget>[1] = {
      id: "cheap",
      gateway: "openrouter",
      model: "x/y",
    };
    await addTarget(dir, entry, now);
    await expect(addTarget(dir, entry, now)).rejects.toThrow(/already exists/);
  });

  it("allows overriding a gateway-derived target of the same id, and says so", async () => {
    // R9.23: target id is compound `<gateway>/<model>` matching the derived
    // target. Overriding with a different `trust` level is the common case.
    const result = await addTarget(
      dir,
      {
        id: "work:gpt-5.2",
        gateway: "work",
        model: "gpt-5.2",
        trust: "third-party",
      },
      "2026-08-09T00:00:00.000Z",
    );
    expect(result.overrides_gateway).toBe(true);
    const report = await collectTargets(dir, {}, { store_backend: store });
    // Overriding must not duplicate the row, and the gateway still backs it.
    expect(report.targets.filter((t) => t.id === "work:gpt-5.2")).toHaveLength(1);
    expect(report.targets.find((t) => t.id === "work:gpt-5.2")).toMatchObject({
      model: "gpt-5.2",
      account: "work",
      origin: "target",
    });
  });

  it("appends a non-secret line to the shared audit log", async () => {
    await addTarget(
      dir,
      {
        id: "cheap",
        gateway: "openrouter",
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
    // R9.23: target id is compound `<gateway>/<model>`
    const result = await testTarget(dir, "work:gpt-5.2", {}, { store_backend: store });
    expect(result.verdict).toBe("no-credential");
    expect(result.detail).toContain("golem account login work");
  });
});

describe("credentialEnvForProxy — N credentials, not 1 (R9.1)", () => {
  it("injects a key for every gateway a target references", async () => {
    await store.store("openrouter", "sk-or", "file");
    await store.store("work", "sk-work", "file");
    const env = await credentialEnvForProxy(dir, {}, { store_backend: store });
    expect(env.GOLEM_UPSTREAM_API_KEY__OPENROUTER).toBe("sk-or");
    expect(env.GOLEM_UPSTREAM_API_KEY__WORK).toBe("sk-work");
  });

  it("skips an unkeyed gateway rather than refusing to start the proxy", async () => {
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
