/**
 * R8.15 — availability asked through the provider table.
 *
 * The load-bearing rule here is the one that reverses direction from the Ollama
 * case: on a non-Ollama endpoint an unlisted model id is **`unknown`, not
 * `not-pulled`**, because llama.cpp answers for whichever GGUF it loaded regardless
 * of the id sent. Reporting "missing" for a model that will answer fine is the same
 * fabricated fact the three-state rule exists to prevent — just failing the other
 * way round.
 */

import { describe, expect, it, vi } from "vitest";
import {
  listedState,
  resolveAvailability,
  resolvedAvailabilityWarning,
} from "../../../src/inference/availability.js";
import type { ProviderEntry } from "../../../src/inference/providers.js";
import { HardwareTier } from "../../../src/interfaces/inference.js";

const OLLAMA = "http://localhost:11434";
const base = { tier: HardwareTier.PMid, ollamaBaseUrl: OLLAMA } as const;

/** What `ollama list` actually holds on the machine that motivated `local-models`. */
const THIS_MACHINE = ["bge-m3:latest", "nomic-embed-text:latest", "qwen2.5-coder:7b"];

const listing = (byEndpoint: Readonly<Record<string, readonly string[]>>) =>
  vi.fn(async (e: { readonly baseUrl: string }) => {
    const found = byEndpoint[e.baseUrl];
    if (found === undefined) throw new Error(`unreachable: ${e.baseUrl}`);
    return found;
  });

describe("listedState", () => {
  it("uses strict Ollama tag semantics for an ollama provider", () => {
    expect(listedState("ollama", ["qwen2.5-coder:7b"], "qwen2.5-coder:7b")).toBe("pulled");
    expect(listedState("ollama", ["bge-m3:latest"], "bge-m3")).toBe("pulled");
    expect(listedState("ollama", ["qwen2.5:32b"], "qwen2.5:3b")).toBe("not-pulled");
  });

  it("never says not-pulled for an OpenAI-compatible endpoint", () => {
    expect(listedState("openai-completions", ["a"], "a")).toBe("pulled");
    expect(listedState("openai-completions", ["a"], "b")).toBe("unknown");
    expect(listedState("openai-completions", [], "b")).toBe("unknown");
  });
});

describe("resolveAvailability — no providers declared", () => {
  it("reproduces the pre-R8.15 picture: 3 of 7 runnable on this machine", async () => {
    const a = await resolveAvailability(base, listing({ [OLLAMA]: THIS_MACHINE }));
    expect(a.slots.filter((s) => s.state === "pulled").map((s) => s.slot)).toEqual([
      "drafter",
      "text-embed",
      "code-embed",
    ]);
    expect(a.missing.map((s) => s.slot)).toEqual([
      "summarizer",
      "extractor",
      "classifier",
      "judge",
    ]);
    expect(a.slots.every((s) => s.resolved.source === "catalog")).toBe(true);
  });

  it("reports everything as unknown when nothing answers, never as missing", async () => {
    const a = await resolveAvailability(base, listing({}));
    expect(a.slots.every((s) => s.state === "unknown")).toBe(true);
    expect(a.missing).toEqual([]);
    expect(a.providers[0]?.reachable).toBe(false);
  });
});

describe("resolveAvailability — a llama.cpp provider", () => {
  const llamacpp: ProviderEntry = {
    id: "llamacpp",
    api: "openai-completions",
    base_url: "http://127.0.0.1:8888/v1",
    models: [{ id: "qwen3.6-35b-a3b" }],
  };

  it("marks every chat role pulled when the server lists the declared id", async () => {
    const a = await resolveAvailability(
      { ...base, providers: [llamacpp] },
      listing({ "http://127.0.0.1:8888/v1": ["qwen3.6-35b-a3b"], [OLLAMA]: THIS_MACHINE }),
    );
    const chat = a.slots.filter((s) => !s.slot.endsWith("-embed"));
    expect(chat.every((s) => s.state === "pulled")).toBe(true);
    expect(chat.every((s) => s.resolved.providerId === "llamacpp")).toBe(true);
  });

  it("says unknown — not missing — when the server reports a different id", async () => {
    const a = await resolveAvailability(
      { ...base, providers: [llamacpp] },
      listing({ "http://127.0.0.1:8888/v1": ["gpt-3.5-turbo"], [OLLAMA]: THIS_MACHINE }),
    );
    expect(a.slots.find((s) => s.slot === "drafter")?.state).toBe("unknown");
    expect(a.missing.map((s) => s.slot)).toEqual([]);
  });

  it("still routes embeddings to the Ollama catalog and checks them there", async () => {
    const a = await resolveAvailability(
      { ...base, providers: [llamacpp] },
      listing({ "http://127.0.0.1:8888/v1": ["qwen3.6-35b-a3b"], [OLLAMA]: THIS_MACHINE }),
    );
    const embed = a.slots.find((s) => s.slot === "text-embed");
    expect(embed?.resolved.providerId).toBe("ollama");
    expect(embed?.state).toBe("pulled");
  });

  it("probes each distinct endpoint once, not once per slot", async () => {
    const list = listing({
      "http://127.0.0.1:8888/v1": ["qwen3.6-35b-a3b"],
      [OLLAMA]: THIS_MACHINE,
    });
    await resolveAvailability({ ...base, providers: [llamacpp] }, list);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("does not double-probe when a provider already names the Ollama endpoint", async () => {
    const ollamaProvider: ProviderEntry = {
      id: "mine",
      api: "ollama",
      base_url: OLLAMA,
      models: [{ id: "qwen2.5-coder:7b", roles: ["drafter"] }],
    };
    const list = listing({ [OLLAMA]: THIS_MACHINE });
    const a = await resolveAvailability({ ...base, providers: [ollamaProvider] }, list);
    expect(list).toHaveBeenCalledTimes(1);
    expect(a.providers).toHaveLength(1);
  });
});

describe("resolvedAvailabilityWarning", () => {
  it("offers `ollama pull` only for models that are actually on Ollama", async () => {
    const a = await resolveAvailability(base, listing({ [OLLAMA]: THIS_MACHINE }));
    const warning = resolvedAvailabilityWarning(a);
    expect(warning).toContain("ollama pull qwen2.5:7b");
    expect(warning).toContain("ollama pull qwen2.5:14b");
  });

  it("gives no pull advice for a llama.cpp miss, because none would help", async () => {
    // The whole point: the pre-R8.15 string said `ollama pull …` unconditionally,
    // which at a llama.cpp server is advice that cannot work.
    const providers: readonly ProviderEntry[] = [
      {
        id: "llamacpp",
        api: "openai-completions",
        base_url: "http://127.0.0.1:8888/v1",
        models: [{ id: "qwen3.6-35b-a3b" }],
      },
    ];
    const a = await resolveAvailability({ ...base, providers }, listing({}));
    const warning = resolvedAvailabilityWarning(a);
    expect(warning).toContain("UNKNOWN");
    expect(warning).not.toContain("ollama pull");
  });

  it("says nothing when every slot is available", async () => {
    const providers: readonly ProviderEntry[] = [
      {
        id: "llamacpp",
        api: "openai-completions",
        base_url: "http://127.0.0.1:8888/v1",
        models: [{ id: "chat" }, { id: "embed-text", embed: "both" }],
      },
    ];
    const a = await resolveAvailability(
      { ...base, providers },
      listing({ "http://127.0.0.1:8888/v1": ["chat", "embed-text"], [OLLAMA]: THIS_MACHINE }),
    );
    expect(resolvedAvailabilityWarning(a)).toBeNull();
  });
});
