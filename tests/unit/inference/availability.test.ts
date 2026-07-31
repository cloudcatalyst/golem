/**
 * Task `local-models` — the tier CATALOG is not the same thing as what Ollama has
 * pulled. These pin the three-state contract (pulled / not-pulled / unknown), the
 * strict name matcher, and the pre-run warnings.
 */

import { describe, expect, it } from "vitest";
import {
  availabilityWarning,
  matchesPulledName,
  resolveTierAvailability,
  roleState,
  roleWarning,
} from "../../../src/inference/availability.js";
import { HardwareTier } from "../../../src/interfaces/inference.js";

const ENDPOINT = "http://localhost:11434";

/** What `ollama list` actually holds on the machine that motivated this task. */
const THIS_MACHINE = ["bge-m3:latest", "nomic-embed-text:latest", "qwen2.5-coder:7b"].map(
  (name) => ({ name }),
);

const tags = (names: readonly string[]) => () => Promise.resolve(names.map((name) => ({ name })));

describe("matchesPulledName", () => {
  it("matches an exact tagged id", () => {
    expect(matchesPulledName("qwen2.5-coder:7b", "qwen2.5-coder:7b")).toBe(true);
  });

  it("matches an untagged catalog id against any tag of the same base", () => {
    expect(matchesPulledName("bge-m3:latest", "bge-m3")).toBe(true);
    expect(matchesPulledName("nomic-embed-text:v1.5", "nomic-embed-text")).toBe(true);
  });

  // The loose `startsWith` used by `hasModel` would call this a match. It is not:
  // 3b and 32b are different models on different tiers.
  it("does NOT let qwen2.5:32b satisfy qwen2.5:3b", () => {
    expect(matchesPulledName("qwen2.5:32b", "qwen2.5:3b")).toBe(false);
  });

  it("does not confuse two model families sharing a prefix", () => {
    expect(matchesPulledName("qwen2.5-coder:7b", "qwen2.5:7b")).toBe(false);
  });
});

describe("resolveTierAvailability", () => {
  it("marks each slot pulled or not-pulled against the endpoint's real list", async () => {
    const a = await resolveTierAvailability(HardwareTier.PMid, {
      endpoint: ENDPOINT,
      listModels: () => Promise.resolve(THIS_MACHINE),
    });
    expect(a.reachable).toBe(true);
    // P_MID: drafter qwen2.5-coder:7b (pulled), both embed slots bge-m3 (pulled),
    // and summarizer/extractor/classifier/judge on qwen2.5:* (not pulled).
    expect(roleState(a, "drafter")).toBe("pulled");
    expect(roleState(a, "classifier")).toBe("not-pulled");
    expect(roleState(a, "judge")).toBe("not-pulled");
    expect(a.models.filter((m) => m.slot.endsWith("-embed")).map((m) => m.state)).toEqual([
      "pulled",
      "pulled",
    ]);
    expect(a.missing.map((m) => m.slot)).toEqual([
      "summarizer",
      "extractor",
      "classifier",
      "judge",
    ]);
  });

  it("lists every slot, including two roles that share one model", async () => {
    const a = await resolveTierAvailability(HardwareTier.PCpu, {
      endpoint: ENDPOINT,
      listModels: tags([]),
    });
    // P_CPU shares qwen2.5:1.5b across three roles and one embed model across both
    // kinds — still 7 lines, because the question is per-role.
    expect(a.models).toHaveLength(7);
    expect(a.models.map((m) => m.slot)).toEqual([
      "summarizer",
      "extractor",
      "classifier",
      "drafter",
      "judge",
      "text-embed",
      "code-embed",
    ]);
  });

  // The R4.4 lesson: never a silent or invented zero. An endpoint we could not
  // list tells us nothing, and "unknown" is the honest answer.
  it("reports unknown (not not-pulled) when the endpoint cannot be listed", async () => {
    const a = await resolveTierAvailability(HardwareTier.PMid, {
      endpoint: ENDPOINT,
      listModels: () => Promise.reject(new Error("connect ECONNREFUSED")),
    });
    expect(a.reachable).toBe(false);
    expect(a.models.every((m) => m.state === "unknown")).toBe(true);
    expect(a.missing).toEqual([]); // nothing is KNOWN to be missing
    expect(a.pulled).toEqual([]);
  });
});

describe("availabilityWarning", () => {
  it("is null when every slot is pulled", async () => {
    const a = await resolveTierAvailability(HardwareTier.PMid, {
      endpoint: ENDPOINT,
      listModels: tags(["qwen2.5:7b", "qwen2.5-coder:7b", "qwen2.5:14b", "bge-m3"]),
    });
    expect(availabilityWarning(a)).toBeNull();
  });

  it("names the missing slots, their models, and the pull command", async () => {
    const a = await resolveTierAvailability(HardwareTier.PMid, {
      endpoint: ENDPOINT,
      listModels: () => Promise.resolve(THIS_MACHINE),
    });
    const w = availabilityWarning(a) ?? "";
    expect(w).toContain("classifier (qwen2.5:7b)");
    expect(w).toContain("judge (qwen2.5:14b)");
    expect(w).toContain("ollama pull qwen2.5:14b");
  });

  it("says UNKNOWN — not missing — when the endpoint is unreachable", async () => {
    const a = await resolveTierAvailability(HardwareTier.PMid, {
      endpoint: ENDPOINT,
      listModels: () => Promise.reject(new Error("down")),
    });
    const w = availabilityWarning(a) ?? "";
    expect(w).toContain("UNKNOWN");
    expect(w).toContain(ENDPOINT);
    expect(w).not.toMatch(/NOT pulled/);
  });
});

describe("roleWarning", () => {
  it("warns for the one role a run will use, and stays quiet for the others", async () => {
    const a = await resolveTierAvailability(HardwareTier.PMid, {
      endpoint: ENDPOINT,
      listModels: () => Promise.resolve(THIS_MACHINE),
    });
    // §89/§100: this is precisely the fact that went unsaid before both runs.
    const classifier = roleWarning(a, "classifier") ?? "";
    expect(classifier).toContain("qwen2.5:7b");
    expect(classifier).toContain("NOT pulled");
    expect(roleWarning(a, "drafter")).toBeNull();
  });

  it("distinguishes unknown from not pulled", async () => {
    const a = await resolveTierAvailability(HardwareTier.PMid, {
      endpoint: ENDPOINT,
      listModels: () => Promise.reject(new Error("down")),
    });
    expect(roleWarning(a, "classifier") ?? "").toContain("UNKNOWN");
  });
});
