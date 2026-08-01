/**
 * R8.18 — the pure half of `golem llamacpp`: which release asset, does it fit, and
 * what argument array starts the server.
 *
 * Everything here is a **pure function**. No network, no filesystem, no clock — the
 * I/O half lives in `llamacpp-bootstrap.ts` and takes these as input. That split is
 * what makes the interesting decisions (does a 45 GB coder fit beside a 19 GB
 * generalist? how many layers on an 8 GB card?) testable without a GPU, a download,
 * or a machine of any particular shape.
 *
 * Golem ships none of llama.cpp's bytes (Decision 53). These functions name a pinned
 * upstream asset and the digest to verify it against; fetching is a separate,
 * consented act.
 */

import type { GgufModel } from "./gguf-catalog.js";
import { estimatedResidentBytes } from "./gguf-catalog.js";

/**
 * The llama.cpp release Golem targets. Pinned, and bumped deliberately — never
 * "latest", because a release that changes asset names or flags mid-flight turns a
 * working install into a support question.
 *
 * Verified 2026-08-01 (verification-notes §113): b10216, published 2026-07-31.
 */
export const LLAMACPP_RELEASE_TAG = "b10216";

export const LLAMACPP_RELEASES_URL = "https://github.com/ggml-org/llama.cpp/releases";

/**
 * Which compute backend an asset is built for.
 *
 * `cuda-13.3` / `cuda-12.4` are fastest on NVIDIA but need a separate ~372 MB CUDA
 * runtime bundle. `vulkan` is 32 MB, needs no runtime, and works on NVIDIA, AMD and
 * Intel alike — a far better default for a tool that must work on machines it has
 * never seen. `cpu` is the floor that always works.
 */
export type LlamacppBackend = "cuda-13.3" | "cuda-12.4" | "vulkan" | "hip" | "cpu";

export interface LlamacppAsset {
  readonly backend: LlamacppBackend;
  /** Release asset filename. */
  readonly name: string;
  /** A second asset that must be extracted alongside it (the CUDA runtime). */
  readonly runtimeName?: string;
}

/** What the planner knows about the machine. All of it measured elsewhere. */
export interface MachineFacts {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** Total system RAM. */
  readonly totalRamBytes: number;
  /** RAM actually free right now — the number that decides whether a load will swap. */
  readonly freeRamBytes: number;
  /** VRAM on the primary accelerator, or 0 when there is none. */
  readonly vramBytes: number;
  /** NVIDIA driver major version, when an NVIDIA GPU was detected. */
  readonly nvidiaDriverMajor?: number;
  /** True when an AMD ROCm-capable GPU was detected. */
  readonly amdGpu?: boolean;
  /** Free bytes on the volume the models will land on. */
  readonly freeDiskBytes: number;
}

/**
 * CUDA 13.x needs a recent driver; below that the 12.4 build is the compatible one.
 * The exact floor moves with each CUDA release, so this is deliberately conservative:
 * a wrong guess downward costs some speed, a wrong guess upward costs a cryptic
 * load-time failure on a user's machine.
 */
const CUDA_13_MIN_DRIVER_MAJOR = 580;

/**
 * PURE — the release asset for this machine.
 *
 * Windows and Linux get real choices; macOS has its own arm64 tarball and no CUDA at
 * all. An unrecognised platform falls to `cpu`, which is slow but never wrong.
 */
export function resolveAsset(facts: MachineFacts, tag = LLAMACPP_RELEASE_TAG): LlamacppAsset {
  const osPart = facts.platform === "win32" ? "win" : facts.platform === "linux" ? "ubuntu" : null;

  if (facts.platform === "darwin") {
    // Metal is built into the macOS builds; there is no separate backend to choose.
    return {
      backend: "cpu",
      name: `llama-${tag}-bin-macos-${facts.arch === "arm64" ? "arm64" : "x64"}.tar.gz`,
    };
  }
  if (osPart === null) {
    return { backend: "cpu", name: `llama-${tag}-bin-win-cpu-x64.zip` };
  }

  const ext = facts.platform === "win32" ? "zip" : "tar.gz";

  if (facts.nvidiaDriverMajor !== undefined && facts.vramBytes > 0) {
    const cuda = facts.nvidiaDriverMajor >= CUDA_13_MIN_DRIVER_MAJOR ? "13.3" : "12.4";
    return {
      backend: cuda === "13.3" ? "cuda-13.3" : "cuda-12.4",
      name: `llama-${tag}-bin-${osPart}-cuda-${cuda}-x64.${ext}`,
      // The CUDA runtime ships separately and is NOT optional — the server will not
      // start without it, and that failure reads as "the binary is broken".
      runtimeName: `cudart-llama-bin-${osPart}-cuda-${cuda}-x64.${ext}`,
    };
  }
  if (facts.amdGpu === true && facts.platform === "win32") {
    return { backend: "hip", name: `llama-${tag}-bin-win-hip-radeon-x64.${ext}` };
  }
  if (facts.vramBytes > 0) {
    // Any other GPU: Vulkan, which is tiny and vendor-neutral.
    return { backend: "vulkan", name: `llama-${tag}-bin-${osPart}-vulkan-x64.${ext}` };
  }
  return { backend: "cpu", name: `llama-${tag}-bin-${osPart}-cpu-x64.${ext}` };
}

/** Download URL for a named release asset at a pinned tag. */
export function assetUrl(name: string, tag = LLAMACPP_RELEASE_TAG): string {
  return `${LLAMACPP_RELEASES_URL}/download/${tag}/${name}`;
}

// ---------------------------------------------------------------------------
// Does it fit?
// ---------------------------------------------------------------------------

export interface FitVerdict {
  readonly fits: boolean;
  /** Estimated resident bytes for every model in the set. */
  readonly requiredBytes: number;
  /** What the machine has free. */
  readonly availableBytes: number;
  /** Bytes to download (files not already present are the caller's business). */
  readonly downloadBytes: number;
  /** Human-readable arithmetic — shown whether it fits or not. */
  readonly explanation: string;
}

/**
 * How much of free RAM a model set may claim before Golem calls it a bad idea.
 *
 * Not a safety margin for its own sake: the OS, the editor, Golem itself and the
 * proxy all need headroom, and an MoE that swaps is dramatically slower than one that
 * simply did not load. Refusing loudly beats discovering it at 2 tokens/sec.
 */
const RAM_HEADROOM_FRACTION = 0.85;

/**
 * PURE — will this set of models run on this machine?
 *
 * Uses **free** RAM rather than total: a machine with 64 GB and 30 GB free cannot host
 * a 45 GB model today, whatever its spec sheet says. Reports the arithmetic either way,
 * because "it doesn't fit" without numbers is not actionable.
 */
export function checkFit(
  models: readonly GgufModel[],
  facts: MachineFacts,
  contextTokens: number,
): FitVerdict {
  const requiredBytes = models.reduce(
    (sum, m) => sum + estimatedResidentBytes(m, contextTokens),
    0,
  );
  const availableBytes = Math.floor(facts.freeRamBytes * RAM_HEADROOM_FRACTION);
  const downloadBytes = models.reduce(
    (sum, m) => sum + m.files.reduce((s, f) => s + f.bytes, 0),
    0,
  );
  const fits = requiredBytes <= availableBytes;
  const names = models.map((m) => m.title).join(" + ");
  const explanation = fits
    ? `${names} needs about ${gib(requiredBytes)} resident at a ${contextTokens.toLocaleString("en-US")}-token ` +
      `context; ${gib(facts.freeRamBytes)} is free, so up to ${gib(availableBytes)} is usable. Fits.`
    : `${names} needs about ${gib(requiredBytes)} resident at a ${contextTokens.toLocaleString("en-US")}-token ` +
      `context, but only ${gib(availableBytes)} of the ${gib(facts.freeRamBytes)} free is usable after headroom. ` +
      "Running it anyway would swap, which is far slower than a smaller quant. " +
      "Pick a smaller quant, drop a model from the set, or free memory.";
  return { fits, requiredBytes, availableBytes, downloadBytes, explanation };
}

/**
 * Free space a volume must retain AFTER the download.
 *
 * An absolute floor rather than a percentage, because the failure it prevents is
 * absolute: an OS with a nearly-full disk stops being able to page, log or update,
 * and "the download technically fitted" is no comfort. A 20 GB model landing on a
 * volume with 23.8 GB free would leave under 2 GB — arithmetically fine and a genuinely
 * bad idea, which is the case that motivated this constant.
 */
const DISK_RESERVE_BYTES = 10 * 1024 ** 3;

/**
 * PURE — is there room on disk for the download?
 *
 * `extracts` distinguishes the two shapes: a GGUF is written once and is its own final
 * artifact, while a release archive coexists with its extracted contents and so peaks
 * at roughly double.
 */
export function checkDiskSpace(
  downloadBytes: number,
  facts: MachineFacts,
  opts: { readonly extracts?: boolean } = {},
): { readonly fits: boolean; readonly explanation: string } {
  const peak = Math.round(downloadBytes * (opts.extracts === true ? 2 : 1.05));
  const needed = peak + DISK_RESERVE_BYTES;
  const fits = needed <= facts.freeDiskBytes;
  return {
    fits,
    explanation: fits
      ? `${gib(downloadBytes)} to download (${gib(peak)} peak), ${gib(facts.freeDiskBytes)} free on the ` +
        `target volume — ${gib(facts.freeDiskBytes - peak)} would remain.`
      : `${gib(downloadBytes)} to download (${gib(peak)} peak, plus a ${gib(DISK_RESERVE_BYTES)} reserve ` +
        `the OS needs) requires ${gib(needed)}, but only ${gib(facts.freeDiskBytes)} is free on the ` +
        "target volume. Choose another location with `golem llamacpp setup --models-dir <path>`.",
  };
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// The server command line
// ---------------------------------------------------------------------------

export interface ServerPlan {
  /** Absolute path to `llama-server`, resolved by the caller. */
  readonly command: string;
  /** Argument array — never a shell string (CLAUDE.md cross-platform rule). */
  readonly args: readonly string[];
  readonly port: number;
  readonly contextTokens: number;
  /** Why these flags, in one line, so the choice is auditable rather than magic. */
  readonly rationale: string;
}

export interface ServerPlanOptions {
  readonly command: string;
  readonly model: GgufModel;
  /** Resolved absolute paths, keyed by the catalog file path. */
  readonly filePaths: Readonly<Record<string, string>>;
  readonly facts: MachineFacts;
  readonly port: number;
  /** Override the computed context window. */
  readonly contextTokens?: number;
  /** Bind address. Loopback unless the user is deliberately serving a LAN. */
  readonly host?: string;
}

/**
 * Context window sized to VRAM, because the KV cache is what actually lives there
 * once `--n-cpu-moe` has pushed the experts to RAM.
 *
 * Conservative by design: a window too large fails at load or evicts mid-task, and
 * both are worse than a smaller one the user can raise deliberately.
 */
export function contextForVram(vramBytes: number): number {
  const gb = vramBytes / 1024 ** 3;
  if (gb >= 24) return 131072;
  if (gb >= 16) return 65536;
  if (gb >= 12) return 32768;
  if (gb >= 8) return 16384;
  if (gb >= 6) return 8192;
  return 4096;
}

/**
 * PURE — the `llama-server` invocation.
 *
 * The MoE trick is the whole point on consumer hardware: `-ngl 99` offloads every
 * layer, then `--n-cpu-moe 999` pulls the expert tensors back to RAM. What is left on
 * the GPU is attention and the KV cache, which is small — so a 20 GB model runs on an
 * 8 GB card at the speed of its 3B active parameters. On a dense model the same flags
 * would be actively wrong, so `moe` gates them.
 */
export function planServer(opts: ServerPlanOptions): ServerPlan {
  const { model, facts, filePaths } = opts;
  const contextTokens = opts.contextTokens ?? contextForVram(facts.vramBytes);
  const weights = model.files.find((f) => f.kind === "weights");
  if (weights === undefined) {
    throw new Error(`catalog entry "${model.id}" has no weights file`);
  }
  const weightsPath = filePaths[weights.path];
  if (weightsPath === undefined) {
    throw new Error(`no resolved path for "${weights.path}"`);
  }

  const args: string[] = ["-m", weightsPath];

  const mmproj = model.files.find((f) => f.kind === "mmproj");
  const mmprojPath = mmproj === undefined ? undefined : filePaths[mmproj.path];
  if (mmprojPath !== undefined) args.push("--mmproj", mmprojPath);

  const draft = model.files.find((f) => f.kind === "draft");
  const draftPath = draft === undefined ? undefined : filePaths[draft.path];
  if (draftPath !== undefined) args.push("--model-draft", draftPath);

  args.push("--host", opts.host ?? "127.0.0.1", "--port", String(opts.port));
  // `--jinja` makes llama.cpp use the GGUF's own chat template, which is what turns
  // the model's native tool-call syntax into parsed `tool_calls`. Without it, tool
  // use degrades to text the client cannot execute (little-coder's LFM2 diagnosis).
  args.push("--jinja");
  args.push("-c", String(contextTokens));

  if (facts.vramBytes > 0) {
    args.push("-ngl", "99");
    if (model.moe) args.push("--n-cpu-moe", "999");
    args.push("--flash-attn", "on");
  }

  const rationale = model.moe
    ? `MoE: every layer offloaded (-ngl 99) with expert tensors kept in RAM (--n-cpu-moe 999), ` +
      `so ${gib(model.files[0]?.bytes ?? 0)} of weights run on ${gib(facts.vramBytes)} of VRAM at ` +
      `${model.activeParamsB}B active params. Context ${contextTokens.toLocaleString("en-US")} sized to VRAM` +
      `${draftPath !== undefined ? "; MTP draft model enabled for speculative decoding" : ""}.`
    : `Dense model: all ${model.activeParamsB}B parameters are active per token, so --n-cpu-moe does ` +
      `not apply and throughput is bounded by RAM bandwidth. Context ${contextTokens.toLocaleString("en-US")}.`;

  return { command: opts.command, args, port: opts.port, contextTokens, rationale };
}
