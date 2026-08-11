/**
 * R6.2 v1 / R9.23 — gateway resolution (spec Decision 21d; ADR-0003, amended).
 * Pure resolver: legacy passthrough, active-gateway selection with per-gateway env
 * secret, and fail-closed handling of an unknown active gateway.
 */

import { describe, expect, it } from "vitest";
import {
  type GatewayEntry,
  perGatewayEnvVar,
  resolveActiveUpstream,
  resolveUpstreamDisplay,
  type UpstreamDisplaySettings,
} from "../../../src/providers/index.js";

const legacy = {
  provider: "anthropic" as const,
  base_url: "https://api.anthropic.com",
  auth_scheme: "inherit" as const,
};

const gateways: GatewayEntry[] = [
  { id: "work", provider: "openai", base_url: "https://api.openai.com/v1", models: ["gpt-5.2"] },
  {
    id: "local",
    provider: "ollama",
    base_url: "http://gpubox.lan:11434/v1",
    models: ["qwen2.5-coder:7b"],
  },
];

describe("perGatewayEnvVar", () => {
  it("uppercases and sanitizes the id", () => {
    expect(perGatewayEnvVar("work")).toBe("GOLEM_UPSTREAM_API_KEY__WORK");
    expect(perGatewayEnvVar("my-acct 2")).toBe("GOLEM_UPSTREAM_API_KEY__MY_ACCT_2");
  });
});

describe("resolveActiveUpstream", () => {
  it("uses the legacy top-level config when no gateway is active", () => {
    const { resolved, warning } = resolveActiveUpstream(
      { legacy, gateways, legacyApiKey: "sk-legacy" },
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

  it("selects the active gateway and its per-gateway env secret + resolved auth", () => {
    const { resolved, warning } = resolveActiveUpstream(
      { legacy, gateways, activeAccount: "work", legacyApiKey: "sk-legacy" },
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

  it("does NOT leak another gateway's key or the legacy key to the active gateway", () => {
    // Only the legacy key is in the env; the active gateway's var is unset.
    const { resolved } = resolveActiveUpstream(
      { legacy, gateways, activeAccount: "local", legacyApiKey: "sk-legacy" },
      { GOLEM_UPSTREAM_API_KEY: "sk-legacy", GOLEM_UPSTREAM_API_KEY__WORK: "sk-work" },
    );
    expect(resolved.accountId).toBe("local");
    expect(resolved.apiKey).toBeUndefined(); // fail-closed: no fallback to legacy/other keys
  });

  it("falls back to legacy + a warning for a selector in neither registry (no silent switch)", () => {
    const { resolved, warning } = resolveActiveUpstream(
      { legacy, gateways, activeAccount: "ghost", legacyApiKey: "sk-legacy" },
      {},
    );
    expect(resolved.accountId).toBeNull();
    expect(resolved.provider).toBe("anthropic");
    expect(warning).toMatch(/in neither proxy\.gateways nor proxy\.targets/);
  });
});

describe("resolveUpstreamDisplay", () => {
  const base: UpstreamDisplaySettings = {
    upstream_provider: "anthropic",
    upstream_base_url: "https://api.anthropic.com",
    upstream_auth_scheme: "inherit",
    gateways,
  };

  it("returns the legacy provider/URL and no model when no gateway is active", () => {
    const d = resolveUpstreamDisplay(base);
    expect(d).toEqual({
      accountId: null,
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: undefined,
    });
  });

  it("reflects the ACTIVE gateway's provider/base/model (never a secret)", () => {
    const d = resolveUpstreamDisplay({ ...base, default_target: "work" });
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

  it("surfaces the configured legacy model when set (translating provider, no gateway)", () => {
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

  it("falls back to legacy + a warning for a selector in neither registry (fail-closed)", () => {
    const d = resolveUpstreamDisplay({ ...base, default_target: "ghost" });
    expect(d.accountId).toBeNull();
    expect(d.provider).toBe("anthropic");
    expect(d.warning).toMatch(/in neither proxy\.gateways nor proxy\.targets/);
  });
});
