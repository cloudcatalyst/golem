/**
 * R6.2 v1 — account resolution (spec Decision 21d; ADR-0003). Pure resolver:
 * legacy passthrough, active-account selection with per-account env secret, and
 * fail-closed handling of an unknown active account.
 */

import { describe, expect, it } from "vitest";
import {
  perAccountEnvVar,
  resolveActiveUpstream,
  resolveUpstreamDisplay,
  type UpstreamAccount,
  type UpstreamDisplaySettings,
} from "../../../src/providers/index.js";

const legacy = {
  provider: "anthropic" as const,
  base_url: "https://api.anthropic.com",
  auth_scheme: "inherit" as const,
};

const accounts: UpstreamAccount[] = [
  { id: "work", provider: "openai", base_url: "https://api.openai.com/v1", model: "gpt-5.2" },
  {
    id: "local",
    provider: "ollama",
    base_url: "http://gpubox.lan:11434/v1",
    model: "qwen2.5-coder:7b",
  },
];

describe("perAccountEnvVar", () => {
  it("uppercases and sanitizes the id", () => {
    expect(perAccountEnvVar("work")).toBe("GOLEM_UPSTREAM_API_KEY__WORK");
    expect(perAccountEnvVar("my-acct 2")).toBe("GOLEM_UPSTREAM_API_KEY__MY_ACCT_2");
  });
});

describe("resolveActiveUpstream", () => {
  it("uses the legacy top-level config when no account is active", () => {
    const { resolved, warning } = resolveActiveUpstream(
      { legacy, accounts, legacyApiKey: "sk-legacy" },
      {},
    );
    expect(warning).toBeUndefined();
    expect(resolved).toEqual({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: undefined,
      authScheme: "inherit",
      apiKey: "sk-legacy",
      accountId: null,
    });
  });

  it("selects the active account and its per-account env secret + resolved auth", () => {
    const { resolved, warning } = resolveActiveUpstream(
      { legacy, accounts, activeAccount: "work", legacyApiKey: "sk-legacy" },
      { GOLEM_UPSTREAM_API_KEY__WORK: "sk-work" },
    );
    expect(warning).toBeUndefined();
    expect(resolved).toEqual({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.2",
      authScheme: "bearer", // openai default
      apiKey: "sk-work",
      accountId: "work",
    });
  });

  it("does NOT leak another account's key or the legacy key to the active account", () => {
    // Only the legacy key is in the env; the active account's var is unset.
    const { resolved } = resolveActiveUpstream(
      { legacy, accounts, activeAccount: "local", legacyApiKey: "sk-legacy" },
      { GOLEM_UPSTREAM_API_KEY: "sk-legacy", GOLEM_UPSTREAM_API_KEY__WORK: "sk-work" },
    );
    expect(resolved.accountId).toBe("local");
    expect(resolved.apiKey).toBeUndefined(); // fail-closed: no fallback to legacy/other keys
  });

  it("falls back to legacy + a warning for an unknown active account (no silent switch)", () => {
    const { resolved, warning } = resolveActiveUpstream(
      { legacy, accounts, activeAccount: "ghost", legacyApiKey: "sk-legacy" },
      {},
    );
    expect(resolved.accountId).toBeNull();
    expect(resolved.provider).toBe("anthropic");
    expect(warning).toMatch(/not in proxy.accounts/);
  });
});

describe("resolveUpstreamDisplay", () => {
  const base: UpstreamDisplaySettings = {
    upstream_provider: "anthropic",
    upstream_base_url: "https://api.anthropic.com",
    upstream_auth_scheme: "inherit",
    accounts,
  };

  it("returns the legacy provider/URL and no model when no account is active", () => {
    const d = resolveUpstreamDisplay(base);
    expect(d).toEqual({
      accountId: null,
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: undefined,
    });
  });

  it("reflects the ACTIVE account's provider/base/model (never a secret)", () => {
    const d = resolveUpstreamDisplay({ ...base, active_account: "work" });
    expect(d).toEqual({
      accountId: "work",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.2",
    });
    // No credential/auth surfaced on a display object.
    expect(Object.keys(d)).not.toContain("apiKey");
    expect(Object.keys(d)).not.toContain("authScheme");
  });

  it("surfaces the configured legacy model when set (translating provider, no account)", () => {
    const d = resolveUpstreamDisplay({
      upstream_provider: "openai",
      upstream_base_url: "https://api.moonshot.ai/v1",
      upstream_model: "kimi-k3",
      upstream_auth_scheme: "inherit",
    });
    expect(d.provider).toBe("openai");
    expect(d.model).toBe("kimi-k3");
    expect(d.accountId).toBeNull();
  });

  it("falls back to legacy + a warning for an unknown active account (fail-closed)", () => {
    const d = resolveUpstreamDisplay({ ...base, active_account: "ghost" });
    expect(d.accountId).toBeNull();
    expect(d.provider).toBe("anthropic");
    expect(d.warning).toMatch(/not in proxy.accounts/);
  });
});
