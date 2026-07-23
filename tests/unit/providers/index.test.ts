/**
 * R6.1 case (a) — Anthropic-native upstream providers: auth-scheme resolution,
 * header mapping (strip client Anthropic creds, inject provider credential),
 * and the semantic-stage caching assumption.
 */

import { describe, expect, it } from "vitest";
import {
  defaultAuthScheme,
  isTranslatingProvider,
  makeAuthMapper,
  resolveAuthScheme,
  upstreamAssumesCaching,
  upstreamChatCompletionsPath,
} from "../../../src/providers/index.js";

describe("translating providers (case b)", () => {
  it("classifies openai/ollama as translating and the case-(a) set as not", () => {
    expect(isTranslatingProvider("openai")).toBe(true);
    expect(isTranslatingProvider("ollama")).toBe(true);
    for (const p of ["anthropic", "azure-foundry", "openrouter", "custom"] as const) {
      expect(isTranslatingProvider(p)).toBe(false);
    }
  });

  it("auth defaults: openai bearer, ollama none (inherit)", () => {
    expect(defaultAuthScheme("openai")).toBe("bearer");
    expect(defaultAuthScheme("ollama")).toBe("inherit");
  });

  it("treats openai/ollama as NON-caching (semantic stage may engage)", () => {
    expect(upstreamAssumesCaching("openai")).toBe(false);
    expect(upstreamAssumesCaching("ollama")).toBe(false);
  });

  it("derives the chat-completions path from the base URL, preserving any prefix", () => {
    expect(upstreamChatCompletionsPath("http://gpubox.lan:11434/v1")).toBe("/v1/chat/completions");
    expect(upstreamChatCompletionsPath("https://api.openai.com/v1")).toBe("/v1/chat/completions");
    expect(upstreamChatCompletionsPath("https://host/openai/v1/")).toBe(
      "/openai/v1/chat/completions",
    );
  });
});

describe("auth scheme resolution", () => {
  it("gives each provider a sensible default", () => {
    expect(defaultAuthScheme("anthropic")).toBe("inherit");
    expect(defaultAuthScheme("azure-foundry")).toBe("api-key");
    expect(defaultAuthScheme("openrouter")).toBe("bearer");
    expect(defaultAuthScheme("custom")).toBe("inherit");
  });

  it("an explicit non-inherit config wins; inherit falls back to the provider default", () => {
    expect(resolveAuthScheme("azure-foundry", "inherit")).toBe("api-key");
    expect(resolveAuthScheme("azure-foundry", "bearer")).toBe("bearer"); // Entra override
    expect(resolveAuthScheme("anthropic", "inherit")).toBe("inherit");
    expect(resolveAuthScheme("custom", "x-api-key")).toBe("x-api-key");
  });
});

describe("makeAuthMapper", () => {
  const clientHeaders = () => ({
    "x-api-key": "sk-ant-client-key",
    authorization: "Bearer oauth-token",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  });

  it("returns undefined for inherit (no rewrite — Anthropic passthrough)", () => {
    expect(makeAuthMapper("inherit", "whatever")).toBeUndefined();
  });

  it("returns undefined when no credential is available (CLI warns, forwards as-is)", () => {
    expect(makeAuthMapper("api-key", undefined)).toBeUndefined();
    expect(makeAuthMapper("bearer", "")).toBeUndefined();
  });

  it("api-key scheme: strips client Anthropic creds, injects api-key, keeps anthropic-version", () => {
    const map = makeAuthMapper("api-key", "azure-secret");
    const out = map?.(clientHeaders());
    expect(out?.["api-key"]).toBe("azure-secret");
    expect(out?.["x-api-key"]).toBeUndefined();
    expect(out?.authorization).toBeUndefined();
    expect(out?.["anthropic-version"]).toBe("2023-06-01");
    expect(out?.["content-type"]).toBe("application/json");
  });

  it("bearer scheme: injects Authorization: Bearer, drops x-api-key", () => {
    const out = makeAuthMapper("bearer", "or-key")?.(clientHeaders());
    expect(out?.authorization).toBe("Bearer or-key");
    expect(out?.["x-api-key"]).toBeUndefined();
  });

  it("x-api-key scheme: replaces x-api-key, drops authorization", () => {
    const out = makeAuthMapper("x-api-key", "gw-key")?.(clientHeaders());
    expect(out?.["x-api-key"]).toBe("gw-key");
    expect(out?.authorization).toBeUndefined();
  });

  it("does not mutate the caller's header object", () => {
    const original = clientHeaders();
    makeAuthMapper("api-key", "k")?.(original);
    expect(original["x-api-key"]).toBe("sk-ant-client-key");
    expect(original.authorization).toBe("Bearer oauth-token");
  });
});

describe("upstreamAssumesCaching", () => {
  it("defers to the URL heuristic for anthropic, assumes caching for the rest", () => {
    expect(upstreamAssumesCaching("anthropic")).toBeUndefined();
    expect(upstreamAssumesCaching("azure-foundry")).toBe(true);
    expect(upstreamAssumesCaching("openrouter")).toBe(true);
    expect(upstreamAssumesCaching("custom")).toBe(true);
  });
});
