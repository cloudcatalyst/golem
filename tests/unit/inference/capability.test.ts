/**
 * WS-D D1 — capability detection. Uses an injected fake ProbeRunner so no real
 * process is spawned; the emphasis is the fail-to-P_CPU guarantee across OSes.
 */

import { describe, expect, it } from "vitest";
import {
  type CapabilityFacts,
  detectCapability,
  type ProbeCommand,
  type ProbeResult,
  type ProbeRunner,
  parseNvidiaSmi,
  parseSysctlMemsize,
  tierForMemoryMiB,
} from "../../../src/inference/capability.js";
import { HardwareTier } from "../../../src/interfaces/inference.js";

/** Build a fake runner from a table of command → result. Unlisted = not ok. */
function fakeRunner(table: Record<string, ProbeResult>): ProbeRunner {
  return (cmd: ProbeCommand) => {
    const key = [cmd.command, ...cmd.args].join(" ");
    return Promise.resolve(table[key] ?? { ok: false, stdout: "" });
  };
}

const NVIDIA_KEY = "nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits";

describe("tierForMemoryMiB", () => {
  it("maps memory to tiers at the documented thresholds", () => {
    expect(tierForMemoryMiB(0)).toBe(HardwareTier.PCpu);
    expect(tierForMemoryMiB(4_096)).toBe(HardwareTier.PMin);
    expect(tierForMemoryMiB(8_192)).toBe(HardwareTier.PMid);
    expect(tierForMemoryMiB(16_384)).toBe(HardwareTier.PMid);
    expect(tierForMemoryMiB(24_576)).toBe(HardwareTier.PMax);
  });
});

describe("parseNvidiaSmi", () => {
  it("returns the largest-memory GPU", () => {
    const out = "8192, NVIDIA RTX 3070\n24564, NVIDIA RTX 4090\n";
    expect(parseNvidiaSmi(out)).toStrictEqual({ memoryMiB: 24564, name: "NVIDIA RTX 4090" });
  });
  it("returns null on empty/garbage output", () => {
    expect(parseNvidiaSmi("")).toBeNull();
    expect(parseNvidiaSmi("no gpus here")).toBeNull();
  });
});

describe("parseSysctlMemsize", () => {
  it("converts bytes to MiB", () => {
    expect(parseSysctlMemsize("17179869184")).toBe(16_384); // 16 GiB
  });
  it("returns null on non-numeric", () => {
    expect(parseSysctlMemsize("nope")).toBeNull();
  });
});

describe("detectCapability", () => {
  it("detects an NVIDIA GPU and maps its VRAM to a tier", async () => {
    const facts = await detectCapability(
      fakeRunner({ [NVIDIA_KEY]: { ok: true, stdout: "24564, NVIDIA RTX 4090\n" } }),
    );
    expect(facts.tier).toBe(HardwareTier.PMax);
    expect(facts.source).toBe("nvidia-smi");
    expect(facts.device).toBe("NVIDIA RTX 4090");
    expect(facts.memoryMiB).toBe(24564);
  });

  it("detects Apple Silicon via uname+sysctl when no NVIDIA GPU", async () => {
    const facts = await detectCapability(
      fakeRunner({
        "uname -m": { ok: true, stdout: "arm64\n" },
        "sysctl -n hw.memsize": { ok: true, stdout: "17179869184\n" }, // 16 GiB
      }),
    );
    expect(facts.source).toBe("apple-silicon");
    // ~70% of 16384 MiB = 11468 MiB → P_MID
    expect(facts.tier).toBe(HardwareTier.PMid);
  });

  it("falls back to P_CPU when no probe succeeds", async () => {
    const facts = await detectCapability(fakeRunner({}));
    expect(facts.tier).toBe(HardwareTier.PCpu);
    expect(facts.source).toBe("cpu-fallback");
  });

  it("falls back to P_CPU when nvidia-smi returns junk", async () => {
    const facts = await detectCapability(
      fakeRunner({ [NVIDIA_KEY]: { ok: true, stdout: "garbage\n" } }),
    );
    expect(facts.tier).toBe(HardwareTier.PCpu);
  });

  it("does not treat a non-arm64 uname as Apple Silicon", async () => {
    const facts = await detectCapability(
      fakeRunner({ "uname -m": { ok: true, stdout: "x86_64\n" } }),
    );
    expect(facts.tier).toBe(HardwareTier.PCpu);
  });

  it("never throws even if the runner itself rejects", async () => {
    const throwingRunner: ProbeRunner = () => Promise.reject(new Error("spawn blew up"));
    const facts: CapabilityFacts = await detectCapability(throwingRunner);
    expect(facts.tier).toBe(HardwareTier.PCpu);
    expect(facts.source).toBe("cpu-fallback");
  });
});
