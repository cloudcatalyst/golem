/**
 * HeadroomSidecar lifecycle + fail-open, tested against a fake worker (Node) that
 * speaks the worker protocol — so no Python/uv/headroom is needed in CI. A real
 * end-to-end run against the Python worker is a manual smoke (docs/DEVELOPMENT).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HeadroomSidecar } from "../../src/compression/headroom-adapter.js";

const FAKE_WORKER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "fake-headroom-worker.mjs",
);

/** A sidecar that launches the fake worker via `node <fake>` instead of uv/python. */
function fakeSidecar(env: Record<string, string> = {}, startupTimeoutMs = 8000): HeadroomSidecar {
  return new HeadroomSidecar({
    command: process.execPath, // node
    launchArgs: [],
    workerPath: FAKE_WORKER,
    startupTimeoutMs,
    requestTimeoutMs: 5000,
    log: () => {}, // silence
    // env is applied by the fake worker via process.env; set it on this process
    // for the child to inherit (vitest runs serially per file by default).
    ...applyEnv(env),
  });
}

/** Set env vars the fake worker reads; return {} so it merges cleanly into options. */
function applyEnv(env: Record<string, string>): Record<string, never> {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return {};
}

const sidecars: HeadroomSidecar[] = [];
function track(s: HeadroomSidecar): HeadroomSidecar {
  sidecars.push(s);
  return s;
}

afterEach(() => {
  for (const s of sidecars.splice(0)) s.stop();
  process.env.FAKE_MODE = undefined as unknown as string;
  delete process.env.FAKE_MODE;
});

describe("HeadroomSidecar (fake worker)", () => {
  it("starts, health-checks, compresses, and returns parsed results", async () => {
    const sc = track(fakeSidecar());
    expect(await sc.start()).toBe(true);
    expect(sc.isRunning()).toBe(true);

    const messages = [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ];
    const result = await sc.compress(messages, "stale_turns");
    expect(result).not.toBeNull();
    expect(result?.tokensBefore).toBe(1000);
    expect(result?.tokensAfter).toBe(900);
    expect(result?.transformsApplied).toContain("read_lifecycle:stale:/x");
    // Fake worker drops the first message.
    expect(result?.messages).toHaveLength(2);
  });

  it("lazily starts on first compress() when start() was not called", async () => {
    const sc = track(fakeSidecar());
    const result = await sc.compress([{ role: "user", content: "x" }], "aggressive");
    expect(result).not.toBeNull();
    expect(sc.isRunning()).toBe(true);
  });

  it("fails open (null) when the launcher command does not exist", async () => {
    const sc = track(
      new HeadroomSidecar({
        command: "definitely-not-a-real-command-xyz",
        launchArgs: [],
        workerPath: FAKE_WORKER,
        startupTimeoutMs: 3000,
        log: () => {},
      }),
    );
    expect(await sc.start()).toBe(false);
    expect(await sc.compress([{ role: "user", content: "x" }], "stale_turns")).toBeNull();
    expect(sc.isRunning()).toBe(false);
  });

  it("fails open (null) when the worker returns a non-200 on /compress", async () => {
    const sc = track(fakeSidecar({ FAKE_MODE: "badstatus" }));
    expect(await sc.start()).toBe(true);
    expect(await sc.compress([{ role: "user", content: "x" }], "stale_turns")).toBeNull();
  });

  it("fails open (false) when the worker never announces a port (startup timeout)", async () => {
    const sc = track(fakeSidecar({ FAKE_MODE: "slowstart" }, 1200));
    expect(await sc.start()).toBe(false);
  });
});
