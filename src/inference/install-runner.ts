/**
 * The long-running, output-streaming counterpart to `probe.ts`'s spawn
 * discipline: installers and model downloads can take minutes, and callers
 * want live progress rather than a buffered result. Argument arrays only —
 * never a shell string (CLAUDE.md) — and `createInstallCommandRunner()`
 * never rejects; any spawn failure surfaces as `{ ok: false, code: null }`.
 *
 * This file is the one place `src/inference/ollama-bootstrap.ts` actually
 * spawns installer processes and downloads bytes. It has no deep unit test —
 * the same treatment `HeadroomSidecar`'s real spawn path already gets in
 * this codebase (see tests/integration/headroom-adapter.test.ts).
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { request } from "undici";

export interface RunOutcome {
  readonly ok: boolean;
  readonly code: number | null;
}

export type OutputSink = (chunk: string, stream: "stdout" | "stderr") => void;

export interface RunInstallCommandOptions {
  readonly onOutput?: OutputSink;
  readonly timeoutMs?: number;
}

export type InstallCommandRunner = (
  cmd: { readonly command: string; readonly args: readonly string[] },
  opts?: RunInstallCommandOptions,
) => Promise<RunOutcome>;

/** Installers and model pulls are slow; a 3s probe timeout would be wrong here. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000;

export function createInstallCommandRunner(): InstallCommandRunner {
  return (cmd, opts = {}) =>
    new Promise<RunOutcome>((resolve) => {
      let settled = false;
      const done = (result: RunOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child: ReturnType<typeof spawn>;
      try {
        // shell:false, argument array — installers may pop a UAC/GUI prompt,
        // so (unlike probe.ts) the window is not force-hidden.
        child = spawn(cmd.command, [...cmd.args], { shell: false, windowsHide: false });
      } catch {
        done({ ok: false, code: null });
        return;
      }

      const timer = setTimeout(() => {
        child.kill();
        done({ ok: false, code: null });
      }, opts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS);
      timer.unref?.();

      child.stdout?.on("data", (c: Buffer) => opts.onOutput?.(c.toString("utf8"), "stdout"));
      child.stderr?.on("data", (c: Buffer) => opts.onOutput?.(c.toString("utf8"), "stderr"));
      child.on("error", () => {
        clearTimeout(timer);
        done({ ok: false, code: null });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ ok: code === 0, code });
      });
    });
}

export type ScriptDownloader = (url: string, destPath: string) => Promise<void>;

/** Real downloader: undici request -> file write stream, made executable (POSIX). */
export function createScriptDownloader(): ScriptDownloader {
  return async (url, destPath) => {
    const res = await request(url, { method: "GET" });
    if (res.statusCode >= 400) {
      const body = await res.body.text();
      throw new Error(`failed to download ${url}: HTTP ${res.statusCode}: ${body}`);
    }
    await mkdir(path.dirname(destPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(destPath);
      res.body.pipe(out);
      out.on("finish", () => resolve());
      out.on("error", reject);
      res.body.on("error", reject);
    });
    await chmod(destPath, 0o755); // no-op on Windows; required to execute on POSIX
  };
}
