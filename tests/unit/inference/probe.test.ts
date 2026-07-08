/**
 * WS-D D1 — the real ProbeRunner (createProbeRunner). Unlike capability.test.ts
 * (which injects a fake ProbeRunner), this exercises the actual node:child_process
 * spawn path: real subprocess success/failure/timeout/missing-binary, always
 * resolving `{ ok, stdout }` and never rejecting.
 *
 * Cross-platform-safe: every real subprocess case spawns `process.execPath`
 * (the running Node binary) with `-e <inline script>` rather than any shell
 * command or Unix-only binary.
 */

import { describe, expect, it } from "vitest";
import { createProbeRunner } from "../../../src/inference/probe.js";

describe("createProbeRunner", () => {
  it("resolves ok:true with captured stdout on a zero exit code", async () => {
    const run = createProbeRunner();
    const result = await run({
      command: process.execPath,
      args: ["-e", "console.log('hello'); process.exit(0)"],
    });
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("resolves ok:false (with any captured stdout) on a non-zero exit code", async () => {
    const run = createProbeRunner();
    const result = await run({
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
    });
    expect(result.ok).toBe(false);
  });

  it("resolves ok:false, stdout:'' when spawn throws synchronously", async () => {
    const run = createProbeRunner();
    // An empty command string is rejected by Node's spawn validation before a
    // child process is ever created, so it throws synchronously.
    const result = await run({ command: "", args: [] });
    expect(result).toEqual({ ok: false, stdout: "" });
  });

  it("resolves ok:false, stdout:'' when the binary does not exist (ENOENT)", async () => {
    const run = createProbeRunner();
    const result = await run({
      command: "golem-probe-test-nonexistent-binary-xyz",
      args: [],
    });
    expect(result).toEqual({ ok: false, stdout: "" });
  });

  it("resolves ok:false, stdout:'' and kills the child after timeoutMs", async () => {
    const run = createProbeRunner(50);
    const start = Date.now();
    const result = await run({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60000)"],
    });
    const elapsed = Date.now() - start;
    expect(result).toEqual({ ok: false, stdout: "" });
    // Should resolve close to timeoutMs, not wait for the 60s script.
    expect(elapsed).toBeLessThan(5_000);
  });
});
