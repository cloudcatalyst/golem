/**
 * WS-D D1 — hardware capability detection → HardwareTier.
 *
 * Cross-platform, CLI-probe-only (no native GPU/ML deps, per CLAUDE.md). The
 * probe spawns short-lived processes with argument arrays (never a shell
 * string) and **every failure path degrades to P_CPU** — detection must never
 * throw and never block the caller for long. See verification-notes §22 for
 * the cross-OS strategy and its known limits.
 *
 * Tier mapping (spec §1 hardware profiles):
 *   P_CPU (0): no usable GPU / detection failed.
 *   P_MIN (1): a GPU/accelerator with < ~8 GB usable VRAM (or Apple Silicon
 *              with modest unified memory).
 *   P_MID (2): ~8–16 GB.
 *   P_MAX (3): > ~16 GB.
 */

import { HardwareTier } from "../interfaces/inference.js";

/** Raw, human-readable facts behind the tier (for `golem devices` / dashboard). */
export interface CapabilityFacts {
  readonly tier: HardwareTier;
  /** e.g. "nvidia-smi", "apple-silicon", "cpu-fallback". */
  readonly source: string;
  /** Detected accelerator name, if any (e.g. "NVIDIA RTX 4080", "Apple M3 Pro"). */
  readonly device?: string;
  /** Usable VRAM / unified memory in MiB, if known. */
  readonly memoryMiB?: number;
  /** Human note about why this tier was chosen or why detection degraded. */
  readonly detail: string;
}

/** One external command to run, as an argument array (never a shell string). */
export interface ProbeCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** Result of running a probe command. */
export interface ProbeResult {
  readonly ok: boolean;
  readonly stdout: string;
}

/**
 * Runs a probe command and returns its stdout. Injectable so tests supply
 * canned outputs without spawning anything. Implementations MUST resolve
 * (never reject) — a failed/absent command is `{ ok: false, stdout: "" }`.
 */
export type ProbeRunner = (cmd: ProbeCommand) => Promise<ProbeResult>;

/** Map a memory figure (MiB) to a tier using the documented thresholds. */
export function tierForMemoryMiB(mib: number): HardwareTier {
  if (mib <= 0) return HardwareTier.PCpu;
  if (mib < 8_192) return HardwareTier.PMin;
  if (mib <= 16_384) return HardwareTier.PMid;
  return HardwareTier.PMax;
}

const CPU_FALLBACK: CapabilityFacts = Object.freeze({
  tier: HardwareTier.PCpu,
  source: "cpu-fallback",
  detail: "No usable GPU detected (or detection failed); using CPU tier.",
});

/**
 * Parse `nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits`.
 * Each line: "<MiB>, <name>". Returns the largest-memory GPU, or null.
 */
export function parseNvidiaSmi(stdout: string): { memoryMiB: number; name: string } | null {
  let best: { memoryMiB: number; name: string } | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const comma = trimmed.indexOf(",");
    if (comma === -1) continue;
    const mib = Number.parseInt(trimmed.slice(0, comma).trim(), 10);
    if (!Number.isFinite(mib)) continue;
    const name = trimmed.slice(comma + 1).trim();
    if (best === null || mib > best.memoryMiB) best = { memoryMiB: mib, name };
  }
  return best;
}

/**
 * Parse Apple `sysctl -n hw.memsize` (bytes of unified memory). On Apple
 * Silicon the GPU shares system memory, so a fraction is usable by models.
 */
export function parseSysctlMemsize(stdout: string): number | null {
  const bytes = Number.parseInt(stdout.trim(), 10);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return Math.floor(bytes / (1024 * 1024));
}

/** Detect an NVIDIA GPU via nvidia-smi (works on Windows and Linux). */
async function detectNvidia(run: ProbeRunner): Promise<CapabilityFacts | null> {
  const res = await run({
    command: "nvidia-smi",
    args: ["--query-gpu=memory.total,name", "--format=csv,noheader,nounits"],
  });
  if (!res.ok) return null;
  const gpu = parseNvidiaSmi(res.stdout);
  if (gpu === null) return null;
  return {
    tier: tierForMemoryMiB(gpu.memoryMiB),
    source: "nvidia-smi",
    device: gpu.name,
    memoryMiB: gpu.memoryMiB,
    detail: `NVIDIA GPU with ${gpu.memoryMiB} MiB VRAM.`,
  };
}

/** Detect Apple Silicon unified memory via sysctl (macOS only). */
async function detectAppleSilicon(run: ProbeRunner): Promise<CapabilityFacts | null> {
  const arch = await run({ command: "uname", args: ["-m"] });
  if (!arch.ok || arch.stdout.trim() !== "arm64") return null;
  const mem = await run({ command: "sysctl", args: ["-n", "hw.memsize"] });
  if (!mem.ok) return null;
  const totalMiB = parseSysctlMemsize(mem.stdout);
  if (totalMiB === null) return null;
  // Roughly 70% of unified memory is usable for models (macOS caps GPU wiring);
  // the exact ceiling varies, so this is a conservative heuristic.
  const usableMiB = Math.floor(totalMiB * 0.7);
  return {
    tier: tierForMemoryMiB(usableMiB),
    source: "apple-silicon",
    device: "Apple Silicon (unified memory)",
    memoryMiB: usableMiB,
    detail: `Apple Silicon with ~${usableMiB} MiB usable of ${totalMiB} MiB unified memory.`,
  };
}

/**
 * Detect the hardware tier. Tries NVIDIA (Win/Linux) then Apple Silicon
 * (macOS); any failure or unrecognized environment yields P_CPU. Pure w.r.t.
 * the injected runner — call once and cache at the service layer.
 */
export async function detectCapability(run: ProbeRunner): Promise<CapabilityFacts> {
  try {
    const nvidia = await detectNvidia(run);
    if (nvidia !== null) return nvidia;
    const apple = await detectAppleSilicon(run);
    if (apple !== null) return apple;
  } catch {
    // Any unexpected error → CPU tier. Detection must never throw.
    return CPU_FALLBACK;
  }
  return CPU_FALLBACK;
}
