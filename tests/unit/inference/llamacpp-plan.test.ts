/**
 * R8.18 — the pure half of `golem llamacpp`: asset choice, fit arithmetic, and the
 * server argument array.
 *
 * These run without a GPU, a download, or a machine of any particular shape, which is
 * the whole reason the planning half is separated from the I/O half.
 */

import { describe, expect, it } from "vitest";
import { ggufModel } from "../../../src/inference/gguf-catalog.js";
import {
  assetUrl,
  checkDiskSpace,
  checkFit,
  contextForVram,
  LLAMACPP_RELEASE_TAG,
  type MachineFacts,
  planServer,
  resolveAsset,
  verifyAssetName,
} from "../../../src/inference/llamacpp-plan.js";

const GB = 1024 ** 3;

/** The machine that motivated the task. */
const THIS_BOX: MachineFacts = {
  platform: "win32",
  arch: "x64",
  totalRamBytes: 64 * GB,
  freeRamBytes: 33 * GB,
  vramBytes: 8 * GB,
  nvidiaDriverMajor: 596,
  freeDiskBytes: 2500 * GB,
};

/**
 * The same box with no NVIDIA GPU. Written as its own literal rather than
 * `{...THIS_BOX, nvidiaDriverMajor: undefined}` because `exactOptionalPropertyTypes`
 * distinguishes "absent" from "present and undefined", and absent is what a machine
 * without an NVIDIA card actually reports.
 */
const NO_NVIDIA: MachineFacts = {
  platform: "win32",
  arch: "x64",
  totalRamBytes: 64 * GB,
  freeRamBytes: 33 * GB,
  vramBytes: 8 * GB,
  freeDiskBytes: 2500 * GB,
};

describe("resolveAsset", () => {
  it("picks the CUDA 13.3 build on a recent NVIDIA driver, with its runtime bundle", () => {
    const asset = resolveAsset(THIS_BOX);
    expect(asset.backend).toBe("cuda-13.3");
    expect(asset.name).toBe(`llama-${LLAMACPP_RELEASE_TAG}-bin-win-cuda-13.3-x64.zip`);
    // The runtime is NOT optional — without it the server will not start, and that
    // failure reads as "the binary is broken".
    expect(asset.runtimeName).toBe("cudart-llama-bin-win-cuda-13.3-x64.zip");
  });

  it("drops to CUDA 12.4 on an older driver", () => {
    const asset = resolveAsset({ ...THIS_BOX, nvidiaDriverMajor: 550 });
    expect(asset.backend).toBe("cuda-12.4");
    expect(asset.runtimeName).toContain("12.4");
  });

  it("uses Vulkan for a non-NVIDIA GPU — 32 MB and no runtime bundle", () => {
    const asset = resolveAsset(NO_NVIDIA);
    expect(asset.backend).toBe("vulkan");
    expect(asset.runtimeName).toBeUndefined();
  });

  it("uses the HIP build for an AMD GPU on Windows", () => {
    const asset = resolveAsset({ ...NO_NVIDIA, amdGpu: true });
    expect(asset.backend).toBe("hip");
  });

  it("falls to CPU when there is no accelerator at all", () => {
    const asset = resolveAsset({ ...NO_NVIDIA, vramBytes: 0 });
    expect(asset.backend).toBe("cpu");
  });

  it("uses tar.gz on Linux and the macOS tarball on darwin", () => {
    expect(resolveAsset({ ...THIS_BOX, platform: "linux" }).name).toMatch(/ubuntu.*\.tar\.gz$/);
    expect(resolveAsset({ ...THIS_BOX, platform: "darwin" }).name).toBe(
      `llama-${LLAMACPP_RELEASE_TAG}-bin-macos-x64.tar.gz`,
    );
  });

  it("builds a pinned download URL — never 'latest'", () => {
    const url = assetUrl("llama-x-bin-win-cuda-13.3-x64.zip");
    expect(url).toContain(`/download/${LLAMACPP_RELEASE_TAG}/`);
    expect(url).not.toContain("latest");
  });

  // The §114 corrections. Every one of these was WRONG before the live run: the old
  // table derived Linux names from the Windows ones, and upstream does not name them
  // that way. These are the regression tests for names that do not exist.
  it("does NOT ask for a Linux CUDA build — upstream publishes none", () => {
    const asset = resolveAsset({ ...THIS_BOX, platform: "linux" });
    expect(asset.name).not.toContain("cuda");
    expect(asset.backend).toBe("vulkan");
    // And it says why, because "where is my CUDA build?" is the obvious question.
    expect(asset.note).toContain("no Linux CUDA build");
  });

  it("names the Linux CPU asset without a -cpu- infix", () => {
    const asset = resolveAsset({ ...NO_NVIDIA, platform: "linux", vramBytes: 0 });
    expect(asset.name).toBe(`llama-${LLAMACPP_RELEASE_TAG}-bin-ubuntu-x64.tar.gz`);
    expect(asset.name).not.toContain("-cpu-");
  });

  it("uses the versioned ROCm tarball for AMD on Linux", () => {
    const asset = resolveAsset({ ...NO_NVIDIA, platform: "linux", amdGpu: true });
    expect(asset.backend).toBe("hip");
    expect(asset.name).toBe(`llama-${LLAMACPP_RELEASE_TAG}-bin-ubuntu-rocm-7.2-x64.tar.gz`);
  });

  it("calls macOS metal, because Metal is compiled in rather than a separate asset", () => {
    expect(resolveAsset({ ...THIS_BOX, platform: "darwin", arch: "arm64" })).toEqual({
      backend: "metal",
      name: `llama-${LLAMACPP_RELEASE_TAG}-bin-macos-arm64.tar.gz`,
    });
  });

  it("keeps arm64 Windows on the CPU build — there is no arm64 CUDA asset", () => {
    const asset = resolveAsset({ ...THIS_BOX, arch: "arm64" });
    expect(asset.name).toBe(`llama-${LLAMACPP_RELEASE_TAG}-bin-win-cpu-arm64.zip`);
  });
});

describe("verifyAssetName", () => {
  const available = [
    `llama-${LLAMACPP_RELEASE_TAG}-bin-win-cuda-13.3-x64.zip`,
    "cudart-llama-bin-win-cuda-13.3-x64.zip",
    `llama-${LLAMACPP_RELEASE_TAG}-bin-ubuntu-vulkan-x64.tar.gz`,
  ];

  it("passes when the asset and its runtime are both published", () => {
    expect(verifyAssetName(resolveAsset(THIS_BOX), available)).toEqual({ ok: true });
  });

  it("fails with the available names when a guessed name is not there", () => {
    const check = verifyAssetName(
      { backend: "cuda-13.3", name: "llama-b1-bin-ubuntu-cuda-13.3-x64.tar.gz" },
      available,
    );
    expect(check.ok).toBe(false);
    // The whole point: a legible message that names alternatives, not a 404 mid-download.
    expect(check.problem).toContain("ubuntu-vulkan");
  });

  it("catches a missing CUDA runtime bundle as well as a missing binary", () => {
    const check = verifyAssetName(resolveAsset(THIS_BOX), [available[0] as string]);
    expect(check.ok).toBe(false);
    expect(check.problem).toContain("cudart");
  });
});

describe("contextForVram", () => {
  it("scales the window with VRAM and never returns zero", () => {
    expect(contextForVram(8 * GB)).toBe(16384);
    expect(contextForVram(24 * GB)).toBe(131072);
    expect(contextForVram(0)).toBe(4096);
    expect(contextForVram(4 * GB)).toBeGreaterThan(0);
  });
});

describe("checkFit", () => {
  const moe = ggufModel("qwen3.6-35b-a3b-q4");
  const coder = ggufModel("qwen3-coder-next-iq2m");

  it("fits the 35B MoE on this box and shows the arithmetic", () => {
    expect(moe).toBeDefined();
    if (moe === undefined) return;
    const v = checkFit([moe], THIS_BOX, 16384);
    expect(v.fits).toBe(true);
    expect(v.explanation).toContain("Fits");
    expect(v.explanation).toContain("GB");
  });

  it("refuses the two-model set the user hoped for, with the numbers", () => {
    // The finding that changed the recommendation: a 23 GB coder beside a 20 GB
    // generalist does not fit the free RAM on a 64 GB machine.
    expect(moe && coder).toBeTruthy();
    if (moe === undefined || coder === undefined) return;
    const v = checkFit([moe, coder], THIS_BOX, 16384);
    expect(v.fits).toBe(false);
    expect(v.explanation).toContain("swap");
    expect(v.requiredBytes).toBeGreaterThan(v.availableBytes);
  });

  it("judges against FREE ram, not total", () => {
    expect(moe).toBeDefined();
    if (moe === undefined) return;
    // Same 64 GB machine, but busy: the spec sheet is not the question.
    const busy = { ...THIS_BOX, freeRamBytes: 6 * GB };
    expect(checkFit([moe], busy, 16384).fits).toBe(false);
  });
});

describe("checkDiskSpace", () => {
  it("passes on the big volume and fails on the small one", () => {
    expect(checkDiskSpace(20 * GB, THIS_BOX).fits).toBe(true);
    // 23.8 GB free is the actual state of C: on the machine this was written on. A
    // 20 GB model would technically fit and would leave under 2 GB, which is a bad
    // idea rather than a tight one — hence the reserve.
    const smallDisk = { ...THIS_BOX, freeDiskBytes: 23.8 * GB };
    const verdict = checkDiskSpace(20 * GB, smallDisk);
    expect(verdict.fits).toBe(false);
    expect(verdict.explanation).toContain("reserve");
    expect(verdict.explanation).toContain("--models-dir");
  });

  it("charges an archive double, because the zip and its contents coexist", () => {
    const disk = { ...THIS_BOX, freeDiskBytes: 20 * GB };
    expect(checkDiskSpace(6 * GB, disk, { extracts: false }).fits).toBe(true);
    expect(checkDiskSpace(6 * GB, disk, { extracts: true }).fits).toBe(false);
  });

  it("reports what would remain when it does fit", () => {
    expect(checkDiskSpace(20 * GB, THIS_BOX).explanation).toContain("would remain");
  });
});

describe("planServer", () => {
  const model = ggufModel("qwen3.6-35b-a3b-q4");
  const paths = {
    "Qwen3.6-35B-A3B-Q4_K_M.gguf": "D:\\models\\weights.gguf",
    "mtp-Qwen3.6-35B-A3B-Q4_0.gguf": "D:\\models\\mtp.gguf",
  };

  it("emits the MoE offload flags that make a 20 GB model run on 8 GB of VRAM", () => {
    expect(model).toBeDefined();
    if (model === undefined) return;
    const plan = planServer({
      command: "llama-server",
      model,
      filePaths: paths,
      facts: THIS_BOX,
      port: 8888,
    });
    expect(plan.args).toContain("-ngl");
    expect(plan.args).toContain("--n-cpu-moe");
    // --jinja is what makes llama.cpp use the GGUF's own chat template, which is what
    // turns native tool-call syntax into parsed tool_calls rather than loose text.
    expect(plan.args).toContain("--jinja");
    expect(plan.args).toContain("--model-draft");
    expect(plan.contextTokens).toBe(16384);
    expect(plan.rationale).toContain("3B active");
  });

  it("is an argument array, never a shell string", () => {
    expect(model).toBeDefined();
    if (model === undefined) return;
    const plan = planServer({
      command: "llama-server",
      model,
      filePaths: paths,
      facts: THIS_BOX,
      port: 8888,
    });
    expect(Array.isArray(plan.args)).toBe(true);
    // A path with a space must survive as one argv entry, not be quoted into a string.
    for (const a of plan.args) expect(a).not.toContain('"');
  });

  it("omits the MoE flags for a dense model, where they would be wrong", () => {
    const dense = ggufModel("qwen3-14b-q4");
    expect(dense).toBeDefined();
    if (dense === undefined) return;
    const plan = planServer({
      command: "llama-server",
      model: dense,
      filePaths: { "Qwen3-14B-Q4_K_M.gguf": "D:\\models\\dense.gguf" },
      facts: THIS_BOX,
      port: 8888,
    });
    expect(plan.args).toContain("-ngl");
    expect(plan.args).not.toContain("--n-cpu-moe");
    expect(plan.rationale).toContain("all 14B parameters are active");
  });

  it("omits GPU flags entirely on a CPU-only box", () => {
    expect(model).toBeDefined();
    if (model === undefined) return;
    const plan = planServer({
      command: "llama-server",
      model,
      filePaths: paths,
      facts: { ...NO_NVIDIA, vramBytes: 0 },
      port: 8888,
    });
    expect(plan.args).not.toContain("-ngl");
    expect(plan.args).not.toContain("--flash-attn");
  });

  it("binds loopback unless a host is named", () => {
    expect(model).toBeDefined();
    if (model === undefined) return;
    const local = planServer({
      command: "llama-server",
      model,
      filePaths: paths,
      facts: THIS_BOX,
      port: 8888,
    });
    expect(local.args[local.args.indexOf("--host") + 1]).toBe("127.0.0.1");
    const lan = planServer({
      command: "llama-server",
      model,
      filePaths: paths,
      facts: THIS_BOX,
      port: 8888,
      host: "0.0.0.0",
    });
    expect(lan.args[lan.args.indexOf("--host") + 1]).toBe("0.0.0.0");
  });

  it("throws rather than guessing when a resolved path is missing", () => {
    expect(model).toBeDefined();
    if (model === undefined) return;
    expect(() =>
      planServer({
        command: "llama-server",
        model,
        filePaths: {},
        facts: THIS_BOX,
        port: 8888,
      }),
    ).toThrow(/no resolved path/);
  });
});
