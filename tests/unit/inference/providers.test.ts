/**
 * R8.15 — role→model resolution when the user has declared their own providers.
 *
 * The rules these pin, in the order they matter:
 *
 * 1. **An unconfigured install behaves exactly as it did before R8.15.** No
 *    providers → the tier catalog, over Ollama, at `ollama_base_url`. This is the
 *    one that must never regress: the feature is opt-in data, and empty data has
 *    to be indistinguishable from no feature.
 * 2. **Declaration order decides**, not last-wins — resolution has to be
 *    deterministic and explicable from reading the file top to bottom.
 * 3. **A single unassigned model is a catch-all**, because that is the llama.cpp
 *    reality: you load one GGUF and it answers everything. Requiring every role to
 *    be spelled out would make the common case the most verbose one.
 * 4. **An undeclared context window is `undefined`, never a guess.** Same
 *    three-state honesty as `availability.ts` (§ the R4.4 lesson).
 */

import { describe, expect, it } from "vitest";
import {
  type ProviderEntry,
  resolveChatModel,
  resolveEmbedModel,
  validateProviders,
} from "../../../src/inference/providers.js";
import { HardwareTier } from "../../../src/interfaces/inference.js";

const OLLAMA = "http://localhost:11434";

/** The tier this repo's dev box detects (RTX 3070 Laptop, 8 GB) — P_MID. */
const TIER = HardwareTier.PMid;

const base = { tier: TIER, ollamaBaseUrl: OLLAMA } as const;

/** The canonical llama.cpp case: one server, one loaded GGUF, no role map. */
const LLAMACPP_SINGLE: ProviderEntry = {
  id: "llamacpp",
  api: "openai-completions",
  base_url: "http://127.0.0.1:8888/v1",
  models: [{ id: "qwen3.6-35b-a3b" }],
};

describe("resolveChatModel — no providers declared", () => {
  it("falls back to the tier catalog over Ollama", () => {
    const r = resolveChatModel("drafter", base);
    expect(r).toEqual({
      providerId: "ollama",
      api: "ollama",
      baseUrl: OLLAMA,
      model: "qwen2.5-coder:7b",
      source: "catalog",
    });
  });

  it("treats an empty list the same as an absent one", () => {
    expect(resolveChatModel("judge", { ...base, providers: [] })).toEqual(
      resolveChatModel("judge", base),
    );
  });

  it("still resolves every role the tier defines", () => {
    expect(resolveChatModel("summarizer", base).model).toBe("qwen2.5:7b");
    expect(resolveChatModel("judge", base).model).toBe("qwen2.5:14b");
  });
});

describe("resolveChatModel — a single unassigned model is a catch-all", () => {
  it("serves every chat role from the one loaded GGUF", () => {
    const ctx = { ...base, providers: [LLAMACPP_SINGLE] };
    for (const role of ["summarizer", "extractor", "classifier", "drafter", "judge"] as const) {
      const r = resolveChatModel(role, ctx);
      expect(r.model).toBe("qwen3.6-35b-a3b");
      expect(r.providerId).toBe("llamacpp");
      expect(r.api).toBe("openai-completions");
      expect(r.baseUrl).toBe("http://127.0.0.1:8888/v1");
      expect(r.source).toBe("provider");
    }
  });

  it("does not let a catch-all answer for embeddings", () => {
    // A chat GGUF is not an embedding model. Silently routing `embed` at it would
    // return garbage vectors that poison the KB — fall back to the catalog instead.
    const r = resolveEmbedModel("text", { ...base, providers: [LLAMACPP_SINGLE] });
    expect(r.source).toBe("catalog");
    expect(r.model).toBe("bge-m3");
  });
});

describe("resolveChatModel — explicit role claims", () => {
  const providers: readonly ProviderEntry[] = [
    {
      id: "llamacpp",
      api: "openai-completions",
      base_url: "http://127.0.0.1:8888/v1",
      models: [
        { id: "qwen3.6-35b-a3b", roles: ["drafter"], context_window: 131072 },
        { id: "tiny", roles: ["classifier"] },
      ],
    },
  ];

  it("routes a claimed role to the claiming model", () => {
    expect(resolveChatModel("drafter", { ...base, providers }).model).toBe("qwen3.6-35b-a3b");
    expect(resolveChatModel("classifier", { ...base, providers }).model).toBe("tiny");
  });

  it("leaves unclaimed roles on the catalog when nothing is a catch-all", () => {
    const r = resolveChatModel("judge", { ...base, providers });
    expect(r.source).toBe("catalog");
    expect(r.model).toBe("qwen2.5:14b");
    expect(r.api).toBe("ollama");
  });

  it("passes a declared context window through", () => {
    expect(resolveChatModel("drafter", { ...base, providers }).contextWindow).toBe(131072);
  });

  it("reports an undeclared context window as undefined rather than guessing", () => {
    expect(resolveChatModel("classifier", { ...base, providers }).contextWindow).toBeUndefined();
    expect(resolveChatModel("judge", base).contextWindow).toBeUndefined();
  });
});

describe("resolveChatModel — precedence between providers", () => {
  const first: ProviderEntry = {
    id: "first",
    api: "openai-completions",
    base_url: "http://127.0.0.1:8888/v1",
    models: [{ id: "a", roles: ["drafter"] }],
  };
  const second: ProviderEntry = {
    id: "second",
    api: "openai-completions",
    base_url: "http://127.0.0.1:1234/v1",
    models: [{ id: "b", roles: ["drafter"] }],
  };

  it("takes the FIRST declared claim, not the last", () => {
    expect(resolveChatModel("drafter", { ...base, providers: [first, second] }).model).toBe("a");
    expect(resolveChatModel("drafter", { ...base, providers: [second, first] }).model).toBe("b");
  });

  it("prefers an explicit claim in a later provider over an earlier catch-all", () => {
    // Otherwise a catch-all declared first would make every later, more specific
    // entry dead config — surprising, and impossible to debug from the file.
    const catchAll: ProviderEntry = {
      id: "catchall",
      api: "openai-completions",
      base_url: "http://127.0.0.1:9999/v1",
      models: [{ id: "generalist" }],
    };
    const r = resolveChatModel("drafter", { ...base, providers: [catchAll, second] });
    expect(r.model).toBe("b");
    expect(resolveChatModel("judge", { ...base, providers: [catchAll, second] }).model).toBe(
      "generalist",
    );
  });

  it("carries api_key_env through when declared", () => {
    const withKey: ProviderEntry = { ...first, api_key_env: "LLAMACPP_API_KEY" };
    expect(resolveChatModel("drafter", { ...base, providers: [withKey] }).apiKeyEnv).toBe(
      "LLAMACPP_API_KEY",
    );
    expect(resolveChatModel("drafter", { ...base, providers: [first] }).apiKeyEnv).toBeUndefined();
  });
});

describe("resolveEmbedModel", () => {
  const providers: readonly ProviderEntry[] = [
    {
      id: "ollama-lan",
      api: "ollama",
      base_url: "http://192.168.1.50:11434",
      models: [
        { id: "bge-m3", embed: "both" },
        { id: "nomic-embed-text", embed: "text" },
      ],
    },
  ];

  it("prefers the kind-specific model over the both-kinds one", () => {
    // `nomic-embed-text` claims text specifically; `bge-m3` claims both. The
    // specific claim wins for text, the general one still covers code.
    expect(resolveEmbedModel("text", { ...base, providers }).model).toBe("nomic-embed-text");
    expect(resolveEmbedModel("code", { ...base, providers }).model).toBe("bge-m3");
  });

  it("keeps the ollama api for an ollama-declared provider", () => {
    const r = resolveEmbedModel("code", { ...base, providers });
    expect(r.api).toBe("ollama");
    expect(r.baseUrl).toBe("http://192.168.1.50:11434");
  });
});

describe("validateProviders", () => {
  it("reports nothing for an absent or empty table", () => {
    expect(validateProviders(undefined)).toEqual([]);
    expect(validateProviders([])).toEqual([]);
  });

  it("reports a duplicate provider id without throwing", () => {
    // A status command must never fail over bad config — it reports and carries on,
    // and resolution stays deterministic (the first entry wins).
    const dup = [LLAMACPP_SINGLE, { ...LLAMACPP_SINGLE, base_url: "http://127.0.0.1:9999/v1" }];
    const problems = validateProviders(dup);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("llamacpp");
    expect(resolveChatModel("drafter", { ...base, providers: dup }).baseUrl).toBe(
      "http://127.0.0.1:8888/v1",
    );
  });

  it("reports a provider that declares no models", () => {
    const empty: ProviderEntry = {
      id: "hollow",
      api: "openai-completions",
      base_url: "http://127.0.0.1:8888/v1",
      models: [],
    };
    expect(validateProviders([empty])[0]).toContain("hollow");
  });

  it("reports a model claiming both a chat role and an embedding kind", () => {
    const confused: ProviderEntry = {
      id: "confused",
      api: "openai-completions",
      base_url: "http://127.0.0.1:8888/v1",
      models: [{ id: "both-ways", roles: ["drafter"], embed: "text" }],
    };
    expect(validateProviders([confused])[0]).toContain("both-ways");
  });
});
