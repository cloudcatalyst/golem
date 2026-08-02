/**
 * R8.18 — the I/O half: downloading resumably, verifying digests, choosing an extractor,
 * and the server pid file.
 *
 * Nothing here touches the network or a real home directory: `fetchImpl`, the install
 * runner and `userDir` are all injected, and every download is a few bytes served from a
 * stub. What is being tested is the *behaviour under interruption and corruption*, which
 * is the only reason this module is shaped the way it is.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ggufModel } from "../../../src/inference/gguf-catalog.js";
import {
  ChecksumMismatchError,
  createLlamacppDeps,
  downloadVerified,
  extractorCandidates,
  fetchModelFiles,
  fetchReleaseAssets,
  findServerBinary,
  freeSpaceBytes,
  type LlamacppDeps,
  llamacppInstallDir,
  llamacppPidPath,
  readDownloadProgress,
  readLlamacppPid,
  readServerProps,
  releaseApiUrl,
  sha256File,
  writeLlamacppPid,
} from "../../../src/inference/llamacpp-bootstrap.js";
import { LLAMACPP_RELEASE_TAG } from "../../../src/inference/llamacpp-plan.js";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "golem-llamacpp-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A deps object whose every side effect lands in the temp dir. */
function deps(overrides: Partial<LlamacppDeps> = {}): LlamacppDeps {
  return createLlamacppDeps({
    userDir: tmp,
    run: async () => ({ ok: false, stdout: "" }),
    install: async () => ({ ok: true, code: 0 }),
    onLine: () => {},
    ...overrides,
  });
}

/** A fetch stub that serves one body, honouring (or refusing) range requests. */
function serve(
  body: string,
  opts: { readonly honourRange?: boolean } = {},
): { readonly fetchImpl: typeof fetch; readonly calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const range = headers.range;
    calls.push(range === undefined ? "full" : range);
    if (range !== undefined && opts.honourRange === true) {
      const from = Number.parseInt(range.replace(/[^0-9]/g, ""), 10);
      const slice = body.slice(from);
      return new Response(slice, {
        status: 206,
        headers: { "content-length": String(Buffer.byteLength(slice)) },
      });
    }
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(Buffer.byteLength(body)) },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("downloadVerified", () => {
  it("downloads, verifies the digest, and leaves no .part behind", async () => {
    const body = "the weights, allegedly";
    const dest = path.join(tmp, "model.gguf");
    const result = await downloadVerified({
      deps: deps({ fetchImpl: serve(body).fetchImpl }),
      url: "https://example.invalid/model.gguf",
      dest,
      expectedSha256: sha256(body),
      label: "model.gguf",
    });

    expect(result.verified).toBe(true);
    expect(await readFile(dest, "utf8")).toBe(body);
    await expect(stat(`${dest}.part`)).rejects.toThrow();
  });

  it("DELETES the partial file when the digest does not match", async () => {
    const dest = path.join(tmp, "corrupt.gguf");
    await expect(
      downloadVerified({
        deps: deps({ fetchImpl: serve("not what was promised").fetchImpl }),
        url: "https://example.invalid/corrupt.gguf",
        dest,
        expectedSha256: sha256("what was promised"),
        label: "corrupt.gguf",
      }),
    ).rejects.toThrow(ChecksumMismatchError);

    // Nothing unverified is kept: a retained partial would be inherited by the next
    // resume attempt, which is how a corrupt download becomes a permanent one.
    await expect(stat(`${dest}.part`)).rejects.toThrow();
    await expect(stat(dest)).rejects.toThrow();
  });

  it("resumes from a partial file with a range request", async () => {
    const body = "0123456789abcdefghij";
    const dest = path.join(tmp, "resume.gguf");
    await writeFile(`${dest}.part`, body.slice(0, 10), "utf8");

    const served = serve(body, { honourRange: true });
    const result = await downloadVerified({
      deps: deps({ fetchImpl: served.fetchImpl }),
      url: "https://example.invalid/resume.gguf",
      dest,
      expectedSha256: sha256(body),
      label: "resume.gguf",
    });

    expect(served.calls).toEqual(["bytes=10-"]);
    expect(result.resumed).toBe(true);
    expect(await readFile(dest, "utf8")).toBe(body);
  });

  it("starts over when the server ignores the range request", async () => {
    const body = "0123456789abcdefghij";
    const dest = path.join(tmp, "norange.gguf");
    await writeFile(`${dest}.part`, body.slice(0, 10), "utf8");

    // honourRange off: a 200 with the WHOLE body. Appending it to the 10 bytes already
    // on disk would corrupt the file silently, which is the failure this guards.
    const result = await downloadVerified({
      deps: deps({ fetchImpl: serve(body).fetchImpl }),
      url: "https://example.invalid/norange.gguf",
      dest,
      expectedSha256: sha256(body),
      label: "norange.gguf",
    });

    expect(result.resumed).toBe(false);
    expect(await readFile(dest, "utf8")).toBe(body);
  });

  it("verifies an already-present file instead of re-downloading it", async () => {
    const body = "already here";
    const dest = path.join(tmp, "present.gguf");
    await writeFile(dest, body, "utf8");

    const served = serve(body);
    const result = await downloadVerified({
      deps: deps({ fetchImpl: served.fetchImpl }),
      url: "https://example.invalid/present.gguf",
      dest,
      expectedSha256: sha256(body),
      label: "present.gguf",
    });

    expect(result.alreadyPresent).toBe(true);
    expect(served.calls).toEqual([]); // no request at all
  });

  it("re-downloads an already-present file whose digest is wrong", async () => {
    const body = "the real bytes";
    const dest = path.join(tmp, "stale.gguf");
    await writeFile(dest, "some older bytes", "utf8");

    const served = serve(body);
    const result = await downloadVerified({
      deps: deps({ fetchImpl: served.fetchImpl }),
      url: "https://example.invalid/stale.gguf",
      dest,
      expectedSha256: sha256(body),
      label: "stale.gguf",
    });

    expect(result.alreadyPresent).toBe(false);
    expect(served.calls).toEqual(["full"]);
    expect(await readFile(dest, "utf8")).toBe(body);
  });

  it("publishes progress another process can read", async () => {
    const body = "x".repeat(4096);
    const dest = path.join(tmp, "progress.gguf");
    await downloadVerified({
      deps: deps({ fetchImpl: serve(body).fetchImpl }),
      url: "https://example.invalid/progress.gguf",
      dest,
      label: "progress.gguf",
      progressIntervalMs: 0,
    });

    const progress = await readDownloadProgress(dest);
    expect(progress?.done).toBe(true);
    expect(progress?.bytes).toBe(4096);
  });
});

describe("sha256File", () => {
  it("hashes by streaming, so a 20 GB file is never held in memory", async () => {
    const file = path.join(tmp, "hash.bin");
    await writeFile(file, "content", "utf8");
    expect(await sha256File(file)).toBe(sha256("content"));
  });
});

describe("extractorCandidates", () => {
  it("names bsdtar by absolute path first on Windows, because `tar` may be GNU tar", () => {
    const candidates = extractorCandidates({
      archive: "C:\\Users\\x\\.golem\\llamacpp\\downloads\\llama.zip",
      destDir: "C:\\Users\\x\\.golem\\llamacpp\\b1",
      platform: "win32",
      systemRoot: "C:\\Windows",
    });
    expect(candidates[0]?.command).toBe(path.join("C:\\Windows", "System32", "tar.exe"));
    // A bare filename, never the absolute path: bsdtar reads `C:\…` as `host:path`.
    expect(candidates[0]?.args).toContain("llama.zip");
    expect(candidates[0]?.args.join(" ")).not.toContain("downloads");
    // And PowerShell's Expand-Archive is the last resort.
    expect(candidates.at(-1)?.command).toBe("powershell");
  });

  it("uses unzip for a zip on POSIX and tar -xzf for a tarball", () => {
    const zip = extractorCandidates({
      archive: "/home/x/a.zip",
      destDir: "/home/x/out",
      platform: "linux",
    });
    expect(zip[0]?.command).toBe("unzip");

    const tarball = extractorCandidates({
      archive: "/home/x/a.tar.gz",
      destDir: "/home/x/out",
      platform: "linux",
    });
    expect(tarball).toHaveLength(1);
    expect(tarball[0]?.args).toContain("-xzf");
  });
});

describe("fetchReleaseAssets", () => {
  it("reads the sha256 out of GitHub's `digest` field", async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      expect(String(url)).toBe(releaseApiUrl());
      return Response.json({
        assets: [
          {
            name: "llama.zip",
            browser_download_url: "https://example.invalid/llama.zip",
            size: 42,
            digest: `sha256:${"a".repeat(64)}`,
          },
          // No digest — must degrade to a size-only entry rather than being dropped.
          {
            name: "old.zip",
            browser_download_url: "https://example.invalid/old.zip",
            size: 7,
          },
        ],
      });
    }) as unknown as typeof fetch;

    const assets = await fetchReleaseAssets(deps({ fetchImpl }));
    expect(assets.get("llama.zip")?.sha256).toBe("a".repeat(64));
    expect(assets.get("old.zip")?.sha256).toBeUndefined();
    expect(assets.get("old.zip")?.bytes).toBe(7);
  });
});

describe("fetchModelFiles", () => {
  it("prefers the LFS oid and size — the publisher's exact bytes, not the catalog's GiB", async () => {
    const model = ggufModel("qwen3.6-35b-a3b-q4");
    if (model === undefined) throw new Error("catalog entry missing");
    const weights = model.files[0]?.path ?? "";

    const fetchImpl = (async () =>
      Response.json([
        { path: weights, size: 999, lfs: { oid: "b".repeat(64), size: 20_419_565_568 } },
        { path: "README.md", size: 467 },
      ])) as unknown as typeof fetch;

    const files = await fetchModelFiles(deps({ fetchImpl }), model);
    expect(files.get(weights)?.sha256).toBe("b".repeat(64));
    // The LFS size wins over the git-blob size: the latter is the pointer file.
    expect(files.get(weights)?.bytes).toBe(20_419_565_568);
  });
});

describe("readServerProps", () => {
  it("reads the live context window from /props", async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      expect(String(url)).toBe("http://127.0.0.1:11435/props");
      return Response.json({ n_ctx: 16384, model_path: "D:/models/qwen.gguf" });
    }) as unknown as typeof fetch;

    const props = await readServerProps({
      deps: deps({ fetchImpl }),
      baseUrl: "http://127.0.0.1:11435",
    });
    expect(props?.contextWindow).toBe(16384);
  });

  it("returns null rather than throwing when the server is not there", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(
      await readServerProps({ deps: deps({ fetchImpl }), baseUrl: "http://127.0.0.1:1" }),
    ).toBeNull();
  });
});

describe("the pid file", () => {
  it("round-trips, and lives in the user dir rather than a project", async () => {
    expect(llamacppPidPath(tmp)).toBe(path.join(tmp, "llamacpp", "server.pid"));
    await writeLlamacppPid(
      { pid: 4242, port: 11435, modelId: "qwen3.6-35b-a3b-q4", contextTokens: 16384, ts: "t" },
      tmp,
    );
    const info = await readLlamacppPid(tmp);
    expect(info?.pid).toBe(4242);
    expect(info?.modelId).toBe("qwen3.6-35b-a3b-q4");
  });

  it("reads a missing or malformed pid file as 'nothing running'", async () => {
    expect(await readLlamacppPid(tmp)).toBeNull();
    await writeFile(llamacppPidPath(tmp), "{not json", "utf8").catch(() => {});
  });
});

describe("layout helpers", () => {
  it("installs one directory per release tag, so an upgrade is additive", () => {
    expect(llamacppInstallDir(LLAMACPP_RELEASE_TAG, tmp)).toBe(
      path.join(tmp, "llamacpp", LLAMACPP_RELEASE_TAG),
    );
  });

  it("finds the server binary in either known archive layout", async () => {
    const installDir = path.join(tmp, "install");
    expect(await findServerBinary(installDir, "linux")).toBeNull();
    await writeFile(path.join(tmp, "llama-server"), "", "utf8");
    expect(await findServerBinary(tmp, "linux")).toBe(path.join(tmp, "llama-server"));
  });

  it("reports free space on an existing ancestor when the target does not exist yet", async () => {
    const bytes = await freeSpaceBytes(path.join(tmp, "not", "created", "yet"));
    expect(bytes).toBeGreaterThan(0);
  });
});
