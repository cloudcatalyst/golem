/**
 * Task `local-models` — `golem devices` must show the catalog and reality side by
 * side. The old output was a flat `models for this tier: a, b, c`, which reads as
 * "available" and was wrong for most slots.
 */

import { describe, expect, it } from "vitest";
import { collectDevices, devicesJson, renderDevices } from "../../../src/cli/devices.js";
import type { CapabilityFacts } from "../../../src/inference/index.js";
import { HardwareTier } from "../../../src/interfaces/inference.js";

const ENDPOINT = "http://localhost:11434";

const FACTS: CapabilityFacts = {
  tier: HardwareTier.PMid,
  source: "nvidia-smi",
  detail: "NVIDIA GeForce RTX 4070 Laptop GPU, 8188 MiB",
  device: "NVIDIA GeForce RTX 4070 Laptop GPU",
  memoryMiB: 8188,
};

/** What `ollama list` actually holds on the machine that motivated the task. */
const THIS_MACHINE = ["bge-m3:latest", "nomic-embed-text:latest", "qwen2.5-coder:7b"];

const collect = (listEndpoint: () => Promise<readonly string[]>) =>
  collectDevices({
    projectDir: process.cwd(),
    endpoint: ENDPOINT, // skips the config read
    providers: [], // R8.15: no user table → the pre-R8.15 picture, unchanged
    detect: () => Promise.resolve(FACTS),
    listEndpoint,
  });

describe("golem devices", () => {
  it("prints each slot's model with whether it is pulled", async () => {
    const out = renderDevices(await collect(() => Promise.resolve(THIS_MACHINE)));
    expect(out).toContain("Hardware tier: 2 (P_MID)");
    expect(out).toMatch(/drafter +qwen2\.5-coder:7b — pulled/);
    expect(out).toMatch(/classifier +qwen2\.5:7b — NOT pulled/);
    expect(out).toMatch(/judge +qwen2\.5:14b — NOT pulled/);
    expect(out).toContain("3/7 of this tier's slots are runnable.");
    expect(out).toContain("ollama pull qwen2.5:14b");
  });

  it("says the availability is UNKNOWN when the endpoint is unreachable", async () => {
    const out = renderDevices(await collect(() => Promise.reject(new Error("ECONNREFUSED"))));
    expect(out).toContain("NOT reachable");
    expect(out).toContain("UNKNOWN");
    expect(out).toMatch(/drafter +qwen2\.5-coder:7b — unknown/);
    // It must not claim anything is missing when it could not look.
    expect(out).not.toContain("NOT pulled");
  });

  it("stays quiet about pulls when everything is present", async () => {
    const out = renderDevices(
      await collect(() =>
        Promise.resolve(["qwen2.5:7b", "qwen2.5-coder:7b", "qwen2.5:14b", "bge-m3:latest"]),
      ),
    );
    expect(out).toContain("7/7 of this tier's slots are runnable.");
    expect(out).not.toContain("ollama pull");
  });

  it("R8.15 — names the provider per row and drops the useless `ollama pull` advice", async () => {
    const report = await collectDevices({
      projectDir: process.cwd(),
      endpoint: ENDPOINT,
      providers: [
        {
          id: "llamacpp",
          api: "openai-completions",
          base_url: "http://127.0.0.1:8888/v1",
          models: [{ id: "qwen3.6-35b-a3b", context_window: 131072 }],
        },
      ],
      detect: () => Promise.resolve(FACTS),
      listEndpoint: (e) =>
        Promise.resolve(
          e.baseUrl === "http://127.0.0.1:8888/v1" ? ["qwen3.6-35b-a3b"] : THIS_MACHINE,
        ),
      // The server was launched with `-c 16384`, contradicting the 131072 the user
      // wrote in config. Both are shown: the live number is the one that binds.
      readProps: () => Promise.resolve({ contextWindow: 16384 }),
    });
    const out = renderDevices(report);
    expect(out).toContain("llamacpp: serving with a 16,384-token context window");
    // Two backends in play, so the endpoint belongs on the row, not in a header
    // that would imply they all came from the same server.
    // "available", not "pulled": llama.cpp pulls nothing, and `golem local status`
    // says the same word for the same row.
    expect(out).toMatch(
      /drafter +qwen3\.6-35b-a3b +— available +\[llamacpp http:\/\/127\.0\.0\.1:8888\/v1\]/,
    );
    // Embeddings must NOT be routed at a chat GGUF — they stay on Ollama.
    expect(out).toMatch(/text-embed +bge-m3 +— pulled +\[ollama http:\/\/localhost:11434\]/);
    expect(out).toContain("7/7 of this tier's slots are runnable.");
    expect(out).not.toContain("ollama pull");

    const json = devicesJson(report);
    const slots = json.model_slots as ReadonlyArray<Record<string, unknown>>;
    expect(slots.find((s) => s.slot === "drafter")).toMatchObject({
      provider: "llamacpp",
      source: "provider",
      context_window: 131072,
    });
    expect(slots.find((s) => s.slot === "code-embed")).toMatchObject({
      provider: "ollama",
      source: "catalog",
    });
  });

  it("R8.15 — a llama.cpp server reporting another id is unknown, never missing", async () => {
    const out = renderDevices(
      await collectDevices({
        projectDir: process.cwd(),
        endpoint: ENDPOINT,
        providers: [
          {
            id: "llamacpp",
            api: "openai-completions",
            base_url: "http://127.0.0.1:8888/v1",
            models: [{ id: "my-handle" }],
          },
        ],
        detect: () => Promise.resolve(FACTS),
        listEndpoint: (e) =>
          Promise.resolve(
            e.baseUrl === "http://127.0.0.1:8888/v1" ? ["gpt-3.5-turbo"] : THIS_MACHINE,
          ),
      }),
    );
    // llama.cpp answers for whatever GGUF it loaded regardless of the id sent, so
    // "NOT pulled" here would be a fabricated fact in the opposite direction.
    expect(out).toMatch(/drafter +my-handle +— unknown/);
    expect(out).not.toContain("NOT pulled");
  });

  it("R8.15 — reports a duplicate provider id without failing", async () => {
    const entry = {
      id: "dup",
      api: "openai-completions",
      base_url: "http://127.0.0.1:8888/v1",
      models: [{ id: "m" }],
    } as const;
    const report = await collectDevices({
      projectDir: process.cwd(),
      endpoint: ENDPOINT,
      providers: [entry, entry],
      detect: () => Promise.resolve(FACTS),
      listEndpoint: () => Promise.resolve(["m"]),
    });
    expect(renderDevices(report)).toContain('duplicate provider id "dup"');
    expect((devicesJson(report).problems as readonly string[]).length).toBe(1);
  });

  it("--json keeps the old flat `models` list and adds per-slot state", async () => {
    const json = devicesJson(await collect(() => Promise.resolve(THIS_MACHINE)));
    expect(json.tier).toBe(HardwareTier.PMid);
    expect(json.endpoint).toBe(ENDPOINT);
    expect(json.endpoint_reachable).toBe(true);
    expect(json.models).toEqual(["qwen2.5:7b", "qwen2.5-coder:7b", "qwen2.5:14b", "bge-m3"]);
    expect(json.missing).toEqual(["qwen2.5:7b", "qwen2.5:14b"]);
    const slots = json.model_slots as ReadonlyArray<{ slot: string; state: string }>;
    expect(slots).toHaveLength(7);
    expect(slots.find((s) => s.slot === "drafter")?.state).toBe("pulled");
    expect(slots.find((s) => s.slot === "classifier")?.state).toBe("not-pulled");
  });
});
