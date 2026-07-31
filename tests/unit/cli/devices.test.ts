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
const THIS_MACHINE = ["bge-m3:latest", "nomic-embed-text:latest", "qwen2.5-coder:7b"].map(
  (name) => ({ name }),
);

const collect = (listModels: () => Promise<readonly { readonly name: string }[]>) =>
  collectDevices({
    projectDir: process.cwd(),
    endpoint: ENDPOINT, // skips the config read
    detect: () => Promise.resolve(FACTS),
    listModels,
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
        Promise.resolve(
          ["qwen2.5:7b", "qwen2.5-coder:7b", "qwen2.5:14b", "bge-m3:latest"].map((name) => ({
            name,
          })),
        ),
      ),
    );
    expect(out).toContain("7/7 of this tier's slots are runnable.");
    expect(out).not.toContain("ollama pull");
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
