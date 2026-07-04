/**
 * WS-D D1 — the real ProbeRunner: spawn a short-lived process with an argument
 * array (never a shell string — CLAUDE.md), enforce a timeout, and resolve to
 * `{ ok, stdout }` on every path (never reject; a missing binary, non-zero
 * exit, or timeout is `ok: false`). This keeps capability detection total.
 */

import { spawn } from "node:child_process";
import type { ProbeCommand, ProbeResult, ProbeRunner } from "./capability.js";

/** Default per-probe timeout. GPU CLIs answer in well under a second normally. */
export const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

export function createProbeRunner(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): ProbeRunner {
  return (cmd: ProbeCommand): Promise<ProbeResult> =>
    new Promise<ProbeResult>((resolve) => {
      let settled = false;
      const done = (result: ProbeResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child: ReturnType<typeof spawn>;
      try {
        // shell:false is the default; args are passed as an array so no shell
        // ever parses them. windowsHide avoids console flashes on Windows.
        child = spawn(cmd.command, [...cmd.args], { shell: false, windowsHide: true });
      } catch {
        // spawn can throw synchronously (e.g. EINVAL) — treat as unavailable.
        done({ ok: false, stdout: "" });
        return;
      }

      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill();
        done({ ok: false, stdout: "" });
      }, timeoutMs);
      timer.unref?.();

      child.stdout?.on("data", (c: Buffer) => chunks.push(c));
      // A missing binary surfaces as an 'error' event (ENOENT), not a throw.
      child.on("error", () => {
        clearTimeout(timer);
        done({ ok: false, stdout: "" });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ ok: code === 0, stdout: Buffer.concat(chunks).toString("utf8") });
      });
    });
}
