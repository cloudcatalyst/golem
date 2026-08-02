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
 * `cuda-13.3` / `cuda-12.4` are fastest on NVIDIA but need a separate ~373 MB CUDA
 * runtime bundle, and upstream publishes them **for Windows only**. `vulkan` is 33 MB,
 * needs no runtime, and works on NVIDIA, AMD and Intel alike — which is why it is the
 * GPU answer on Linux regardless of vendor. `metal` is built into the macOS tarballs
 * rather than being a separate asset. `cpu` is the floor that always works.
 */
export type LlamacppBackend = "cuda-13.3" | "cuda-12.4" | "vulkan" | "hip" | "metal" | "cpu";

export interface LlamacppAsset {
  readonly backend: LlamacppBackend;
  /** Release asset filename. */
  readonly name: string;
  /** A second asset that must be extracted alongside it (the CUDA runtime). */
  readonly runtimeName?: string;
  /**
   * Why this asset and not a faster one, when the answer is surprising. Present only
   * where a user would otherwise reasonably ask "where is my CUDA build?".
   */
  readonly note?: string;
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
 * The ROCm version baked into the Linux AMD asset name. It moves with the release, so
 * it is pinned beside the tag rather than derived — and `verifyAssetName` catches it
 * the moment a bump makes it wrong, instead of the download 404ing.
 */
const LINUX_ROCM_VERSION = "7.2";

/**
 * PURE — the release asset for this machine.
 *
 * The naming is **not** symmetric across platforms, and guessing cost this task a bug
 * (verification-notes §114): at `b10216` upstream publishes **no Linux CUDA build at
 * all**, and the Linux CPU asset has no `-cpu-` infix (`…-bin-ubuntu-x64.tar.gz`).
 * So an NVIDIA machine on Linux gets **Vulkan** — slower than CUDA, but it exists and
 * it works, which beats a name that resolves to nothing. Windows keeps the CUDA path.
 *
 * An unrecognised platform falls to the Linux CPU tarball, which is slow but never
 * wrong. Every name here is checked against the live release list before anything is
 * downloaded — see {@link verifyAssetName}.
 */
export function resolveAsset(facts: MachineFacts, tag = LLAMACPP_RELEASE_TAG): LlamacppAsset {
  const arch = facts.arch === "arm64" ? "arm64" : "x64";

  if (facts.platform === "darwin") {
    // Metal is compiled into the macOS tarballs; there is no separate asset to pick.
    return { backend: "metal", name: `llama-${tag}-bin-macos-${arch}.tar.gz` };
  }

  if (facts.platform === "win32") {
    if (facts.nvidiaDriverMajor !== undefined && facts.vramBytes > 0 && arch === "x64") {
      const cuda = facts.nvidiaDriverMajor >= CUDA_13_MIN_DRIVER_MAJOR ? "13.3" : "12.4";
      return {
        backend: cuda === "13.3" ? "cuda-13.3" : "cuda-12.4",
        name: `llama-${tag}-bin-win-cuda-${cuda}-x64.zip`,
        // The CUDA runtime ships separately and is NOT optional — the server will not
        // start without it, and that failure reads as "the binary is broken".
        runtimeName: `cudart-llama-bin-win-cuda-${cuda}-x64.zip`,
      };
    }
    if (facts.amdGpu === true && arch === "x64") {
      return { backend: "hip", name: `llama-${tag}-bin-win-hip-radeon-x64.zip` };
    }
    if (facts.vramBytes > 0 && arch === "x64") {
      return { backend: "vulkan", name: `llama-${tag}-bin-win-vulkan-x64.zip` };
    }
    return { backend: "cpu", name: `llama-${tag}-bin-win-cpu-${arch}.zip` };
  }

  if (facts.platform === "linux") {
    if (facts.amdGpu === true && arch === "x64") {
      return {
        backend: "hip",
        name: `llama-${tag}-bin-ubuntu-rocm-${LINUX_ROCM_VERSION}-x64.tar.gz`,
      };
    }
    if (facts.vramBytes > 0) {
      return {
        backend: "vulkan",
        name: `llama-${tag}-bin-ubuntu-vulkan-${arch}.tar.gz`,
        ...(facts.nvidiaDriverMajor !== undefined
          ? {
              note:
                "Upstream publishes no Linux CUDA build for this release, so Vulkan is " +
                "the GPU path on Linux even on NVIDIA. It is slower than CUDA and it is " +
                "what exists; build from source if you need CUDA on Linux.",
            }
          : {}),
      };
    }
    return { backend: "cpu", name: `llama-${tag}-bin-ubuntu-${arch}.tar.gz` };
  }

  return {
    backend: "cpu",
    name: `llama-${tag}-bin-ubuntu-x64.tar.gz`,
    note: `Unrecognised platform "${facts.platform}" — falling back to the Linux CPU build.`,
  };
}

/**
 * PURE — is the name we resolved actually in the release?
 *
 * A guessed asset name is a guess, and upstream renames assets between releases (the
 * §114 finding). Checking against the live list turns a 404 mid-download into one
 * legible message that names the alternatives, which is the difference between "Golem
 * is broken" and "pick one of these".
 */
export function verifyAssetName(
  asset: LlamacppAsset,
  available: readonly string[],
): { readonly ok: boolean; readonly problem?: string } {
  const missing = [
    asset.name,
    ...(asset.runtimeName === undefined ? [] : [asset.runtimeName]),
  ].filter((n) => !available.includes(n));
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    problem:
      `llama.cpp release ${LLAMACPP_RELEASE_TAG} has no asset named ${missing.join(" or ")}. ` +
      `Golem pins one release deliberately, so this means the asset naming changed upstream. ` +
      `Available builds: ${available.filter((n) => n.startsWith("llama-") || n.startsWith("cudart-")).join(", ")}`,
  };
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
  /**
   * The id the server should answer to on `/v1/models` and accept as `model`.
   *
   * Without it llama.cpp names the model after whatever file it loaded, which is a
   * path — so the provider entry Golem writes would have to hardcode a filename and
   * would break the moment the file moved. Passing the catalog id makes the two sides
   * agree by construction.
   */
  readonly alias?: string;
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

  // A draft model needs BOTH the file and the speculation *type*, and getting that
  // wrong is not a graceful failure: `--model-draft <mtp file>` with the default
  // `--spec-type` segfaults llama-server at load (exit 0xC0000005, verified on b10216 —
  // §114). Qwen's MTP head is not a standalone draft model; `draft-mtp` is the mode
  // that knows how to use it. So the type travels with the file, and a file whose type
  // Golem does not know is **not passed at all** — a model that loads without
  // speculative decoding beats one that crashes with it.
  const draft = model.files.find((f) => f.kind === "draft");
  const draftPath = draft === undefined ? undefined : filePaths[draft.path];
  const specType = draft?.specType;
  if (draftPath !== undefined && specType !== undefined) {
    args.push("--model-draft", draftPath, "--spec-type", specType);
  }

  if (opts.alias !== undefined) args.push("--alias", opts.alias);
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
