/**
 * R6.1 case (a) — Anthropic-native upstream providers: auth-scheme resolution,
 * header mapping (strip client Anthropic creds, inject provider credential),
 * and the semantic-stage caching assumption.
 */

import { describe, expect, it } from "vitest";
import {
  defaultAuthScheme,
  doubledVersionSegment,
  isGeminiProvider,
  isTranslatingProvider,
  makeAuthMapper,
  preservesVendorPrefix,
  resolveAuthScheme,
  upstreamAssumesCaching,
  upstreamBasePath,
  upstreamChatCompletionsPath,
  upstreamRequestUrl,
} from "../../../src/providers/index.js";

describe("translating providers (case b)", () => {
  it("classifies openai/ollama/openrouter as translating and the case-(a) set as not", () => {
    expect(isTranslatingProvider("openai")).toBe(true);
    expect(isTranslatingProvider("ollama")).toBe(true);
    // Decision 48: OpenRouter moved from case (a) to case (b) — its Anthropic
    // endpoint can only serve Claude models, so byte-faithful made every
    // non-Claude model (including the free tier) unreachable.
    expect(isTranslatingProvider("openrouter")).toBe(true);
    for (const p of ["anthropic", "azure-foundry", "custom"] as const) {
      expect(isTranslatingProvider(p)).toBe(false);
    }
  });

  it("auth defaults: openai bearer, ollama none (inherit)", () => {
    expect(defaultAuthScheme("openai")).toBe("bearer");
    expect(defaultAuthScheme("ollama")).toBe("inherit");
  });

  it("treats openai/ollama/gemini as NON-caching (semantic stage may engage)", () => {
    expect(upstreamAssumesCaching("openai")).toBe(false);
    expect(upstreamAssumesCaching("ollama")).toBe(false);
    expect(upstreamAssumesCaching("gemini")).toBe(false);
  });

  it("classifies gemini as translating, gemini-schema, and no header auth (query-param key)", () => {
    expect(isTranslatingProvider("gemini")).toBe(true);
    expect(isGeminiProvider("gemini")).toBe(true);
    expect(isGeminiProvider("openai")).toBe(false);
    expect(defaultAuthScheme("gemini")).toBe("inherit");
  });

  it("derives the chat-completions path from the base URL, preserving any prefix", () => {
    expect(upstreamChatCompletionsPath("http://gpubox.lan:11434/v1")).toBe("/v1/chat/completions");
    expect(upstreamChatCompletionsPath("https://api.openai.com/v1")).toBe("/v1/chat/completions");
    expect(upstreamChatCompletionsPath("https://host/openai/v1/")).toBe(
      "/openai/v1/chat/completions",
    );
    // OpenRouter's documented base URL — the one the user actually pastes.
    expect(upstreamChatCompletionsPath("https://openrouter.ai/api/v1")).toBe(
      "/api/v1/chat/completions",
    );
  });

  it("tolerates a base URL that already names the chat-completions endpoint", () => {
    // Copied straight out of a provider's curl example; appending produced a
    // doubled `/chat/completions/chat/completions` that 404s.
    expect(upstreamChatCompletionsPath("https://openrouter.ai/api/v1/chat/completions")).toBe(
      "/api/v1/chat/completions",
    );
  });

  it("keeps the vendor/ prefix ONLY for the multi-vendor gateway", () => {
    // OpenRouter's canonical id IS `vendor/model`; stripping it resolves to a
    // different vendor's model or 400s. Single-vendor upstreams want it bare.
    expect(preservesVendorPrefix("openrouter")).toBe(true);
    for (const p of ["openai", "ollama", "gemini", "anthropic", "custom"] as const) {
      expect(preservesVendorPrefix(p)).toBe(false);
    }
  });

  it("keeps OpenRouter fail-safe on caching despite being translated", () => {
    // A multi-vendor gateway fronts both caching and non-caching models, so Golem
    // cannot know per-gateway — it stays fail-safe (no lossy history rewriting)
    // rather than inheriting the translating providers' `false`.
    expect(upstreamAssumesCaching("openrouter")).toBe(true);
  });
});

describe("request-URL composition (probe/proxy agreement)", () => {
  it("derives the base path the way the proxy prepends it", () => {
    expect(upstreamBasePath("https://api.anthropic.com")).toBe("");
    expect(upstreamBasePath("https://api.anthropic.com/")).toBe("");
    expect(upstreamBasePath("https://openrouter.ai/api/v1")).toBe("/api/v1");
    expect(upstreamBasePath("https://openrouter.ai/api/v1/")).toBe("/api/v1");
  });

  it("predicts the real POST target per provider case", () => {
    // Case (a): the proxy appends the client's own `/v1/messages`.
    expect(upstreamRequestUrl("anthropic", "https://api.anthropic.com")).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    expect(upstreamRequestUrl("azure-foundry", "https://x.services.ai.azure.com/anthropic")).toBe(
      "https://x.services.ai.azure.com/anthropic/v1/messages",
    );
    // Case (b): the translated chat-completions endpoint.
    expect(upstreamRequestUrl("openrouter", "https://openrouter.ai/api/v1")).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(upstreamRequestUrl("openai", "https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("flags a base URL whose composed path repeats the version segment", () => {
    // The exact trap: an OpenRouter base URL on a byte-faithful provider composes
    // `/api/v1/v1/messages`, which 404s with an HTML page — while a credential
    // probe against `/api/v1/models` happily reports the key as accepted.
    expect(doubledVersionSegment("anthropic", "https://openrouter.ai/api/v1")).toBe(
      "https://openrouter.ai/api/v1/v1/messages",
    );
    expect(doubledVersionSegment("custom", "https://gateway.internal/v1")).toBe(
      "https://gateway.internal/v1/v1/messages",
    );
    // Sane compositions are not flagged.
    expect(doubledVersionSegment("anthropic", "https://api.anthropic.com")).toBeUndefined();
    expect(doubledVersionSegment("openrouter", "https://openrouter.ai/api/v1")).toBeUndefined();
    expect(doubledVersionSegment("openai", "https://api.openai.com/v1")).toBeUndefined();
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
